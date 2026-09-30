/**
 * 多帧求值通道（spec 2.2-08 / 2.2-09）。
 *
 * 真实招聘页面把聊天框、简历预览放在 iframe 里，所以「只查主 frame」的实现会在这些站点上
 * 永远定位不到。spike 实测（plan §9.4）：`mainFrame.framesInSubtree` 覆盖顶层 + 同源 + **跨源**
 * 子帧，且 `WebFrameMain.executeJavaScript()` 三者都可用——因此这里不需要任何第三方 CDP 客户端。
 *
 * 另一条刻意的设计：**单帧失败不掀翻整次扫描**。站点自造的浮层帧常常拒绝脚本，
 * 但那一帧读不到不代表别的帧读不到；把失败收集进结果里报告，才是可诊断的形态。
 *
 * 这里同时放着「拿视图」和「等装载落定」两个小工具：页面操作和风控观测都要它们，
 * 前者在 spec 2.1 就已经收过一轮，后者是同一份等待逻辑的第二个使用者（AGENTS.md §2.2）。
 */
import { AppError } from '@auto-cc/core';
import type { WebContents, WebFrameMain } from 'electron';
import type { ShellService } from '@auto-cc/shell';

/**
 * 壳层视图宿手的最小面（见 spec 2.1 的三方分工：视图由 shell 拥有，页面层只取用）。
 *
 * `browser.page` / `browser.locate` / `browser.act` 三条路径都要先拿到同一块视图，
 * 「拿不到就报 NO_KERNEL_SESSION」这段逻辑在此出现第三次，所以收进来（AGENTS.md §2.2）。
 */
export type KernelHost = Pick<ShellService, 'kernelContents' | 'getStatus'>;

/**
 * 取当前可用的内核视图句柄。
 * @param host shell 交出来的视图宿主
 * @param scope 报错归属的服务名——错误要指向真正的调用方，界面才知道是页面挂了还是定位挂了
 * @returns 未销毁的 `WebContents`
 * @throws 视图不存在或已销毁时 `NO_KERNEL_SESSION`（先 `sessions.open(platform)` 再说页面）
 */
export function requireKernelContents(host: KernelHost, scope: string): WebContents {
  const contents = host.kernelContents();
  if (!contents) {
    throw new AppError('NO_KERNEL_SESSION', '内核视图尚未挂载任何平台，先打开一个会话再操作页面', scope, {
      partition: host.getStatus().kernelViewPartition,
    });
  }
  return contents;
}

/** 一个帧的求值结果。 */
export type FrameEvaluation = {
  /** 该帧的地址；跨源帧也能从 `WebFrameMain.url` 读到 */
  frameUrl: string;
  /** 是否为顶层帧 */
  isMain: boolean;
  /** 脚本返回值；失败时为 null */
  value: unknown;
  /** 该帧的失败原因；成功时为 null */
  error: string | null;
};

/**
 * 列出本次求值要覆盖的帧：顶层在前，其余按子树顺序。
 * @param contents 内核视图句柄
 * @returns 顶层 + 全部子孙帧；顶层不可用时为空数组
 */
export function framesOf(contents: WebContents): WebFrameMain[] {
  const main = contents.mainFrame;
  if (!main) return [];
  return [main, ...main.framesInSubtree.filter((frame) => frame !== main)];
}

/**
 * 在整棵帧树里求值同一段脚本，逐帧收集结果。
 *
 * 顶层永远排在第一位：跨帧同名候选并存时，「主文档里的那一个」优先是排序的隐含前提。
 * @param contents 内核视图句柄
 * @param source 已生成的表达式源码
 * @param awaitPromise 是否等 Promise 兑现（等待类脚本要为 true）
 * @returns 每帧一条结果，失败帧带原因而不是抛出
 */
