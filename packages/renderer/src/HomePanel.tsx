/**
 * Home 总览（spec 10.11-02～09；plan §14.3）：页首单一主行动、4 数字、2 状态行、趋势、接下来。
 *
 * 三条硬口径：
 * 1. 每个数字都只读一个既有口（`funnel.trend` / `funnel.query` / `usage.ledger.summary` /
 *    `journey.tracking.list` / `outbound.authorization.current` / `journey.unattended.view` /
 *    `sessions.status` / `entitlement.gate.outboundStatus`），界面不求和、不出比率（§14.3.2）。
 * 2. 三块各自读、各自降级：一块的服务挂了只坏一块（10.11-09），所以三只 loader 分开，
 *    不用一个 `Promise.all` 把整页绑死。
 * 3. 空态三态：真没有「—」+ 一句 + 入口；不可用「—」+ 原因原文 + 重试；读取中给与终态等高的骨架。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  FunnelTrendView,
  FunnelView,
  JobTrackingView,
  ResumeDocSummaryView,
  SessionPlatformView,
  UnattendedAuthorizationView,
  UnattendedRunView,
  UsageSummaryView,
} from '@auto-cc/shared';
import { Banner, DeskButton, DeskSegmented } from './ui/controls';
import { DeskPathGuide, DeskSection } from './ui/disclosure';
import { advanceViewTrail } from './viewTrail';
import { isLocalSessionUrl } from './platform-choice';
import { platformLabel } from './platform-label';

/** 数字那一格的稳定标识（harness 读 `data-cell`，不读译文）。 */
type NumberCell = 'quota' | 'progress' | 'sends' | 'todo';

/** 趋势区间的两档（7/30 天）；天数只影响 `funnel.trend` 的窗口，不影响口径本身。 */
type TrendWindow = 7 | 30;

/**
 * 一块的加载态：`loading` 时画等高骨架，`ready` 后才有数字。
 *
 * `failed` 带一个 `timedOut`：**「慢」与「挂」必须是两种结果**（2026-11-22 裁定，QA 的 F2）。
 * 服务被摘掉（桥调用永不返回）与读得慢（>8s）都会走到超时，但前者是「读不到」、
 * 后者是「这次没答上来、可能下一次就来」——压成同一句话会让人以为服务坏了。
 */
type BlockState<T> =
  { state: 'loading' } | { state: 'failed'; reason: string; timedOut: boolean } | { state: 'ready'; value: T };

/** 一块读数的等待上限（毫秒）；超时只说明「这一次没答上来」，不等于服务不存在。 */
const BLOCK_TIMEOUT_MS = 8_000;

/**
 * 从一份失败回执里取原因原文；没有结构化错误（或根本没回执）时给回落句。
 * @param reply 可能是 undefined / ok:true / ok:false 三态
 * @param fallback 取不到原因时的回落文案
 * @returns 可读的原因
 */
function failureReasonOf(reply: { ok: boolean; error?: { message: string } } | undefined, fallback: string): string {
  return reply !== undefined && reply.ok === false && reply.error !== undefined ? reply.error.message : fallback;
}

/**
 * 把一次失败落成「一块的失败态」，并把**超时**与**读不到**分开（2026-11-22 裁定 / QA 的 F2）。
 * @param error 读取函数抛出的东西；超时那一路带 `timedOut: true`（由 `useBlock` 的计时器标记）
 * @returns 原因原文 + 是不是超时（界面据此给不同的那句话与 `data-timeout`）
 */
export function blockFailureState(error: unknown): { reason: string; timedOut: boolean } {
  const timedOut = (error as { timedOut?: boolean } | null)?.timedOut === true;
  return { reason: error instanceof Error ? error.message : String(error), timedOut };
}

/** 柱高的固定档位：Tailwind 只生成源码里出现过的类名，所以按 8 档映射，不写内联 style。 */
const BAR_HEIGHT_CLASSES = ['h-1', 'h-2', 'h-3', 'h-4', 'h-6', 'h-8', 'h-10', 'h-14'] as const;

/**
 * 按当日外发数在区间峰值里的比例取一档柱高。
 * @param sends 当日成功外发数（服务读数，可能为 null）
 * @param maxSends 区间内峰值（同一次读数里取最大，仅用于选档）
 * @returns Tailwind 高度类
 */
const barHeightClass = (sends: number, maxSends: number): string => {
  const ratio = maxSends <= 0 ? 0 : Math.min(1, sends / maxSends);
  const index = Math.min(BAR_HEIGHT_CLASSES.length - 1, Math.round(ratio * (BAR_HEIGHT_CLASSES.length - 1)));
  return BAR_HEIGHT_CLASSES[index] ?? 'h-1';
};

