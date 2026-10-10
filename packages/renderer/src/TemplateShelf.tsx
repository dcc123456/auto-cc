import { useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResumeTemplateLayoutView, ResumeTemplateSummaryView } from '@auto-cc/shared';
import { BLOCK_SELECTED_CLASS, BLOCK_SURFACE_CLASS, DeskButton, DeskSegmented } from './ui/controls';
import type { DeskSegmentOption } from './ui/controls';
import { DeskExplainer } from './ui/disclosure';

/** 版式骨架七轴的形状别名：小图与筛选行都说这一份方言，不在界面重新声明轴类型（§2.5）。 */
type ShelfLayout = ResumeTemplateLayoutView;

/**
 * 模板架的当前筛选：一条轴的值在场 = 只看在这一档的模板；键缺省或为 undefined = 这一条不看。
 * 形状是"逐轴可选"的平对象而不是谓词串，父级才能把它放进自己的 state 并在视图切换后原样递回来。
 */
export interface ResumeShelfFilter {
  /** 栏数轴（数值与数据同源，不预先字符串化） */
  columns?: ShelfLayout['columns'];
  /** 抬头摆法轴 */
  header?: ShelfLayout['header'];
  /** 区块标题画法轴 */
  heading?: ShelfLayout['heading'];
  /** 强调色族轴 */
  accent?: ShelfLayout['accent'];
  /** 密度轴 */
  density?: ShelfLayout['density'];
}

/** 模板架的全部对外输入：这是一件纯展示件，不碰桥接、不自取数据（数据形状见 templates 注释）。 */
export interface TemplateShelfProps {
  /** 模板摘要清单：父级从 `resume['export.templates']` 取来整份递入；本组件一次桥接都不发 */
  templates: readonly ResumeTemplateSummaryView[];
  /** 当前用来出纸的那一套 id（对应卡片描边升档；不在清单里时只是没有选中格，不报错） */
  selectedId: string;
  /** 人设定的默认那套 id：朱砂盖章角标**只**画在它身上，一屏只许有一个章（唯一凭据） */
  defaultId: string;
  /** 当前筛选（父级持有，所以切视图回来还在；undefined 值表示该轴不参与筛选） */
  filter: ResumeShelfFilter;
  /** 筛选行任一档变更时回报下一份完整筛选（再点当前档 = 清掉该轴；本组件不在本地合第二份） */
  onFilterChange: (next: ResumeShelfFilter) => void;
  /** 点卡片 = 用这一套出纸；只回报 id，落不落"当前"由父级判 */
  onSelect: (id: string) => void;
  /** 把当前选中那套设为人设定的默认（对 `resume['export.setPreference']` 的唯一入口，别处不长第二颗） */
  onSetDefault: () => void;
  /** 父级有动作在途：整架按不动，避免上一次出纸还没回来又换一套 */
  busy?: boolean;
  /** 整架按不动的原因码（如 `TEMPLATE_LIST_PENDING`），按项目规矩必须与下一行人话成对出现（spec 6.2-06） */
  disabledReason?: string;
  /** 原因码对人说的话（翻译归父级，本组件不持任何文案——§5.5） */
  disabledReasonLabel?: string;
}

/** 筛选行的 facet 元表：key 直接取 layout 与 filter 的同名轴，labelKey 是轴名的 i18n 键。 */
const SHELF_FACETS = [
  { key: 'columns', labelKey: 'shelf.filter.columns' },
  { key: 'header', labelKey: 'shelf.filter.header' },
  { key: 'heading', labelKey: 'shelf.filter.heading' },
  { key: 'accent', labelKey: 'shelf.filter.accent' },
  { key: 'density', labelKey: 'shelf.filter.density' },
] as const;

/** facet 的轴名联合：由元表反推，不另写一份（写了就是第二处事实，§2.2）。 */
type ShelfFacetKey = (typeof SHELF_FACETS)[number]['key'];

/**
 * 强调色轴 → 小图里"实涂"元素的底色（色带、实底标题条、胶囊、序号块、短下划线共用这一档）。
 * 必须逐色写成完整字面量：Tailwind v4 只扫源码里出现的字符串，`bg-${accent}-500` 拼出来编译不进产物（§9 实测）。
 */
