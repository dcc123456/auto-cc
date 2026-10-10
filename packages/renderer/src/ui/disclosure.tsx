import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BLOCK_SURFACE_CLASS } from './controls';

/**
 * 收纳三件原件（`DeskSection` / `DeskExplainer` / `DeskActionRow`）。
 *
 * 为什么要单开这一支文件而不是往 `controls.tsx` 里塞：`check-renderer-conventions.ts` 第 10 节
 * 的注释（"原件以后按形态分子目录"）留的正是这个位置，而 `src/ui/**` 整棵子树在裸控件、
 * 语气洗底、hover 凭据、按不动原因码四条判据上都是豁免的——新形态按形态分文件，豁免范围才不会扩面。
 * `DeskDisclosure`（`controls.tsx`）保持原样：它是一根行内文字链、没有正文槽、开合归调用方，
 * 与这里"卡片级容器 + 原件自己持持久态"是两种形状，硬合要在组件里加 variant 分支（§2.7）。
 *
 * 三条形状各解决一条界面病（用户 2026-10-09 提的）：块级面板平铺到脚 → `DeskSection` 默认收起；
 * 长说明文案摊在页面上 → `DeskExplainer` 收起来按需展开；一行里按钮被文字挤断 → `DeskActionRow`。
 */

/**
 * 折叠状态的持久化键：一支 JSON 映射 `Record<sectionId, boolean>`。
 * 与 `auto-cc.lang`、`auto-cc.metrics.range`、`auto-cc.kernel-slot-width` 同一份 localStorage、
 * 同一个前缀口径。**只有 `DeskSection` 落盘**——`DeskExplainer` 是教材不是工作台，见那边那条注释。
 */
const DISCLOSURE_STORAGE_KEY = 'auto-cc.desk.disclosure';

/**
 * 读某一格的展开表态。
 * @param id 稳定的 ASCII 段 id（如 `jd.criteria`），绝不用译文当键（§5.6）
 * @param defaultOpen 库里没有这一格时的回落值
 * @returns 该格此刻算展开还是收起；整份映射形状不对时**全部回落默认值**，不炸首屏
 */
function loadSectionOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(DISCLOSURE_STORAGE_KEY);
    if (!raw) return defaultOpen;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultOpen;
    const value = (parsed as Record<string, unknown>)[id];
    return typeof value === 'boolean' ? value : defaultOpen;
  } catch {
    // 手改过、旧版本残留、配额截断都可能让这串不是合法 JSON；收纳偏好不值得为它拦下整屏渲染。
    return defaultOpen;
  }
}

/**
 * 写回某一格的展开表态（合并写，不清别人的格）。
 * @param id 段 id
 * @param open 是否展开
 */
function saveSectionOpen(id: string, open: boolean): void {
  let map: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISCLOSURE_STORAGE_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') map = parsed as Record<string, unknown>;
  } catch {
    map = {};
  }
  map[id] = open;
  localStorage.setItem(DISCLOSURE_STORAGE_KEY, JSON.stringify(map));
}

/**
 * 一格的开合状态：初值从 localStorage 取，每次切换立即落盘。
 * @param id 段 id（见 `loadSectionOpen`）
 * @param defaultOpen 库里没有记录时的回落档
 * @param openSignal 跨视图那一跳的 `requestId`（见 `DeskSectionProps.openSignal`）；undefined = 这一格没有被跳进
 * @returns 当前是否展开，与一个切换函数
 */
function useSectionOpen(id: string, defaultOpen: boolean, openSignal?: number): [boolean, () => void] {
  const [open, setOpen] = useState(() => loadSectionOpen(id, defaultOpen));
  const toggle = useCallback(() => {
    setOpen((previous) => {
      const next = !previous;
      saveSectionOpen(id, next);
      return next;
    });
  }, [id]);
  // 「跳进这一格」必须连带把它打开：正文收起时是真的卸载（见 `DeskSection` 那条注释），
  // 于是面包屑把人送到了简历屏、那一格的输入框却整个不在 DOM 里——落点看不见，跳转等于没发生。
  // `requestId` 是自增的，所以同一格被第二次跳进仍然会重新打开（人不认"上次我收起来了"）。
  useEffect(() => {
    if (openSignal === undefined) return;
    setOpen(true);
    saveSectionOpen(id, true);
  }, [id, openSignal]);
  return [open, toggle];
}