const dayStartMs = (nowMs: number): number => {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
};

/**
 * 取一块读数的公共壳：一次读、失败留原因、手动重试。
 * @param load 读取函数（成功返回整块读数）
 * @returns 这一块的读数状态与 `reload`（供「重试」用）
 */
function useBlock<T>(load: () => Promise<T | { error: string }>, timeoutReason: string): [BlockState<T>, () => void] {
  const [state, setState] = useState<BlockState<T>>({ state: 'loading' });
  const run = useCallback(() => {
    setState({ state: 'loading' });
    // 服务被摘掉后桥调用可能**永不返回**（下游 PENDING），界面不能停在骨架上：超时落「读取超时 + 重试」。
    // 与「读不到」共用一次 `setState`，但 `timedOut` 标出来，文案与 `data-timeout` 因此能分开读。
    const timedOut = new Promise<never>((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error(timeoutReason), { timedOut: true })), BLOCK_TIMEOUT_MS);
    });
    void Promise.race([load(), timedOut])
      .then((value) => {
        if (value && typeof value === 'object' && 'error' in value) {
          setState({ state: 'failed', reason: value.error, timedOut: false });
        } else setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        // 服务挂掉/桥接抛错落到「读不到 + 原因」；超时落到「读取超时」（两者文案与 data-timeout 不同）。
        setState({ state: 'failed', ...blockFailureState(error) });
      });
  }, [load, timeoutReason]);
  useEffect(() => {
    run();
  }, [run]);
  return [state, run];
}

/**
 * 首页前置缺失的三类（spec 10.11-08：一条阻断条、同时最多 1 条）。
 */
export type HomeBlockerId = 'login' | 'resume' | 'model';

/**
 * 按「未登录 → 无简历 → 无模型」的优先级挑出**唯一**一条阻断。
 * @param input 三项前置各自是否已满足（模型那项由既有 `llm.settings.read` 的生成通道给）
 * @returns 最前面那条缺失；三样齐时 null——挑成两条就是判据说的「堆红字」
 */
export function pickHomeBlocker(input: {
  isLoggedIn: boolean;
  hasDocs: boolean;
  modelMissing: boolean;
}): HomeBlockerId | null {
  if (!input.isLoggedIn) return 'login';
  if (!input.hasDocs) return 'resume';
  if (input.modelMissing) return 'model';
  return null;
}

/**
 * 「无人值守」那一行的值：按授权单状态各给一句人话（不把暂停/失效折叠成「只建议」）。
 * @param t 翻译函数
 * @param next 「接下来」那一块的读数状态（未就绪时按「还没读到」）
 * @returns 供 `home.status.unattended` 插值的那一段
 */
export function unattendedValue(
  t: TFunction,
  next: { state: 'loading' } | { state: 'failed'; reason: string } | { state: 'ready'; value: HomeNext },
): string {
  if (next.state !== 'ready') return t('home.unattendedValue.unknown');
  const reading = unattendedStatusKey(next.value);
  return t(reading.key, reading.params ?? {});
}

/**
 * 授权单状态 → 该用哪条文案（纯函数，单测直接钉住「暂停不许回落成只建议」）。
 * @param value 「接下来」那块里与授权有关的两位
 * @returns 文案 key 与插值参数（暂停没写原因时直接换成 `pausedNoReason` 那条 key，不把 key 塞进参数）
 */
export function unattendedStatusKey(value: {
  authorization: HomeNext['authorization'] | { status: string; targets: string[]; pauseReason?: string | null };
}): { key: string; params?: Record<string, string | number> } {
  const authorization = value.authorization;
  if (authorization === null) return { key: 'home.unattendedValue.suggest' };
  if (authorization.status === 'active') {
    return { key: 'home.unattendedValue.active', params: { count: authorization.targets.length } };
  }
  if (authorization.status === 'paused') {
    // 没写原因时换**另一条 key**，绝不把 key 当插值参数传（那会把 `home.…` 原样画到界面上，QA 报的裸 key）。
    if (authorization.pauseReason === null || authorization.pauseReason === undefined) {
      return { key: 'home.unattendedValue.pausedNoReason' };
    }
    return { key: 'home.unattendedValue.paused', params: { reason: authorization.pauseReason } };
  }
  return { key: `home.unattendedValue.${authorization.status}` };
}

