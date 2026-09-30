import { Briefcase, Database, MessageSquare, RefreshCw, ScrollText, Search, SearchX, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppErrorPayload,
  CaptureRunView,
  CaptureStatusView,
  GreetReceiptView,
  JdProgressEvent,
  JdStoreStatusView,
  JobListResultView,
  JobRowView,
  SalaryView,
} from '@auto-cc/shared';
import { formatClock } from './format';
import { useBridgeAction } from './useBridgeAction';

/** 进度播报最多留几条：面板是验收入口，不是历史库（与定位实验台的自愈播报同一形状）。 */
const PROGRESS_LIMIT = 4;

/** 库内清单一次画多少行：抓取默认回 20 条，界面只展示最近这些，滚动区不失控。 */
const ROW_DISPLAY_LIMIT = 12;

/**
 * JD 抓取实验台：把「搜索 → 滚动收集 → 逐条读详情 → 落库」这条只读链路的结局画到界面上
 * （spec 2.3-01 / 2.3-06…2.3-11）。
 *
 * 界面**只转述服务读数**：停止原因、跳过条数、账本前后行数都来自 `jd.capture.run` 的返回，
 * 一行都不自己判断——抓取逻辑在 `platform-boss`，这里再算一遍就成了第二套实现（AGENTS.md §2.5）。
 * 进度行来自 `jd/progress` 推送而不是轮询（spec 2.3-07）。
 *
 * 2.5-f 起这里也是**打招呼的界面入口**（spec 2.5-02）：每行一个按钮直接打 `outbound.greet.perform`，
 * 成功就摆回执、失败就摆错误码——闸门拒人不落账，所以界面上那行 `QUOTA_EXCEEDED` 是唯一留痕。
 * 「已回复」标记与排序都来自 `jd.store.list` 的读数（spec 2.5-08 / 2.5-14），界面不参与判定。
 */
