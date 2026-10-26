/**
 * 「把这一份 PDF 交给伴生应用 Office-cc 整页编辑」的判定与拉起（spec 3.15，plan `03-resume-pdf` §21，裁定㊴）。
 *
 * 为什么判定与拉起都放这一格：`index.ts` 是窗口与托盘那一格，能单测的只有纯判定（本包既有画法见
 * `reveal-target.ts` / `file-picker.ts`）。这一口碰的是**子进程**，所以入参形状、CLI 回执映射、
 * 超时、spawn 失败四类结局在这里判完，`index.ts` 只负责把拒绝抛成结构化错误。
 *
 * 契约的来源是伴生应用自己声明为稳定的那一面（`packages/cli/src/cli.ts` 的全局 `--json`、
 * `result.ts` 的 EXIT 表与 `ErrorReason` 清单）。我们只拼那一条命令行，
 * **不复制**它的 `control.json` / socket / token 发现逻辑——那会在本仓长出第二份事实（§2.5）。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AppErrorCode } from '@auto-cc/core';

/** 伴生 CLI 的默认命令名；配置键 `companionEditorBin` 与 env 都能覆盖它（缺省即零配置可用）。 */
export const COMPANION_EDITOR_DEFAULT_BIN = 'officecc';

/**
 * 拉起的最长等待（毫秒）。下限有依据：CLI 自己在找不到在跑的实例时会启动伴生应用并等它发布
 * control endpoint 最多 45s（`packages/cli/src/commands/open.ts` 的 `APP_START_TIMEOUT_MS`），
 * 这一侧必须比它长，否则"第一次要冷启动伴生应用"这一条正常路径会被我们掐成超时。
 */
export const COMPANION_EDITOR_TIMEOUT_MS = 60_000;

/** stdout 的读取上限（字节）：超了就不猜那枚残缺 JSON，直接判失败。 */
const COMPANION_STDOUT_LIMIT = 64 * 1024;

/** 那一次跳转的结局：接纳时带回拼好的 argv 与解析后的绝对路径，拒绝时带回原因码与一句进日志的原因。 */
export type CompanionOpenPlan =
  { isAccepted: true; args: string[]; filePath: string } | { isAccepted: false; code: AppErrorCode; reason: string };

/** CLI 那一趟回来的判读结果（`launchCompanion` 的返回值，也是服务方法唯一要看的形状）。 */
export type CompanionReply =
  { isAccepted: true } | { isAccepted: false; code: AppErrorCode; reason: string; details?: unknown };

/** 一次子进程运行的原始读数；`interpretCompanionReply` 的唯一输入，测试可直接构造它。 */
export interface CompanionRawReply {
  /** CLI 在 stdout 上写的那一枚 JSON（`--json` 契约：一条命令一个对象）。 */
  stdout: string;
  /** 进程退出码；被信号终止时为 null。 */
  exitCode: number | null;
  /** 等待超过 `COMPANION_EDITOR_TIMEOUT_MS`，已被我们终止。 */
  isTimedOut: boolean;
  /** spawn 自己失败时 Node 给的错误码（`ENOENT` = 那条命令在本机根本找不到）。 */
  spawnErrorCode?: string;
  /** stdout 越过读取上限：此时 JSON 必然残缺，不许当成功。 */
  isStdoutOverflowed?: boolean;
}