const ACCENT_BAR_CLASS: Record<ShelfLayout['accent'], string> = {
  neutral: 'bg-neutral-500',
  slate: 'bg-slate-500',
  stone: 'bg-stone-500',
  zinc: 'bg-zinc-500',
  gray: 'bg-gray-500',
  sky: 'bg-sky-600',
  teal: 'bg-teal-500',
  emerald: 'bg-emerald-600',
  amber: 'bg-amber-500',
  rose: 'bg-rose-600',
  violet: 'bg-violet-600',
  indigo: 'bg-indigo-600',
  red: 'bg-red-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
};

/** 强调色轴 → 小图里"描边"元素的边色（盒式抬头、粗块标题、左线标题、题下细线共用这一档）。 */
const ACCENT_EDGE_CLASS: Record<ShelfLayout['accent'], string> = {
  neutral: 'border-neutral-500',
  slate: 'border-slate-500',
  stone: 'border-stone-500',
  zinc: 'border-zinc-500',
  gray: 'border-gray-500',
  sky: 'border-sky-600',
  teal: 'border-teal-500',
  emerald: 'border-emerald-600',
  amber: 'border-amber-500',
  rose: 'border-rose-600',
  violet: 'border-violet-600',
  indigo: 'border-indigo-600',
  red: 'border-red-500',
  blue: 'border-blue-500',
  green: 'border-green-500',
};

/**
 * 密度轴 → 区块之间的留白档。纸面是定高的，roomy 装不下被 `overflow-hidden` 裁掉是**如实**的画法——
 * 真实成品里 roomy 同样一页装得更少，小图不假装塞得进去。
 */
const DENSITY_SECTION_GAP: Record<ShelfLayout['density'], string> = {
  compact: 'gap-1',
  normal: 'gap-1.5',
  roomy: 'gap-2.5',
};

/** 密度轴 → 抬头与正文之间的隔档（与区块缝同一组尺度，分两张表是因为类名族不同，不许复用串）。 */
const DENSITY_HEADER_GAP: Record<ShelfLayout['density'], string> = {
  compact: 'mb-1',
  normal: 'mb-1.5',
  roomy: 'mb-2',
};

/**
 * 抬头摆法轴 → 小图抬头块的排布画法，与 `template-kit.ts` 的 `renderHeader` 八档逐一对应：
 * center/left/right 靠对齐，split 左右两坨，banner 实涂色带，boxed 描边框住，stacked 联系方式逐行，ruleUnder 题下一条粗线。
 */
const HEADER_SHELL_CLASS: Record<ShelfLayout['header'], string> = {
  center: 'flex flex-col items-center gap-0.5',
  left: 'flex flex-col items-start gap-0.5',
  right: 'flex flex-col items-end gap-0.5',
  split: 'flex items-end justify-between gap-1',
  banner: 'flex flex-col items-center gap-0.5 px-1 py-1',
  boxed: 'flex flex-col items-center gap-0.5 border-2 px-1 py-1',
  stacked: 'flex flex-col items-start gap-0.5',
  ruleUnder: 'flex flex-col items-start gap-0.5 border-b-2 pb-1',
};

/** 示意纸面：定高定宽的一页 A4（约 96×132，比 210:297 差一档可接受），`bg-paper` 两案都是浅色纸面，灰条才有稳定的墨色读数。 */
const SHEET_CLASS =
  'flex h-[132px] w-[96px] shrink-0 flex-col overflow-hidden rounded-[2px] border border-neutral-300 bg-paper p-1.5';

/** 卡片壳的可点档：hover 与按不动分属两条字面量——07 稿硬规矩"不可点的元素绝不长出 hover"（spec 6.2-25），机检按字符串级判。 */
const CARD_SHELL_LIVE =
  'relative flex w-[120px] shrink-0 cursor-pointer flex-col items-center gap-1 rounded-md border p-2';

/** 卡片壳的按不动档：提暗 + 不给手型，同一条字面量里没有任何 `hover:`（与上条互为两态，见 `CARD_SHELL_LIVE`）。 */
const CARD_SHELL_DEAD =
  'relative flex w-[120px] shrink-0 cursor-not-allowed flex-col items-center gap-1 rounded-md border p-2 opacity-40';

/**
 * 收集一条轴在当前清单里真实用到的互异取值。
 * @param templates 模板摘要清单（父级从桥接取来的那一份，本函数不改它）
 * @param facet 要看哪条轴
 * @returns 去重后按字符串序排列的档位读数；长度 ≤1 表示整架这一条只有一个取值（那一格筛选没有信息量，不画）
 */