/**
 * 把 `markers` 摊成 `data-*` 实参（与 `Banner` 同一口径：harness 要的是读数，不是译文）。
 * @param markers 键名不带 `data-` 前缀的读数表
 * @returns 可直接展开在元素上的属性表
 */
function markerAttrsOf(markers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(markers ?? {}).map(([name, value]) => [`data-${name}`, value]));
}

export interface DeskSectionProps {
  /** 稳定的 ASCII 段 id（`jd.criteria` 这种），既是持久化键也是 harness 断言的锚点。 */
  id: string;
  /** 段标题（调用方翻译好传入）。 */
  title: ReactNode;
  /**
   * 收起时也留在明面上的那一行读数（如「第 3 轮 · 已入库 12/40」）。
   * 收起来不能把"这一格此刻怎么样"一起收走，否则人必须点开才知道状态（易上手）。
   * 字号固定 11px：灰阶 `slate-500` 只属于 ≤11px 的读数，这是 6.1-09 的机检半边，`src/ui/**` 也不豁免。
   */
  summary?: ReactNode;
  /** 库里没有记录时是否展开。默认 false——本轮的诉求是"能收起就默认收起"。 */
  defaultOpen?: boolean;
  /**
   * 跨视图那一跳的 `requestId`（09 稿形态⑥ / spec 6.4-05）。给了它（且这一格正是那一跳的落点）时，
   * 这一格**强制打开**并落盘：收起态下正文是卸载的，人不该被送到一格看不见输入框的地方。
   * 由调用方决定什么时候给——`undefined` 就是"这只是一次普通的展开偏好"。
   */
  openSignal?: number;
  /** 挂在段容器上的附加 `data-*`（harness 常按 testid 找那一格）。 */
  markers?: Record<string, string>;
  /**
   * 只在**收起态**出现在段头之后的那一行（裁定㉖ 第 2 条「把导入提到段头」的落点）。
   *
   * 为什么是段头的**兄弟行**而不是塞进段头里：段头本身就是一颗 `<button>`，而嵌套交互元素会被浏览器
   * 把内层那颗的点击判给外层——harness 与人再也按不到内层自己的 `data-action`（上面那条实测注释）。
   * 为什么只在收起态渲染：展开态正文里本来就有同一颗键，两处同时存在就是 §2.5 禁止的"两个入口都能办同一件事"。
   * 缺席时这一行整个不渲染，所以其余没给这一格的段 DOM 一字不变。
   */
  headExtra?: ReactNode;
  /** 追加 class（只放外边与宽度档）。 */
  className?: string;
  children: ReactNode;
}

/**
 * 可折叠的块级面板：段头常驻，正文收起时**真的卸载**（只加 `hidden` 省不出纵向空间，
 * 而这一族的存在理由就是把"打开就堆到脚"的六块卡片收成一条可读的列）。
 * @param props 见 `DeskSectionProps`
 * @returns 一格带描边的段；正文在收起态下不挂载
 */