/**
 * 在本机找出那支伴生 CLI。
 * @param bin 配置解析出来的命令名或绝对路径（缺省 `officecc`；`cordis.yml`、env、界面偏好三层都能覆盖）
 * @param env 环境变量快照（只取 `PATH` 与 `HOME`；测试可整体替换，不依赖真实 shell）
 * @param platform 按哪个平台的规则找（Windows 只认 `.exe`、PATH 用 `;` 分，见 plan §21.5 第 4 条；
 *        单测靠它在 mac 上也能验 Windows 那一条分支，真实运行时两者是同一台机器）
 * @param exists 存在性探针（默认 `existsSync`，单测注入替身以避开真实磁盘）
 * @returns 能直接交给 `spawn` 的那一条命令（名字或绝对路径）；只有"配了带目录的路径而它不存在"与"配置是空串"
 *          这两种回 undefined → 上层报 `COMPANION_EDITOR_MISSING`。裸命令名一律原样回，让系统按 `PATH` 最后认一次
 *          （起不来时子进程会以 `ENOENT` 说话，那边同样接成 `COMPANION_EDITOR_MISSING`，两头的说法是一致的）。
 *          **配了带目录的路径就照它**，不再回头查 PATH——否则"我明明指了绝对路径"与"它跑了另一份安装"两种说法同时成立。
 */
export function resolveCompanionCommand(
  bin: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined {
  const name = bin.trim();
  if (name === '') return undefined;
  // 路径按**目标平台**那套语义拼（`path.win32` 在 mac 上也存在），否则这条分支在开发机上永远测不到；
  // 真实运行时两者本来就是同一台机器。
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const suffixes = platform === 'win32' ? ['.exe'] : [''];
  const looksLikePath = name.includes('/') || name.includes('\\') || /^[A-Za-z]:[\\/]/.test(name);
  if (looksLikePath) {
    return suffixes.map((suffix) => `${name}${suffix}`).find((candidate) => exists(candidate));
  }
  // PATH 的键名在 Windows 上是 `Path`，大小写不敏感地取，否则永远查不到。
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  // `Path` 这样的键名不能写成 `env['Path'.toUpperCase()]`（那是 `PATH`，回 undefined）。
  const fromPath = (pathKey === undefined ? '' : (env[pathKey] ?? ''))
    .split(impl.delimiter)
    .filter((dir) => dir !== '');
  // 打包态从 Finder / 开始菜单起来时拿到的 PATH 不含用户自己的 `~/.local/bin` 这类目录，
  // 而伴生 CLI 恰好常装在那里——零配置这条路就补这几处常用位置（只读探测，不写任何东西）。
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const common =
    platform === 'darwin'
      ? [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']
      : platform === 'win32'
        ? []
        : [`${home}/.local/bin`, '/usr/local/bin', '/usr/bin'];
  const directories = [...fromPath, ...common.filter((dir) => dir !== '')];
  for (const dir of directories) {
    const hit = suffixes.map((suffix) => impl.join(dir, `${name}${suffix}`)).find((candidate) => exists(candidate));
    if (hit) return hit;
  }
  return name;
}

/**
 * 组一条 `officecc --json open <绝对路径> [--page n]`。
 * @param filePath 未受信的渲染层实参：要交出去的那份 PDF 的绝对路径（形状没有任何保证）
 * @param page 未受信的渲染层实参：人此刻正看的那一页（**1 起**，与伴生 CLI 的 `--page` 同一口径）；
 *        不是正整数就整支省略——页号只是"帮我翻到那一页"，不值得为它失败一次跳转
 * @returns 接纳时 argv 与解析后的绝对路径；拒绝时 `INVALID_ARGUMENT`。
 *          **只收绝对路径与 `.pdf`**：这条口的语义是"把人手里那份 PDF 交出去"，
 *          相对路径会随主进程的工作目录漂移，非 PDF 也不归这一格管。
 *          文件在不在磁盘上**不在这里判**——伴生 CLI 自己会回 `file_not_found`，那才是唯一的一份事实。
 */
export function planCompanionOpen(filePath: unknown, page: unknown): CompanionOpenPlan {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { isAccepted: false, code: 'INVALID_ARGUMENT', reason: '没有要交给伴生应用的文件' };
  }
  if (!path.isAbsolute(filePath)) {
    return { isAccepted: false, code: 'INVALID_ARGUMENT', reason: `要交出的路径必须是绝对路径：${filePath}` };
  }
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.pdf') {
    return {
      isAccepted: false,
      code: 'INVALID_ARGUMENT',
      reason: `伴生应用这一口只交 PDF：${resolved}`,
    };
  }
  const pageNumber = typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : undefined;
  return {
    isAccepted: true,
    filePath: resolved,
    args: ['--json', 'open', resolved, ...(pageNumber === undefined ? [] : ['--page', String(pageNumber)])],
  };
}