function facetValuesOf(templates: readonly ResumeTemplateSummaryView[], facet: ShelfFacetKey): string[] {
  const seen = new Set<string>();
  for (const template of templates) seen.add(String(template.layout[facet]));
  return [...seen].sort();
}

/**
 * 一套模板是否在当前筛选下留下。
 * @param layout 该套的七轴取值
 * @param filter 当前筛选；没出现或值为 undefined 的轴不参与判定
 * @returns 所有参与判定的轴都对上才算留下（轴值一律按字符串比，栏数轴的 1/2 与筛选里的数值同形）
 */
function matchesFilter(layout: ShelfLayout, filter: ResumeShelfFilter): boolean {
  for (const facet of SHELF_FACETS) {
    const expected = filter[facet.key];
    if (expected !== undefined && String(layout[facet.key]) !== String(expected)) return false;
  }
  return true;
}

/**
 * 把某一 facet 报来的字符串装配成下一份筛选。
 * @param facet 这次改的是哪条轴
 * @param rawValue 该轴的新档读数；空串 = 清掉这条轴（再点当前档就是取消筛选）
 * @param filter 当前筛选（其余轴原样保留）
 * @returns 完整下一份；栏数轴的空串解析成数值 1|2，其它轴按字面量收窄回轴类型
 */
function nextFilterOf(facet: ShelfFacetKey, rawValue: string, filter: ResumeShelfFilter): ResumeShelfFilter {
  const isCleared = rawValue === '';
  switch (facet) {
    case 'columns':
      return { ...filter, columns: isCleared ? undefined : (Number(rawValue) as ShelfLayout['columns']) };
    case 'header':
      return { ...filter, header: isCleared ? undefined : (rawValue as ShelfLayout['header']) };
    case 'heading':
      return { ...filter, heading: isCleared ? undefined : (rawValue as ShelfLayout['heading']) };
    case 'accent':
      return { ...filter, accent: isCleared ? undefined : (rawValue as ShelfLayout['accent']) };
    case 'density':
      return { ...filter, density: isCleared ? undefined : (rawValue as ShelfLayout['density']) };
  }
}

/**
 * 画小图里的一个区块标题（九种画法各一坨几何，对应 `template-kit.ts` 的 `renderHeading`）。
 * @param heading 该套的区块标题画法档
 * @param accent 强调色档：实涂与描边两类元素跟着它走色
 * @returns 一组只含灰条/色块的 div；没有任何文字，也没有任何真实内容
 */
function ShelfHeading({ heading, accent }: { heading: ShelfLayout['heading']; accent: ShelfLayout['accent'] }) {
  const titleBar = 'h-1 w-2/5 bg-neutral-500';
  switch (heading) {
    case 'doubleRule':
      return <div className={`h-1 w-2/5 border-y bg-neutral-500 ${ACCENT_EDGE_CLASS[accent]}`} />;
    case 'bar':
      return (
        <div className={`flex h-1.5 items-center rounded-[1px] px-0.5 ${ACCENT_BAR_CLASS[accent]}`}>
          <div className="h-0.5 w-3/5 bg-white/80" />
        </div>
      );
    case 'block':
      return <div className={`h-1.5 w-2/5 border-b-2 bg-neutral-600 ${ACCENT_EDGE_CLASS[accent]}`} />;
    case 'wide':
      return <div className="h-0.5 w-1/3 bg-neutral-400" />;
    case 'numbered':
      return (
        <div className="flex items-center gap-0.5">
          <div className={`size-1 rounded-[1px] ${ACCENT_BAR_CLASS[accent]}`} />
          <div className={titleBar} />
        </div>
      );
    case 'leftBorder':
      return <div className={`h-1 w-2/5 border-l-2 bg-neutral-500 pl-0.5 ${ACCENT_EDGE_CLASS[accent]}`} />;
    case 'pill':
      return (
        <div className={`flex h-1.5 w-2/5 items-center rounded-full px-1 ${ACCENT_BAR_CLASS[accent]}`}>
          <div className="h-0.5 w-full bg-white/80" />
        </div>
      );
    case 'underlineShort':
      return (
        <div className="flex flex-col gap-0.5">
          <div className={titleBar} />
          <div className={`h-0.5 w-1/5 ${ACCENT_BAR_CLASS[accent]}`} />
        </div>
      );
    case 'rule':
    default:
      return <div className={`h-1 w-2/5 border-b bg-neutral-500 pb-0.5 ${ACCENT_EDGE_CLASS[accent]}`} />;
  }
}

