/**
 * 设置持久层（spec 7.1-05）：把"人在界面里的表态"写进 userData，重启仍然算数。
 *
 * 为什么需要它：`plugins.saveConfig` → `kernel.applyConfig` → `ConfigService.setRuntime` 改的是
 * **内存** Map（AGENTS.md §9 实测 5.3-b 原文：「配置层只写内存运行时层，从不落盘」），
 * 于是界面上填的 `baseUrl` / 模型名一重启就没了。本模块就是缺的那半——只做一件事：
 * 把 runtime 补丁同时写进一个 JSON 文件，并在下次装载时作为独立一层喂回合并。
 *
 * 层级位置 `default < file < **persisted** < env < runtime` 的理由见 plan §3.2：
 * cordis.yml 是入库基线（要被用户表态盖过），env 是验收与 CI 的覆盖口子（不能被存下来的值盖过）。
 * 密钥**不走这里**（那是 `secret.ts`），因为本文件的内容是明文可读的。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeDeep } from './merge.js';

/** 设置文件的固定名。 */
export const SETTINGS_FILENAME = 'settings.json';

/** 落盘形状：`{ "<插件id>": { …该插件的覆盖值 } }`，与 runtime 补丁同构。 */
export type SettingsMap = Record<string, Record<string, unknown>>;

function asSettingsMap(value: unknown): SettingsMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: SettingsMap = {};
  for (const [id, patch] of Object.entries(value)) {
    if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) {
      result[id] = patch as Record<string, unknown>;
    }
  }
  return result;
}

/**
 * 设置文件本体：一次装载进内存，之后每次写都整库重写。
 *
 * 文件很小（只有被白名单放开的几个键），所以不做增量 IO，也不做缓存失效。
 */
export class SettingsStore {
  private values: SettingsMap = {};

  constructor(private readonly dir: string) {}

  /** 设置文件的绝对路径。 */
  filePath = (): string => join(this.dir, SETTINGS_FILENAME);

  /**
   * 读盘。
   * @returns 已存的全部覆盖值；文件不存在或解析失败时是空表——**坏文件不许挡启动**，
   * 但它也不会被覆盖掉：只有人真的保存一次才重写（`write` 是唯一写入口）
   */
  load = (): SettingsMap => {
    try {
      this.values = asSettingsMap(JSON.parse(readFileSync(this.filePath(), 'utf8')));
    } catch {
      this.values = {};
    }
    return this.values;
  };

  /** 某插件当前已持久化的覆盖值（没有则空对象）。 */
  get = (id: string): Record<string, unknown> => this.values[id] ?? {};

  /**
   * 深合并一层覆盖并落盘。
   * @param id 插件 id
   * @param patch 该插件的覆盖值（只应是白名单内的键，白名单在调用方 `setPersisted` 上把关）
   */
  write = (id: string, patch: Record<string, unknown>): void => {
    this.values = { ...this.values, [id]: mergeDeep(this.values[id] ?? {}, patch) };
    this.flush();
  };

  /** 整库重写：明文 JSON，权限 0600，临时文件 + rename。 */
  private flush(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.filePath()}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath());
    chmodSync(this.filePath(), 0o600);
  }
}