/**
 * 把一次子进程运行翻成本 app 的三种处置，**每种都说得出下一步**。
 * @param raw 原始读数（stdout / 退出码 / 超时 / spawn 错误码 / 溢出位）
 * @returns 只有「CLI 回了 `status:'ok'` 且进程 0 退出」算成功；
 *          其余按 `COMPANION_EDITOR_TIMEOUT`（等不到）、`COMPANION_EDITOR_MISSING`（本机没装）、
 *          `COMPANION_EDITOR_REJECTED`（它按自己的 reason 拒了，如 `outside_allowed_roots`）、
 *          `COMPANION_EDITOR_FAILED`（没按 `--json` 回话、`partial`、非零退出）分流。
 *          CLI 的英文 `message` 只进 `details` 作诊断，**不当界面文案**（§5.5）。
 */
export function interpretCompanionReply(raw: CompanionRawReply): CompanionReply {
  if (raw.isTimedOut) {
    return {
      isAccepted: false,
      code: 'COMPANION_EDITOR_TIMEOUT',
      reason: `伴生应用没有在 ${COMPANION_EDITOR_TIMEOUT_MS}ms 内答话`,
    };
  }
  if (raw.spawnErrorCode !== undefined) {
    const isMissing = raw.spawnErrorCode === 'ENOENT';
    return {
      isAccepted: false,
      code: isMissing ? 'COMPANION_EDITOR_MISSING' : 'COMPANION_EDITOR_FAILED',
      reason: isMissing
        ? '本机找不到伴生应用的命令行工具，配不出这一条路径就跳不过去'
        : `伴生应用的命令行工具起不来：${raw.spawnErrorCode}`,
      details: { spawnErrorCode: raw.spawnErrorCode },
    };
  }
  if (raw.isStdoutOverflowed) {
    return {
      isAccepted: false,
      code: 'COMPANION_EDITOR_FAILED',
      reason: '伴生应用回的内容超出读取上限，这一趟不按成功处理',
      details: { limitBytes: COMPANION_STDOUT_LIMIT },
    };
  }
  const parsed: unknown = parseJsonObject(raw.stdout);
  if (parsed === undefined) {
    return {
      isAccepted: false,
      code: 'COMPANION_EDITOR_FAILED',
      reason: '伴生应用没有按 --json 回话',
      details: { exitCode: raw.exitCode, stdoutHead: raw.stdout.slice(0, 200) },
    };
  }
  const record = parsed as Record<string, unknown>;
  if (record.status === 'error') {
    return {
      isAccepted: false,
      code: 'COMPANION_EDITOR_REJECTED',
      // 那句话里带上 CLI 的稳定 reason 名（`file_not_found` 这种）：它的英文 message 只说现象，
      // 而人要按名字才查得到伴生应用文档里对应的那条处置。
      reason: `伴生应用拒了这一次跳转（${stringValue(record.error)}）：${stringValue(record.message)}`,
      details: {
        cliReason: stringValue(record.error),
        cliMessage: stringValue(record.message),
        cliSuggestion: stringValue(record.suggestion),
        exitCode: raw.exitCode,
      },
    };
  }
  if (record.status !== 'ok' || raw.exitCode !== 0) {
    return {
      isAccepted: false,
      code: 'COMPANION_EDITOR_FAILED',
      reason: `伴生应用这一趟不是干净成功：status=${stringValue(record.status)} exit=${String(raw.exitCode)}`,
      details: { status: record.status, exitCode: raw.exitCode },
    };
  }
  return { isAccepted: true };
}

