import { BarChart3, CalendarClock, CircleAlert, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  dayKey,
  startOfDay,
  type AppErrorPayload,
  type FunnelLevel,
  type FunnelRange,
  type FunnelView,
} from '@auto-cc/shared';

/** 区间档位：两个预设 + 自定义（spec 5.8-04）。localStorage 里存的就是这个判别式。 */
type RangePreset = 'last7' | 'last30' | 'custom';

/**
 * 看板的筛选偏好（plan §7.6.2 决策十八）。
 *
 * 只落渲染层 localStorage：为一个下拉框开新表与新迁移不值当，而 `plugins.saveConfig` 那条路
 * 会重建下游服务、还会关掉已打开的会话视图——本面板的判据（5.8-02）恰恰是「它什么动作都不该触发」。
 */
type RangePreference = { preset: RangePreset; fromDay: string; toDay: string };

/** 偏好键：与 `auto-cc.lang` 同一份 localStorage，前缀同为 `auto-cc.`。 */
const PREF_STORAGE_KEY = 'auto-cc.metrics.range';

/**
 * 五级各自的语言包键。
 *
 * 写成字面量表而不是拼 `metrics.level.${level}`：§5.6 要的是「键能对上文案」，
 * 拼出来的键在语言包里查不到也照样静默显示键名，这张表让五个键在源码里逐个可见。
 */
const LEVEL_KEYS: Record<FunnelLevel, string> = {
  search: 'metrics.level.search',
  greet: 'metrics.level.greet',
  reply: 'metrics.level.reply',
  deliver: 'metrics.level.deliver',
  interview: 'metrics.level.interview',
};

/**
 * 比例条的档位类（plan §7.6.2 决策十九）。
 *
 * 为什么不按读数算出百分比再塞进 `style`：渲染层的 eslint 拦的是 `style` **属性本身**
 * （`JSXAttribute[name.name='style']`，AGENTS.md §5.1），没有「只做数据宽度」这种豁免口；
 * 而 Tailwind 只认源码里字面存在的类名，动态拼出来的 `w-[37%]` 根本不会生成样式。
 * 两者一夹，唯一能落地的形状就是这条十分位档：下标由读数算，类名是常量数组里的字面量。
 * 精确数字始终写在同一行文字里，条只是「哪一级明显比上一级窄」的眼睛辅助。
 */
const BAR_STEPS = [
  'w-0',
  'w-[10%]',
  'w-[20%]',
  'w-[30%]',
  'w-[40%]',
  'w-[50%]',
  'w-[60%]',
  'w-[70%]',
  'w-[80%]',
  'w-[90%]',
  'w-full',
] as const;

/**
 * 把一条读数折成条宽下标。
 *
 * 比例以「本级 ÷ 五级里最大数」计，所以第一条接近满格、漏斗一路收窄这件事是可见的。
 * 非零的读数至少给一档（`w-[10%]`）：`1 ÷ 40` 四舍五入会归到 `w-0`，
 * 而「有 1 条却画不出格子」正是 5.8-07 要拦的那种读起来像 0 的显示。
 * @param count 本级条数
 * @param max 五级里最大的那个数；<=0 表示整屏都是 0
 * @returns `BAR_STEPS` 的下标
 */
const barStepOf = (count: number, max: number): number => {
  if (max <= 0) return 0;
  const step = Math.round((count / max) * (BAR_STEPS.length - 1));
  return Math.min(BAR_STEPS.length - 1, Math.max(count > 0 ? 1 : 0, step));
};

/**
 * 在本地日界上加减天数（跨夏令时仍是 00:00，比 `+ n * 86_400_000` 可靠）。
 * 只有本面板用得到（区间由发起方算，决策十七），所以留在渲染层，不进 `shared`。
 * @param anchorMs 起算日的 00:00 毫秒
 * @param offsetDays 偏移天数，可为负
 * @returns 目标日的 00:00 毫秒
 */