/**
 * 4 数字所需的读数。
 *
 * 口径澄清（2026-11-22，QA 的 F1）：这一块的**粒度是「块」不是「格」**——五个只读口在一个
 * `Promise.all` 里取齐，任一失败就把整块落成「不可用 + 原因 + 重试」。原来那句「缺哪个就只让哪一格降级」
 * 与实现不符，删掉：真按格降级要么四份超时各管各的、要么容忍半格「—」混着 0 显示，两种都会让
 * 「这一格是真没有还是没读到」读不出来。
 */
interface HomeNumbers {
  quota: { used: number; limit: number | null; remaining: number | null } | null;
  tracked: JobTrackingView[] | null;
  deliverCount: number | null;
  lastSend: UsageSummaryView['recent'][number] | null;
  authorizedJobs: number | null;
  runCompleted: number | null;
}

/** 趋势块读数。 */
interface HomeTrend {
  trend: FunnelTrendView;
  funnel: FunnelView;
  /** 最近 5 笔：账本读不到时为 null——**不许**当成「0 笔」画（裁定 D：同一块里漏斗给「—」、这里写 0 是两套口径）。 */
  recent: UsageSummaryView['recent'] | null;
  /** 账本读不到时的原因原文（recent 为 null 时才用）。 */
  recentError: string | null;
}

/** 接下来那一块所需的读数。 */
interface HomeNext {
  platforms: SessionPlatformView[];
  docs: ResumeDocSummaryView[];
  authorization: UnattendedAuthorizationView | null;
  run: UnattendedRunView | null;
}

/**
 * Home 页本体。
 * @returns 五块：页首 / 4 数字 / 2 状态行 / 趋势 / 接下来
 */