/**
 * 跑一趟伴生 CLI 并把读数交给 `interpretCompanionReply`。
 * @param command `resolveCompanionCommand` 选出的那一条命令
 * @param args `planCompanionOpen` 拼出的 argv（**数组形式**，绝不拼成一条 shell 字符串，§8.1）
 * @param timeoutMs 等待上限（默认 `COMPANION_EDITOR_TIMEOUT_MS`；测试用短值免等）
 * @param spawnImpl 子进程工厂（默认真实 `spawn`；单测注入替身，这样"起不来 / 超时"两类分支也能被断言）
 * @returns 三种处置之一。子进程的 stderr 只丢不读——CLI 的人读文本走 stdout 那枚 JSON，
 *          而我们要的从来不是它印给人看的那几行。
 */
export function launchCompanion(
  command: string,
  args: string[],
  timeoutMs: number = COMPANION_EDITOR_TIMEOUT_MS,
  spawnImpl: typeof spawn = spawn,
): Promise<CompanionReply> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let exitCode: number | null = null;
    let isOverflowed = false;
    let isTimedOut = false;
    let spawnErrorCode: string | undefined;
    let settled = false;
    // 计时器排在 `spawnChild()` 之后一次性建好：`finish` 里要清它，而同步抛那条路必须在它存在之后才收尾，
    // 用 `let` 提前声明会被读成一个"可能永远不 assign"的空位（也可能在 TDZ 里被读到）。
    const child = spawnChild();
    const timer =
      child === undefined
        ? undefined
        : setTimeout(() => {
            isTimedOut = true;
            child.kill();
            finish();
          }, timeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(
        interpretCompanionReply({
          stdout,
          exitCode,
          isTimedOut,
          spawnErrorCode,
          isStdoutOverflowed: isOverflowed,
        }),
      );
    };
    // `spawn` 对无效参数是**同步抛**（Windows 上那条 `.cmd` 就是这一类），同步抛不会变成 `error` 事件；
    // 接不住这一抛，这一趟就永远不 resolve，界面上那颗键从此停在在途态——所以起进程这件事本身也在判据里。
    if (child === undefined) {
      finish();
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > COMPANION_STDOUT_LIMIT) {
        isOverflowed = true;
        child.kill();
        finish();
      }
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? 'UNKNOWN';
      finish();
    });
    child.once('close', (code: number | null) => {
      exitCode = code;
      finish();
    });

    /** 真起进程，把同步抛折算成 `spawnErrorCode`；失败时回 undefined，由调用处立刻收尾。 */
    function spawnChild(): ChildProcessByStdio<null, Readable, null> | undefined {
      try {
        // stdin 关掉、stderr 丢掉：这一口只认 stdout 那一枚 JSON，多余的管道只会多挂句柄。
        return spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (error) {
        // 这一抛带得出 `code`（Windows 上那条 `.cmd` 是 `EINVAL`），优先取它——`name` 只有 `Error` 这个字，
        // 而界面上要说的是"哪一种起不来"。
        const errno = error as NodeJS.ErrnoException;
        spawnErrorCode = errno.code ?? errno.name;
        return undefined;
      }
    }
  });
}

/**
 * 只认「一个 JSON 对象」这一种 stdout。
 * @param stdout 原始文本
 * @returns 解析出的对象；不是合法 JSON、是 JSON 但不是对象（数字、数组、`null`）时回 undefined
 */
function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把 JSON 里任意形状的一个字段收成可进日志的字符串。
 * @param value 该字段（伴生应用可能不写它，也可能写成非字符串）
 * @returns 字符串原样、数字与布尔按字面；对象/数组一律回空串——`String(obj)` 会得到
 *          `[object Object]` 这种比没有更坏的读数（诊断要靠 `details` 里的原始结构，不是这一句）。
 */
function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