const shiftDay = (anchorMs: number, offsetDays: number): number => {
  const day = new Date(anchorMs);
  day.setDate(day.getDate() + offsetDays);
  return day.getTime();
};

/**
 * `input[type=date]` 的值 → 本地那天的 00:00 毫秒。
 * @param value 形如 `2026-10-01`；空串或非法值返回 NaN，原样交给主进程判定（本层不重复校验）
 * @returns 本地日界毫秒（不带时刻后缀，所以按本地时区解析）
 */
const fromDayInput = (value: string): number => new Date(`${value}T00:00:00`).getTime();

/**
 * 默认的筛选偏好：近 7 天，自定义那两个日期填今天。
 * @returns 可直接写进 localStorage 的偏好
 */
const defaultPreference = (): RangePreference => {
  const today = dayKey(startOfDay(Date.now()));
  return { preset: 'last7', fromDay: today, toDay: today };
};

/**
 * 读回上次的筛选偏好（spec 5.8-04 的「持久化」在读这一半）。
 *
 * 存的东西来自 localStorage，形状没有任何保证（用户手改、旧版本残留都算），所以逐字段收窄，
 * 不合法就整体回落默认值——而不是 `as RangePreference` 骗过编译器后在渲染期崩。
 * @returns 校验过的偏好
 */
function readPreference(): RangePreference {
  const fallback = defaultPreference();
  const stored = localStorage.getItem(PREF_STORAGE_KEY);
  if (stored === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    const preset = record.preset;
    if (preset !== 'last7' && preset !== 'last30' && preset !== 'custom') return fallback;
    const fromDay = record.fromDay;
    const toDay = record.toDay;
    if (typeof fromDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) return fallback;
    if (typeof toDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) return fallback;
    return { preset, fromDay, toDay };
  } catch {
    return fallback;
  }
}

/**
 * 偏好 → 半开区间（含头不含尾，决策十七）。
 *
 * 「近 7 天」是**含今天的 7 个本地日**，上界取明天 00:00 且不含；自定义同样含止境那一天。
 * 非法值（空串、被手改成 `2026-13-99`）在这里保留成 NaN 原样传出去：区间合法性只有主进程
 * `requireRange` 一处判定（§2.2 不起第二份校验），界面显示它回的那句原话。
 * @param pref 已校验的筛选偏好
 * @returns 交给 `funnel.query` 的区间
 */
const rangeOf = (pref: RangePreference): FunnelRange => {
  const todayStart = startOfDay(Date.now());
  if (pref.preset === 'custom') {
    return { fromMs: fromDayInput(pref.fromDay), toMs: shiftDay(fromDayInput(pref.toDay), 1) };
  }
  const days = pref.preset === 'last30' ? 30 : 7;
  return { fromMs: shiftDay(todayStart, -(days - 1)), toMs: shiftDay(todayStart, 1) };
};

/**
 * 结构化失败的「给人看的那一句」。
 *
 * 只取 `message`（主进程原话），不把 `code` / `details` 摆上屏幕：那些是给用例断言的，
 * 而「区间非法」这类失败的修法（换个日期）只有原话读得懂（spec 5.8-04）。
 * @param error 桥接回包里的错误载荷
 * @returns 可直接插进提示句的文本
 */
const errorText = (error: AppErrorPayload): string => error.message;

/**
 * 指标看板：投递漏斗五级 + 额度三量的只读化身（spec 5.8-01 / 03 / 04 / 07 / 08）。
 *
 * 数全部来自 `funnel.query` 这一张主进程读数（plan §7.6.2 决策十六）：本组件不碰任何一张表、
 * 不写一段 SQL、不发一个动作，连「刷新」都只是重读（5.8-02 的判据）。
 * 三条不让数字骗人的口径：
 * ① `count === null` 的那一级画**原话**不画 0——「此刻没挂载那个服务」与「这段时间一条都没发生」
 *    是两种事实，而约面级全仓没有字段（决策十五），给它编个数就是把「没做这件事」显示成「零转化」。
 * ② 有主人的几级全是 0 时上方一条空态引导（5.8-07），避免整屏 0 被读成「转化率为 0」。
 * ③ `tookMs` 原样显示主进程自测的那个数（5.8-05），界面不自测——自测会把 IPC 往返也算进聚合代价。
 */
