/**
 * `platform.boss` 服务（spec 2.2-06 / 2.2-07 → 2.3 起接上页面通道）。
 *
 * 为什么要有这个包，而不是把适配器写在 `browser` 里：plan §3 规则 1 规定内核不认识 BOSS，
 * 平台知识只能被注册进来。于是「读知识包 → 造适配器 → 登记」这一步必须待在平台包这一侧，
 * 由装配清单（`cordis.yml`）决定装不装它；`browser` 与 `workflow` 一行都不改。
 *
 * 知识包是数据资产、与内核代码分开发版（plan §9.2），所以默认随包内嵌一份，
 * 又要能在不改代码的前提下换文件验证（配置键 `packFile`）：2.6 搬运真实站点知识时就走这条口。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, Service, asApp, type Context } from '@auto-cc/core';
import {
  parseKnowledgePack,
  type BrowserActService,
  type BrowserPageService,
  type KnowledgePack,
  type PlatformRegistryService,
} from '@auto-cc/plugin-browser';
import { z } from 'zod';
import { createBossAdapter } from './adapter.js';
import bundledBossPack from './knowledge/boss.json';

/** 本包对 `platform.registry` 的全部诉求：把自己登记进去，别的一概不碰。 */
type RegistryHost = Pick<PlatformRegistryService, 'register'>;

/** 本包对 `browser.page` 的全部诉求：适配器只需要导航与批量抽取这两只手（见 `BossPageHand`）。 */
type PageHand = Pick<BrowserPageService, 'navigate' | 'extract'>;

/** 本包对 `browser.act` 的全部诉求：打招呼那一下要用的敲字、点击与等待（见 `BossActionHand`）。 */
type ActionHand = Pick<BrowserActService, 'type' | 'click' | 'waitFor'>;

export const bossPlatformSchema = z.strictObject({
  /**
   * 外部知识包文件的绝对路径（相对路径按进程工作目录解析）。
   * 省略时用随包内嵌的 `src/knowledge/boss.json`；改定位只改这份文件，不发版、不动 TS。
   */
  packFile: z.string().min(1).optional(),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BossPlatformConfig = z.output<typeof bossPlatformSchema>;

/**
 * 取出本次要用的站点知识包。
 * @param packFile 外部知识文件路径；省略或为空串时用内嵌那一份
 * @returns 经 `parseKnowledgePack` 校验的知识包（结构、每条定位声明都过了语义校验）
 * @throws 文件读不出、不是合法 JSON、或内容不合法时 `KNOWLEDGE_PACK_INVALID`，绝不返回半残的包
 */
export function loadBossKnowledgePack(packFile?: string): KnowledgePack {
  if (!packFile) return parseKnowledgePack(bundledBossPack);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(packFile), 'utf8')) as unknown;
  } catch (error) {
    throw new AppError(
      'KNOWLEDGE_PACK_INVALID',
      `站点知识包读取失败：${error instanceof Error ? error.message : String(error)}`,
      'platform.boss',
      { packFile },
    );
  }
  return parseKnowledgePack(raw);
}

export class BossPlatformService extends Service {
  static provide = 'platform.boss';
  static Config = bossPlatformSchema;
  static inject = ['platform.registry', 'browser.page', 'browser.act'];

  constructor(
    ctx: Context,
    private readonly config: BossPlatformConfig,
  ) {
    super(ctx, 'platform.boss');
  }

  /**
   * 登记表句柄：本包只需要它的 `register`，因此收成有限集（与 `sessions` 取 `shell` 同一条路，
   * 想加能力得先改这一行，改动就会被看见）。
   * @returns `platform.registry` 服务实例
   */
  private get registry(): RegistryHost {
    return asApp(this.ctx)['platform.registry'];
  }

  /**
   * 页面通道句柄：适配器靠它读页面，本包不碰 `webContents`（plan §3 规则 3）。
   * @returns `browser.page` 的 `navigate` / `extract`
   */
  private get page(): PageHand {
    return asApp(this.ctx)['browser.page'];
  }

  /**
   * 动作通道句柄：打招呼靠它敲字与点击，本包同样不碰 `webContents`。
   * @returns `browser.act` 的 `type` / `click` / `waitFor`
   */
  private get act(): ActionHand {
    return asApp(this.ctx)['browser.act'];
  }

  [Service.init](): void {
    const pack = loadBossKnowledgePack(this.config.packFile);
    this.registry.register(createBossAdapter(pack, this.page, this.act));
    this.ctx.logger.info(
      `BOSS 适配器已登记：知识包 ${String(Object.keys(pack.locators).length)} 条定位声明 · 动作 ${pack.capabilities.join(' / ')}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'platform.boss': BossPlatformService;
  }
}

export { createBossAdapter, type BossActionHand, type BossPageHand, resolveDetailUrl } from './adapter.js';
export { cleanText, parsePostedAt, parseSalary, splitRequirements } from './normalize.js';
export { JdStoreService, JD_MIGRATION_VERSION, LIST_LIMIT, type JobDraft, type JobUpsertResult } from './jd-store.js';
export { JdCaptureService, draftFromDetail, draftFromSummary, type JdCaptureConfig } from './jd-capture.js';
export {
  ConversationStoreService,
  CONVERSATION_MIGRATION_VERSION,
  type ConversationStoreConfig,
} from './conversation-store.js';