/**
 * 画小图里的一条条目行（经历/项目那类条目）。
 * @param entry 条目行结构档：split = 标题条与日期条两端同行，stack = 上下两行
 * @returns 两根灰条组成的行；条长与深浅区分"标题"与"时间"两个槽位
 */
function ShelfEntry({ entry }: { entry: ShelfLayout['entry'] }) {
  if (entry === 'split') {
    return (
      <div className="flex items-center justify-between gap-1">
        <div className="h-0.5 w-3/5 bg-neutral-400" />
        <div className="h-0.5 w-1/5 bg-neutral-300" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="h-0.5 w-3/5 bg-neutral-400" />
      <div className="h-0.5 w-1/5 bg-neutral-300" />
    </div>
  );
}

/**
 * 画小图里的一个完整区块：标题一种画法 + 两条条目。
 * @param layout 该套的七轴取值（heading/entry/accent 在这一格里都出场）
 */
function ShelfSection({ layout }: { layout: ShelfLayout }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <ShelfHeading heading={layout.heading} accent={layout.accent} />
      <ShelfEntry entry={layout.entry} />
      <ShelfEntry entry={layout.entry} />
    </div>
  );
}

/**
 * 画小图的正文区：单栏通栏排区块，双栏分一宽主栏加一窄侧栏（分工与 `template-kit.ts` 的侧栏口径一致）。
 * @param layout 七轴取值（columns 定分栏，density 定区块缝）
 */
function ShelfBody({ layout }: { layout: ShelfLayout }) {
  const sectionGap = DENSITY_SECTION_GAP[layout.density];
  if (layout.columns === 1) {
    return (
      <div className={`flex min-h-0 flex-1 flex-col ${sectionGap}`}>
        <ShelfSection layout={layout} />
        <ShelfSection layout={layout} />
      </div>
    );
  }
  return (
    <div className={`flex min-h-0 flex-1 ${sectionGap}`}>
      <div className={`flex min-w-0 flex-[2] flex-col ${sectionGap}`}>
        <ShelfSection layout={layout} />
        <ShelfSection layout={layout} />
      </div>
      <div className={`flex w-1/4 flex-col ${sectionGap}`}>
        <ShelfSection layout={layout} />
      </div>
    </div>
  );
}

/**
 * 画小图的抬头区（姓名条 + 联系方式条）。
 * @param layout 七轴取值：header 定摆法，accent 定 banner/boxed/ruleUnder 三档的上色
 * @returns 一组灰条（banner 档压在实涂色带上时灰条换成透明白条，否则深色带会把占位条压没）
 */
function ShelfHeader({ layout }: { layout: ShelfLayout }) {
  const shell = HEADER_SHELL_CLASS[layout.header];
  const isBanner = layout.header === 'banner';
  const accentEdge =
    layout.header === 'boxed' || layout.header === 'ruleUnder' ? ` ${ACCENT_EDGE_CLASS[layout.accent]}` : '';
  if (layout.header === 'split') {
    return (
      <div className={shell}>
        <div className="h-1.5 w-2/5 bg-neutral-700" />
        <div className="flex flex-col items-end gap-0.5">
          <div className="h-0.5 w-7 bg-neutral-400" />
          <div className="h-0.5 w-5 bg-neutral-300" />
        </div>
      </div>
    );
  }
  if (layout.header === 'stacked') {
    return (
      <div className={shell}>
        <div className="h-1.5 w-1/2 bg-neutral-700" />
        <div className="h-0.5 w-1/3 bg-neutral-400" />
        <div className="h-0.5 w-1/4 bg-neutral-300" />
      </div>
    );
  }
  return (
    <div className={`${shell}${isBanner ? ` ${ACCENT_BAR_CLASS[layout.accent]}` : accentEdge}`}>
      <div className={`h-1.5 w-1/2 ${isBanner ? 'bg-white/85' : 'bg-neutral-700'}`} />
      <div className={`h-0.5 w-2/3 ${isBanner ? 'bg-white/70' : 'bg-neutral-400'}`} />
    </div>
  );
}

