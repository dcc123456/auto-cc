import {
  Briefcase,
  Check,
  Database,
  FileUp,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppErrorPayload,
  CaptureRunView,
  CaptureStatusView,
  DeliverApprovalView,
  DeliverReceiptView,
  GreetReceiptView,
  JdProgressEvent,
  JdStoreStatusView,
  JobListResultView,
  JobRowView,
  SalaryView,
} from '@auto-cc/shared';
import { formatClock } from './format';
import { ConsentOverlay, ConsentStatusRow } from './ConsentModal';
import { Banner, DeskButton, DeskCheck, DeskField } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';
import { useConsent } from './useConsent';

/** 进度播报最多留几条：面板是验收入口，不是历史库（与定位实验台的自愈播报同一形状）。 */
const PROGRESS_LIMIT = 4;

/** 库内清单一次画多少行：抓取默认回 20 条，界面只展示最近这些，滚动区不失控。 */
const ROW_DISPLAY_LIMIT = 12;

/**
 * JD 抓取实验台：把「搜索 → 滚动收集 → 逐条读详情 → 落库」这条不碰外发的链路的结局画到界面上
 * （spec 2.3-01 / 2.3-06…2.3-11）。
 *
 * 界面**只转述服务读数**：停止原因、跳过条数、账本前后行数都来自 `jd.capture.run` 的返回，
 * 一行都不自己判断——抓取逻辑在 `platform-boss`，这里再算一遍就成了第二套实现（AGENTS.md §2.5）。
 * 进度行来自 `jd/progress` 推送而不是轮询（spec 2.3-07）。
 *
 * 2.5-f 起这里也是**打招呼的界面入口**（spec 2.5-02）：每行一个按钮直接打 `outbound.greet.perform`，
 * 成功就摆回执、失败就摆错误码——闸门拒人不落账，所以界面上那行 `QUOTA_EXCEEDED` 是唯一留痕。
 * 「已回复」标记与排序都来自 `jd.store.list` 的读数（spec 2.5-08 / 2.5-14），界面不参与判定。
 *
 * 2.6-c 起这里也是**投递确认卡片**（spec 2.6-01 / 06）：`semi` 档的那一次 `deliver.perform` 会挂在
 * 主进程里等表态，所以确认/拒绝两个按钮走的是**另一份忙碌态**——若它们也被 `busy` 禁用，
 * 界面就把自己锁死在「等一个永远点不到的按钮」上，到点自动拒绝（fail-closed 的那一路）。
 *
 * 2.7-e 起这三个动作（抓取 / 打招呼 / 投递）都先过 `consent.ensure`（spec 2.7-06 的界面拦截点 ①）：
 * 那个平台还没签过风险确认时卡片先亮出来、原动作挂起，点「我承担」把签字写进库之后才重放。
 * 这一层只是**提前拦**——真正的护栏在释放路径上（拦截点 ②），所以界面漏了也不会真发出去。
 *
 * 6.4-04 起库内清单是 **列表 / 详情 / 动作三段**（02 稿的骨架）：行只负责"指向"哪一条，
 * 详情与打招呼·投递都跟着那一行走，不再是一列行内按钮。详情读的是 `jd.store.list` 已经带回的那一行
 * （`description / requirements / sourceUrl` 都在 `JobRowView` 里），不另开读路径。
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
  /** 简历 PDF 的绝对路径：留空则由主进程用 `outbound.deliver` 配置里的 `resumeFile`（P3 之前的临时入口）。 */
  const [resumePathDraft, setResumePathDraft] = useState('');
  /** 最近一次打招呼的回执（`GreetReceiptView`）：闸门拒了就没有回执，界面上只剩结构化错误（spec 2.5-02）。 */
  const [lastGreet, setLastGreet] = useState<GreetReceiptView>();
  /** 最近一次投递回执：`committed:false` 就是 `suggest` 档的待发送态（spec 2.6-06）。 */
  const [lastDeliver, setLastDeliver] = useState<DeliverReceiptView>();
  /** 此刻在等的投递单（spec 2.6-01）：只由 `outbound.deliver.pending()` 的读数填，界面不自造。 */
  const [pendingApprovals, setPendingApprovals] = useState<DeliverApprovalView[]>([]);
  /**
   * 清单里此刻指向哪一行（spec 6.4-04 的三段式）：只存 key，详情与动作段都从 `jobList` 里现取那一行，
   * 不另存一份行数据——存了就出现"清单刷新而详情还停在旧值"的两套事实（§2.5）。
   */
  const [selectedRowKey, setSelectedRowKey] = useState<string>();
  const bridge = window.autoCC;
  const { refresh: refreshConsent, ...consent } = useConsent();

  const read = useCallback(async () => {
    const [captureReply, storeReply, listReply, pendingReply] = await Promise.all([
      bridge?.jd['capture.status'](),
      bridge?.jd['store.status'](),
      bridge?.jd['store.list'](ROW_DISPLAY_LIMIT),
      bridge?.outbound['deliver.pending'](),
    ]);
    if (captureReply?.ok) setCaptureStatus(captureReply.value);
    if (storeReply?.ok) setStoreStatus(storeReply.value);
    // 清单只在**已经点开过**的时候跟着刷新：动作后重读就是「读数跟着库走」的证据，
    // 而没点过的会话不该凭空长出一步 `jd.store.list`（界面仍然只转述，不替用户决定看什么）。
    if (listReply?.ok) setJobList((current) => (current ? listReply.value : current));
    // 待确认单**每次都读**：它是「此刻有没有人在等」的状态，漏读就等于把用户晾在那里。
    if (pendingReply?.ok) setPendingApprovals(pendingReply.value);
    // 签字状态跟着这一遍一起刷：界面每重读一次快照就把「这个平台签过没有」再取一遍原文，
    // 「重启 / reload 之后仍然显示已确认、且不再弹卡片」（spec 2.7-06 的「出现一次」）靠这行才有证据。
    const platforms = new Set<string>();
    if (captureReply?.ok) platforms.add(captureReply.value.platform);
    if (listReply?.ok) {
      for (const row of listReply.value.rows) platforms.add(row.platform);
    }
    await refreshConsent([...platforms]);
  }, [bridge, refreshConsent]);

  const { busy, notice, run } = useBridgeAction(read);
  /**
   * 确认 / 拒绝两个按钮用**另一个**忙碌态实例（spec 2.6-01）。
   *
   * 触发投递的那次调用在 `semi` 档会一直挂在主进程里等表态，因此它占着上面那个 `busy`；
   * 若表态按钮也共用同一个 `busy`，界面就把自己锁死成「要点的那个按钮永远禁用」，
   * 结局只能是超时自动拒绝——那不是审批，那是必然失败。
   */
  const { busy: approvalBusy, run: runApproval } = useBridgeAction(read);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    const offProgress = bridge.on('jd/progress', (payload) => {
      setProgress((current) => [payload, ...(current ?? [])].slice(0, PROGRESS_LIMIT));
    });
    // 确认卡片由事件弹出，但**卡片内容仍来自 `pending()` 的读数**：事件只说「现在有单子了」，
    // 界面不拿载荷当状态源，否则刷新一次就对不上主进程那边（spec 2.6-01）。
    const offApproval = bridge.on('outbound/approval-requested', () => {
      void read();
    });
    return () => {
      offProgress();
      offApproval();
    };
  }, [bridge, read]);

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
   * 跑一轮抓取：滚动收集列表 + 逐条读详情 + 幂等入库，页面侧不点打招呼也不投简历，
   * 但**这一整轮本身占 `search` 那一条日额度**（spec 2.7-03），到量会直接被闸门拒掉。
   * 搜索条件取界面上的关键词（必填）与城市 / 经验 / 本次目标条数（均可空）。
   *
   * 动作先过 `consent.ensure`（spec 2.7-06 的界面拦截点 ①）：抓取属于哪个平台只由
   * `jd.capture.status` 的 `platform` 说出，界面不猜；还没读到配置时交空列表，
   * 由释放路径上那道硬拦（拦截点 ②）给出结构化错误。
   */
  const capture = () => {
    const keyword = keywordDraft.trim();
    const limit = Number(limitDraft);
    return void consent.ensure(captureStatus ? [captureStatus.platform] : [], () => {
      void run(
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
    });
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
    return void consent.ensure([row.platform], () => {
      void run(
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
    });
  };

  /**
   * 对库内一行递一次简历（spec 2.6-01 / 06 的界面入口）：只给目标与文件，编排全在服务侧。
   *
   * `semi` 档下这次调用会**挂在主进程里**，直到人在下面的确认卡片上表态为止；`suggest` 档只回一份
   * `committed:false` 的回执、账本一行都不增。被拒 / 超时 / 已下架都以结构化错误上浮，界面上只剩错误码。
   * @param row 库内的一行 JD（`jobId` 是投递目标，`title` / `company` 只进确认卡片与回执）
   */
  const deliver = (row: JobRowView) => {
    return void consent.ensure([row.platform], () => {
      void run(
        t('deliver.action', { title: row.title }),
        () =>
          bridge?.outbound['deliver.perform']({
            platform: row.platform,
            jobId: row.jobId,
            title: row.title,
            company: row.company,
            filePath: resumePathDraft.trim() || undefined,
          }),
        {
          apply: (receipt) => {
            setBridgeError(undefined);
            setLastDeliver(receipt);
          },
          onError: (error) => {
            setLastDeliver(undefined);
            setBridgeError(error);
          },
        },
      );
    });
  };

  /**
   * 把确认卡片上那句表态送回主进程（spec 2.6-01）。
   *
   * 单子已经在等待期间定局过（超时、或上一次点击已生效）会以 `APPROVAL_NOT_FOUND` 上浮，
   * 界面把它当结构化错误摆出来——**绝不因为「找不到那张卡片」而放行投递**（fail-closed）。
   * @param approval 卡片对应的那张投递单
   * @param approved 用户点的是确认还是拒绝
   */
  const resolve = (approval: DeliverApprovalView, approved: boolean) => {
    return void runApproval(
      t(approved ? 'deliver.approveAction' : 'deliver.denyAction', { jobId: approval.jobId }),
      () => bridge?.outbound['deliver.resolveApproval'](approval.approvalId, approved),
      { onError: setBridgeError },
    );
  };

  const okLabel = (flag: boolean): string => (flag ? t('jd.yes') : t('jd.no'));
  /**
   * 行内动作（打招呼 / 投递 / 读库）此刻按不动的唯一原因：上一笔动作还挂着。
   * 原因码与人在的话一起给（6.2-06），"灰掉但不说为什么"在这里算缺陷。
   */
  const isActionDisabled = busy !== undefined;
  const isListEnabled = !isActionDisabled;
  /** 一行的稳定标识：列表 key 与选中态共用这一处来源，不让两处各拼一遍。 */
  const rowKey = (row: JobRowView): string => `${row.platform}-${String(row.id)}`;
  /** 此刻指向的那一行：从 `jobList` 现取；清单换过一批取不到时按"没选"处理，详情与动作段一起收起。 */
  const selectedRow = jobList?.rows.find((row) => rowKey(row) === selectedRowKey);
  return (
    <div className="flex flex-col gap-4" data-testid="job-lab">
      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Briefcase size={16} />
            {t('jd.heading')}
          </h2>
          <DeskButton action="refresh" variant="line" compact busy={!!busy} onClick={() => void read()}>
            <RefreshCw size={12} />
            {t('jd.refresh')}
          </DeskButton>
        </div>

        <p className="mt-2 text-[11px] text-slate-500" data-testid="jd-config">
          {t('jd.config', {
            targetCount: captureStatus?.targetCount ?? '-',
            maxRounds: captureStatus?.maxRounds ?? '-',
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
        {captureStatus && <ConsentStatusRow view={consent.views[captureStatus.platform]} />}
      </section>

      <ConsentOverlay consent={consent} />

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.criteriaHeading')}</h3>
        <div className="mt-2 flex flex-col gap-2">
          <DeskField
            action="jd-keyword"
            data-testid="jd-keyword"
            value={keywordDraft}
            onValueChange={setKeywordDraft}
            placeholder={t('jd.keywordPlaceholder')}
          />
          <div className="flex gap-2">
            <DeskField
              action="jd-city"
              data-testid="jd-city"
              value={cityDraft}
              onValueChange={setCityDraft}
              placeholder={t('jd.cityPlaceholder')}
              className="flex-1"
            />
            <DeskField
              action="jd-experience"
              data-testid="jd-experience"
              value={experienceDraft}
              onValueChange={setExperienceDraft}
              placeholder={t('jd.experiencePlaceholder')}
              className="flex-1"
            />
            <DeskField
              action="jd-limit"
              type="number"
              min={1}
              data-testid="jd-limit"
              value={limitDraft}
              onValueChange={setLimitDraft}
              placeholder={t('jd.limitPlaceholder')}
              className="w-24"
            />
          </div>
          <div className="flex items-center gap-2">
            {/* 抓取走实心（它是这一屏的主操作，效果档是读）；外发那两只才是朱砂 */}
            <DeskButton
              action="capture"
              variant="solid"
              compact
              busy={!!busy}
              disabled={!keywordDraft.trim()}
              disabledReason={!keywordDraft.trim() ? 'KEYWORD_EMPTY' : undefined}
              disabledReasonLabel={!keywordDraft.trim() ? t('jd.reasonKeywordEmpty') : undefined}
              onClick={capture}
            >
              <Search size={12} />
              {t('jd.captureButton')}
            </DeskButton>
            <DeskButton
              action="list"
              variant="line"
              compact
              busy={!!busy}
              disabled={!isListEnabled}
              disabledReason={!isListEnabled ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={!isListEnabled ? t('jd.reasonBusy') : undefined}
              onClick={listJobs}
            >
              <Database size={12} />
              {t('jd.listButton')}
            </DeskButton>
          </div>
        </div>

        {notice && (
          <Banner tone="celadon" markers={{ testid: 'jd-notice' }} className="mt-2">
            {notice}
          </Banner>
        )}

        {lastGreet && (
          <Banner tone="jade" markers={{ testid: 'jd-greet-receipt', origin: lastGreet.origin }} className="mt-2">
            <div className="w-full">
              <p className="font-semibold">{t('jd.greetReceiptHeading')}</p>
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
          </Banner>
        )}

        {bridgeError && (
          <Banner tone="seal" markers={{ testid: 'jd-error', 'error-code': bridgeError.code }} className="mt-2">
            <div className="w-full">
              <p className="font-semibold">{t('jd.errorHeading')}</p>
              <p className="mt-1 break-all">
                {t('jd.errorRow', { code: bridgeError.code, message: bridgeError.message })}
              </p>
              {bridgeError.code === 'NO_KERNEL_SESSION' && (
                <p className="mt-1 text-amber" data-testid="jd-error-hint">
                  {t('jd.errNoSession')}
                </p>
              )}
            </div>
          </Banner>
        )}
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <FileUp size={14} />
          {t('deliver.heading')}
        </h3>
        <p className="mt-1 text-[11px] text-slate-500">{t('deliver.hint')}</p>
        <DeskField
          action="deliver-resume-path"
          data-testid="deliver-resume-path"
          value={resumePathDraft}
          onValueChange={setResumePathDraft}
          placeholder={t('deliver.resumePathPlaceholder')}
          className="mt-2 w-full"
        />

        <h4 className="mt-3 text-[11px] font-semibold text-slate-300">{t('deliver.pendingHeading')}</h4>
        {pendingApprovals.length === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="deliver-pending-empty">
            {t('deliver.pendingEmpty')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1" data-testid="deliver-pending">
            {pendingApprovals.map((approval) => (
              <li
                key={approval.approvalId}
                className="rounded-md border border-amber/45 bg-amber-wash px-3 py-1.5"
                data-approval-id={approval.approvalId}
              >
                <p className="break-all text-[11px] text-slate-100">
                  {t('deliver.pendingRow', {
                    jobId: approval.jobId,
                    title: approval.title,
                    company: approval.company,
                    fileName: approval.attachment.fileName,
                    sizeBytes: approval.attachment.sizeBytes,
                    sha: approval.attachment.sha256.slice(0, 12),
                    requestedAt: formatClock(approval.requestedAt, t('jd.none')),
                    expiresAt: formatClock(approval.expiresAt, t('jd.none')),
                  })}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  {/* 确认=签字，走朱砂（seal 的第二义就是"人在这件事上盖了印"）；
                      拒绝不涂红——两枚红按钮并排会让人分不出哪一枚会发出去。 */}
                  <DeskButton
                    action={`approve-${approval.approvalId}`}
                    variant="seal"
                    compact
                    busy={!!approvalBusy}
                    disabled={!!approvalBusy}
                    disabledReason={approvalBusy ? 'APPROVAL_BUSY' : undefined}
                    disabledReasonLabel={approvalBusy ? t('jd.reasonApprovalBusy') : undefined}
                    onClick={() => resolve(approval, true)}
                  >
                    <Check size={12} />
                    {t('deliver.approve')}
                  </DeskButton>
                  <DeskButton
                    action={`deny-${approval.approvalId}`}
                    variant="line"
                    compact
                    busy={!!approvalBusy}
                    disabled={!!approvalBusy}
                    disabledReason={approvalBusy ? 'APPROVAL_BUSY' : undefined}
                    disabledReasonLabel={approvalBusy ? t('jd.reasonApprovalBusy') : undefined}
                    onClick={() => resolve(approval, false)}
                  >
                    <X size={12} />
                    {t('deliver.deny')}
                  </DeskButton>
                </div>
              </li>
            ))}
          </ul>
        )}

        {lastDeliver && (
          <Banner
            tone="jade"
            markers={{ testid: 'deliver-receipt', committed: lastDeliver.committed ? 'true' : 'false' }}
            className="mt-2"
          >
            <div className="w-full">
              <p className="font-semibold">{t('deliver.receiptHeading')}</p>
              <p className="mt-1 break-all">
                {t('deliver.receiptRow', {
                  jobId: lastDeliver.jobId,
                  fileName: lastDeliver.attachment.fileName,
                  sizeBytes: lastDeliver.attachment.sizeBytes,
                  sha: lastDeliver.attachment.sha256.slice(0, 12),
                  state: t(lastDeliver.committed ? 'deliver.stateCommitted' : 'deliver.stateStaged'),
                  ledgerId: lastDeliver.ledgerId ?? t('deliver.noLedger'),
                  waitedMs: lastDeliver.waitedMs,
                  source: lastDeliver.source,
                  reason: lastDeliver.reason,
                })}
              </p>
            </div>
          </Banner>
        )}
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
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

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
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
            {/* 这两个读数取自闸门任务内部，因此不含本轮那条 search：相等只证明抓取没顺手记别的动作
                （spec 2.3-11 原判据「抓取不入账」已按 2.7-03 更正）。 */}
            <p className="text-[11px] text-slate-400" data-testid="jd-ledger-check">
              {t('jd.ledger', {
                before: lastRun.ledgerRowsBefore,
                after: lastRun.ledgerRowsAfter,
                noOtherAction: okLabel(lastRun.ledgerRowsBefore === lastRun.ledgerRowsAfter),
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
                    className="break-all rounded-md border border-amber/45 bg-amber-wash px-3 py-1.5 text-[11px] text-amber"
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

      {/* 清单这一段是**查询容器**：三段式到底并排还是上下走，取决于这一列自己的宽度，而不是视口宽度——
          右栏的内核视图槽位默认整条不存在（裁定⑱），展开时才占 38%（`--kernel-view-width` 与
          KERNEL_VIEW_WIDTH_RATIO 机检同源），1200 宽的窗口在展开态只剩 486px，并排会把详情压到 202px
          （实测读数），所以窄时退回"列表→详情→动作"的纵向读序，宽窗口才兑现 02 稿的横向骨架。 */}
      <section className="@container rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.listHeading')}</h3>
        {!jobList ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-list-idle">
            {t('jd.listIdle')}
          </p>
        ) : (
          <div className="mt-2 grid min-w-0 gap-3 @2xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            {/* 第一段：清单。行只负责"指向"，不带动作键（spec 6.4-04）；选中态走 celadon 不走 jade——
                jade 是"已核"，而"人挑了这一行"只是当前指向，与 ScriptPanel 候选行同一套画法。 */}
            <ul className="flex min-w-0 flex-col gap-1" data-testid="jd-rows">
              {jobList.rows.map((row) => {
                const isRowSelected = selectedRowKey === rowKey(row);
                return (
                  <li
                    key={rowKey(row)}
                    className={`rounded-md border px-2 py-1.5 ${
                      isRowSelected ? 'border-celadon/50 bg-celadon-wash' : 'border-line bg-ink-950/60 hover:bg-ink-850'
                    }`}
                    data-job-selected={isRowSelected ? 'true' : 'false'}
                    data-replied={row.replied ? 'true' : 'false'}
                  >
                    <label className="flex items-start gap-2">
                      <DeskCheck
                        action={`jd-row-${row.jobId}`}
                        type="radio"
                        name="jd-row"
                        checked={isRowSelected}
                        onCheckedChange={() => setSelectedRowKey(rowKey(row))}
                        data-jd-row={row.jobId}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-all text-[11px] text-slate-200">
                          {t('jd.rowMain', {
                            id: row.id,
                            title: row.title,
                            company: row.company,
                            salary: salaryLabel(row.salary),
                            salaryText: row.salaryText,
                          })}
                        </span>
                        <span
                          className={
                            row.replied
                              ? 'mt-0.5 flex items-center gap-1 text-[11px] text-jade'
                              : 'mt-0.5 flex items-center gap-1 text-[11px] text-slate-500'
                          }
                          data-testid={`jd-row-replied-${row.jobId}`}
                          data-inbound={row.inboundCount}
                        >
                          <MessageSquare size={12} />
                          {row.replied ? t('jd.rowReplied', { inbound: row.inboundCount }) : t('jd.rowNotReplied')}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            {/* 第二、三段：详情与动作区。没选中就整段不出现——外发那两只键在没人指定目标时压根不该上屏，
                比"摆出来但按不动"更守 §8.3。 */}
            {!selectedRow ? (
              <p
                className="self-start rounded-md border border-line bg-ink-950/60 px-3 py-2 text-[11px] text-slate-500"
                data-testid="jd-detail-idle"
              >
                {t('jd.detailIdle')}
              </p>
            ) : (
              <div className="min-w-0 rounded-md border border-line bg-ink-950/70 p-3" data-testid="jd-detail">
                <p className="text-[11px] text-slate-500" data-testid="jd-detail-captured">
                  {t('jd.detailCaptured', {
                    platform: selectedRow.platform,
                    capturedAt: formatClock(selectedRow.capturedAt, t('jd.none')),
                  })}
                </p>
                <h4 className="mt-0.5 break-all text-sm font-semibold text-slate-100">{selectedRow.title}</h4>
                <p className="mt-0.5 break-all text-[11px] text-slate-300">
                  {t('jd.detailByline', {
                    company: selectedRow.company,
                    city: selectedRow.city,
                    experience: selectedRow.experience,
                    education: selectedRow.education,
                    salary: salaryLabel(selectedRow.salary),
                  })}
                </p>
                <p className="mt-1 break-all text-[11px] text-slate-500" data-testid="jd-detail-meta">
                  {t('jd.rowMeta', {
                    city: selectedRow.city,
                    experience: selectedRow.experience,
                    education: selectedRow.education,
                    postedAt: formatClock(selectedRow.postedAt, selectedRow.postedText),
                    capturedAt: formatClock(selectedRow.capturedAt, t('jd.none')),
                    detailCapturedAt: formatClock(selectedRow.detailCapturedAt, t('jd.detailMissing')),
                    descriptionLength: selectedRow.description.length,
                  })}
                </p>
                {selectedRow.detailCapturedAt === null && (
                  <p className="mt-1 text-[11px] text-amber" data-testid="jd-detail-partial">
                    {t('jd.detailPartial')}
                  </p>
                )}

                <h5 className="mt-2 border-t border-line pt-2 text-[11px] font-semibold text-slate-300">
                  {t('jd.detailDescriptionHeading')}
                </h5>
                <p
                  className="mt-1 max-h-44 overflow-y-auto whitespace-pre-line break-all text-[11px] leading-relaxed text-slate-200"
                  data-testid="jd-detail-description"
                >
                  {selectedRow.description.length === 0 ? t('jd.detailDescriptionEmpty') : selectedRow.description}
                </p>

                <h5 className="mt-2 border-t border-line pt-2 text-[11px] font-semibold text-slate-300">
                  {t('jd.detailRequirementsHeading', { count: selectedRow.requirements.length })}
                </h5>
                {selectedRow.requirements.length === 0 ? (
                  <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-detail-requirements-empty">
                    {t('jd.detailRequirementsEmpty')}
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-0.5" data-testid="jd-detail-requirements">
                    {selectedRow.requirements.map((requirement, index) => (
                      <li
                        className="break-all text-[11px] text-slate-300"
                        key={`${selectedRow.jobId}-${String(index)}`}
                      >
                        {requirement}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 break-all text-[11px] text-slate-500" data-testid="jd-detail-source-url">
                  {t('jd.detailSourceUrl', { url: selectedRow.sourceUrl })}
                </p>

                {/* 第三段：动作区跟着选中的那一行走，两只键的 data-action 与换装前逐字相同。
                    它们仍是朱砂——都是会离开这台机器的动作（曾经一只涂青瓷、一只涂琥珀，读起来像"一个安全
                    一个只写本机"，正是要避免的误读，§8.3 的界面表达）。 */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-strong pt-2">
                  <span className="min-w-0 flex-1 break-all text-[11px] text-slate-400" data-testid="jd-action-target">
                    {t('jd.actionTarget', { title: selectedRow.title, company: selectedRow.company })}
                  </span>
                  <DeskButton
                    action={`greet-${selectedRow.jobId}`}
                    variant="seal"
                    compact
                    busy={!!busy}
                    disabled={isActionDisabled}
                    disabledReason={isActionDisabled ? 'ACTION_BUSY' : undefined}
                    disabledReasonLabel={isActionDisabled ? t('jd.reasonBusy') : undefined}
                    onClick={() => greet(selectedRow)}
                  >
                    <Send size={12} />
                    {t('jd.greetButton')}
                  </DeskButton>
                  <DeskButton
                    action={`deliver-${selectedRow.jobId}`}
                    variant="seal"
                    compact
                    busy={!!busy}
                    disabled={isActionDisabled}
                    disabledReason={isActionDisabled ? 'ACTION_BUSY' : undefined}
                    disabledReasonLabel={isActionDisabled ? t('jd.reasonBusy') : undefined}
                    onClick={() => deliver(selectedRow)}
                  >
                    <FileUp size={12} />
                    {t('deliver.rowButton')}
                  </DeskButton>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