export function MetricsPanel() {
  const { t } = useTranslation();
  const [view, setView] = useState<FunnelView>();
  const [notice, setNotice] = useState<string>();
  const [pref, setPref] = useState<RangePreference>(readPreference);
  const bridge = window.autoCC;

  /** 按当前偏好重读一次看板；失败时把主进程原话留在界面上，harness 截图才拿得到证据。 */
  const read = useCallback(async (): Promise<void> => {
    const reply = await bridge?.funnel.query(rangeOf(pref));
    if (!reply) {
      setNotice(t('action.noBridge'));
      return;
    }
    if (reply.ok) {
      setView(reply.value);
      setNotice(undefined);
      return;
    }
    setNotice(t('metrics.loadFailed', { message: errorText(reply.error) }));
  }, [bridge, pref, t]);

  useEffect(() => {
    void read();
  }, [read]);

  /**
   * 换筛选档位并立刻持久化（spec 5.8-04 的「筛选条件持久化」就落在这一次写入上）。
   * @param next 新的偏好
   */
  const applyPreference = (next: RangePreference): void => {
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(next));
    setPref(next);
  };

  const levels = view?.levels ?? [];
  const counts = levels.map((level) => level.count).filter((count): count is number => count !== null);
  const maxCount = counts.length > 0 ? Math.max(...counts) : 0;
  // 空态判定只看「有主人可数」的那几级：约面级恒为 null，不能因为它让空态永远出不来。
  const isEmpty = counts.length > 0 && counts.every((count) => count === 0);
  const quota = view?.quota;

  return (
    <section data-testid="metrics-panel" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <BarChart3 size={16} />
          {t('metrics.heading')}
        </h2>
        {/* 墨案的描边档样式只能整串写在这里：`check-dashboard-readonly.ts` 判据 1 把本文件的
            进口钉死在四个包（引不到能力包就引不到第二条外发通道），所以不能改用 `DeskButton`。
            判据 4 同时要求全文件恰好一只按钮，且它的 onClick 只能是 `void read()`。 */}
        <button
          type="button"
          data-action="refresh"
          onClick={() => void read()}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border border-line-strong bg-ink-800 px-2 py-0.5 text-[11px] font-medium text-slate-100 transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-slate-500 hover:bg-ink-750 hover:text-slate-50 active:translate-y-px active:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-celadon/70"
        >
          <RefreshCw size={12} />
          {t('metrics.refresh')}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('metrics.hint')}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <label className="flex items-center gap-1" htmlFor="metrics-preset">
          <CalendarClock size={14} />
          {t('metrics.filterLabel')}
        </label>
        <select
          id="metrics-preset"
          data-testid="metrics-preset"
          value={pref.preset}
          onChange={(event) => applyPreference({ ...pref, preset: event.target.value as RangePreset })}
          className="min-w-0 rounded-md border border-line-strong bg-ink-950 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-celadon/60"
        >
          <option value="last7">{t('metrics.presetLast7')}</option>
          <option value="last30">{t('metrics.presetLast30')}</option>
          <option value="custom">{t('metrics.presetCustom')}</option>
        </select>
        {pref.preset === 'custom' && (
          <>
            <label className="flex items-center gap-1" htmlFor="metrics-from">
              {t('metrics.from')}
              <input
                id="metrics-from"
                data-testid="metrics-from"
                type="date"
                value={pref.fromDay}
                onChange={(event) => applyPreference({ ...pref, fromDay: event.target.value })}
                className="min-w-0 rounded-md border border-line-strong bg-ink-950 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-celadon/60"
              />
            </label>
            <label className="flex items-center gap-1" htmlFor="metrics-to">
              {t('metrics.to')}
              <input
                id="metrics-to"
                data-testid="metrics-to"
                type="date"
                value={pref.toDay}
                onChange={(event) => applyPreference({ ...pref, toDay: event.target.value })}
                className="min-w-0 rounded-md border border-line-strong bg-ink-950 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-celadon/60"
              />
            </label>
          </>
        )}
        {view && (
          <span data-testid="metrics-range" className="text-slate-500">
            {t('metrics.rangeShown', { from: dayKey(view.range.fromMs), to: dayKey(view.range.toMs) })}
          </span>
        )}
      </div>

      {notice && (
        <p
          data-testid="metrics-notice"
          className="mt-2 flex items-start gap-1 rounded-md border border-amber/45 bg-amber-wash px-3 py-2 text-[11px] text-amber"
        >
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          {notice}
        </p>
      )}

      {isEmpty && (
        <p data-testid="metrics-empty" className="mt-2 text-[11px] text-slate-400">
          {t('metrics.emptyHint')}
        </p>
      )}

      <ul className="mt-3 flex flex-col gap-2" data-testid="metrics-levels">
        {levels.map((level) => (
          <li
            key={level.level}
            data-funnel-level={level.level}
            data-funnel-count={level.count ?? 'null'}
            className="rounded-lg border border-line bg-ink-950/60 px-3 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-slate-300">{t(LEVEL_KEYS[level.level])}</span>
              <span className="font-mono text-xs text-slate-200">
                {level.count === null ? t('metrics.noNumber') : t('metrics.count', { count: level.count })}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-slate-800">
              <div
                className={`h-2 rounded-full ${
                  level.count === null
                    ? 'w-0 bg-slate-700'
                    : `${BAR_STEPS[barStepOf(level.count, maxCount)]} bg-celadon`
                }`}
              />
            </div>
            {level.unavailableReason && (
              <p data-funnel-reason={level.level} className="mt-1 text-[11px] text-amber">
                {t('metrics.noSource', { reason: level.unavailableReason })}
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('metrics.quotaHeading')}</h3>
        {!quota ? (
          <p data-testid="metrics-await" className="mt-1 text-[11px] text-slate-500">
            {t('metrics.awaitRead')}
          </p>
        ) : (
          <>
            {quota.mode === null ? (
              <p data-testid="metrics-gate-missing" className="mt-1 text-[11px] text-amber">
                {t('metrics.gateMissing')}
              </p>
            ) : (
              <p data-testid="metrics-mode" data-quota-mode={quota.mode} className="mt-1 text-[11px] text-slate-400">
                {quota.mode === 'daily' ? t('metrics.modeDaily') : t('metrics.modeUnlimited')}
              </p>
            )}
            <ul className="mt-2 flex flex-col gap-1">
              {quota.actions.map((row) => (
                <li
                  key={row.action}
                  data-quota-action={row.action}
                  data-quota-used={row.usedToday ?? 'null'}
                  data-quota-limit={row.dailyLimit ?? 'null'}
                  data-quota-remaining={row.remaining ?? 'null'}
                  className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400"
                >
                  <span className="font-mono text-xs text-slate-200">{row.action}</span>
                  <span>
                    {row.usedToday === null
                      ? t('metrics.sourceMissing')
                      : t('metrics.usedToday', { count: row.usedToday })}
                  </span>
                  <span>
                    {row.dailyLimit === null
                      ? t('metrics.limitMissing')
                      : quota.mode === 'unlimited'
                        ? t('metrics.limitUnlimited')
                        : t('metrics.limit', { count: row.dailyLimit })}
                  </span>
                  <span>
                    {row.remaining === null
                      ? quota.mode === null
                        ? t('metrics.remainingNoGate')
                        : t('metrics.remainingUnlimited')
                      : t('metrics.remaining', { count: row.remaining })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {view && (
        <p data-testid="metrics-took" className="mt-3 text-[11px] text-slate-500">
          {t('metrics.took', { ms: view.tookMs })}
          {' · '}
          {t('metrics.readOnly')}
        </p>
      )}
    </section>
  );
}
