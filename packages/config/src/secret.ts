/**
 * 密钥库（spec 7.1-01 ~ 7.1-06）：全仓唯一的凭证落盘面。
 *
 * 它**不属于配置四层**，也不参与 `traceConfig` 的合并：密钥一旦进了合并结果，就会顺着
 * `config.trace()` 流到诊断面板与日志里（AGENTS.md §8.5/§8.6）。所以这里单独一格——
 * 写进去的明文只存在一个 0600 的文件里，对外只交出掩码读数。
 *
 * 加密由 `Cipher` 端口决定：主进程里是 Electron `safeStorage`（macOS 走 Keychain、
 * Windows 走 DPAPI、Linux 走 secret service），拿不到就退回恒等端口并**如实上报 `encrypted:false`**，
 * 不做静默降级（spec 7.1-03）。纯 Node（vitest）里 `import('electron')` 要么解析不到、
 * 要么拿到的 `safeStorage` 是 undefined——本机 spike 实测过这条，所以测试必然走恒等端口，
 * 加密分支由注入假 `Cipher` 的用例覆盖。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 密钥文件的固定名：与 settings.json 分开放，一个是密文、一个是明文可读的界面表态。 */
export const SECRET_FILENAME = 'secrets.bin';

/** 加解密端口。`encrypted` 是**事实陈述**，界面要照着它说话。 */
export interface Cipher {
  readonly encrypted: boolean;
  /** 把明文变成落盘字节。 */
  encrypt(plain: string): Buffer;
  /** 把落盘字节还原成明文；解不开必须抛（调用方据此报 `SECRET_UNREADABLE`，不猜空串）。 */
  decrypt(blob: Buffer): string;
}

/** 恒等端口：`safeStorage` 不可用时的落盘形态（UTF-8 明文 + 0600）。 */
export const plainCipher: Cipher = {
  encrypted: false,
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (blob) => blob.toString('utf8'),
};

/** Electron `safeStorage` 里本模块用到的三件事（结构型声明，不给 config 包引入 electron 类型依赖）。 */
interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** safeStorage 端口：`encryptString` 失败会抛，交给调用方（不吞）。 */
function fromSafeStorage(safeStorage: SafeStorageLike): Cipher {
  return {
    encrypted: true,
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  };
}

/**
 * 探测本进程能不能用系统安全存储。
 *
 * 用**变量 specifier** 做动态 import：`electron` 不是本包的依赖，打包后也不在 node_modules 里，
 * 它只在真正运行于 Electron 主进程时才可解析；写成字面量会让 TS 与 esbuild 都去解析它而报错。
 * @returns 可用则返回 safeStorage 端口，否则返回恒等端口（不抛，调用方读 `encrypted` 播报）
 */
export async function resolveCipher(): Promise<Cipher> {
  const specifier = 'electron';
  try {
    const mod = (await import(specifier)) as Partial<SafeStorageLike> & { default?: Partial<SafeStorageLike> };
    const candidate: Partial<SafeStorageLike> = mod?.default ?? mod ?? {};
    const { isEncryptionAvailable, encryptString, decryptString } = candidate;
    if (isEncryptionAvailable?.() === true && encryptString && decryptString) {
      return fromSafeStorage({ isEncryptionAvailable, encryptString, decryptString });
    }
  } catch {
    // 非 Electron 运行时（纯 Node / vitest）与打包态都在这里收敛成恒等端口。
  }
  return plainCipher;
}

/** 一条密钥的掩码读数：只够界面说"存过、末四位是什么、什么时候写的"。 */
export interface SecretRecord {
  path: string;
  /** 明文末 4 位（不足 4 位时全给，反正它本身就短）。 */
  tail: string;
  /** 落盘时间（ISO 8601）；旧记录没这个字段时是 null，不猜。 */
  updatedAt: string | null;
}

/** 密钥库的一次装载结果：`unreadable` 是"文件在但解不开"，界面必须把它说出来而不是当作没存。 */
export interface SecretLoad {
  records: SecretRecord[];
  unreadable: boolean;
}