/**
 * 一套模板的版式示意小图：一张定高的"纸"，内容由七条轴决定的灰条/色块几何构成。
 * 它是**示意图不是成品预览**（真实渲染一张 2–4s，50 套现渲早被否掉），诚实声明由架上的
 * `DeskExplainer` 常驻那一行兑现，这里只管画。
 * @param layout 该套模板的七轴取值（唯一入参：画什么完全由轴决定，不吃任何简历内容）
 */
function TemplateSkeleton({ layout }: { layout: ShelfLayout }) {
  return (
    <div aria-hidden="true" className={SHEET_CLASS}>
      <div className={DENSITY_HEADER_GAP[layout.density]}>
        <ShelfHeader layout={layout} />
      </div>
      <ShelfBody layout={layout} />
    </div>
  );
}

/**
 * 模板架：把 50 套模板摆成"按轴筛选 + 版式示意小图网格"的可选架。
 *
 * 纯展示件——不取数、不写库：数据与动作全部经 props 进出，所以它能被任何父级（简历屏、
 * agent 工具卡片）复用而不长出第二份状态（§2.5）。筛选档位**从数据现推**（`facetValuesOf`），
 * 轴值表只在 `template-kit.ts` 一份，界面不抄。
 * @param props 见 `TemplateShelfProps`（templates 由父级从 `resume['export.templates']` 取来）
 * @returns 一整块带描边的架：读数行、诚实说明、筛选行、小图网格（或两种空态文案）
 */
