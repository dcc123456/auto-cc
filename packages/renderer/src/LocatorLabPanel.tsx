import { Crosshair, MousePointerClick, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ActResultView,
  AppErrorPayload,
  ElementFingerprint,
  LocateResultView,
  LocateSpec,
  LocateStatusView,
  LocatedView,
  LocatorRelocatedEvent,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';
import { formatClock } from './format';
import { Banner, DeskButton } from './ui/controls';

/** 自愈播报最多留几条：面板是验收入口，不是历史库（与会话面板的失效横幅同一形状）。 */
const RELOCATED_LIMIT = 3;

/**
 * 从打分后的候选里剥出指纹本体。
 * @param chosen 上一次定位胜出的候选（除指纹外还带分数、理由与所在帧）
 * @returns 只含 `ElementFingerprint` 声明的那八个字段，作为下一次定位的 `lastKnown`
 */
const toFingerprint = (chosen: LocatedView): ElementFingerprint => ({
  tagName: chosen.tagName,
  role: chosen.role,
  accessibleName: chosen.accessibleName,
  text: chosen.text,
  attributes: chosen.attributes,
  ancestorRoles: chosen.ancestorRoles,
  nearbyTexts: chosen.nearbyTexts,
  rect: chosen.rect,
});

/**
 * 预置定位声明。description 一律填 i18n key：界面 t() 出译文，主进程回显
 * （recentFailures / locator/relocated 事件）时同一把 key 再翻译一次，两处永远同文案。
 *
 * 三条都对着本地 fixture 的 `locator-lab` 页写（AGENTS.md §7.2：验收只打仿站）：
 * - `specTarget` 的两条候选正是 `?variant=after` 改版会打断的两样东西（testid 与主类名），
 *   所以第二次点「定位」时声明全数落空，只剩上一次成功留下的指纹能把元素找回来（2.2-05）；
 * - `specAmbiguous` 用最宽的 `button`，页面上有多个按钮时必须拒绝猜测而不是挑一个（2.2-02）；
 * - `specMissing` 三样全指向不存在的元素，用来演示结构化失败态（2.2-04）。
 */
const LAB_SPECS: LocateSpec[] = [
  {
    description: 'locator.specTarget',
    cardinality: 'single',
    candidates: [
      { strategy: 'testId', value: 'greet-button', attribute: 'data-testid' },
      { strategy: 'css', value: '.btn--primary' },
    ],
  },
  {
    description: 'locator.specAmbiguous',
    cardinality: 'single',
    // 只给一条最宽的 css 候选：页面上只要有两个按钮就触发「歧义拒绝」而不是猜一个。
    candidates: [{ strategy: 'css', value: 'button' }],
  },
  {
    description: 'locator.specMissing',
    cardinality: 'single',
    // 故意指向不存在的选择器：spec 2.2-04 的失败态由这一行一键演示。
    candidates: [
      { strategy: 'testId', value: 'no-such-widget-22-04', attribute: 'data-testid' },
      { strategy: 'css', value: '#no-such-widget-22-04' },
      { strategy: 'xpath', value: '//no-such-widget-22-04' },
    ],
  },
];

/**
 * 定位结局 → 颜色，四态各占一条语义（plan §5）：`matched` 是唯一的好消息 → 玉；
 * `ambiguous` / `below-score` 都是「有候选但闸门没敢动」，要人看一眼才能继续 → 同一档琥珀；
 * `not-found` 是终局失败 → 朱砂。原先给 `ambiguous` 的紫在本项目调色板上没有语义位，删掉。
 */
const STATUS_CLASS: Record<LocateResultView['status'], string> = {
  matched: 'border-jade/45 bg-jade-wash text-jade',
  ambiguous: 'border-amber/50 bg-amber-wash text-amber',
  'below-score': 'border-amber/50 bg-amber-wash text-amber',
  'not-found': 'border-seal/55 bg-seal-wash text-seal',
};

/**
 * 定位实验台：把定位/动作层的结构化失败画到界面上（spec 2.2-04），
 * 并订阅 `locator/relocated` 让指纹自愈留痕（spec 2.2-05）。
 *
 * 三条预置声明各带「定位」「点击」两个按钮，其中一条故意不可命中；
 * 结果区**原样转述**服务返回的结局与分数，桥接错误（如未开会话的
 * `NO_KERNEL_SESSION`）单独成横幅，绝不与「定位未过线」混为一谈。
 */
export function LocatorLabPanel() {
  const { t } = useTranslation();
  const [statusView, setStatusView] = useState<LocateStatusView>();
  const [lastLocate, setLastLocate] = useState<LocateResultView>();
  const [lastAct, setLastAct] = useState<ActResultView>();
  const [bridgeError, setBridgeError] = useState<AppErrorPayload>();
  const [relocated, setRelocated] = useState<LocatorRelocatedEvent[]>();
  const bridge = window.autoCC;
  /**
   * 每条声明最近一次成功定位留下的指纹。
   * 存 `useRef` 而不是 state：它不参与渲染，只为下一次「定位」按钮带上 `lastKnown`，
   * 改版现场（声明全数落空）由服务侧拿它把元素找回来（spec 2.2-05）。
   */
  const fingerprints = useRef<Record<string, ElementFingerprint>>({});

  const read = useCallback(async () => {
    const reply = await bridge?.browser['locate.status']();
    if (reply?.ok) setStatusView(reply.value);
  }, [bridge]);

  const { busy, notice, run } = useBridgeAction(read);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    // 自愈事件来自推送而不是轮询：改版现场被找回的那一刻必须恰好出现在屏幕上。
    const offRelocated = bridge.on('locator/relocated', (payload) => {
      setRelocated((current) => [payload, ...(current ?? [])].slice(0, RELOCATED_LIMIT));
    });
    return () => {
      offRelocated();
    };
  }, [bridge]);

  /**
   * 把一次动作的结局写成提示行文案。
   *
   * 提示行说的是**结局**而不是「调用成功」：定位没命中时桥接照样回 ok，
   * 写成「成功」就成了一行和下面结果区互相打脸的假话。
   * @param label 动作标签（「定位「…」」/「点击「…」」）
   * @param status 本次结局，取 `locator.status.*` 的键（定位四态 + 动作两态）
   * @returns 提示行文案
   */
  const outcomeNotice = (label: string, status: LocateResultView['status'] | ActResultView['status']): string =>
    t('locator.noticeOutcome', { action: label, status: t(`locator.status.${status}`) });

  /**
   * 对一条预置声明跑一次定位，并把成功结果里的指纹留给下一次（自愈的输入，spec 2.2-05）。
   * @param spec 面板预置的定位声明（description 是 i18n key）
   */
  const locate = (spec: LocateSpec) => {
    const label = t('locator.actionLocate', { name: t(spec.description) });
    return void run(label, () => bridge?.browser['locate.find'](spec, fingerprints.current[spec.description]), {
      apply: (value) => {
        setBridgeError(undefined);
        setLastAct(undefined);
        setLastLocate(value);
        if (value.status === 'matched' && value.chosen) {
          fingerprints.current[spec.description] = toFingerprint(value.chosen);
        }
      },
      describe: (value) => outcomeNotice(label, value.status),
      onError: setBridgeError,
    });
  };

  /**
   * 对一条预置声明跑一次真实点击（CDP 受信通道）。
   * @param spec 面板预置的定位声明（description 是 i18n key）
   */
  const click = (spec: LocateSpec) => {
    const label = t('locator.actionClick', { name: t(spec.description) });
    return void run(label, () => bridge?.browser['act.click'](spec), {
      apply: (value) => {
        setBridgeError(undefined);
        setLastLocate(undefined);
        setLastAct(value);
      },
      // 点击的结局只有 done/timeout，和定位共用同一套 status 文案。
      describe: (value) => outcomeNotice(label, value.status),
      onError: setBridgeError,
    });
  };

  const okLabel = (flag: boolean): string => (flag ? t('locator.yes') : t('locator.no'));

  /**
   * 在途那一拍共用的原因码与人话。
   *
   * 文案走 `locator.reasonBusy` 这一条扁平键而不是 `locator.reason.<码>`：本命名空间里已经有一条
   * `reason`（「判定理由：{{reason}}」），再挂一个同名对象键就成了重复键、后一份把前一份吃掉（§2.5）。
   * 这一屏也只有这一支码，所以不做按码查表的假通用。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const busyReasonLabel = busyReason === undefined ? undefined : t('locator.reasonBusy');

  return (
    <div className="flex flex-col gap-4" data-testid="locator-lab">
      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Crosshair size={16} />
            {t('locator.heading')}
          </h2>
          <DeskButton
            action="refresh"
            variant="line"
            compact
            busy={!!busy}
            disabled={busyReason !== undefined}
            disabledReason={busyReason}
            disabledReasonLabel={busyReasonLabel}
            onClick={() => void read()}
          >
            <RefreshCw size={14} />
            {t('locator.refresh')}
          </DeskButton>
        </div>

        <p className="mt-2 text-[11px] text-slate-500" data-testid="locator-thresholds">
          {t('locator.thresholds', {
            minScore: statusView?.minScore ?? '-',
            minMargin: statusView?.minMargin ?? '-',
            candidateLimit: statusView?.candidateLimit ?? '-',
          })}
        </p>

        <h3 className="mt-3 text-xs font-semibold text-slate-300">
          {t('locator.failuresHeading', { count: statusView?.recentFailures.length ?? 0 })}
        </h3>
        {(statusView?.recentFailures.length ?? 0) === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500">{t('locator.failuresEmpty')}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1" data-testid="locator-recent-failures">
            {(statusView?.recentFailures ?? []).map((failure, index) => (
              <li
                key={`${failure.description}-${String(index)}`}
                className="rounded-md border border-seal/45 bg-seal-wash px-3 py-1.5 text-[11px] text-seal"
              >
                {t('locator.failureRow', {
                  description: t(failure.description),
                  status: t(`locator.status.${failure.status}`),
                  reason: failure.reason,
                  time: formatClock(failure.at, t('locator.none')),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('locator.specsHeading')}</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {LAB_SPECS.map((spec) => (
            <li
              key={spec.description}
              data-lab-spec={spec.description}
              className="flex items-center justify-between gap-2 rounded-lg border border-line bg-ink-950/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs text-slate-200">{t(spec.description)}</p>
                <p className="mt-0.5 break-all text-[11px] text-slate-500">
                  {t('locator.specCandidates', {
                    strategies: spec.candidates.map((candidate) => candidate.strategy).join(' / '),
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* 「定位」只把页面扫一遍，一行都不写 → `line`；
                    「点击」经 CDP 把真实鼠标事件派发进页面——页面是仿站时它落在本机，
                    是真实平台时这一下就到了别人服务器上 → 整条动作链同一档朱砂（§8.3 的界面表达）。 */}
                <DeskButton
                  action="locate"
                  variant="line"
                  compact
                  busy={!!busy}
                  disabled={busyReason !== undefined}
                  disabledReason={busyReason}
                  disabledReasonLabel={busyReasonLabel}
                  onClick={() => locate(spec)}
                >
                  <Crosshair size={12} />
                  {t('locator.locateButton')}
                </DeskButton>
                <DeskButton
                  action="click"
                  variant="seal"
                  compact
                  busy={!!busy}
                  disabled={busyReason !== undefined}
                  disabledReason={busyReason}
                  disabledReasonLabel={busyReasonLabel}
                  onClick={() => click(spec)}
                >
                  <MousePointerClick size={12} />
                  {t('locator.clickButton')}
                </DeskButton>
              </div>
            </li>
          ))}
        </ul>

        {notice && (
          <p
            className="mt-2 rounded-md border border-line bg-ink-950/70 px-3 py-2 text-[11px] text-slate-300"
            data-testid="locator-notice"
          >
            {notice}
          </p>
        )}

        {bridgeError && (
          <Banner tone="seal" markers={{ testid: 'locator-error', 'error-code': bridgeError.code }} className="mt-2">
            <div className="w-full">
              <p className="font-semibold">{t('locator.errorHeading')}</p>
              <p className="mt-1 break-all">
                {t('locator.errorRow', { code: bridgeError.code, message: bridgeError.message })}
              </p>
              {bridgeError.code === 'NO_KERNEL_SESSION' && (
                <p className="mt-1 break-all text-amber" data-testid="locator-error-hint">
                  {t('locator.errNoSession')}
                </p>
              )}
            </div>
          </Banner>
        )}
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('locator.resultHeading')}</h3>
        {!lastLocate && !lastAct && <p className="mt-1 text-[11px] text-slate-500">{t('locator.resultIdle')}</p>}

        {lastLocate && (
          <div
            className="mt-2 flex flex-col gap-1"
            data-testid="locator-locate-result"
            data-locate-status={lastLocate.status}
          >
            <div className="flex items-center gap-2">
              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_CLASS[lastLocate.status]}`}>
                {t(`locator.status.${lastLocate.status}`)}
              </span>
              <span className="text-[11px] text-slate-400">{t(lastLocate.spec.description)}</span>
              {lastLocate.relocated && (
                <span className="rounded border border-jade/45 bg-jade-wash px-1.5 py-0.5 text-[11px] text-jade">
                  {t('locator.relocatedFlag')}
                </span>
              )}
            </div>
            <p className="break-all text-[11px] text-slate-400">{t('locator.reason', { reason: lastLocate.reason })}</p>
            {lastLocate.chosen && (
              <p className="text-[11px] text-slate-300">
                {t('locator.chosen', { strategy: lastLocate.chosen.strategy, score: lastLocate.chosen.score })}
              </p>
            )}
            {lastLocate.ranked.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5" data-testid="locator-ranked">
                {lastLocate.ranked.map((candidate, index) => (
                  <li key={`${candidate.strategy}-${String(index)}`} className="break-all text-[11px] text-slate-500">
                    {t('locator.rankedRow', {
                      strategy: candidate.strategy,
                      score: candidate.score,
                      reasons: candidate.reasons.join(' / '),
                    })}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 break-all text-[11px] text-slate-600" data-testid="locator-snapshot-ref">
              {t('locator.snapshotRef', { ref: lastLocate.snapshotRef })}
            </p>
            {lastLocate.snapshot && (
              <p className="break-all text-[11px] text-slate-500" data-testid="locator-fail-snapshot">
                {t('locator.snapshotOnFail', {
                  title: lastLocate.snapshot.title,
                  elements: lastLocate.snapshot.elementCount,
                  textLength: lastLocate.snapshot.textLength,
                })}
              </p>
            )}
          </div>
        )}

        {lastAct && (
          <div className="mt-2 flex flex-col gap-1" data-testid="locator-act-result" data-act-status={lastAct.status}>
            <p className="text-[11px] text-slate-300">
              {t('locator.actRow', {
                action: lastAct.action,
                status: t(`locator.status.${lastAct.status}`),
                waitedMs: lastAct.waitedMs,
              })}
            </p>
            <p className="text-[11px] text-slate-400">
              {/* 通道与受信标记如实转达：cdp 是浏览器级真实输入，dom 只是页面内派发（spec 2.2-12）。 */}
              {t('locator.actChannel', { channel: lastAct.channel, trusted: okLabel(lastAct.trusted) })}
            </p>
            {lastAct.valueAfter !== null && (
              <p className="break-all text-[11px] text-slate-400">
                {t('locator.actValueAfter', { value: lastAct.valueAfter })}
              </p>
            )}
            {lastAct.predicate && (
              <p className="text-[11px] text-slate-400">
                {t('locator.actPredicate', {
                  kind: lastAct.predicate.kind,
                  satisfied: okLabel(lastAct.predicate.satisfied),
                })}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <Sparkles size={14} />
          {t('locator.relocatedHeading')}
        </h3>
        {(relocated?.length ?? 0) === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="locator-relocated-empty">
            {t('locator.relocatedEmpty')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1" data-testid="locator-relocated">
            {(relocated ?? []).map((event, index) => (
              <li
                key={`${event.description}-${String(index)}`}
                className="rounded-md border border-jade/40 bg-jade-wash px-3 py-1.5 text-[11px] text-jade"
              >
                {t('locator.relocatedRow', {
                  description: t(event.description),
                  strategy: event.strategy,
                  score: event.score,
                  frameUrl: event.frameUrl,
                  because: event.because,
                  time: formatClock(event.at, t('locator.none')),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
