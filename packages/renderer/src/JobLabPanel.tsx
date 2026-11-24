import {
  Briefcase,
  Check,
  Database,
  ExternalLink,
  FileSearch,
  FileText,
  FileUp,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SEARCH_FILTER_DIMENSIONS, type SearchFilterDimension } from '@auto-cc/shared';
import type {
  AppErrorPayload,
  BridgeReply,
  CaptureRunView,
  CaptureStatusView,
  DeliverApprovalView,
  DeliverReceiptView,
  GreetProgressEvent,
  GreetReceiptView,
  JdProgressEvent,
  JdStoreStatusView,
  JobListFilterView,
  JobListResultView,
  JobRowView,
  JobStage,
  SalaryView,
} from '@auto-cc/shared';
import { formatClock } from './format';
import { resolveCapturePlatform, shouldOfferPlatformChoice } from './platform-choice';
import { platformLabel } from './platform-label';
import { ConsentOverlay, ConsentStatusRow } from './ConsentModal';
import {
  ArmButton,
  Banner,
  BLOCK_EDGE_CLASS,
  BLOCK_SURFACE_CLASS,
  DeskButton,
  DeskCheck,
  DeskField,
  DeskSelect,
  DeskFilterField,
  DeskOptionPicker,
  DeskTile,
  OPTION_PICKER_THRESHOLD,
  Tag,
} from './ui/controls';
import { DeskActionRow, DeskExplainer, DeskPathGuide, DeskSection } from './ui/disclosure';
import { Modal } from './ui/overlays';
import { matchHits, type MatchCriteria } from './jobMatch';
import { DeskProgressLog, type DeskProgressEntry } from './ui/progress-log';
import { useBridgeAction } from './useBridgeAction';
import { useConsent } from './useConsent';
import { advanceViewTrail } from './viewTrail';

/** 进度播报最多留几条：面板是验收入口，不是历史库（与定位实验台的自愈播报同一形状）。 */
const PROGRESS_LIMIT = 4;

/** 库内清单一次画多少行：默认 100 条，按 `filter-more` 每次再加 100（服务端上限 500）。 */
const ROW_DISPLAY_LIMIT = 100;
const ROW_PAGE_STEP = 100;

/**
 * 筛选维度的标签 key（**显式映射表**，2026-11-23 的 P1 就是从这里漏出去的）。
 *
 * 上一轮写成 `t(\`jd.filterLabel.${dimension}\`)`：维度是运行期拼的，语言包缺 `experience` 时
 * 界面直接把 `jd.filterLabel.experience` 画给用户看，而机检只看得到写死的 `t(…)` 的字符串实参。
 * 现在改成 `Record<SearchFilterDimension, string>`：**少一个维度就编译不过**；
 * 每个 key 又是字面量，机检与单测都能核到语言包里有没有。
 */
const FILTER_LABEL_KEY: Record<SearchFilterDimension, string> = {
  district: 'jd.filterLabel.district',
  experience: 'jd.filterLabel.experience',
  degree: 'jd.filterLabel.degree',
  salary: 'jd.filterLabel.salary',
  scale: 'jd.filterLabel.scale',
  jobType: 'jd.filterLabel.jobType',
  stage: 'jd.filterLabel.stage',
  industry: 'jd.filterLabel.industry',
  position: 'jd.filterLabel.position',
  city: 'jd.filterLabel.city',
};

/**
 * 取某个维度的标签 key；知识包若给出清单之外的维度（不该发生），退回「筛选」而不是画一个裸 key。
 * @param dimension 维度名（来自平台知识包，不可信输入）
 * @returns 语言包里的 key 或兜底 key
 */
function filterLabelKey(dimension: string): string {
  return (SEARCH_FILTER_DIMENSIONS as readonly string[]).includes(dimension)
    ? FILTER_LABEL_KEY[dimension as SearchFilterDimension]
    : 'jd.filterLabel.fallback';
}

/**
 * 把界面上选中的附加筛选摊成抓取入参的字段（2026-11-23 实测的 9 维）。
 *
 * 知识包里的维度名与契约字段名不是一套（`district` / `scale` / `stage` 更短），换算写在这一处；
 * 空串表示「不限」，**不传**而不是传空串（传空串会让站点把这一维当成已筛且筛空）。
 * @param selected 维度名 → 人话标签
 * @returns 只含已选维度的契约字段
 */
function extraCriteria(selected: Record<string, string>): Record<string, string> {
  const fieldOf: Record<string, string> = {
    district: 'cityDistrict',
    scale: 'companyScale',
    stage: 'financingStage',
  };
  const out: Record<string, string> = {};
  for (const [dimension, label] of Object.entries(selected)) {
    if (label === '') continue;
    out[fieldOf[dimension] ?? dimension] = label;
  }
  return out;
}

/**
 * 卡片上那三个状态点（2026-11-23 用户裁定①）：「已定制 / 已打招呼 / 已投递」各自独立。
 *
 * 判据只取**库里真有的**那一列状态（`journey.tracking.list` 的 `state`）与「对方回过话」那一位：
 * - 已定制：状态到过 `tailored` 及其之后（定制过就一直是定制过，后面不会退回去）；
 * - 已打招呼：到过 `greeted` 及其之后；
 * - 已投递：到过 `delivered` 及其之后（`interviewed` 同样算投递过）；
 * - 已回复：`jobs` 行上的 `replied`（会话里有招聘者方向的消息），与状态列正交——有人回话但没记录过状态也成立。
 * 状态未知（`state === null`，从没记录过事件）时前三个点全灭：不替它猜「captured」。
 * @param stage 该岗位当前跟踪态；null 表示没记录过
 * @param replied 对方是否回过话
 * @returns 有序的状态点（标签用于 i18n key 与 `data-card-dot`）
 */