export function JobLabPanel() {
  const { t } = useTranslation();
  const [captureStatus, setCaptureStatus] = useState<CaptureStatusView>();
  const [storeStatus, setStoreStatus] = useState<JdStoreStatusView>();
  const [jobList, setJobList] = useState<JobListResultView>();
  const [lastRun, setLastRun] = useState<CaptureRunView>();
  const [progress, setProgress] = useState<JdProgressEvent[]>();
  const [bridgeError, setBridgeError] = useState<AppErrorPayload>();
  const [keywordDraft, setKeywordDraft] = useState('');
  const [cityDraft, setCityDraft] = useState('');
  const [experienceDraft, setExperienceDraft] = useState('');
  /** 本次目标条数（`criteria.limit`）：填了就压过配置的 `targetCount`，让 2.3-06 的「达目标即停」能在界面上演示。 */
  const [limitDraft, setLimitDraft] = useState('');
  /** 最近一次打招呼的回执（`GreetReceiptView`）：闸门拒了就没有回执，界面上只剩结构化错误（spec 2.5-02）。 */
  const [lastGreet, setLastGreet] = useState<GreetReceiptView>();
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [captureReply, storeReply, listReply] = await Promise.all([
      bridge?.jd['capture.status'](),
      bridge?.jd['store.status'](),
      bridge?.jd['store.list'](ROW_DISPLAY_LIMIT),
    ]);
    if (captureReply?.ok) setCaptureStatus(captureReply.value);
    if (storeReply?.ok) setStoreStatus(storeReply.value);
    // 清单只在**已经点开过**的时候跟着刷新：动作后重读就是「读数跟着库走」的证据，
    // 而没点过的会话不该凭空长出一步 `jd.store.list`（界面仍然只转述，不替用户决定看什么）。
    if (listReply?.ok) setJobList((current) => (current ? listReply.value : current));
  }, [bridge]);

  const { busy, notice, run } = useBridgeAction(read);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    const offProgress = bridge.on('jd/progress', (payload) => {
      setProgress((current) => [payload, ...(current ?? [])].slice(0, PROGRESS_LIMIT));
    });
    return () => {
      offProgress();
    };
  }, [bridge]);

  /**
   * 归一化薪资 → 一句话（spec 2.3-03：面议与「认不出来」都必须说出口，不许用 0 冒充数字）。
   * @param salary 服务回传的归一化结果；null 表示这行还没归一化过
   * @returns 一句完整文案（区间 / 单值 + 单位 + 周期 + 可选的「N 薪」）
   */
  const salaryLabel = (salary: SalaryView | null): string => {
    if (!salary) return t('jd.salaryUnparsed');
    if (salary.isNegotiable) return t('jd.salaryNegotiable');
    if (salary.min === null && salary.max === null) return t('jd.salaryUnknown');
    const unit = t(`jd.salaryUnit.${salary.unit}`);
    const period = t(`jd.salaryPeriod.${salary.period}`);
    const months = salary.salaryMonths === null ? '' : t('jd.salaryMonths', { months: salary.salaryMonths });
    if (salary.max === null || salary.max === salary.min) {
      return t('jd.salarySingle', { value: salary.min ?? salary.max ?? 0, unit, period, months });
    }
    return t('jd.salaryRange', { min: salary.min ?? 0, max: salary.max, unit, period, months });
  };

  /**
   * 跑一轮抓取：滚动收集列表 + 逐条读详情 + 幂等入库，全程只读、不经闸门。
   * 搜索条件取界面上的关键词（必填）与城市 / 经验 / 本次目标条数（均可空）。
   */
  const capture = () => {
    const keyword = keywordDraft.trim();
    const limit = Number(limitDraft);
    return void run(
      t('jd.actionRun', { keyword }),
      () =>
        bridge?.jd['capture.run']({
          keyword,
          city: cityDraft.trim() || undefined,
          experience: experienceDraft.trim() || undefined,
          limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        }),
      {
        apply: (value) => {
          setBridgeError(undefined);
          setLastRun(value);
        },
        // 提示行说的是**结局**：抓了几条、跳了几条、为什么停，而不是「调用成功」。
        describe: (value) =>
          t('jd.noticeRun', {
            stored: value.stored,
            skipped: value.skipped.length,
            stoppedBy: t(`jd.stopped.${value.stoppedBy}`),
          }),
        onError: setBridgeError,
      },
    );
  };

  /** 读库内清单（`jd.store.list`），用来证明重启后行还在、幂等没有翻倍（spec 2.3-04）。 */
  const listJobs = () => {
    return void run(t('jd.actionList'), () => bridge?.jd['store.list'](ROW_DISPLAY_LIMIT), {
      apply: (value) => {
        setBridgeError(undefined);
        setJobList(value);
      },
      describe: (value) => t('jd.noticeList', { shown: value.rows.length, total: value.total }),
      onError: setBridgeError,
    });
  };

  /**
   * 对库内一行打一次招呼（spec 2.5-02 的界面入口）：只递生成入参，文案由 `outbound.script` 出。
   *
   * 走的是白名单里那条 `outbound.greet.perform`，编排（幂等 → 文案 → 黑名单 → 额度 → 频控 → 落账）
   * 全在服务侧，这里只把回执与结构化错误原样摆出来——闸门拒人不记账，界面上的错误码是唯一留痕。
   * @param row 库内的一行 JD（`jobId` 是会话目标，`id` 只用来当话术生成的 JD 标识）
   */
  const greet = (row: JobRowView) => {
    return void run(
      t('jd.actionGreet', { title: row.title }),
      () =>
        bridge?.outbound['greet.perform']({
          platform: row.platform,
          jobId: row.jobId,
          script: { jdId: String(row.id), title: row.title, company: row.company },
        }),
      {
        apply: (receipt) => {
          setBridgeError(undefined);
          setLastGreet(receipt);
        },
        onError: (error) => {
          setLastGreet(undefined);
          setBridgeError(error);
        },
      },
    );
  };

  const okLabel = (flag: boolean): string => (flag ? t('jd.yes') : t('jd.no'));

  return (
    <div className="flex flex-col gap-4" data-testid="job-lab">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Briefcase size={16} />
            {t('jd.heading')}
          </h2>
          <button
            type="button"
            data-action="refresh"
            onClick={() => void read()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw size={14} />
            {t('jd.refresh')}
          </button>
        </div>

        <p className="mt-2 text-[11px] text-slate-500" data-testid="jd-config">
          {t('jd.config', {
            targetCount: captureStatus?.targetCount ?? '-',
            maxRounds: captureStatus?.maxRounds ?? '-',
            roundPauseMs: captureStatus?.roundPauseMs ?? '-',
          })}
        </p>
        <p className="mt-1 text-[11px] text-slate-400" data-testid="jd-store-status">
          {storeStatus
            ? t('jd.storeStatus', {
                total: storeStatus.total,
                withDetail: storeStatus.withDetail,
                schemaVersion: storeStatus.schemaVersion,
              })
            : t('jd.storeIdle')}
        </p>
        {storeStatus?.newestSourceUrl && (
          <p className="mt-1 break-all text-[11px] text-slate-500" data-testid="jd-newest-source">
            {t('jd.newestSource', { url: storeStatus.newestSourceUrl })}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.criteriaHeading')}</h3>
        <div className="mt-2 flex flex-col gap-2">
          <input
            type="text"
            data-testid="jd-keyword"
            value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            placeholder={t('jd.keywordPlaceholder')}
            className="min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
          />
          <div className="flex gap-2">
            <input
              type="text"
              data-testid="jd-city"
              value={cityDraft}
              onChange={(event) => setCityDraft(event.target.value)}
              placeholder={t('jd.cityPlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            />
            <input
              type="text"
              data-testid="jd-experience"
              value={experienceDraft}
              onChange={(event) => setExperienceDraft(event.target.value)}
              placeholder={t('jd.experiencePlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            />
            <input
              type="number"
              min={1}
              data-testid="jd-limit"
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
              placeholder={t('jd.limitPlaceholder')}
              className="w-24 min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-action="capture"
              disabled={!!busy || !keywordDraft.trim()}
              onClick={capture}
              className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
            >
              <Search size={12} />
              {t('jd.captureButton')}
            </button>
            <button
              type="button"
              data-action="list"
              disabled={!!busy}
              onClick={listJobs}
              className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Database size={12} />
              {t('jd.listButton')}
            </button>
          </div>
        </div>

        {notice && (
          <p
            className="mt-2 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
            data-testid="jd-notice"
          >
            {notice}
          </p>
        )}

        {lastGreet && (
          <div
            className="mt-2 rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-[11px] text-emerald-200"
            data-testid="jd-greet-receipt"
            data-origin={lastGreet.origin}
          >
            <p className="flex items-center gap-1 font-semibold">
              <Send size={12} />
              {t('jd.greetReceiptHeading')}
            </p>
            <p className="mt-1 break-all">
              {t('jd.greetReceiptRow', {
                jobId: lastGreet.jobId,
                ledgerId: lastGreet.ledgerId,
                waitedMs: lastGreet.waitedMs,
                source: lastGreet.source,
                origin: t(`jd.origin.${lastGreet.origin}`),
                reason: lastGreet.reason,
              })}
            </p>
          </div>
        )}

        {bridgeError && (
          <div
            className="mt-2 rounded-md border border-rose-800 bg-rose-950 px-3 py-2 text-[11px] text-rose-300"
            data-testid="jd-error"
            data-error-code={bridgeError.code}
          >
            <p className="flex items-center gap-1 font-semibold">
              <SearchX size={12} />
              {t('jd.errorHeading')}
            </p>
            <p className="mt-1 break-all">
              {t('jd.errorRow', { code: bridgeError.code, message: bridgeError.message })}
            </p>
            {bridgeError.code === 'NO_KERNEL_SESSION' && (
              <p className="mt-1 text-amber-300" data-testid="jd-error-hint">
                {t('jd.errNoSession')}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <ScrollText size={14} />
          {t('jd.progressHeading')}
        </h3>
        {(progress?.length ?? 0) === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-progress-empty">
            {t('jd.progressIdle')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5" data-testid="jd-progress">
            {(progress ?? []).map((event, index) => (
              <li
                key={`${event.phase}-${String(event.round)}-${String(index)}`}
                className="break-all text-[11px] text-slate-400"
                data-progress-phase={event.phase}
              >
                {t('jd.progressRow', {
                  round: event.round,
                  phase: t(`jd.phase.${event.phase}`),
                  stored: event.stored,
                  target: event.target,
                  containers: event.containers,
                  currentTitle: event.currentTitle,
                  time: formatClock(event.at, t('jd.none')),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.outcomeHeading')}</h3>
        {!lastRun ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-outcome-idle">
            {t('jd.outcomeIdle')}
          </p>
        ) : (
          <div className="mt-1 flex flex-col gap-1" data-testid="jd-outcome" data-stopped-by={lastRun.stoppedBy}>
            <p className="break-all text-[11px] text-slate-300">
              {t('jd.outcomeRow', {
                platform: lastRun.platform,
                keyword: lastRun.keyword,
                city: lastRun.city ?? '-',
                rounds: lastRun.rounds,
                containers: lastRun.containers,
                stored: lastRun.stored,
                total: lastRun.total,
                stoppedBy: t(`jd.stopped.${lastRun.stoppedBy}`),
              })}
            </p>
            {/* 抓取是只读动作：账本行数前后必须相等，不等就说明抓取被计成了一次外发（spec 2.3-11）。 */}
            <p className="text-[11px] text-slate-400" data-testid="jd-ledger-check">
              {t('jd.ledger', {
                before: lastRun.ledgerRowsBefore,
                after: lastRun.ledgerRowsAfter,
                readOnly: okLabel(lastRun.ledgerRowsBefore === lastRun.ledgerRowsAfter),
              })}
            </p>
            <h4 className="mt-2 text-[11px] font-semibold text-slate-300">
              {t('jd.skippedHeading', { count: lastRun.skipped.length })}
            </h4>
            {lastRun.skipped.length === 0 ? (
              <p className="text-[11px] text-slate-500" data-testid="jd-skipped-empty">
                {t('jd.skippedEmpty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="jd-skipped">
                {lastRun.skipped.map((failure, index) => (
                  <li
                    key={`${failure.sourceUrl}-${String(index)}`}
                    className="break-all rounded-md border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-[11px] text-amber-200"
                  >
                    {t('jd.skippedRow', {
                      title: failure.title,
                      reason: failure.reason,
                      sourceUrl: failure.sourceUrl,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.listHeading')}</h3>
        {!jobList ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-list-idle">
            {t('jd.listIdle')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1" data-testid="jd-rows">
            {jobList.rows.map((row) => (
              <li
                key={`${row.platform}-${String(row.id)}`}
                className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-1.5"
                data-replied={row.replied ? 'true' : 'false'}
              >
                <p className="break-all text-[11px] text-slate-200">
                  {t('jd.rowMain', {
                    id: row.id,
                    title: row.title,
                    company: row.company,
                    salary: salaryLabel(row.salary),
                    salaryText: row.salaryText,
                  })}
                </p>
                <p className="mt-0.5 break-all text-[11px] text-slate-500">
                  {t('jd.rowMeta', {
                    city: row.city,
                    experience: row.experience,
                    education: row.education,
                    postedAt: formatClock(row.postedAt, row.postedText),
                    capturedAt: formatClock(row.capturedAt, t('jd.none')),
                    detailCapturedAt: formatClock(row.detailCapturedAt, t('jd.detailMissing')),
                    descriptionLength: row.description.length,
                  })}
                </p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span
                    className={
                      row.replied
                        ? 'flex items-center gap-1 text-[11px] text-emerald-300'
                        : 'flex items-center gap-1 text-[11px] text-slate-500'
                    }
                    data-testid={`jd-row-replied-${row.jobId}`}
                    data-inbound={row.inboundCount}
                  >
                    <MessageSquare size={12} />
                    {row.replied ? t('jd.rowReplied', { inbound: row.inboundCount }) : t('jd.rowNotReplied')}
                  </span>
                  <button
                    type="button"
                    data-action={`greet-${row.jobId}`}
                    disabled={!!busy}
                    onClick={() => greet(row)}
                    className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
                  >
                    <Send size={12} />
                    {t('jd.greetButton')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