export function HomePanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [windowDays, setWindowDays] = useState<TrendWindow>(7);
  // 读数用的「此刻」只在**读的那一刻**取：写进渲染期会让 loader 身份每次渲染都变，
  // effect 跟着无限重跑（本轮实测直接打满渲染进程、CDP 都超时）。刷新时再推进一次。
  const nowRef = useRef(Date.now());

  /**
   * 数字块：额度、追踪、投递成功数、最近一笔、授权数与执行器完成数，**一块读齐**。
   * 五个口任一失败 → 整块不可用（口径见 `HomeNumbers` 的注释；不是逐格降级）。
   */
  const loadNumbers = useCallback(async (): Promise<HomeNumbers> => {
    const nowMs = nowRef.current;
    const todayStart = dayStartMs(nowMs);
    const [funnelReply, trackingReply, summaryReply, authReply, runReply] = await Promise.all([
      bridge?.funnel.query({ fromMs: todayStart, toMs: nowMs }),
      bridge?.journey['tracking.list'](),
      bridge?.usage['ledger.summary'](5),
      bridge?.outbound['authorization.current'](),
      bridge?.journey['unattended.view'](),
    ]);
    // 读数口与调用成对列出来：失败时把**是哪一条读数**一起报出去（裁定 E）——
    // 只报「服务未挂载：outbound」看不出根因在闸门/账本，加上读数口才能顺着依赖链找。
    const calls = [
      ['funnel.query', funnelReply],
      ['journey.tracking.list', trackingReply],
      ['usage.ledger.summary', summaryReply],
      ['outbound.authorization.current', authReply],
      ['journey.unattended.view', runReply],
    ] as const;
    const firstFailure = calls.find(([, reply]) => !reply?.ok);
    if (firstFailure) {
      // 抛错交给 useBlock 落成 failed：读数块只坏这一块，另外两块照常（spec 10.11-09 的同一机制）。
      const [call, reply] = firstFailure;
      throw new Error(
        t('home.unavailableAtCall', {
          reason: failureReasonOf(reply, t('home.unavailable.noBridge')),
          call,
        }),
      );
    }
    const quotaAction = funnelReply?.ok
      ? funnelReply.value.quota.actions.find((row) => row.action === 'deliver')
      : undefined;
    return {
      quota: funnelReply?.ok
        ? {
            used: quotaAction?.usedToday ?? 0,
            limit: quotaAction?.dailyLimit ?? null,
            remaining: quotaAction?.remaining ?? null,
          }
        : null,
      tracked: trackingReply?.ok ? trackingReply.value : null,
      deliverCount: funnelReply?.ok
        ? (funnelReply.value.levels.find((row) => row.level === 'deliver')?.count ?? null)
        : null,
      lastSend: summaryReply?.ok ? (summaryReply.value.recent[0] ?? null) : null,
      authorizedJobs: authReply?.ok ? (authReply.value?.targets.length ?? 0) : null,
      runCompleted: runReply?.ok ? runReply.value.completed.length : null,
    };
  }, [bridge]);

  /** 趋势块：14 天柱 + 五级漏斗（区间合计）+ 最近 5 笔。 */
  const loadTrend = useCallback(async (): Promise<HomeTrend | { error: string }> => {
    const nowMs = nowRef.current;
    // 柱图固定 14 天（10.11-05：14 天柱）；7/30 两档切的是漏斗与口径区间。
    // 14 天柱：起点取 13 天前，闭区间正好 14 个自然日（原先按 14 天算会多出一根 = 15 点）。
    const barRange = { fromMs: nowMs - 13 * 86_400_000, toMs: nowMs };
    const range = { fromMs: nowMs - windowDays * 86_400_000, toMs: nowMs };
    const [trendReply, funnelReply, summaryReply] = await Promise.all([
      bridge?.funnel.trend(barRange),
      bridge?.funnel.query(range),
      bridge?.usage['ledger.summary'](5),
    ]);
    if (!trendReply?.ok) return { error: trendReply?.error.message ?? t('home.unavailable.noBridge') };
    if (!funnelReply) return { error: t('home.unavailable.noBridge') };
    if (!funnelReply.ok) return { error: funnelReply.error.message };
    return {
      trend: trendReply.value,
      funnel: funnelReply.value,
      recent: summaryReply?.ok ? summaryReply.value.recent : null,
      recentError: summaryReply?.ok ? null : (summaryReply?.error.message ?? t('home.unavailable.noBridge')),
    };
  }, [bridge, t, windowDays]);

  /** 接下来那块：登录态 / 简历 / 授权单 / 执行器（阻断优先排序用它）。 */
  const loadNext = useCallback(async (): Promise<HomeNext> => {
    const [sessionsReply, docsReply, authReply, runReply] = await Promise.all([
      bridge?.sessions.status(),
      bridge?.resume['doc.list'](),
      bridge?.outbound['authorization.current'](),
      bridge?.journey['unattended.view'](),
    ]);
    // 同一条口径（裁定 E）：报出是哪一条读数失败，而不是只报下游服务名。
    const calls = [
      ['sessions.status', sessionsReply],
      ['resume.doc.list', docsReply],
      ['outbound.authorization.current', authReply],
      ['journey.unattended.view', runReply],
    ] as const;
    const failure = calls.find(([, reply]) => !reply?.ok);
    if (failure) {
      const [call, reply] = failure;
      throw new Error(
        t('home.unavailableAtCall', {
          reason: failureReasonOf(reply, t('home.unavailable.noBridge')),
          call,
        }),
      );
    }
    return {
      platforms: sessionsReply?.ok ? sessionsReply.value.platforms : [],
      docs: docsReply?.ok ? docsReply.value : [],
      authorization: authReply?.ok ? authReply.value : null,
      run: runReply?.ok ? runReply.value : null,
    };
  }, [bridge]);

  /** 模型配置（阻断条用）：读既有 `llm.settings.read` 的 `missing`，不新开读取通道、不自己探 key。 */
  const loadModel = useCallback(async (): Promise<{ missing: string[] }> => {
    const reply = await bridge?.llm['settings.read']();
    if (!reply?.ok) throw new Error(reply?.error.message ?? t('home.unavailable.noBridge'));
    // 只看生成通道（`chat`）：向量那条只服务检索，缺它不影响定制与打招呼。
    const chatLeg = reply.value.legs.find((row) => row.leg === 'chat');
    return { missing: chatLeg?.missing ?? ['baseUrl', 'model', 'apiKey'] };
  }, [bridge, t]);

  /**
   * 一块失败时的那句话：**超时与读不到分开**（2026-11-22 裁定 / QA 的 F2）。
   * @param state 失败的那一块（`timedOut` 由 `useBlock` 标）
   * @returns 超时说「N 秒没有回音」，读不到说原因原文
   */
  const failureText = (state: { reason: string; timedOut: boolean }): string =>
    state.timedOut
      ? t('home.timedOut', { seconds: BLOCK_TIMEOUT_MS / 1000 })
      : t('home.unavailable', { reason: state.reason });

  const timeoutReason = t('home.unavailable.timeout');
  const [numbers, reloadNumbers] = useBlock(loadNumbers, timeoutReason);
  const [trend, reloadTrend] = useBlock(loadTrend, timeoutReason);
  const [next, reloadNext] = useBlock(loadNext, timeoutReason);
  // 模型这一格失败（例如 llm-settings 没挂载）时只表示「不知道」，不能让首页长出一条假的阻断条。
  const [model, reloadModel] = useBlock(loadModel, timeoutReason);

  /** 「接下来」的六条（按阻断优先），并按当前状态算出哪几条该出现。 */
  const steps = useMemo(() => {
    const value = next.state === 'ready' ? next.value : undefined;
    const real = (value?.platforms ?? []).filter((row) => !isLocalSessionUrl(row.startUrl));
    const loggedIn = real.some((row) => row.auth === 'active');
    const platformName = real[0] ? platformLabel(t, real[0].id) : t('home.next.platformFallback');
    const hasDocs = (value?.docs.length ?? 0) > 0;
    const authActive = value?.authorization?.status === 'active';
    const runStatus = value?.run?.status ?? 'idle';
    const all = [
      !loggedIn ? { id: 'login', text: t('home.next.login', { platform: platformName }), to: 'trust' as const } : null,
      !hasDocs ? { id: 'resume', text: t('home.next.resume'), to: 'resume' as const } : null,
      runStatus === 'paused' || runStatus === 'failed'
        ? { id: 'reason', text: t('home.next.reason'), to: 'jobs' as const }
        : null,
      authActive && runStatus !== 'running'
        ? { id: 'resumeRun', text: t('home.next.resumeRun'), to: 'jobs' as const }
        : null,
      { id: 'jobs', text: t('home.next.jobs'), to: 'jobs' as const },
      { id: 'tracking', text: t('home.next.tracking'), to: 'trust' as const },
    ];
    return all.filter((row): row is { id: string; text: string; to: 'jobs' | 'resume' | 'trust' } => row !== null);
  }, [next, t]);

  const primary = steps[0];
  const numbersValue = numbers.state === 'ready' ? numbers.value : undefined;
  const tracked = numbersValue?.tracked ?? [];
  const delivered = tracked.filter((row) => row.state === 'delivered').length;
  const interviewed = tracked.filter((row) => row.state === 'interviewed').length;
  const wholeEmpty =
    numbers.state === 'ready' &&
    next.state === 'ready' &&
    next.value.docs.length === 0 &&
    tracked.length === 0 &&
    (numbersValue?.deliverCount ?? 0) === 0 &&
    numbersValue?.lastSend === null;
  const trendValue = trend.state === 'ready' ? trend.value : undefined;
  const maxSends = Math.max(1, ...(trendValue?.trend.days.map((day) => day.sends ?? 0) ?? [0]));

  /**
   * 前置缺失的那一条阻断条（spec 10.11-08）：未登录 → 无简历 → 无模型，只报最前面一条。
   * 数据全部来自本页已有的三块读数与模型格，不另开读取；读数没到或那格失败时宁可不报。
   */
  const blocker = useMemo((): { id: HomeBlockerId; text: string; to: 'trust' | 'resume' | 'models' } | null => {
    const value = next.state === 'ready' ? next.value : undefined;
    if (!value) return null;
    const real = value.platforms.filter((row) => !isLocalSessionUrl(row.startUrl));
    const id = pickHomeBlocker({
      isLoggedIn: real.some((row) => row.auth === 'active'),
      hasDocs: value.docs.length > 0,
      modelMissing: model.state === 'ready' && model.value.missing.length > 0,
    });
    if (id === null) return null;
    const platformName = real[0] ? platformLabel(t, real[0].id) : t('home.next.platformFallback');
    if (id === 'login') return { id, text: t('home.blocker.login', { platform: platformName }), to: 'trust' };
    if (id === 'resume') return { id, text: t('home.blocker.resume'), to: 'resume' };
    return { id, text: t('home.blocker.model'), to: 'models' };
  }, [next, model, t]);

  /** 趋势块「真没有」：区间零外发、漏斗各级都是 0（不是读不到）、最近 5 笔为空。 */
  const trendNone =
    trendValue !== undefined &&
    trendValue.trend.days.every((day) => (day.sends ?? 0) === 0) &&
    trendValue.funnel.levels.every((level) => level.count === 0) &&
    // 账本读不到（null）不算「真没有」：那是读不到，不是没有。
    trendValue.recent !== null &&
    trendValue.recent.length === 0;

  return (
    <div className="flex flex-col gap-4" data-testid="home-panel">
      <DeskPathGuide
        testid="home-path-guide"
        here={t('home.guide.here')}
        next={t('home.guide.next')}
        exit={t('home.guide.exit')}
        focusSelector='[data-action="assistant-capsule"]'
        focusLabel={t('guide.focus')}
      />
      {/* ① 页首：招呼 + 一句区间读数 + 刷新 + 问助手 + 单一动态主行动 */}
      <section className="rounded-xl border border-line bg-ink-900/60 p-4" data-testid="home-head">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-50">{t('home.heading')}</h2>
          <span className="text-[11px] text-slate-400" data-testid="home-range-line">
            {t('home.rangeLine', { days: windowDays })}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <DeskButton
              action="home-refresh"
              variant="line"
              compact
              onClick={() => {
                reloadNumbers();
                reloadTrend();
                reloadNext();
                reloadModel();
              }}
            >
              {t('home.refresh')}
            </DeskButton>
            <DeskButton
              action="home-ask-assistant"
              variant="line"
              compact
              onClick={() => document.querySelector<HTMLButtonElement>('[data-action="assistant-capsule"]')?.click()}
            >
              {t('home.askAssistant')}
            </DeskButton>
          </span>
        </div>
        {primary ? (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="home-primary-action">
            <DeskButton
              action="home-primary"
              variant="solid"
              compact
              markers={{ step: primary.id }}
              onClick={() =>
                advanceViewTrail({
                  sourceView: 'chat',
                  sourceTitle: t('nav.chat'),
                  targetView: primary.to,
                  targetTitle: t(`desk.${primary.to}.title`),
                  targetDetail: primary.text,
                })
              }
            >
              {primary.text}
            </DeskButton>
          </div>
        ) : null}
      </section>

      {/* 前置缺失：只有一条阻断条（琥珀描边 + 一行原因 + 直达键），同时最多 1 条（spec 10.11-08）。 */}
      {blocker ? (
        // 语气洗底只许由 `src/ui/**` 的原件持有（spec 6.2-20），所以这里交语气档名、不自己拼 class。
        <Banner
          tone="amber"
          size="compact"
          markers={{ testid: 'home-blocker', blocker: blocker.id }}
          actions={
            <DeskButton
              action="home-blocker-go"
              variant="line"
              compact
              onClick={() =>
                advanceViewTrail({
                  sourceView: 'chat',
                  sourceTitle: t('nav.chat'),
                  targetView: blocker.to,
                  targetTitle: t(`desk.${blocker.to}.title`),
                  targetDetail: blocker.text,
                })
              }
            >
              {t('home.blocker.go')}
            </DeskButton>
          }
        >
          {blocker.text}
        </Banner>
      ) : null}

      {/* 整页空态：零数据首启不画 4 个 0 与空坐标轴（spec 10.11-08），只给「三步开张」卡。 */}
      {wholeEmpty ? (
        <section className="rounded-xl border border-line bg-ink-900/60 p-4" data-testid="home-empty-card">
          <h3 className="text-sm font-semibold text-slate-100">{t('home.empty.title')}</h3>
          <p className="mt-1 text-[11px] text-slate-400">{t('home.empty.hint')}</p>
          <ol className="mt-3 flex flex-col gap-2">
            {(
              [
                ['resume', t('home.empty.step1'), t('home.next.resume')],
                ['jobs', t('home.empty.step2'), t('home.next.jobs')],
                ['authorize', t('home.empty.step3'), t('home.next.resumeRun')],
              ] as [string, string, string][]
            ).map(([id, text, detail], index) => (
              <li key={id} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300" data-step={id}>
                <span className="grid size-5 shrink-0 place-items-center rounded-full border border-line-strong font-mono text-[10px] text-slate-400">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">{text}</span>
                <DeskButton
                  action={`home-empty-${id}`}
                  variant="line"
                  compact
                  onClick={() =>
                    advanceViewTrail({
                      sourceView: 'chat',
                      sourceTitle: t('nav.chat'),
                      targetView: id === 'resume' ? 'resume' : 'jobs',
                      targetTitle: t(`desk.${id === 'resume' ? 'resume' : 'jobs'}.title`),
                      targetDetail: detail,
                    })
                  }
                >
                  {t('home.empty.go')}
                </DeskButton>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ② 4 数字：每格带口径；三态按 spec 10.11-08——读取中给与终态同高的骨架、不可用给「—」+ 原因原文 + 重试。 */}
      <section
        className={`grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4 ${wholeEmpty ? 'hidden' : ''}`}
        data-testid="home-numbers"
      >
        {numbers.state === 'loading' ? (
          (['quota', 'progress', 'sends', 'todo'] as NumberCell[]).map((cell) => (
            // 骨架的行结构与就绪态逐行对应（同一套字号/行高类），高度因此由同一份排版决定，不靠手填像素。
            <div
              key={cell}
              data-testid="home-number-skeleton"
              data-cell={cell}
              className="rounded-lg border border-line bg-ink-900/60 px-3 py-2"
              aria-busy="true"
            >
              <p className="text-[11px] text-slate-400">
                <span className="inline-block h-3 w-16 animate-pulse rounded bg-ink-800" />
              </p>
              <p className="mt-0.5 font-mono text-lg text-slate-50">
                <span className="inline-block h-5 w-20 animate-pulse rounded bg-ink-800" />
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                <span className="inline-block h-3 w-24 animate-pulse rounded bg-ink-800" />
              </p>
            </div>
          ))
        ) : numbers.state === 'failed' ? (
          <div
            data-testid="home-numbers-unavailable"
            className="col-span-full flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-[11px] text-amber"
          >
            <span data-timeout={String(numbers.timedOut)}>— {failureText(numbers)}</span>
            <DeskButton action="home-numbers-retry" variant="line" compact onClick={reloadNumbers}>
              {t('home.retry')}
            </DeskButton>
          </div>
        ) : (
          (
            [
              [
                'quota',
                t('home.cell.quota'),
                numbersValue?.quota ? `${numbersValue.quota.used}/${numbersValue.quota.limit ?? '—'}` : '—',
                t('home.caption.quota', {
                  used: numbersValue?.quota?.used ?? '—',
                  limit: numbersValue?.quota?.limit ?? '—',
                  remaining: numbersValue?.quota?.remaining ?? '—',
                }),
              ],
              [
                'progress',
                t('home.cell.progress'),
                String(tracked.length),
                t('home.caption.progress', { delivered, interview: interviewed }),
              ],
              [
                'sends',
                t('home.cell.sends'),
                numbersValue?.deliverCount === null || numbersValue?.deliverCount === undefined
                  ? '—'
                  : String(numbersValue.deliverCount),
                t('home.caption.sends', {
                  days: windowDays,
                  last: numbersValue?.lastSend ? new Date(numbersValue.lastSend.ts).toLocaleTimeString() : '—',
                  target: numbersValue?.lastSend?.targetId ?? '—',
                }),
              ],
              [
                'todo',
                t('home.cell.todo'),
                String(numbersValue?.authorizedJobs ?? '—'),
                t('home.caption.todo', {
                  count: numbersValue?.authorizedJobs ?? 0,
                  completed: numbersValue?.runCompleted ?? '—',
                }),
              ],
            ] as [NumberCell, string, string, string][]
          ).map(([cell, label, value, caption]) => (
            <div
              key={cell}
              data-testid="home-number"
              data-cell={cell}
              className="rounded-lg border border-line bg-ink-900/60 px-3 py-2"
            >
              <p className="text-[11px] text-slate-400">{label}</p>
              <p className="mt-0.5 font-mono text-lg text-slate-50" data-testid="home-number-value">
                {value}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500" data-testid="home-number-caption">
                {caption}
              </p>
            </div>
          ))
        )}
      </section>

      {/* ③ 2 状态行 */}
      <section
        className="flex flex-col gap-1 rounded-lg border border-line bg-ink-900/40 px-3 py-2 text-[11px]"
        data-testid="home-status"
      >
        <p data-testid="home-status-unattended">
          {/* 暂停/失效不再回落成「只建议」（2026-11-22 裁定，QA 的 04）：那等于把风控暂停藏起来。
              每种状态给一句自己的人话，暂停必须带原因原文——没写原因也不许省掉这一格。 */}
          {t('home.status.unattended', { value: unattendedValue(t, next) })}
        </p>
        <p data-testid="home-status-run">
          {t('home.status.run', {
            // 状态名走语言包（`stopping` 也必须有人话，不能把英文枚举甩到界面上）
            status: t(`home.runState.${next.state === 'ready' ? (next.value.run?.status ?? 'idle') : 'unknown'}`),
            current: next.state === 'ready' ? (next.value.run?.currentTarget ?? '—') : '—',
            completed: next.state === 'ready' ? String(next.value.run?.completed.length ?? 0) : '—',
            pending: next.state === 'ready' ? String(next.value.run?.pending.length ?? 0) : '—',
          })}
        </p>
      </section>

      {/* ④ 趋势：14 天柱（逐日 sends）+ 五级漏斗；最近 5 笔折叠在块底 */}
      <DeskSection
        id="home.trend"
        defaultOpen
        markers={{ testid: 'home-trend' }}
        title={t('home.trend.title')}
        className={wholeEmpty ? 'hidden' : ''}
      >
        <div className="mb-2 flex items-center gap-2">
          <DeskSegmented
            action="home-window"
            value={String(windowDays) as '7' | '30'}
            onSelect={(value) => setWindowDays(Number(value) as TrendWindow)}
            options={[
              { value: '7', label: t('home.window.7') },
              { value: '30', label: t('home.window.30') },
            ]}
          />
          {trend.state === 'failed' ? (
            <DeskButton action="home-trend-retry" variant="line" compact onClick={reloadTrend}>
              {t('home.retry')}
            </DeskButton>
          ) : null}
        </div>
        {trend.state === 'loading' ? (
          <div className="h-40 animate-pulse rounded bg-ink-800" data-testid="home-trend-skeleton" />
        ) : trend.state === 'failed' ? (
          <p
            className="text-[11px] text-amber"
            data-testid="home-trend-unavailable"
            data-timeout={String(trend.timedOut)}
          >
            {failureText(trend)}
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="home-trend-body">
            <ul className="flex min-h-24 items-end gap-1" data-testid="home-trend-days">
              {trendValue?.trend.days.map((day) => (
                <li
                  key={day.day}
                  data-day={day.day}
                  data-sends={String(day.sends ?? '')}
                  className="flex flex-1 flex-col items-center gap-1"
                >
                  <span
                    className={`w-full rounded-t bg-celadon/70 ${barHeightClass(day.sends ?? 0, maxSends)}`}
                    data-bar-height={String(Math.round(((day.sends ?? 0) / maxSends) * 56))}
                  />
                  <span className="text-[9px] text-slate-500">{day.day.slice(5)}</span>
                </li>
              ))}
            </ul>
            {trendNone ? (
              <p className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400" data-testid="home-trend-none">
                {t('home.trendNone')}
                <DeskButton
                  action="home-trend-none-go"
                  variant="line"
                  compact
                  onClick={() =>
                    advanceViewTrail({
                      sourceView: 'chat',
                      sourceTitle: t('nav.chat'),
                      targetView: 'jobs',
                      targetTitle: t('desk.jobs.title'),
                      targetDetail: t('home.trendNone'),
                    })
                  }
                >
                  {t('home.trendNoneGo')}
                </DeskButton>
              </p>
            ) : null}
            <ul className="flex flex-wrap gap-3 text-[11px] text-slate-400" data-testid="home-funnel">
              {trendValue?.funnel.levels.map((level) => (
                <li key={level.level} data-level={level.level}>
                  {t(`metrics.level.${level.level}`)} {level.count === null ? '—' : level.count}
                </li>
              ))}
            </ul>
            {trendValue?.recent === null ? (
              <p className="text-[11px] text-amber" data-testid="home-recent-unavailable">
                — {t('home.unavailable', { reason: trendValue.recentError ?? '' })}
              </p>
            ) : null}
            {trendValue?.recent !== null ? (
              <details className="text-[11px] text-slate-400" data-testid="home-recent">
                <summary>{t('home.recent.title', { count: trendValue?.recent?.length ?? 0 })}</summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {(trendValue?.recent ?? []).map((row) => (
                    <li key={row.id}>
                      {new Date(row.ts).toLocaleTimeString()} · {row.action} · {row.targetId}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        )}
      </DeskSection>

      {/* ⑤ 接下来：≤4 条，其余折叠 */}
      <DeskSection id="home.next" defaultOpen markers={{ testid: 'home-next' }} title={t('home.next.title')}>
        <ul className="flex flex-col gap-1" data-testid="home-next-list">
          {steps.slice(0, 4).map((step) => (
            <li key={step.id} data-step={step.id}>
              <DeskButton
                action={`home-next-${step.id}`}
                variant="ghost"
                compact
                onClick={() =>
                  advanceViewTrail({
                    sourceView: 'chat',
                    sourceTitle: t('nav.chat'),
                    targetView: step.to,
                    targetTitle: t(`desk.${step.to}.title`),
                    targetDetail: step.text,
                  })
                }
              >
                {step.text}
              </DeskButton>
            </li>
          ))}
        </ul>
        {steps.length > 4 ? (
          <details className="mt-1 text-[11px] text-slate-400" data-testid="home-next-more">
            <summary>{t('home.next.more', { count: steps.length - 4 })}</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {steps.slice(4).map((step) => (
                <li key={step.id}>{step.text}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {next.state === 'failed' ? (
          <p
            className="mt-1 text-[11px] text-amber"
            data-testid="home-next-unavailable"
            data-timeout={String(next.timedOut)}
          >
            {failureText(next)}
            <DeskButton action="home-next-retry" variant="line" compact onClick={reloadNext}>
              {t('home.retry')}
            </DeskButton>
          </p>
        ) : null}
      </DeskSection>
    </div>
  );
}