function cardStatusDots(
  stage: JobStage | null,
  replied: boolean,
): { label: 'tailored' | 'greeted' | 'delivered' | 'replied'; on: boolean }[] {
  const reached = (target: JobStage): boolean => {
    if (stage === null) return false;
    const order: JobStage[] = ['captured', 'matched', 'tailored', 'greeted', 'replied', 'delivered', 'interviewed'];
    const at = order.indexOf(stage);
    const want = order.indexOf(target);
    // `closed` 不在推进序列里（它是终态）：关掉的岗位按「关之前到过哪儿」判不了，于是三点按未达成画，
    // 让「已关闭」那一位由追踪面板去说，卡片上不编。
    return at >= 0 && want >= 0 && at >= want;
  };
  return [
    { label: 'tailored', on: reached('tailored') },
    { label: 'greeted', on: reached('greeted') },
    { label: 'delivered', on: reached('delivered') },
    { label: 'replied', on: replied },
  ];
}

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
  /**
   * 本次要搜哪个平台（spec 2.3-12）：只在有多个可抓取平台时由人改。
   * 留空 = 跟 `jd.capture.status` 的默认平台走；平台清单变了而旧选择失效时也会落回默认。
   */
  const [platformDraft, setPlatformDraft] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');
  const [cityDraft, setCityDraft] = useState('');
  const [experienceDraft, setExperienceDraft] = useState('');
  /** 本次目标条数（`criteria.limit`）：填了就压过配置的 `targetCount`，让 2.3-06 的「达目标即停」能在界面上演示。 */
  const [limitDraft, setLimitDraft] = useState('');
  /**
   * 附加筛选（2026-11-23）：维度名 → 界面上选中的**人话标签**（如 `experience: '3-5年'`）。
   *
   * 界面只存人话、不存码：码表在平台知识包里，换算在适配器一侧（2026-11-23 实测 9 维，
   * 界面自己拼码就等于把站点知识抄进渲染层）。空串表示这一维「不限」。
   */
  const [extraFilters, setExtraFilters] = useState<Record<string, string>>({});
  /**
   * 本次真正发出去的搜索条件：弹窗里的「匹配理由」按它推。
   * 与库内筛选的 `activeFilterRef` 同一口径——只认已发出的那一份，不认输入框草稿。
   */
  const [lastCriteria, setLastCriteria] = useState<MatchCriteria>({});
  /**
   * 当前平台**真正能发**的筛选维度与取值（来自 `platform.registry.list()` 的 `searchFilters`）。
   *
   * 「能发」的判据在知识包：既有参数名、又有标签表。没登记的维度不上屏——
   * 否则就是一个按了没反应的控件，正是「看起来能筛」那种谎话。
   */
  const [searchFilters, setSearchFilters] = useState<{ dimension: string; labels: string[] }[]>([]);
  /** 区县码表属于哪个城市（知识包声明；与城市不符时区县清空+禁用，2026-11-23 裁定②）。 */
  const [districtCity, setDistrictCity] = useState<string | undefined>(undefined);
  /** 此刻展开着长列表选择器的维度名（原地替换那一格；null = 都收起）。 */
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  // Esc 的层级（2026-11-23 裁定③）：选择器展开时先关选择器，**不**让这一下冒到助手面板那一层。
  // 用捕获阶段 + stopPropagation：浮层的 Esc 监听挂在 window 冒泡阶段，捕获先跑就能把它截住。
  useEffect(() => {
    if (openPicker === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      setOpenPicker(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openPicker]);

  // 知识包热换之后界面要重读维度（Q5）：`plugins.saveConfig` 会重建下游服务，而渲染层只在
  // 平台变化时读一次 `platform.registry.list()`，于是新增/删除维度要 reload 才出现。
  // 这里在窗口重新获得焦点时补读一次：不吃掉「换包」这件事，也不再要求人去 reload。
  const registryTick = useRef(0);
  useEffect(() => {
    const onFocus = (): void => {
      registryTick.current += 1;
      setExtraFilters((previous) => previous);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  /**
   * 区县这一维此刻能不能用（2026-11-23 裁定②）：只有「城市 == 知识包声明的 districtCity」才放行。
   * 现在那份区县表全是上海的码；切到北京还留着「徐汇区」，等于把上海区码塞给北京——
   * 「界面说筛了、实际筛错」比没筛更糟，所以其余情况清空 + 禁用 + 说明。
   */
  const districtEnabled = districtCity !== undefined && cityDraft.trim() === districtCity;
  // 城市一变：新的城市没有区县码时，把已选的区县清掉（否则会带着上海的「徐汇区」去搜北京）。
  useEffect(() => {
    if (districtEnabled) return;
    setExtraFilters((previous) =>
      previous.district === undefined || previous.district === '' ? previous : { ...previous, district: '' },
    );
  }, [districtEnabled]);

  const declaresExperience = searchFilters.some((filter) => filter.dimension === 'experience');
  /** 城市那一维（有码表才走选择器；仿站那份包没有，退回手输框）。它单独占一行，不进下面的筛选网格。 */
  const cityFilter = searchFilters.find((filter) => filter.dimension === 'city');
  /** 简历 PDF 的绝对路径：留空则由主进程用 `outbound.deliver` 配置里的 `resumeFile`（P3 之前的临时入口）。 */
  const [resumePathDraft, setResumePathDraft] = useState('');
  /** 最近一次打招呼的回执（`GreetReceiptView`）：闸门拒了就没有回执，界面上只剩结构化错误（spec 2.5-02）。 */
  const [lastGreet, setLastGreet] = useState<GreetReceiptView>();
  /** 最近一次打招呼的阶段流水（spec 2.5-16）：最新在前，只在它跑的那一条目标上累积。 */
  const [greetProgress, setGreetProgress] = useState<GreetProgressEvent[]>([]);
  /** 当前这次打招呼的目标（`platform:target`），用来过滤掉别的面板/别条岗位的进度事件。 */
  const greetTargetRef = useRef('');
  /** 同一目标的可渲染副本：详情区换了行之后，旧目标的流水不该长在新行下面。 */
  const [greetTargetKey, setGreetTargetKey] = useState('');
  /** 最近一次投递回执：`committed:false` 就是 `suggest` 档的待发送态（spec 2.6-06）。 */
  const [lastDeliver, setLastDeliver] = useState<DeliverReceiptView>();
  /** 此刻在等的投递单（spec 2.6-01）：只由 `outbound.deliver.pending()` 的读数填，界面不自造。 */
  const [pendingApprovals, setPendingApprovals] = useState<DeliverApprovalView[]>([]);
  /**
   * 清单里此刻指向哪一行（spec 6.4-04 的三段式）：只存 key，详情与动作段都从 `jobList` 里现取那一行，
   * 不另存一份行数据——存了就出现"清单刷新而详情还停在旧值"的两套事实（§2.5）。
   */
  const [selectedRowKey, setSelectedRowKey] = useState<string>();
  /**
   * 库内筛选的草稿与**当前生效条件**分开：草稿只跟输入框走，按下「筛选」才写进 ref 并重读。
   * 用 ref 而不是 state 持有生效条件，是因为 `useBridgeAction` 的 `run` 收尾会调 `read()`，
   * 而 `read` 在同一个闭包里跑——state 还没提交时它会拿旧筛选条件把刚筛好的清单覆盖掉。
   */
  const [filterKeyword, setFilterKeyword] = useState('');
  /** 库内筛选不再单列城市格（10.10-08）：城市只在搜索条件那一只框里填，库内仍按关键词/经验/已回复筛。 */
  const [filterExperience, setFilterExperience] = useState('');
  const [filterReplied, setFilterReplied] = useState(false);
  /**
   * 详情弹窗是否开着（2026-11-23 用户裁定：岗位卡片平铺，点开用弹窗看详情）。
   * 与 `selectedRowKey` 分开：选中态决定"弹窗里画哪一条"，这个布尔决定"弹窗开不开"——
   * 关掉弹窗不该把选中态一起丢掉，否则重开时又得当没选过。
   */
  const [detailOpen, setDetailOpen] = useState(false);

  /**
   * 岗位跟踪态（`journey.tracking.list` 的投影）：卡片上的「已定制 / 已打招呼 / 已投递」三个点靠它。
   *
   * 为什么现读而不是从 `jobList` 的行里取：`jobs` 表没有这几列（那是追踪域的事实，spec 10.8-01），
   * 在渲染层拼一份就成了第二份真相。读失败时保持空表：卡片少一个点，不影响任何动作。
   */
  const [trackingByJob, setTrackingByJob] = useState<Map<string, JobStage | null>>(new Map());
  /** 让跟踪态重读一次的信号（打招呼/投递之后点会变）。 */
  const [trackingTick, setTrackingTick] = useState(0);
  const activeFilterRef = useRef<JobListFilterView>({});
  const listLimitRef = useRef(ROW_DISPLAY_LIMIT);
  const bridge = window.autoCC;
  const { refresh: refreshConsent, ...consent } = useConsent();
  /** 当前能跑抓取的平台（服务侧按适配器能力给出，界面不自己维护名单）。 */
  const searchPlatforms = captureStatus?.platforms ?? [];
  /** 本次实际会挂载并搜索的平台：人选的优先，其次默认平台，最后退到清单第一条。 */
  const effectivePlatform = resolveCapturePlatform(searchPlatforms, captureStatus?.platform ?? '', platformDraft);

  const read = useCallback(async () => {
    const [captureReply, storeReply, listReply, pendingReply] = await Promise.all([
      bridge?.jd['capture.status'](),
      bridge?.jd['store.status'](),
      bridge?.jd['store.list'](listLimitRef.current, activeFilterRef.current),
      bridge?.outbound['deliver.pending'](),
    ]);
    if (captureReply?.ok) setCaptureStatus(captureReply.value);
    if (storeReply?.ok) setStoreStatus(storeReply.value);
    if (listReply?.ok) setJobList(listReply.value);
    // 待确认单**每次都读**：它是「此刻有没有人在等」的状态，漏读就等于把用户晾在那里。
    if (pendingReply?.ok) setPendingApprovals(pendingReply.value);
    // 签字状态跟着这一遍一起刷：界面每重读一次快照就把「这个平台签过没有」再取一遍原文，
    // 「重启 / reload 之后仍然显示已确认、且不再弹卡片」（spec 2.7-06 的「出现一次」）靠这行才有证据。
    const platforms = new Set<string>();
    // 多平台时每一只都可能被选中（spec 2.3-12），签字读数要一次刷齐，切换时不必再等一次读。
    if (captureReply?.ok) {
      platforms.add(captureReply.value.platform);
      for (const platform of captureReply.value.platforms) platforms.add(platform);
    }
    if (listReply?.ok) {
      for (const row of listReply.value.rows) platforms.add(row.platform);
    }
    await refreshConsent([...platforms]);
  }, [bridge, refreshConsent]);

  const { busy, notice, noticeTone, run } = useBridgeAction(read);
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

  /**
   * 这一屏重新可见时重读快照（10.10 补格：改过平台配置后搜索键会一直停在
   * `NO_SEARCH_PLATFORM` 禁用态——面板只在挂载时读一次 `jd.capture.status`，
   * 配置热改重建服务后它不重读，人看到的就是一颗"点了没反应"的键）。
   *
   * 用回调 ref 挂观察器：视图是 `hidden` 切换、面板本体常驻，只有真正被切到这一屏时才相交。
   */
  const observerRef = useRef<IntersectionObserver | undefined>(undefined);
  const attachVisibleWatcher = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      if (!node || typeof IntersectionObserver === 'undefined') return;
      observerRef.current = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void read();
      });
      observerRef.current.observe(node);
    },
    [read],
  );

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
    // 打招呼的阶段流水（spec 2.5-16）：只收当前这一条目标的，别条岗位/别的面板的进度不往这里混。
    const offGreetProgress = bridge.on('outbound/greet-progress', (payload) => {
      if (`${payload.platform}:${payload.target}` !== greetTargetRef.current) return;
      setGreetProgress((current) => [payload, ...current].slice(0, 9));
    });
    return () => {
      offProgress();
      offApproval();
      offGreetProgress();
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
   * 打招呼阶段码 → 一句人话（spec 2.5-16）。
   *
   * 频控与落账两格带数字：前者让人知道还要等多久，后者与回执里的账本行号对得上。
   * @param event 主进程推来的阶段读数
   * @returns 已翻译的一句
   */
  const greetProgressText = (event: GreetProgressEvent): string => {
    switch (event.phase) {
      case 'consent':
        return t('jd.greetPhase.consent');
      case 'channel':
        return t('jd.greetPhase.channel');
      case 'duplicate':
        return t('jd.greetPhase.duplicate');
      case 'content':
        return event.mode === 'script' ? t('jd.greetPhase.contentScript') : t('jd.greetPhase.contentManual');
      case 'blacklist':
        return t('jd.greetPhase.blacklist');
      case 'quota':
        return t('jd.greetPhase.quota');
      case 'throttle':
        return (event.waitedMs ?? 0) > 0
          ? t('jd.greetPhase.throttleWait', { seconds: Math.ceil((event.waitedMs ?? 0) / 1000) })
          : t('jd.greetPhase.throttle');
      case 'send':
        return t('jd.greetPhase.send');
      case 'done':
        return event.ledgerId === undefined
          ? t('jd.greetPhase.doneGeneric')
          : t('jd.greetPhase.done', { ledgerId: event.ledgerId });
    }
  };

  /**
   * 跑一轮抓取：滚动收集列表 + 逐条读详情 + 幂等入库，页面侧不点打招呼也不投简历，
   * 但**这一整轮本身占 `search` 那一条日额度**（spec 2.7-03），到量会直接被闸门拒掉。
   * 搜索条件取界面上的关键词（必填）与城市 / 经验 / 本次目标条数（均可空）。
   *
   * 动作先过 `consent.ensure`（spec 2.7-06 的界面拦截点 ①）：抓取属于哪个平台只由
   * `jd.capture.status` 的平台清单说出，界面不猜；还没读到配置时交空列表，
   * 由释放路径上那道硬拦（拦截点 ②）给出结构化错误。
   *
   * 开搜之前会**自动挂载目标平台的会话视图**（spec 2.3-12）：只有一个可抓取平台时直接挂它，
   * 多个时用上面选的那一个。这样人不必先去会话面板手动「打开站点」，也避免
   * `NO_KERNEL_SESSION` 把一次正常的搜索变成失败。
   */
  const capture = () => {
    const keyword = keywordDraft.trim();
    const limit = Number(limitDraft);
    return void consent.ensure(effectivePlatform === '' ? [] : [effectivePlatform], () => {
      void run(
        t('jd.actionRun', { keyword }),
        () => {
          if (!bridge) return undefined;
          return (async (): Promise<BridgeReply<CaptureRunView>> => {
            // 抓取要一块装着平台的内核视图（spec 2.3-12）：先看当前挂的是不是要搜的平台，
            // 不是就先 `sessions.open` 挂上去再搜。已挂对时不再重建视图——重建会把用户正在看的页面换掉。
            if (effectivePlatform !== '') {
              const status = await bridge.sessions.status();
              if (!status.ok) return { ok: false, error: status.error };
              if (status.value.activePlatform !== effectivePlatform) {
                const opened = await bridge.sessions.open(effectivePlatform);
                if (!opened.ok) return { ok: false, error: opened.error };
              }
            }
            const criteria: MatchCriteria = {
              keyword,
              city: cityDraft.trim() || undefined,
              cityDistrict: extraFilters.district || undefined,
              experience: (declaresExperience ? (extraFilters.experience ?? '') : experienceDraft.trim()) || undefined,
              degree: extraFilters.degree || undefined,
              salary: extraFilters.salary || undefined,
            };
            setLastCriteria(criteria);
            return bridge.jd['capture.run'](
              {
                keyword,
                city: cityDraft.trim() || undefined,
                // 平台声明了「经验」维度时以那一格下拉为准；没声明才走自由文本（仿站那一档）。
                experience:
                  (declaresExperience ? (extraFilters.experience ?? '') : experienceDraft.trim()) || undefined,
                ...extraCriteria(extraFilters),
                limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
              },
              effectivePlatform === '' ? undefined : effectivePlatform,
            );
          })();
        },
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

  /**
   * 读一次「这个平台能发哪些筛选维度」（`platform.registry.list()` 的 `searchFilters`）。
   *
   * 跟随当前在跑的平台：换平台后下拉里那一组标签也要跟着换（两个站点的枚举本来就不一样）。
   * 读不到就交空数组：界面退回「只有关键词与城市」，不是一个按了没反应的控件。
   */
  useEffect(() => {
    const client = window.autoCC;
    if (!client || effectivePlatform === '') {
      setSearchFilters([]);
      return;
    }
    void (async () => {
      const reply = await client.platform['registry.list']();
      if (!reply.ok) return;
      const platform = reply.value.platforms.find((item) => item.id === effectivePlatform);
      setSearchFilters(platform?.searchFilters ?? []);
      setDistrictCity(platform?.searchDistrictCity);
    })();
  }, [effectivePlatform]);

  /**
   * 读一次岗位跟踪态，投影成 `平台|岗位 → 状态` 的表（卡片上的状态点用它）。
   *
   * 读失败就保持上一份：这一格只是卡片上的三个小点，不该因为追踪服务没挂载就把整屏标红。
   * 重读时机是清单换了、或打过招呼/投递之后（`trackingTick`）——不轮询。
   */
  useEffect(() => {
    const client = window.autoCC;
    if (!client) return;
    void (async () => {
      const reply = await client.journey['tracking.list']();
      if (!reply.ok) return;
      const next = new Map<string, JobStage | null>();
      for (const row of reply.value) next.set(`${row.platform}|${row.jobId}`, row.state);
      setTrackingByJob(next);
    })();
  }, [trackingTick, jobList]);

  /**
   * 读库内清单（`jd.store.list`），用来证明重启后行还在、幂等没有翻倍（spec 2.3-04）。
   * @param filter 生效中的筛选条件（默认取 ref 里那一份，保证动作后重读仍按同一条件）
   * @param limit 本次画多少行（默认取当前分页档）
   */
  const listJobs = (filter: JobListFilterView = activeFilterRef.current, limit = listLimitRef.current) => {
    return void run(t('jd.actionList'), () => bridge?.jd['store.list'](limit, filter), {
      apply: (value) => {
        setBridgeError(undefined);
        setJobList(value);
      },
      describe: (value) => t('jd.noticeList', { shown: value.rows.length, matched: value.matched, total: value.total }),
      onError: setBridgeError,
    });
  };

  /**
   * 删除一条库内岗位（2026-11-24 用户裁定）。
   *
   * 只清「库内岗位 + 抓到的详情」（同一张 `jobs` 表），账本 / 投递记录 / 追踪 / 会话一律保留——
   * 那是审计事实：删岗位不等于那件事没发生过。界面上用两步 armed 键做二次确认，
   * 文案明说「投递与沟通记录会保留」。删完关弹窗并重读列表（Home/统计由下一次读取同步）。
   * @param row 当前弹窗指着的那一行
   */
  const removeJob = (row: JobRowView): void => {
    void run(t('jd.removeAction'), () => bridge?.jd['store.remove'](row.jobId, row.platform), {
      apply: () => {
        setBridgeError(undefined);
        setDetailOpen(false);
        setSelectedRowKey(undefined);
        listJobs();
      },
      describe: (value) => t('jd.removeDone', { title: row.title, removed: value.removed }),
      onError: setBridgeError,
    });
  };

  /**
   * 把筛选草稿收成服务端条件。
   * @returns 只带非空字段的筛选对象；全空时返回空对象（服务端按「不筛」处理）
   */
  const draftFilter = (): JobListFilterView => {
    const keyword = filterKeyword.trim();
    const experience = filterExperience.trim();
    // 城市不再是库里单独那一格（10.10-08）：搜索条件那只城市框已经决定了入库的城市，
    // 库内再筛一次只会让人以为“要填两遍城市”，服务端那份 city 条件因此不从这里出。
    return {
      ...(keyword === '' ? {} : { keyword }),
      ...(experience === '' ? {} : { experience }),
      ...(filterReplied ? { replied: true } : {}),
    };
  };

  /** 按下「筛选」：把草稿写进生效条件并回到第一页重读。 */
  const applyFilter = () => {
    const next = draftFilter();
    activeFilterRef.current = next;
    listLimitRef.current = ROW_DISPLAY_LIMIT;
    listJobs(next, ROW_DISPLAY_LIMIT);
  };

  /** 清空筛选：输入框与生效条件一起复位，回到全库第一页。 */
  const clearFilter = () => {
    setFilterKeyword('');
    setFilterExperience('');
    setFilterReplied(false);
    activeFilterRef.current = {};
    listLimitRef.current = ROW_DISPLAY_LIMIT;
    listJobs({}, ROW_DISPLAY_LIMIT);
  };

  /** 再画一页：每按一次加 100 行，服务端自己会钳到 500。 */
  const loadMore = () => {
    const nextLimit = Math.min(listLimitRef.current + ROW_PAGE_STEP, 500);
    listLimitRef.current = nextLimit;
    listJobs(activeFilterRef.current, nextLimit);
  };

  /**
   * 把某个岗位交给内核视图：先按平台挂载会话（会自动显示右栏网页窗口），再导航到这一行的来源地址。
   * 用户随后在真实页面里自己聊天、投递；这里只负责把人送到那一页，不代点任何按钮。
   * @param row 库内这一行（`platform` 决定会话分区，`sourceUrl` 是岗位详情页）
   */
  const openJobPage = (row: JobRowView) =>
    void run(
      t('jd.actionOpenPage', { title: row.title }),
      () => {
        if (!bridge) return undefined;
        return (async () => {
          const opened = await bridge.sessions.open(row.platform);
          if (!opened.ok) return opened;
          return await bridge.browser['page.navigate'](row.sourceUrl);
        })();
      },
      {
        describe: (page) => t('jd.noticeOpenPage', { url: page.url }),
        onError: setBridgeError,
      },
    );

  /**
   * 进入简历页的生成子页面；带上这一行的正文作为 JD 种子（没有正文就不带，避免擦掉人已经写好的文字）。
   * @param row 选中的岗位；省略 = 顶部总入口，只切到生成页
   */
  const generateResume = (row?: JobRowView) => {
    advanceViewTrail({
      sourceView: 'jobs',
      sourceTitle: t('desk.jobs.title'),
      sourceDetail: row?.title,
      targetView: 'resume',
      targetTitle: t('desk.resume.title'),
      targetDetail: t('generate.heading'),
      seedJdText: row !== undefined && row.description.length > 0 ? row.description : undefined,
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
      greetTargetRef.current = `${row.platform}:${row.jobId}`;
      setGreetTargetKey(greetTargetRef.current);
      setGreetProgress([]);
      setLastGreet(undefined);
      void run(
        t('jd.actionGreet', { title: row.title }),
        () =>
          bridge?.outbound['greet.perform']({
            platform: row.platform,
            jobId: row.jobId,
            script: { jdId: row.jobId, title: row.title, company: row.company },
          }),
        {
          apply: (receipt) => {
            setBridgeError(undefined);
            setLastGreet(receipt);
            // 打过招呼之后卡片上那个点要亮起来：代码里没有别的事件会说「状态变了」，只能现读一次。
            setTrackingTick((tick) => tick + 1);
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
            setTrackingTick((tick) => tick + 1);
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
  /**
   * 抓取按钮此刻按不动的第一原因：没有关键词先说关键词，平台包全被摘掉时再说平台。
   * 没读到状态（`captureStatus` 还没回来）不算「没有平台」——那只是还没读，不是配置缺失。
   */
  const captureBlockedReason = !keywordDraft.trim()
    ? 'KEYWORD_EMPTY'
    : captureStatus !== undefined && searchPlatforms.length === 0
      ? 'NO_SEARCH_PLATFORM'
      : undefined;
  /** 一行的稳定标识：列表 key 与选中态共用这一处来源，不让两处各拼一遍。 */
  const rowKey = (row: JobRowView): string => `${row.platform}-${String(row.id)}`;

  /** 此刻指向的那一行：从 `jobList` 现取；清单换过一批取不到时按"没选"处理，详情与动作段一起收起。 */
  const selectedRow = jobList?.rows.find((row) => rowKey(row) === selectedRowKey);
  /** 选中行的打招呼坐标：流水只挂回它自己的那一行，换行后不会伪装成新一行的进度。 */
  const selectedGreetTarget = selectedRow === undefined ? '' : `${selectedRow.platform}:${selectedRow.jobId}`;
  /**
   * 最新一条进度：`progress` 是**新的在前**（推送时 prepend 并截到 `PROGRESS_LIMIT`），所以 [0] 就是"此刻"。
   * 进度段默认收起之后，这一条还要在段头那一行读数里说话——收起不能把"跑到哪了"一起收走。
   */
  const latestProgress = progress?.[0];
  /** 打招呼流水已翻成上屏条目；最新一条是当前所在的那一步。 */
  const greetProgressEntries: DeskProgressEntry[] = greetProgress.map((event, index) => ({
    key: `${event.phase}-${String(event.step)}-${String(event.at)}`,
    phase: event.phase,
    step: event.step,
    total: event.total,
    at: event.at,
    active: index === 0,
    text: greetProgressText(event),
  }));
  return (
    <div ref={attachVisibleWatcher} className="flex flex-col gap-4" data-testid="job-lab">
      {/* 搜岗这一屏的三问（spec 10.10-16）：下一步那颗键把焦点送到关键词框，出口去简历页。 */}
      <DeskPathGuide
        testid="jobs-path-guide"
        here={t('guide.jobs.here')}
        next={t('guide.jobs.next')}
        exit={t('guide.jobs.exit')}
        focusSelector='[data-action="jd-keyword"]'
        focusLabel={t('guide.focus')}
      />
      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Briefcase size={16} />
            {t('jd.heading')}
          </h2>
          <div className="flex items-center gap-2">
            <DeskButton action="jd-generate-resume" variant="line" compact onClick={() => generateResume()}>
              <FileText size={12} />
              {t('jd.generateResume')}
            </DeskButton>
            <DeskButton action="refresh" variant="line" compact busy={!!busy} onClick={() => void read()}>
              <RefreshCw size={12} />
              {t('jd.refresh')}
            </DeskButton>
          </div>
        </div>

        {/* 「抓取」这个词第一次出现时就给白话（spec 10.10-07）：不进设置页也能知道这一屏在做什么。 */}
        <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-capture-gloss">
          {t('jd.captureHint')}
        </p>
        <p className="mt-2 text-[11px] text-slate-500" data-testid="jd-config">
          {t('jd.config', {
            targetCount: captureStatus?.targetCount ?? '-',
            maxRounds: captureStatus?.maxRounds ?? '-',
          })}
        </p>
        <p
          className="mt-1 text-[11px] text-slate-400"
          data-testid="jd-store-status"
          data-schema-version={String(storeStatus?.schemaVersion ?? '')}
        >
          {storeStatus
            ? t('jd.storeStatus', { total: storeStatus.total, withDetail: storeStatus.withDetail })
            : t('jd.storeIdle')}
        </p>
        {storeStatus?.newestSourceUrl && (
          <p className="mt-1 break-all text-[11px] text-slate-500" data-testid="jd-newest-source">
            {t('jd.newestSource', { url: storeStatus.newestSourceUrl })}
          </p>
        )}
        {captureStatus && <ConsentStatusRow view={consent.views[effectivePlatform]} />}
      </section>

      <ConsentOverlay consent={consent} />

      <section className="@container rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.criteriaHeading')}</h3>
        {/* 多平台才需要人挑（spec 2.3-12）：只有一个可抓取平台时省掉这一格，点搜索就直接挂它。 */}
        {shouldOfferPlatformChoice(searchPlatforms) && (
          <div className="mt-2" data-testid="jd-platform-picker">
            <DeskSelect
              action="jd-platform"
              data-testid="jd-platform"
              label={t('jd.platformLabel')}
              value={effectivePlatform}
              onValueChange={setPlatformDraft}
              className="w-full"
            >
              {searchPlatforms.map((platform) => (
                <option key={platform} value={platform}>
                  {platformLabel(t, platform)}
                </option>
              ))}
            </DeskSelect>
          </div>
        )}
        <div className="mt-2 flex flex-col gap-2">
          {/* 第一行（2026-11-24 用户裁定：搜索条件不许一个字段占一行）：城市 + 关键词 + 条数同行。
              窄窗（@xl 以下）自动落成一列，不横向溢出。 */}
          <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_6rem]">
            {/* 城市（2026-11-23 裁定①）：知识包有 city 码表就换选择器（373 项 + 搜索），
                打错城市会给 amber 提示，不再是「凭记忆手打、打错静默空结果」。
                没有码表的装配（仿站那份包）保留手输框——那是唯一能用的形态，不硬造码。 */}
            {cityFilter === undefined ? (
              <DeskField
                action="jd-city"
                data-testid="jd-city"
                value={cityDraft}
                onValueChange={setCityDraft}
                placeholder={t('jd.cityPlaceholder')}
                className="flex-1"
              />
            ) : openPicker === 'city' ? (
              <div className="min-w-0 flex-1" data-testid="jd-city-picker">
                <DeskOptionPicker
                  action="jd-picker-city"
                  label={t('jd.filterLabel.city')}
                  labels={cityFilter.labels}
                  value={cityDraft}
                  onChange={setCityDraft}
                  onClose={() => setOpenPicker(null)}
                  searchPlaceholder={t('jd.picker.search')}
                  emptyText={t('jd.picker.empty')}
                  clearText={t('jd.picker.clear')}
                  doneText={t('jd.picker.done')}
                  backText={t('jd.picker.back')}
                  clearSearchText={t('jd.picker.clearSearch')}
                />
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <DeskFilterField
                  action="jd-city"
                  testid="jd-city"
                  label={t('jd.filterLabel.city')}
                  value={cityDraft}
                  placeholder={t('jd.cityPlaceholder')}
                  unknown={
                    cityDraft !== '' && !cityFilter.labels.includes(cityDraft)
                      ? t('jd.picker.unknown', { value: cityDraft })
                      : undefined
                  }
                  onOpen={() => setOpenPicker('city')}
                />
              </div>
            )}
            <DeskField
              action="jd-keyword"
              data-testid="jd-keyword"
              value={keywordDraft}
              onValueChange={setKeywordDraft}
              placeholder={t('jd.keywordPlaceholder')}
            />
            <DeskField
              action="jd-limit"
              type="number"
              min={1}
              data-testid="jd-limit"
              value={limitDraft}
              onValueChange={setLimitDraft}
              placeholder={t('jd.limitPlaceholder')}
            />
          </div>
          {/* 经验那一维：平台声明了码表就走下面的筛选网格（单选下拉），没声明才留这只手输框。 */}
          {declaresExperience ? null : (
            <DeskField
              action="jd-experience"
              data-testid="jd-experience"
              value={experienceDraft}
              onValueChange={setExperienceDraft}
              placeholder={t('jd.experiencePlaceholder')}
            />
          )}
          {/* 附加筛选（2026-11-23 实测 9 维）：**只有知识包声明了参数名与标签表的维度才上屏**。
              这样界面不会长出「看起来能筛」的控件；传了站上不存在的取值由适配器结构化拒绝。 */}
          {searchFilters.length > 0 ? (
            <div
              className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3"
              data-testid="jd-search-filters"
              data-filter-count={searchFilters.length}
            >
              {searchFilters
                .filter((filter) => filter.dimension !== 'city')
                .map((filter) => {
                  const dimensionLabel = t(filterLabelKey(filter.dimension));
                  const current = extraFilters[filter.dimension] ?? '';
                  // 区县按**语义**固定下拉（2026-11-23 裁定②）：它是城市的子级，16 项两下点完，
                  // 不该因为「>12 用选择器」这条数据阈值被换成面板。
                  const forceSelect = filter.dimension === 'district';
                  const districtBlocked = filter.dimension === 'district' && !districtEnabled;
                  // 其余短列表（≤12）用原生下拉；长列表（行业 145 / 职位类型 134）换原地选择器。
                  if (forceSelect || filter.labels.length <= OPTION_PICKER_THRESHOLD) {
                    return (
                      <DeskSelect
                        key={filter.dimension}
                        action={`jd-filter-${filter.dimension}`}
                        data-testid={`jd-filter-${filter.dimension}`}
                        label={dimensionLabel}
                        value={current}
                        onValueChange={(value) =>
                          setExtraFilters((previous) => ({ ...previous, [filter.dimension]: value }))
                        }
                        className="w-full"
                        {...(districtBlocked
                          ? {
                              disabled: true,
                              // 原生禁用也一起给（2026-11-23 第 10 轮裁定②）：北京态下原本能展开、能点、
                              // 被组件弹回，「点了没反应」比「点不动」更难懂。
                              hardDisabled: true,
                              disabledReason: 'DISTRICT_CITY_MISMATCH',
                              disabledReasonLabel: t('jd.districtUnavailable', { city: districtCity ?? '—' }),
                            }
                          : {})}
                      >
                        <option value="">{t('jd.filterAny')}</option>
                        {filter.labels.map((label) => (
                          <option key={label} value={label}>
                            {label}
                          </option>
                        ))}
                      </DeskSelect>
                    );
                  }
                  if (openPicker === filter.dimension) {
                    return (
                      <div key={filter.dimension} className="@2xl:col-span-2 @4xl:col-span-2">
                        <DeskOptionPicker
                          action={`jd-picker-${filter.dimension}`}
                          label={dimensionLabel}
                          labels={filter.labels}
                          value={current}
                          onChange={(value) =>
                            setExtraFilters((previous) => ({ ...previous, [filter.dimension]: value }))
                          }
                          onClose={() => setOpenPicker(null)}
                          searchPlaceholder={t('jd.picker.search')}
                          emptyText={t('jd.picker.empty')}
                          clearText={t('jd.picker.clear')}
                          doneText={t('jd.picker.done')}
                          backText={t('jd.picker.back')}
                          clearSearchText={t('jd.picker.clearSearch')}
                        />
                      </div>
                    );
                  }
                  return (
                    <DeskFilterField
                      key={filter.dimension}
                      action={`jd-filter-${filter.dimension}`}
                      label={dimensionLabel}
                      value={current}
                      placeholder={t('jd.filterAny')}
                      unknown={
                        current !== '' && !filter.labels.includes(current)
                          ? t('jd.picker.unknown', { value: current })
                          : undefined
                      }
                      onOpen={() => setOpenPicker(filter.dimension)}
                    />
                  );
                })}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            {/* 抓取走实心（它是这一屏的主操作，效果档是读）；外发那两只才是朱砂 */}
            <DeskButton
              action="capture"
              variant="solid"
              compact
              busy={!!busy}
              disabled={captureBlockedReason !== undefined}
              disabledReason={captureBlockedReason}
              disabledReasonLabel={
                captureBlockedReason === 'KEYWORD_EMPTY'
                  ? t('jd.reasonKeywordEmpty')
                  : captureBlockedReason === 'NO_SEARCH_PLATFORM'
                    ? t('jd.reasonNoPlatform')
                    : undefined
              }
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
              onClick={() => listJobs()}
            >
              <Database size={12} />
              {t('jd.listButton')}
            </DeskButton>
          </div>
        </div>

        {/* 搜索键按不动时把原因写在明面，并给邻接动作（spec 10.10-18）：没填关键词 → 提示去填；
            没有平台 → 直接给「去登录」入口（它才是这颗键按不动的真正原因）。 */}
        {captureBlockedReason !== undefined ? (
          <div
            className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-amber"
            data-testid="jd-capture-reason"
          >
            <span>
              {captureBlockedReason === 'KEYWORD_EMPTY' ? t('jd.reasonKeywordEmpty') : t('jd.reasonNoPlatform')}
            </span>
            {captureBlockedReason === 'NO_SEARCH_PLATFORM' ? (
              <DeskButton
                action="jd-go-login"
                variant="line"
                compact
                onClick={() =>
                  advanceViewTrail({
                    sourceView: 'jobs',
                    sourceTitle: t('nav.jobs'),
                    targetView: 'trust',
                    targetTitle: t('desk.trust.title'),
                    targetDetail: t('jd.reasonNoPlatform'),
                  })
                }
              >
                {t('jd.goLogin')}
              </DeskButton>
            ) : null}
          </div>
        ) : null}

        {notice && (
          <Banner tone={noticeTone} markers={{ testid: 'jd-notice' }} className="mt-2">
            {notice}
          </Banner>
        )}

        {lastGreet && (
          <Banner
            tone="jade"
            markers={{
              testid: 'jd-greet-receipt',
              origin: lastGreet.origin,
              'job-id': String(lastGreet.jobId ?? ''),
              'ledger-id': String(lastGreet.ledgerId),
              source: lastGreet.source,
            }}
            className="mt-2"
          >
            {/* 与投递回执同一个拆法（规则④）：100 字那一串 `·` 拆成"页面回了什么"和"等了多久"两行，
                对账标识符挪到 markers——`jd-greet-receipt` 这根通道本身一字未改（8.4-01 的证据在读它）。 */}
            <div className="w-full">
              <p className="font-semibold">{t('jd.greetReceiptHeading')}</p>
              <p className="mt-1 flex items-center gap-1.5 break-all">
                <Tag tone="jade">{t(`jd.origin.${lastGreet.origin}`)}</Tag>
                {t('jd.greetReceiptPage', { reason: lastGreet.reason })}
              </p>
              <p className="mt-1 break-all">{t('jd.greetReceiptWait', { waitedMs: lastGreet.waitedMs })}</p>
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

      {/* 清单这一段是**查询容器**：三段式到底并排还是上下走，取决于这一列自己的宽度，而不是视口宽度——
          右栏的内核视图槽位默认整条不存在（裁定⑱），展开时才占 38%（`--kernel-view-width` 与
          KERNEL_VIEW_WIDTH_RATIO 机检同源），1200 宽的窗口在展开态只剩 486px，并排会把详情压到 202px
          （实测读数），所以窄时退回"列表→详情→动作"的纵向读序，宽窗口才兑现 02 稿的横向骨架。 */}
      <section className="@container rounded-xl border border-line bg-ink-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('jd.listHeading')}</h3>
        {/* 库内筛选（spec 9.2-01）：条件在服务端生效，`total/matched/shown` 三只读数同时上屏，
            避免「库里有、界面却一条不见」被读成数据丢了。 */}
        <div className="mt-2 grid min-w-0 gap-2 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <DeskField
            action="jd-filter-keyword"
            data-testid="jd-filter-keyword"
            value={filterKeyword}
            onValueChange={setFilterKeyword}
            placeholder={t('jd.filterKeywordPlaceholder')}
          />
          <DeskField
            action="jd-filter-experience"
            data-testid="jd-filter-experience"
            value={filterExperience}
            onValueChange={setFilterExperience}
            placeholder={t('jd.filterExperiencePlaceholder')}
          />
          <DeskCheck
            action="jd-filter-replied"
            data-testid="jd-filter-replied"
            label={t('jd.filterReplied')}
            checked={filterReplied}
            onCheckedChange={setFilterReplied}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DeskButton
            action="jd-filter-apply"
            variant="line"
            compact
            busy={!!busy}
            disabled={isActionDisabled}
            disabledReason={isActionDisabled ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={isActionDisabled ? t('jd.reasonBusy') : undefined}
            onClick={applyFilter}
          >
            <Search size={12} />
            {t('jd.filterApply')}
          </DeskButton>
          <DeskButton
            action="jd-filter-clear"
            variant="ghost"
            compact
            busy={!!busy}
            disabled={isActionDisabled}
            disabledReason={isActionDisabled ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={isActionDisabled ? t('jd.reasonBusy') : undefined}
            onClick={clearFilter}
          >
            {t('jd.filterClear')}
          </DeskButton>
          {jobList && (
            <span className="text-[11px] text-slate-500" data-testid="jd-filter-summary">
              {t('jd.filterSummary', {
                total: jobList.total,
                matched: jobList.matched,
                shown: jobList.rows.length,
              })}
            </span>
          )}
        </div>
        {!jobList ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="jd-list-idle">
            {t('jd.listIdle')}
          </p>
        ) : jobList.rows.length === 0 && jobList.total === 0 ? (
          // 库内一条都没有 ≠ 筛选没筛到（spec 10.10-08）：干净实例首进这一屏，先说的话必须是「还没搜过」，
          // 而不是「没有符合筛选条件」——后者会让新手以为自己的条件把岗位筛没了，可他从没搜过。
          <p className="mt-2 text-[11px] text-slate-500" data-testid="jd-list-idle">
            {t('jd.listIdle')}
          </p>
        ) : jobList.rows.length === 0 ? (
          <p className="mt-2 text-[11px] text-slate-500" data-testid="jd-filter-empty">
            {t('jd.filterEmpty')}
          </p>
        ) : (
          <>
            {/* 卡片平铺（2026-11-23 用户裁定：岗位要平铺、点开用弹窗看详情）。
                列数按**这一段自己的宽度**走（容器查询），不按视口：右栏网页窗口展开时这一列会变窄，
                按视口判会得到「窗口很宽、卡片却挤成一条」。一列到四列，任何宽度都不横向滚动。 */}
            <ul
              className="mt-2 grid min-w-0 grid-cols-1 gap-2 @md:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4"
              data-testid="jd-cards"
              data-card-count={jobList.rows.length}
            >
              {jobList.rows.map((row) => {
                const stage = trackingByJob.get(`${row.platform}|${row.jobId}`) ?? null;
                const dots = cardStatusDots(stage, row.replied);
                return (
                  <li key={rowKey(row)} className="min-w-0">
                    {/* 整张卡是一个按钮：点哪儿都开详情，不用瞄准某一小块（新手最容易点空的那种形状）。
                        焦点环与 Esc/遮罩关闭由 `<Modal>` 那一层统一管，焦点回位也归它（回的就是这颗按钮）。 */}
                    <DeskTile
                      action={`jd-card-${row.jobId}`}
                      selected={selectedRowKey === rowKey(row)}
                      markers={{
                        'job-card': row.jobId,
                        'job-replied': row.replied ? 'true' : 'false',
                      }}
                      onClick={() => {
                        setSelectedRowKey(rowKey(row));
                        setDetailOpen(true);
                      }}
                    >
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-100">
                          {row.title}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-amber">
                          {row.salaryText || t('agent.tool.jobs.salaryUnknown')}
                        </span>
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-slate-400">{row.company}</span>
                      {/* 等高（2026-11-23 裁定）：这三行都**不换行**（truncate），行数固定，同档同行自然等高。
                          上一版用 flex-wrap，长城市名/长标题折成两行，于是同排出现 129 与 148 两种高度。 */}
                      <span className="flex min-w-0 items-center gap-x-2 overflow-hidden text-[10.5px] text-slate-500">
                        {row.city ? <span className="truncate">{row.city}</span> : null}
                        {row.experience ? <span className="shrink-0">{row.experience}</span> : null}
                        {row.education ? <span className="shrink-0">{row.education}</span> : null}
                      </span>
                      {/* 状态点：只画**真读得到**的那几种。三个点各自独立，不合成一个「进度条」——
                          合成之后人分不清「定制了但没打招呼」与「都没做」。 */}
                      {/* 状态**只写真的达成的**（2026-11-23 裁定）：258 个灰点配四行字会被读成「都投过了」。
                          一条都没达成时只写一句「未投递」，不列四个空状态。 */}
                      <span className="mt-auto flex min-w-0 items-center gap-x-2 overflow-hidden pt-1 text-[10.5px]">
                        {dots.every((dot) => !dot.on) ? (
                          <span className="text-slate-600" data-card-dot="none">
                            {t('jd.cardDot.none')}
                          </span>
                        ) : (
                          dots
                            .filter((dot) => dot.on)
                            .map((dot) => (
                              <span
                                key={dot.label}
                                data-card-dot={dot.label}
                                className="flex items-center gap-1 text-jade"
                              >
                                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-jade" />
                                {t(`jd.cardDot.${dot.label}`)}
                              </span>
                            ))
                        )}
                        {row.detailCapturedAt === null ? (
                          <span className="text-amber" data-card-dot="summary-only">
                            {t('jd.cardDot.summaryOnly')}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[10.5px] text-slate-600">{t('jd.cardOpenHint')}</span>
                    </DeskTile>
                  </li>
                );
              })}
            </ul>

            {/* 详情弹窗（2026-11-23 裁定②）：完整 JD、命中说明与三个动作入口都在这一层。
                Esc / 点遮罩关闭、焦点回原卡片、窄窗铺满可滚都由 `<Modal>` 那一层负责——
                与简历预览用的是同一只浮层，不另开一套。 */}
            <Modal
              action="jd-detail"
              open={detailOpen && selectedRow !== undefined}
              title={selectedRow === undefined ? t('jd.listHeading') : selectedRow.title}
              onClose={() => setDetailOpen(false)}
              width="960"
              dismissOnScrim
              testId="jd-detail-modal"
              closeLabel={t('jd.detailClose')}
              footer={
                selectedRow === undefined ? (
                  <DeskButton action="jd-detail-close" variant="line" compact onClick={() => setDetailOpen(false)}>
                    {t('jd.detailClose')}
                  </DeskButton>
                ) : (
                  <>
                    {/* 删除（2026-11-24 裁定）：两步确认——第一下只武装、四秒内再按一下才删；
                        确认文案里写明「投递与沟通记录会保留」，因为账本/投递/追踪/会话一条都不动。 */}
                    <ArmButton
                      action="jd-remove"
                      confirmAction="jd-remove-confirm"
                      onConfirm={() => removeJob(selectedRow)}
                      armedLabel={t('jd.removeArmed')}
                      tip={t('jd.removeHint')}
                    >
                      {t('jd.removeButton')}
                    </ArmButton>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400" data-testid="jd-action-target">
                      {t('jd.actionTarget', { title: selectedRow.title, company: selectedRow.company })}
                    </span>
                    <DeskButton
                      action="jd-open-page"
                      variant="line"
                      compact
                      busy={!!busy}
                      disabled={isActionDisabled}
                      disabledReason={isActionDisabled ? 'ACTION_BUSY' : undefined}
                      disabledReasonLabel={isActionDisabled ? t('jd.reasonBusy') : undefined}
                      onClick={() => openJobPage(selectedRow)}
                    >
                      <ExternalLink size={12} />
                      {t('jd.openPageButton')}
                    </DeskButton>
                    <DeskButton
                      action="jd-generate-resume-row"
                      variant="line"
                      compact
                      onClick={() => generateResume(selectedRow)}
                    >
                      <FileText size={12} />
                      {t('jd.generateResumeRow')}
                    </DeskButton>
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
                  </>
                )
              }
            >
              {selectedRow === undefined ? null : (
                <div className="min-w-0" data-testid="jd-detail">
                  <p className="text-[11px] text-slate-500" data-testid="jd-detail-captured">
                    {t('jd.detailCaptured', {
                      platform: selectedRow.platform,
                      capturedAt: formatClock(selectedRow.capturedAt, t('jd.none')),
                    })}
                  </p>
                  <p className="mt-0.5 break-all text-[11px] text-slate-300">
                    {t('jd.detailByline', {
                      company: selectedRow.company,
                      city: selectedRow.city,
                      experience: selectedRow.experience,
                      education: selectedRow.education,
                      salary: salaryLabel(selectedRow.salary),
                    })}
                  </p>
                  {/* 「匹配理由」这一格只说**有据可查**的那一句：这一屏的清单是按生效中的筛选条件取回来的，
                      命中条件就是它在这里的原因。本仓没有匹配打分，不编「匹配度 92%」那种数（8.10-04 同一口径）。 */}
                  <p className="mt-1 break-all text-[11px] text-slate-400" data-testid="jd-detail-why">
                    {matchHits(selectedRow, lastCriteria).length === 0
                      ? t('jd.matchNone')
                      : t('jd.matchHits', {
                          hits: matchHits(selectedRow, lastCriteria)
                            .map((hit) => t(`jd.matchHit.${hit.kind}`, { value: hit.value, actual: hit.extra }))
                            .join(t('jd.matchJoin')),
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
                    className="mt-1 max-h-[38vh] overflow-y-auto whitespace-pre-line break-all text-[11px] leading-relaxed text-slate-200"
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
                  {greetProgressEntries.length > 0 && greetTargetKey === selectedGreetTarget && (
                    <div
                      className="mt-2 rounded-md border border-line bg-ink-900/40 p-2"
                      data-testid="jd-greet-progress"
                    >
                      <p className="text-[11px] font-semibold text-slate-300">{t('jd.greetProgressHeading')}</p>
                      <DeskProgressLog entries={greetProgressEntries} testId="jd-greet-progress-log" className="mt-1" />
                    </div>
                  )}
                </div>
              )}
            </Modal>
            {jobList.rows.length < jobList.matched && (
              <div className="mt-2 flex justify-end">
                <DeskButton
                  action="jd-filter-more"
                  variant="line"
                  compact
                  busy={!!busy}
                  disabled={isActionDisabled}
                  disabledReason={isActionDisabled ? 'ACTION_BUSY' : undefined}
                  disabledReasonLabel={isActionDisabled ? t('jd.reasonBusy') : undefined}
                  onClick={loadMore}
                >
                  {t('jd.filterMore', { shown: jobList.rows.length, matched: jobList.matched })}
                </DeskButton>
              </div>
            )}
          </>
        )}
      </section>

      {/* 投递这一格**默认展开**（用户 2026-10-09 裁定：必须用户确认的部分留在明面），
          收起来的只有「这一步到底怎么走」那三句——它是教材，不是待办。 */}
      <DeskSection
        id="deliver.form"
        defaultOpen
        markers={{ testid: 'deliver-section' }}
        title={
          <span className="flex items-center gap-2">
            <FileUp size={14} />
            {t('deliver.heading')}
          </span>
        }
        summary={
          <span data-testid="deliver-summary">{t('deliver.summary', { pending: pendingApprovals.length })}</span>
        }
      >
        <DeskPathGuide
          testid="deliver-path-guide"
          className="mb-2"
          here={t('guide.deliver.here')}
          next={t('guide.deliver.next')}
          exit={t('guide.deliver.exit')}
          focusSelector='[data-testid="deliver-pick-file"]'
          focusLabel={t('guide.focus')}
        />
        {/* 投递不再让人手打文件路径（spec 10.10-11）：给「选择文件」，选中的文件名显示在旁边。
            留空时仍由主进程用 `outbound.deliver` 配置里那一份，这条兜底写在提示里而不是输入框里。 */}
        <DeskActionRow>
          <DeskButton
            action="deliver-pick-file"
            variant="line"
            compact
            markers={{ testid: 'deliver-pick-file' }}
            onClick={() => {
              void (async () => {
                const picked = await bridge?.shell['selectFile']({
                  title: t('deliver.pickFileTitle'),
                  filters: [{ name: t('deliver.pickFileFilter'), extensions: ['pdf'] }],
                  multiple: false,
                });
                if (picked?.ok && picked.value.filePath) setResumePathDraft(picked.value.filePath);
              })();
            }}
          >
            {t('deliver.pickFile')}
          </DeskButton>
          <span className="min-w-0 break-all text-[11px] text-slate-400" data-testid="deliver-resume-path">
            {resumePathDraft === ''
              ? t('deliver.pickFileNone')
              : t('deliver.pickFileChosen', { name: resumePathDraft.split('/').pop() ?? resumePathDraft })}
          </span>
        </DeskActionRow>

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
                className={`rounded-md border px-3 py-1.5 ${BLOCK_EDGE_CLASS.amber} ${BLOCK_SURFACE_CLASS}`}
                data-approval-id={approval.approvalId}
                data-approval-job-id={approval.jobId}
                data-approval-size-bytes={String(approval.attachment.sizeBytes)}
                data-approval-sha={approval.attachment.sha256}
              >
                {/* 一行一件事（plan §3.24 规则④）：原先 133 字的单行把岗位、文件、字节数、
                    sha、两个时刻用 `·` 串成一串，人读不出"我现在要点哪一颗"。
                    对账用的标识符全部挪到上面那三个 data-*（harness 通道一字未改，只是换了挂法）。 */}
                <p className="break-all text-[11px] text-slate-100">
                  {t('deliver.pendingTitle', { title: approval.title, company: approval.company })}
                </p>
                <p className="mt-0.5 break-all text-[11px] text-slate-300">
                  {t('deliver.pendingFile', { fileName: approval.attachment.fileName })}
                </p>
                <p className="mt-0.5 break-all text-[11px] text-slate-400">
                  {t('deliver.pendingWhen', {
                    requestedAt: formatClock(approval.requestedAt, t('jd.none')),
                    expiresAt: formatClock(approval.expiresAt, t('jd.none')),
                  })}
                </p>
                <DeskActionRow className="mt-1">
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
                </DeskActionRow>
              </li>
            ))}
          </ul>
        )}

        {lastDeliver && (
          <Banner
            tone="jade"
            markers={{
              testid: 'deliver-receipt',
              committed: lastDeliver.committed ? 'true' : 'false',
              'job-id': String(lastDeliver.jobId ?? ''),
              sha: lastDeliver.attachment.sha256,
              'size-bytes': String(lastDeliver.attachment.sizeBytes),
              'ledger-id': String(lastDeliver.ledgerId ?? ''),
              source: lastDeliver.source,
            }}
            className="mt-3"
          >
            <div className="w-full">
              <p className="font-semibold">{t('deliver.receiptHeading')}</p>
              <p className="mt-1 flex items-center gap-1.5 break-all">
                <Tag tone={lastDeliver.committed ? 'jade' : 'amber'}>
                  {t(lastDeliver.committed ? 'deliver.stateCommitted' : 'deliver.stateStaged')}
                </Tag>
                {t('deliver.receiptFile', { fileName: lastDeliver.attachment.fileName })}
              </p>
              <p className="mt-1 break-all">
                {t('deliver.receiptWait', { waitedMs: lastDeliver.waitedMs, reason: lastDeliver.reason })}
              </p>
              {/* 对账编号只有出问题要查库时才用得上，所以挂在披露层里；
                  同一批值也已经在上面那组 `data-*` 上，这里给人读、那里给机器读，不是两份事实。 */}
              <DeskExplainer id="deliver.receiptIds" className="mt-1" label={t('deliver.receiptIdsToggle')}>
                <p className="break-all">
                  {t('deliver.receiptIds', {
                    jobId: lastDeliver.jobId,
                    sizeBytes: lastDeliver.attachment.sizeBytes,
                    sha: lastDeliver.attachment.sha256.slice(0, 12),
                    ledgerId: lastDeliver.ledgerId ?? t('deliver.noLedger'),
                    source: lastDeliver.source,
                  })}
                </p>
              </DeskExplainer>
            </div>
          </Banner>
        )}

        <DeskExplainer id="deliver.how" className="mt-3" label={t('deliver.howToggle')}>
          <p data-testid="deliver-hint">{t('deliver.hint')}</p>
          <p className="mt-1">{t('deliver.pipeline')}</p>
          <p className="mt-1">{t('deliver.tiers')}</p>
        </DeskExplainer>
      </DeskSection>

      {/* 进度与结局**默认收起**（用户 2026-10-09 的总原则：不涉及必须确认或输入的都可以收），
          但段头必须留一行读数——人不必点开也要知道"这一轮跑到哪儿了"。
          读数因此同时挂在 `data-*` 上：收起态下 harness 照样能量到同一批数字，不用先展开。 */}
      <DeskSection
        id="jd.progress"
        markers={{ testid: 'jd-progress-section' }}
        title={
          <span className="flex items-center gap-2">
            <ScrollText size={14} />
            {t('jd.progressHeading')}
          </span>
        }
        summary={
          latestProgress ? (
            <span
              data-testid="jd-progress-summary"
              data-round={String(latestProgress.round)}
              data-stored={String(latestProgress.stored)}
              data-target={String(latestProgress.target)}
            >
              {t('jd.progressHead', {
                round: latestProgress.round,
                phase: t(`jd.phase.${latestProgress.phase}`),
                stored: latestProgress.stored,
                target: latestProgress.target,
              })}
            </span>
          ) : (
            <span data-testid="jd-progress-summary">{t('jd.progressIdle')}</span>
          )
        }
      >
        {(progress?.length ?? 0) === 0 ? (
          <p className="text-[11px] text-slate-500" data-testid="jd-progress-empty">
            {t('jd.progressIdle')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="jd-progress">
            {(progress ?? []).map((event, index) => (
              <li
                key={`${event.phase}-${String(event.round)}-${String(index)}`}
                className="break-all text-[11px] text-slate-400"
                data-progress-phase={event.phase}
              >
                {/* 一行一件事（plan §3.24 规则④）：原先 113 字用 `·` 把轮次、阶段、入库数、容器数、
                    标题、时刻串成一串，人读不出该看哪个；现在拆成"跑到哪 + 此刻在读谁"两行。 */}
                <span className="block">
                  {t('jd.progressHead', {
                    round: event.round,
                    phase: t(`jd.phase.${event.phase}`),
                    stored: event.stored,
                    target: event.target,
                  })}
                </span>
                <span className="block text-[11px] text-slate-500">
                  {t('jd.progressDetail', {
                    containers: event.containers,
                    time: formatClock(event.at, t('jd.none')),
                  })}
                </span>
                {/* 列表阶段 `currentTitle` 是空串（还没开始逐条读），因此这一行只在读详情时长出来。 */}
                {event.currentTitle.length > 0 && (
                  <span className="block text-[11px] text-slate-400">
                    {t('jd.progressReading', { currentTitle: event.currentTitle })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </DeskSection>

      <DeskSection
        id="jd.outcome"
        markers={{ testid: 'jd-outcome-section' }}
        title={
          <span className="flex items-center gap-2">
            <FileSearch size={14} />
            {t('jd.outcomeHeading')}
          </span>
        }
        summary={
          lastRun ? (
            <span
              data-testid="jd-outcome-summary"
              data-stored={String(lastRun.stored)}
              data-total={String(lastRun.total)}
              data-skipped={String(lastRun.skipped.length)}
              data-stopped-by={lastRun.stoppedBy}
            >
              {t('jd.outcomeSummary', {
                stored: lastRun.stored,
                skipped: lastRun.skipped.length,
                stoppedBy: t(`jd.stopped.${lastRun.stoppedBy}`),
              })}
            </span>
          ) : (
            <span data-testid="jd-outcome-summary">{t('jd.outcomeIdle')}</span>
          )
        }
      >
        {!lastRun ? (
          <p className="text-[11px] text-slate-500" data-testid="jd-outcome-idle">
            {t('jd.outcomeIdle')}
          </p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="jd-outcome" data-stopped-by={lastRun.stoppedBy}>
            <p className="break-all text-[11px] text-slate-300">
              {t('jd.outcomeHead', {
                platform: lastRun.platform,
                keyword: lastRun.keyword,
                city: lastRun.city ?? '-',
                rounds: lastRun.rounds,
              })}
            </p>
            <p className="break-all text-[11px] text-slate-300">
              {t('jd.outcomeCount', {
                containers: lastRun.containers,
                stored: lastRun.stored,
                total: lastRun.total,
              })}
            </p>
            <p className="text-[11px] text-slate-400">
              {t('jd.outcomeStop', { stoppedBy: t(`jd.stopped.${lastRun.stoppedBy}`) })}
            </p>
            <h4 className="mt-1 text-[11px] font-semibold text-slate-300">
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
                    className={`break-all rounded-md border px-3 py-1.5 text-[11px] ${BLOCK_EDGE_CLASS.amber} ${BLOCK_SURFACE_CLASS} text-amber`}
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
            <DeskExplainer id="jd.outcomeMachine" className="mt-1" label={t('jd.outcomeMachineToggle')}>
              <p className="break-all" data-testid="jd-ledger-check">
                {t('jd.ledger', {
                  before: lastRun.ledgerRowsBefore,
                  after: lastRun.ledgerRowsAfter,
                  noOtherAction: okLabel(lastRun.ledgerRowsBefore === lastRun.ledgerRowsAfter),
                })}
              </p>
              {/* 这两个读数取自闸门任务内部，因此不含本轮那条 search：相等只证明抓取没顺手记别的动作
                  （spec 2.3-11 原判据「抓取不入账」已按 2.7-03 更正）。 */}
              <p className="mt-1 break-all">{t('jd.skippedNote')}</p>
            </DeskExplainer>
          </div>
        )}
      </DeskSection>
    </div>
  );
}