export async function evaluateInFrames(
  contents: WebContents,
  source: string,
  awaitPromise = false,
): Promise<FrameEvaluation[]> {
  const frames = framesOf(contents);
  const evaluations: FrameEvaluation[] = [];
  for (const frame of frames) {
    const isMain = frame === frames[0];
    try {
      const value = await frame.executeJavaScript(source, awaitPromise);
      evaluations.push({ frameUrl: frame.url, isMain, value, error: null });
    } catch (error) {
      // 帧在脚本送达前被拆掉是常态（站点自己换浮层），所以这里只留一句话，不堆栈。
      evaluations.push({
        frameUrl: frame.url,
        isMain,
        value: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return evaluations;
}

/**
 * 等一次导航装载落定。
 *
 * 监听器必须在三条出口（成功 / 失败 / 超时）里都摘掉：`once` 只保证触发过一次，
 * 而超时那条永远不会触发，留着就是每次导航泄漏一对监听（spec 2.1-11 数的正是这个）。
 *
 * 页面层与风控观测层都要「等到正文可读再读一次」，所以这段收在这里（AGENTS.md §2.2）。
 * @param contents 目标视图句柄
 * @param timeoutMs 等待上限（毫秒）
 * @returns 落定方式；`timeout` 不是错误，页面仍会继续装载，由读数反映真实进度
 */
export function settleLoad(contents: WebContents, timeoutMs: number): Promise<'loaded' | 'failed' | 'timeout'> {
  return new Promise((resolve) => {
    const finish = (outcome: 'loaded' | 'failed' | 'timeout'): void => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onLoaded);
      contents.removeListener('did-fail-load', onFailed);
      resolve(outcome);
    };
    const onLoaded = (): void => finish('loaded');
    const onFailed = (): void => finish('failed');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    contents.once('did-finish-load', onLoaded);
    contents.once('did-fail-load', onFailed);
  });
}

/**
 * 取出求值成功的帧；一个都没成功就是页面级的事故，而不是「读了但没命中」。
 *
 * `readingsFromFrames` 与 `browser.page.extract` 都要做这件判定（后者还要保留帧归属，
 * 所以不能直接复用拍平函数），抽成一处以免两份错误消息各说一套（AGENTS.md §2.2）。
 * @param evaluations `evaluateInFrames` 的结果
 * @param scope 报错归属的服务名
 * @returns 成功帧的求值结果
 * @throws 所有帧都失败时 `PAGE_SCRIPT_FAILED`
 */
export function usableEvaluations(evaluations: FrameEvaluation[], scope: string): FrameEvaluation[] {
  const usable = evaluations.filter((item) => item.error === null);
  if (evaluations.length > 0 && usable.length === 0) {
    const reasons = evaluations.map((item) => `${item.frameUrl || '（无地址）'}：${item.error}`).join(' / ');
    throw new AppError('PAGE_SCRIPT_FAILED', `所有帧都读取失败（${reasons}）`, scope, {
      frames: evaluations.length,
    });
  }
  return usable;
}

/**
 * 把逐帧读数拍平成一份页面侧读数集合。
 * @param evaluations `evaluateInFrames` 的结果
 * @param clamp 单帧读数的钳制函数（页面值一律是不可信输入）
 * @returns 拼接后的读数数组
 * @throws 所有帧都失败时 `PAGE_SCRIPT_FAILED`——一帧都没读成功，与「读了但没命中」是两回事
 */
export function readingsFromFrames<T>(evaluations: FrameEvaluation[], clamp: (raw: unknown) => T[]): T[] {
  return usableEvaluations(evaluations, 'browser.frame').flatMap((item) => clamp(item.value));
}

/**
 * 失败帧的摘要，用于界面与日志解释「哪一帧没读到」。
 * @param evaluations `evaluateInFrames` 的结果
 * @returns 每帧一条 `地址: ok|原因`
 */
export function frameSummary(evaluations: FrameEvaluation[]): string[] {
  return evaluations.map((item) => `${item.frameUrl || '（无地址）'}: ${item.error ?? 'ok'}`);
}

/**
 * 找到与读数对应的帧对象（下动作时要把帧内坐标折算成视图坐标）。
 * @param contents 内核视图句柄
 * @param frameUrl 读数里带回的帧地址
 * @returns 命中的帧；找不到时为 null（页面已经跳转，调用方按「需要重新定位」处理）
 */
export function findFrameByUrl(contents: WebContents, frameUrl: string): WebFrameMain | null {
  return framesOf(contents).find((frame) => frame.url === frameUrl) ?? null;
}

/**
 * 该帧在父帧里对应的那个子帧元素的位置序列（跨源时读不到 `frameElement`，只能按 src / name 认）。
 * @param frame 目标帧
 * @returns 从最外层到该帧的直接父帧这一段链；顶层帧为空数组
 */
export function ancestorChain(frame: WebFrameMain): WebFrameMain[] {
  const chain: WebFrameMain[] = [];
  let parent = frame.parent;
  while (parent && parent !== frame.top) {
    chain.unshift(parent);
    parent = parent.parent;
  }
  return chain;
}

/**
 * 在同一父帧的同地址兄弟帧里，目标帧排第几个。
 *
 * 知识包里的 `src` 相同但确实是两个 iframe 时（BOSS 的聊天区就长这样），
 * 只有序号能把它们分开。身份比较失败时退回归序——总比猜错要好。
 * @param parent 父帧
 * @param frame 目标帧
 * @returns 同地址帧里的下标
 */
export function ordinalInParent(parent: WebFrameMain, frame: WebFrameMain): number {
  const sameUrl = parent.frames.filter((child) => child.url === frame.url);
  const byIdentity = sameUrl.findIndex((child) => child === frame);
  return byIdentity >= 0 ? byIdentity : Math.max(0, sameUrl.length - 1);
}
