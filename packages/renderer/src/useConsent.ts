/**
 * 首次启用自动化前的风险确认（spec 2.7-06 的界面拦截点 ①）。
 *
 * 这里做的事只有一件：**把一个动作推迟到用户点过「我承担」之后**。判定依据始终是
 * `sessions.consentStatus(platform)` 的读数，界面自己不留「已经弹过一次」的布尔量——
 * plan §14.3 第 6 条把「出现一次」的判据钉在库里的 scope，而不是前端的记忆，
 * 所以 reload、重启、换面板之后都不该再弹，也不该因为组件重建就以为已经签过。
 *
 * 读不到签字状态时按「没签」处理（fail-closed）：宁可让用户多点一次确认，
 * 也不能在没证据的情况下替用户点头。
 */
import { useCallback, useState } from 'react';
import type { AppErrorPayload, SessionConsentView } from '@auto-cc/shared';

/** 一张等用户表态的确认：哪个平台、挂起的动作、以及那条读数的原文（读不到原文时只有平台名）。 */
type ConsentRequest = { platform: string; view: SessionConsentView | null; platforms: string[]; action: () => void };

/** `useConsent` 交出去的面。 */
export interface ConsentFacade {
  /** 签字读数（只在动作之前读过的那些平台会有值）。 */
  readonly views: Record<string, SessionConsentView>;
  /** 此刻等表态的那张卡片；null 表示界面不需要拦任何东西。 */
  readonly request: ConsentRequest | null;
  /** 确认 / 放弃两个按钮的忙碌态。 */
  readonly busy: boolean;
  /** 最近一次读签字状态或写入签字失败的结构化错误。 */
  readonly error: AppErrorPayload | undefined;
  /**
   * 只读、不改动作：把这几个平台的签字读数刷进 `views`，供面板上那行状态读数显示。
   * 面板每次重读快照都带上它，「重启后再看仍是已确认」这条判据（plan §14.3 第 6 条末段）才有界面证据。
   * @param platforms 要刷的平台标识
   */
  refresh: (platforms: string[]) => Promise<void>;
  /**
   * 已签字就立刻跑 `action`，未签字就把 `action` 挂起并亮出确认卡片。
   * @param platforms 这个动作会动到的平台（多个时逐个确认，全签完才放行）
   * @param action 原动作；本钩子不关心它做什么，只决定发不放
   */
  ensure: (platforms: string[], action: () => void) => Promise<void>;
  /** 用户在卡片上点「我承担」：写一次签字，然后把挂起的动作发出去。 */
  grant: () => Promise<void>;
  /** 用户放弃：挂起的动作被丢弃，一个页面都不会碰。 */
  deny: () => void;
}

/**
 * 订阅一个平台的签字读数并找出「还没签」的那一个。
 * @param platforms 待确认的平台标识
 * @returns 读数表 + 第一个未签（或读不到）的平台；都签过时为 null
 */
async function readUnsigned(
  platforms: string[],
): Promise<{ views: Record<string, SessionConsentView>; unsigned: string | null; error?: AppErrorPayload }> {
  const bridge = window.autoCC;
  const replies = await Promise.all(
    platforms.map(async (platform) => (bridge ? bridge.sessions.consentStatus(platform) : undefined)),
  );
  const views: Record<string, SessionConsentView> = {};
  let unsigned: string | null = null;
  let error: AppErrorPayload | undefined;
  replies.forEach((reply, index) => {
    const platform = platforms[index] as string;
    if (reply?.ok) {
      views[platform] = reply.value;
      // 读得到但没签：这是要弹卡片的那种；读不到：也按没签处理，但记下错误码供界面说话。
      if (!reply.value.granted && !unsigned) unsigned = platform;
      return;
    }
    if (!unsigned) {
      unsigned = platform;
    }
    // 只有真的拿到结构化错误时才记下来：桥接不存在（纯浏览器调试态）时 `reply` 是 undefined，
    // 那不是「主进程拒了」，编一个错误码进界面就是说谎。
    if (!error) error = reply?.error;
  });
  return { views, unsigned, error };
}

/**
 * 风险确认钩子：把「先签字、再动手」这件事收在一个地方，三个面板共用一份判定（AGENTS.md §2.2）。
 * @returns 见 `ConsentFacade`
 */
export function useConsent(): ConsentFacade {
  const [views, setViews] = useState<Record<string, SessionConsentView>>({});
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorPayload>();

  const refresh = useCallback(async (platforms: string[]) => {
    if (platforms.length === 0) return;
    const reading = await readUnsigned(platforms);
    setViews((current) => ({ ...current, ...reading.views }));
  }, []);

  const ensure = useCallback(async (platforms: string[], action: () => void) => {
    // 空列表 = 界面还读不出这个动作属于哪个平台（例如还没拿到抓取配置）。
    // 这时不在这里瞎猜平台名：放行到原动作，让释放路径上那道硬拦（拦截点 ②）给出结构化错误。
    if (platforms.length === 0) {
      action();
      return;
    }
    const reading = await readUnsigned(platforms);
    setViews((current) => ({ ...current, ...reading.views }));
    setError(reading.error);
    const unsigned = reading.unsigned;
    if (!unsigned) {
      action();
      return;
    }
    // 卡片只摆读到的东西：`scope` 那行来自 `consentStatus` 的原文，读不到就不编一个平台名出来（§2.6）。
    setRequest({ platform: unsigned, view: reading.views[unsigned] ?? null, platforms, action });
  }, []);

  const grant = useCallback(async () => {
    if (!request) return;
    setBusy(true);
    const reply = await window.autoCC?.sessions.grantConsent(request.platform);
    setBusy(false);
    if (!reply?.ok) {
      setError(reply?.error);
      return;
    }
    const granted = reply.value;
    setViews((current) => ({ ...current, [granted.platform]: granted }));
    setError(undefined);
    // 一次动作可能牵多个平台（工作流的计划里每个节点各带一个）：还有没签的就接着问，
    // 全签完了才把挂起的那一次发出去。
    const pending = await readUnsigned(request.platforms);
    setViews((current) => ({ ...current, ...pending.views }));
    if (pending.unsigned) {
      setRequest({ ...request, platform: pending.unsigned, view: pending.views[pending.unsigned] ?? null });
      return;
    }
    setRequest(null);
    request.action();
  }, [request]);

  const deny = useCallback(() => {
    setRequest(null);
  }, []);

  return { views, request, busy, error, refresh, ensure, grant, deny };
}