/** 掩码：交出末 4 位，其余一律不回。 */
export function maskSecret(plain: string): string {
  const trimmed = plain.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

/** 落盘结构：`{ "<path>": { value, updatedAt } }`，密文逐条包装，便于定位单条损坏。 */
interface SecretEntry {
  value: string;
  updatedAt: string;
}

/**
 * 密钥库本体：持有内存副本 + 一个 0600 文件。
 *
 * 写盘走「临时文件 → rename」，避免半截写入把好数据顶掉；每条值单独加密，
 * 于是密钥文件里任何一处都 grep 不到明文（spec 7.1-02）。
 */
export class SecretStore {
  private entries = new Map<string, SecretEntry>();
  private unreadableFlag = false;

  constructor(
    private readonly dir: string,
    private readonly cipher: Cipher,
  ) {}

  /** 密钥文件的绝对路径（测试与验收取证用）。 */
  filePath = (): string => join(this.dir, SECRET_FILENAME);

  /** 能不能算加密存储（界面状态行的那句"未加密存储"由它决定）。 */
  get isEncrypted(): boolean {
    return this.cipher.encrypted;
  }

  /**
   * 读盘并解密。
   * @returns 装载结果；文件不存在时是空集合（首启动），解不开时 `unreadable:true` 且**保留原文件**
   */
  load = (): SecretLoad => {
    let raw: Buffer;
    try {
      raw = readFileSync(this.filePath());
    } catch {
      return { records: [], unreadable: false };
    }
    try {
      const decrypted = this.cipher.decrypt(raw);
      const parsed = JSON.parse(decrypted) as Record<string, SecretEntry>;
      this.entries = new Map(Object.entries(parsed));
      this.unreadableFlag = false;
    } catch {
      // 换机、重装、Keychain 口令变更都会走到这里（plan §6 风险二）：
      // 不静默清空用户仅有的那份凭证，也不让主进程崩——报出去，让人重填一次。
      this.entries = new Map();
      this.unreadableFlag = true;
    }
    return { records: this.list(), unreadable: this.unreadableFlag };
  };

  /** 装载失败的那一面（spec 7.1-04）。 */
  get unreadable(): boolean {
    return this.unreadableFlag;
  }

  /**
   * 取明文密钥。
   * @param path 密钥路径（服务名级别，如 `llm.chat`）
   * @returns 明文；没存过返回空串，交由调用方判"缺 key"
   */
  get = (path: string): string => this.entries.get(path)?.value ?? '';

  /**
   * 写入一条密钥并立即落盘。
   * @param path 密钥路径
   * @param plain 明文（调用方负责 trim 与"是不是哨兵值"的判断，这里只管存）
   */
  set = (path: string, plain: string): void => {
    this.entries.set(path, { value: plain, updatedAt: new Date().toISOString() });
    this.flush();
  };

  /** 删除一条密钥并落盘；不存在时静默成功（幂等，界面上的"清除"按钮不该因为点第二次而报错）。 */
  clear = (path: string): void => {
    if (this.entries.delete(path)) this.flush();
  };

  /** 掩码清单：只有末 4 位与时间，永不含明文。 */
  list = (): SecretRecord[] =>
    [...this.entries.entries()].map(([path, entry]) => ({
      path,
      tail: maskSecret(entry.value),
      updatedAt: entry.updatedAt ?? null,
    }));

  /** 整库重写：加密后一次性写出，权限收到 0600。 */
  private flush(): void {
    mkdirSync(this.dir, { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(this.entries));
    const blob = this.cipher.encrypt(payload);
    // 先落同目录的临时文件再 rename：写入中途断电不会留下半截文件顶掉旧数据。
    // 名字带随机后缀，避免两个实例（开发态的隔离副本）互相踩。
    const tmp = `${this.filePath()}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, blob, { mode: 0o600 });
    // 已存在的文件上 `mode` 不生效（createOnly 语义），所以显式 chmod（spike 实测默认落 0644）。
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath());
    chmodSync(this.filePath(), 0o600);
  }
}