export function TemplateShelf({
  templates,
  selectedId,
  defaultId,
  filter,
  onFilterChange,
  onSelect,
  onSetDefault,
  busy,
  disabledReason,
  disabledReasonLabel,
}: TemplateShelfProps) {
  const { t } = useTranslation();
  /** 整架按不动：父级在途或父级给了前置缺失的原因码，两态共用一条闸门（卡片与设默认键都吃它）。 */
  const isShelfDead = busy === true || disabledReason !== undefined;
  /** 按不动的原因码：调用方给的码优先（那是业务前置），否则就是在途这一档。 */
  const shelfDeadReason = disabledReason ?? (busy === true ? 'ACTION_BUSY' : undefined);
  /**
   * 原因码对人说的话：调用方给了 `disabledReason` 就必须由其配对 `disabledReasonLabel`（spec 6.2-06），
   * 只在"父级动作在途"这一档由本组件自己翻（这是本组件唯一能自己确证的原因）。
   */
  const shelfDeadLabel =
    disabledReason !== undefined ? disabledReasonLabel : busy === true ? t('shelf.busy') : undefined;

  /** 每条 facet 在当前清单里的互异档位；只有 >1 档的轴才进筛选行（档位表从数据现推，见组件头注释）。 */
  const facetReadings = useMemo(
    () => SHELF_FACETS.map((facet) => ({ ...facet, values: facetValuesOf(templates, facet.key) })),
    [templates],
  );
  /** 筛选后剩下的卡片；筛选为空对象时整份在场。 */
  const visibleTemplates = useMemo(
    () => templates.filter((item) => matchesFilter(item.layout, filter)),
    [templates, filter],
  );
  /** 当前出纸那一套的摘要（名字进读数行）；不在清单里时读数行如实缺席，不拿 id 冒充名字。 */
  const selectedTemplate = templates.find((item) => item.id === selectedId);

  return (
    <section
      data-testid="template-shelf"
      data-shelf="templates"
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-ink-900/60 p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold text-slate-200">{t('shelf.heading')}</h3>
        <span className="text-[11px] text-slate-500" data-testid="shelf-count">
          {t('shelf.count', { total: templates.length, shown: visibleTemplates.length })}
        </span>
        {selectedTemplate ? (
          <span className="text-[11px] text-slate-400" data-testid="shelf-selected">
            {t('shelf.selected', { name: selectedTemplate.name })}
          </span>
        ) : null}
      </div>

      {/* 诚实条款常驻（spec 6.4-09 的"示意图不是成品"这一句）：点开之前明面上也只有两行字。 */}
      <div className="flex flex-col gap-1">
        <p className="text-[11px] text-slate-500">{t('shelf.pick')}</p>
        <DeskExplainer id="shelf-honest" label={t('shelf.honest.label')}>
          <p>{t('shelf.honest.body')}</p>
        </DeskExplainer>
      </div>

      {/*
        档位文案原样显示轴值（等宽技术读数），**故意不逐条翻译**：全套轴值四十余档，
        逐档建译文表等于在界面里抄第二份"轴有哪些取值"——唯一事实源在 `template-kit.ts`，
        新增一档时译文表必慢一拍、新档在界面直接露出裸键（§2.5）；而每档下面画着的小图就是它的图例。
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {facetReadings.map((facet) => {
          if (facet.values.length < 2) return null;
          const current = filter[facet.key] === undefined ? undefined : String(filter[facet.key]);
          const options: DeskSegmentOption<string>[] = facet.values.map((value) => ({
            value,
            label: <span className="font-mono">{value}</span>,
          }));
          return (
            <div key={facet.key} className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-500">{t(facet.labelKey)}</span>
              <DeskSegmented
                action={`shelf-filter-${facet.key}`}
                options={options}
                value={current}
                busy={isShelfDead}
                disabledReason={isShelfDead ? shelfDeadReason : undefined}
                disabledReasonLabel={isShelfDead ? shelfDeadLabel : undefined}
                onSelect={(picked) => onFilterChange(nextFilterOf(facet.key, picked === current ? '' : picked, filter))}
              />
            </div>
          );
        })}
      </div>

      {templates.length === 0 ? (
        <p className="text-[11px] text-slate-500" data-shelf-state="empty-none">
          {t('shelf.empty.none')}
        </p>
      ) : visibleTemplates.length === 0 ? (
        <p className="text-[11px] text-slate-500" data-shelf-state="empty-filter">
          {t('shelf.empty.afterFilter', { total: templates.length })}
        </p>
      ) : (
        // 架体自己滚：50 套摊开是 2000px（宽档单栏量到过 6032px），会把整块屏撑成人找不到键的地步。
        // 限高在这里、不在 `DeskSection` 的体上——段是通用原件，不该为一只架子长高度约束（§2.2）。
        <div
          data-testid="shelf-grid"
          className="flex max-h-[min(52vh,440px)] flex-wrap content-start gap-3 overflow-y-auto pr-1"
        >
          {visibleTemplates.map((template) => {
            const isSelected = template.id === selectedId;
            const isDefault = template.id === defaultId;
            // 卡片壳上的 stopPropagation：设默认那颗真按钮嵌在可点卡片里，不挡一下会一次点击连带派发 onSelect。
            return (
              <div
                key={template.id}
                data-action="shelf-card"
                data-template-id={template.id}
                data-selected={isSelected ? 'true' : 'false'}
                role="button"
                tabIndex={0}
                aria-label={t('shelf.pickCard', { name: template.name })}
                {...(isShelfDead
                  ? {
                      'aria-disabled': true,
                      ...(shelfDeadReason === undefined ? {} : { 'data-disabled-reason': shelfDeadReason }),
                      ...(shelfDeadLabel === undefined ? {} : { title: shelfDeadLabel }),
                    }
                  : {
                      onClick: () => {
                        onSelect(template.id);
                      },
                      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(template.id);
                        }
                      },
                    })}
                className={`${isShelfDead ? CARD_SHELL_DEAD : `${CARD_SHELL_LIVE} hover:border-slate-500`} ${
                  isSelected ? BLOCK_SELECTED_CLASS : `${BLOCK_SURFACE_CLASS} border-line`
                }`}
              >
                <TemplateSkeleton layout={template.layout} />
                {/* 展示名这一行是卡片里唯一有字的地方，衬线轴（serif）把线索挂在这里：
                    灰条小图本身画不出字体族，定档的画法（font-display）只有落在文字上才看得见。 */}
                <span
                  className={`w-full truncate text-center text-[11px] ${
                    isSelected ? 'text-slate-100' : 'text-slate-300'
                  } ${template.layout.serif ? 'font-display' : ''}`}
                >
                  {template.name}
                </span>
                {isDefault ? (
                  <span
                    data-shelf-badge="default"
                    className="absolute right-1 top-1 rounded-chip bg-seal-deep px-1 py-px font-display text-[10px] leading-none text-white"
                  >
                    {t('shelf.badge.default')}
                  </span>
                ) : null}
                {isSelected ? (
                  <span onClick={(event) => event.stopPropagation()}>
                    <DeskButton
                      action="remember-template"
                      variant="line"
                      compact
                      busy={busy === true}
                      disabled={isShelfDead}
                      disabledReason={shelfDeadReason}
                      disabledReasonLabel={shelfDeadLabel}
                      onClick={onSetDefault}
                    >
                      {t('shelf.setDefault')}
                    </DeskButton>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