export function DeskSection({
  id,
  title,
  summary,
  defaultOpen = false,
  openSignal,
  markers,
  headExtra,
  className = '',
  children,
}: DeskSectionProps) {
  const [open, toggle] = useSectionOpen(id, defaultOpen, openSignal);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      {...markerAttrsOf(markers)}
      data-section={id}
      data-open={open ? 'true' : 'false'}
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-ink-900/60 ${className}`}
    >
      {/* 段头本身就是一颗按钮，且**不嵌**别的交互元素：嵌在 `<button>` 里等于嵌套交互元素，
          浏览器会把内层那颗的点击判给外层，harness 就再也按不到那颗自己的 `data-action`。 */}
      <button
        type="button"
        data-action={`${id}-toggle`}
        aria-expanded={open}
        onClick={toggle}
        className="flex shrink-0 items-center gap-2 px-4 py-3 text-left transition-colors duration-150 hover:bg-ink-850"
      >
        <Chevron size={13} className="shrink-0 text-slate-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-slate-50">{title}</span>
          {summary ? <span className="mt-0.5 block truncate text-[11px] text-slate-500">{summary}</span> : null}
        </span>
      </button>
      {/* 常驻动作条：段头的**兄弟行**，只在收起态出现（`headExtra` 缺席时这一行整个不渲染）。
          收起态下正文是卸载的，于是"这一格最主要的那颗键"跟着一起消失——人必须点开段头才找得到做事的入口，
          这正是 2026-10-10 那句报障（「导入简历功能无效」「如何删除都不可见」）里最重的一条根因。 */}
      {!open && headExtra ? (
        <div data-head-extra={id} className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2">
          {headExtra}
        </div>
      ) : null}
      {/* 正文是这一段里**唯一可滚**的一格：段落在纵向 flex 列（对话屏）里是 flex 子项，
          而 `overflow-hidden` 让它的自动最小尺寸塌成 0，于是"给多少长多少"而不是把输入区顶出画面
          （活体读数：对话列各带合计 733 而面板只有 652，展开的档位段把输入区整个顶到窗口之外）。
          段头 `shrink-0` 因此常驻，被限高的是正文。 */}
      {open ? <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-4 py-3">{children}</div> : null}
    </section>
  );
}

export interface DeskExplainerProps {
  /** 稳定的 ASCII 段 id，用于挂 `data-explainer` 与 toggle 的 `data-action`。 */
  id: string;
  /** 触发文案（调用方翻译好传入，如「这一步到底做了什么？」）。原件不留任何文案。 */
  label: ReactNode;
  /** 展开后的正文（可以是段落、列表、读数块）。 */
  children: ReactNode;
  /** 挂在容器上的附加 `data-*`：既有验收通道（`data-testid`）跟着一起挪进来，不改名。 */
  markers?: Record<string, string>;
  /** 追加 class（只放外边与宽度档）。 */
  className?: string;
}

/**
 * 长说明文案的容器：明面上只留一行触发文案，正文按需展开。
 *
 * 开合态**不落盘**，这是与 `DeskSection` 的刻意分岔：section 收的是"工作台"（人改过它的开合
 * 是稳定的工作习惯，值得留），explainer 收的是"教材"（开机就把六段说明摊回页面上，
 * 等于这一片什么都没改）。所以刷新即回落收起，而一次会话内点开过就别让它在人读到一半时自己缩回去。
 * @param props 见 `DeskExplainerProps`
 * @returns 一行可点开的触发文案；展开时在下方画一块中性读数区
 */
export function DeskExplainer({ id, label, markers, className = '', children }: DeskExplainerProps) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div
      {...markerAttrsOf(markers)}
      data-explainer={id}
      data-open={open ? 'true' : 'false'}
      className={`min-w-0 ${className}`}
    >
      <button
        type="button"
        data-action={`${id}-toggle`}
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="inline-flex items-center gap-1 text-left text-[11px] text-slate-400 transition-colors duration-150 hover:text-celadon"
      >
        <Chevron size={11} className="shrink-0" aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <div
          // 底材与描边沿用块级那一族的现成档（墨面 + line），不新长一张脸、也不给教材涂语气色。
          className={`mt-1.5 rounded-md border border-line ${BLOCK_SURFACE_CLASS} px-3 py-2 text-[11px] leading-relaxed text-slate-300`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface DeskActionRowProps {
  /** 行内成员（通常是 `DeskButton` / `ArmButton`）。 */
  children: ReactNode;
  /** 追加 class（只放外边与宽度档）。 */
  className?: string;
}

/**
 * 不换行挤出空壳的动作条：成员永远保有自己的宽度，位置不够就**整颗换到下一行**。
 * 这条形状存在的理由正是本轮那条界面病——按钮和长读数同处一条行里时，被压扁的是按钮，
 * 于是界面上出现"只剩内边距的空壳"（`controls.tsx` 里那条 `overflow-hidden` 注释记过同一个后果）。
 * @param props 见 `DeskActionRowProps`
 * @returns 一条动作行；成员不缩，不够位时整颗下移
 */
export function DeskActionRow({ children, className = '' }: DeskActionRowProps) {
  // `[&>*]:shrink-0` 挂在行上而不是每颗键上：这一族的承诺就是"成员永远保有自己的宽度"，
  // 由容器统一保证才不会靠调用方记得给每一格补 class（§2.2 抽到第二次就抽公共层）。
  return <div className={`flex min-w-0 flex-wrap items-center gap-1.5 [&>*]:shrink-0 ${className}`}>{children}</div>;
}
