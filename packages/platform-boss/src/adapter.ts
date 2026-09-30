/**
 * BOSS 平台适配器（spec 2.2-06：2.2 只交付**空壳**）。
 *
 * 空壳的意义在于把「契约能被一个平台包实现」这件事变成编译期事实：`meta` 全部来自站点知识包，
 * 五个方法一个都不碰 `webContents`（plan §3 规则 3），调用即结构化失败。
 * 抓取属 2.3、打招呼属 2.5、投递属 2.6 —— 届时只改这个文件的方法体，契约与登记表都不动。
 *
 * 这里**不出现任何选择器**：页面结构一律经 `@auto-cc/plugin-browser` 的定位声明按语义名取用，
 * 于是 2.2-08 的机检（`scripts/check-knowledge-pack.ts`）能把「选择器只许待在知识包里」钉住。
 */
import { AppError } from '@auto-cc/core';
import type { KnowledgePack, PlatformAdapter } from '@auto-cc/plugin-browser';
import type { PlatformMetaView } from '@auto-cc/shared';

/** 契约里五个动作的方法名（错误消息与 `details` 都按它归因）。 */
export type BossAdapterMethod = 'search' | 'detail' | 'chat' | 'sendResume' | 'readReplies';

/** 每个动作由哪个子计划补齐：空壳阶段唯一的「什么时候能用」依据，界面据此显示待办。 */
const DELIVERED_BY: Record<BossAdapterMethod, string> = {
  search: '2.3',
  detail: '2.3',
  chat: '2.5',
  sendResume: '2.6',
  readReplies: '2.5',
};

/**
 * 空壳的统一失败：声明「这个动作在 2.2 还没有实现」，并说清等哪个子计划。
 *
 * 用 `METHOD_NOT_FOUND`（`errors.ts` 现有码里唯一的「能力不存在」语义）而不是 `OUTBOUND_FAILED`：
 * 后者意味着「真的打过招呼但失败了」，会污染 2.7 的失败率统计，也会让账本看起来记过账。
 * 这里连 `entitlement.gate` 都没进（AGENTS.md §7.3 的必经口由 2.5 接上），所以什么都没发生过。
 * @param method 被调用的契约方法名，同时是归因键
 * @returns 永不完成的 Promise：以 `METHOD_NOT_FOUND` 拒绝，`details.deliveredBy` 给出补齐它的子计划号
 */
const notImplemented = (method: BossAdapterMethod): Promise<never> =>
  Promise.reject(
    new AppError(
      'METHOD_NOT_FOUND',
      `BOSS 适配器的 ${method} 尚未实现，由子计划 ${DELIVERED_BY[method]} 交付`,
      'platform.boss',
      { method, deliveredBy: DELIVERED_BY[method] },
    ),
  );

/**
 * 用一份**已校验**的知识包造出 BOSS 适配器。
 *
 * 为什么是工厂而不是类：适配器唯一的输入就是这份数据，2.6 换一版知识包就换一个实例，
 * 不需要子类；而 `platform.registry` 要的是「一个实现了契约的对象」，工厂返回的就是它。
 * @param pack 经 `parseKnowledgePack` 校验过的知识包（结构已由 zod 保证，这里不再判空）
 * @returns 契约完整、动作全部以结构化错误失败的平台适配器
 */
export function createBossAdapter(pack: KnowledgePack): PlatformAdapter {
  const meta: PlatformMetaView = {
    id: pack.platform,
    displayName: pack.displayName,
    startUrl: pack.startUrl,
    // 拷一份：登记表面向渲染层，不能让界面读数跟着知识包对象的后续修改漂移。
    capabilities: [...pack.capabilities],
  };
  return {
    meta,
    search: () => notImplemented('search'),
    detail: () => notImplemented('detail'),
    chat: () => notImplemented('chat'),
    sendResume: () => notImplemented('sendResume'),
    readReplies: () => notImplemented('readReplies'),
  };
}
