import { BadgeCheck, CircleAlert, Info, LoaderCircle, Send, Stamp, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  ComponentType,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { TFunction } from 'i18next';
import type { LucideIcon } from 'lucide-react';
import type { ToolEffect } from '@auto-cc/shared';

/**
 * 墨案控件的六个档：描边、实底、幽灵、以及三个语义档（效果归属色）。
 * `seal` 只能给「动作会离开这台机器」的按钮，`jade` 只能给已读/已核类动作，
 * `amber` 只能给本机写入与等待表态——串色即缺陷（docs/plans/06-ui-ink-desk/plan.md §5）。
 */
export type DeskVariant = 'line' | 'solid' | 'ghost' | 'seal' | 'jade' | 'amber';

/** 控件的结果态读数：`done` 两秒自行回落，`failed` 不回落，必须人再动一次（07 稿五态规则）。 */
export type DeskResult = 'done' | 'failed';

/** 五态里「进行中宽度锁死」的实现方式：转针槽位常驻，空闲时只是透明（07 稿③）。 */
const SPINNER_SLOT = 'inline-flex w-3.5 shrink-0 items-center justify-center';

/**
 * 各 variant 的静态 class。**必须写成完整字面量**——Tailwind 只扫源码里出现的字符串，
 * 拼出来的 class 不会生成。悬停一律「提亮一档、无位移」，位移只允许出现在按下瞬间。
 * @param variant 语义档
 * @param disabled 是否禁用（禁用时不提亮，靠 ring 属性把原因带在节点上）
 * @param compact 窄档：贴在行内的小按钮用，字号与内边距都收一档
 */
const buttonClass = (variant: DeskVariant, disabled: boolean, compact: boolean): string => {
  const base =
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1.5 text-xs'} font-medium ` +
    'transition-[background-color,border-color,color,box-shadow] duration-150 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-celadon/70 ' +
    (disabled
      ? 'cursor-not-allowed border-line bg-ink-850 text-slate-400 '
      : // 默认 → 悬停（提亮一档、无位移）→ 按下（下移 1px + 回到 ink-800）
        'active:translate-y-px active:bg-ink-800 ');
  // 禁用时**整档语义色都不拼**（spec 6.2-10）。两条原因都在这一行里：
  // ① 描边——原先 `base` 给 `border-line`、`tone` 又给 `border-line-strong` / `border-slate-600` /
  //   `border-transparent`，而 Tailwind 生成的样式表按它自己的顺序排，`border-line` 排在后面就赢不了，
  //   活体读数因此是"同一屏三种按不动的边框"（amber `.14`、line `.26`、solid `rgb(85,103,122)`、ghost 透明）。
  // ② 悬停——这里用的是 `aria-disabled` 而不是原生 `disabled`（原生禁用不派发鼠标事件，tooltip 就没了），
  //   于是 `:hover` 照样生效，留着 `hover:bg-*` 等于"按不动却会提亮"。
  // 禁用的画法只由 `base` 的禁用分支给一份，五档必然同色。
  // 三档语义按钮的**文案用 `-ink` 档**，描边与淡洗仍用色相档：同色文字压在 14~18% 的同色淡洗上
  // 只剩 3.3~3.7，够不到 12px 的 4.5:1（spec 6.1-06 普查实测，两个主题都中招）。
  const tone = disabled
    ? ''
    : variant === 'seal'
      ? 'border-seal/45 bg-seal/18 text-seal-ink hover:border-seal/70 hover:bg-seal/28 hover:text-slate-50'
      : variant === 'jade'
        ? 'border-jade/40 bg-jade/14 text-jade-ink hover:border-jade/65 hover:bg-jade/24 hover:text-slate-50'
        : variant === 'amber'
          ? 'border-amber/40 bg-amber/14 text-amber-ink hover:border-amber/65 hover:bg-amber/24 hover:text-slate-50'
          : variant === 'solid'
            ? 'border-slate-600 bg-ink-750 text-slate-50 hover:bg-ink-700 hover:border-slate-500'
            : variant === 'ghost'
              ? 'border-transparent bg-transparent text-slate-300 hover:bg-ink-800 hover:text-slate-50'
              : 'border-line-strong bg-ink-800 text-slate-100 hover:bg-ink-750 hover:border-slate-500 hover:text-slate-50';
  return `${base}${tone}`;
};

/** 结果态的底色 wash：jade 走 2 秒回落动画，seal 常亮直到人再动一次。 */
const RESULT_WASH: Record<DeskResult, string> = {
  done: 'bg-jade-wash animate-wash',
  failed: 'bg-seal-wash',
};

/** 结果态的图标：成功盖一个 jade 的对勾，失败盖一枚朱砂印章（失败要显眼到必须处理）。 */
const RESULT_ICON: Record<DeskResult, ReactNode> = {
  done: <BadgeCheck size={14} className="text-jade-ink" aria-hidden="true" />,
  failed: <Stamp size={14} className="text-seal-ink" aria-hidden="true" />,
};

export interface DeskButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-disabled'> {
  /** harness 的点击凭据（AGENTS.md §9 第④条：每只可点控件都要有 `data-action`），必填。 */
  action: string;
  /** 语义档，默认描边。 */
  variant?: DeskVariant;
  /** 进行中：转针 + 宽度锁死 + 不可重复触发。 */
  busy?: boolean;
  /** 结果态，配合 `useDeskResult` 用；undefined 表示还没有结果。 */
  result?: DeskResult;
  /** 禁用时挂到节点上的原因码（`NO_CONSENT` / `ENTITLEMENT_EXHAUSTED` / …），harness 与读屏都取这一项。 */
  disabledReason?: string;
  /**
   * 原因码对人说的话（调用方负责翻译）。只给码不给这句话，禁用就成了"界面不说谎"的反例：
   * 人只知道按不动，不知道为什么按不动（07 稿④）。
   */
  disabledReasonLabel?: string;
  /** 窄档：贴在列表行内的小按钮（07 稿的 .btn-sm）。 */
  compact?: boolean;
  /**
   * 完成态文案（07 稿⑤「成功描青并把文案换成完成态」）。给了它，`result === 'done'` 那一格
   * 就换成这句话；不给则结果态只加 wash 与角标（多数按钮不需要——"保存"按完仍写"保存"是缺陷，
   * 但"下一页"这类瞬时动作没有完成态可言）。调用方负责翻译（§5.5：文案不许长在组件里）。
   */
  doneLabel?: string;
  /**
   * 附加的 `data-*` 标记（例如 armed 状态），供 harness 断言。
   * 组件 props 上没有 data-* 的索引签名，所以调用方不能直接写 `data-armed`——走这里。
   */
  markers?: Record<string, string>;
}

/**
 * 墨案的按钮：把 07 稿的五态规则收在一个组件里，面板只管传状态。
 * @param action 该控件的 `data-action` 值（必填，见 DeskButtonProps）
 * @param variant 语义档；`seal` 保留给外发/不可逆
 * @param busy 是否进行中
 * @param result 结果态（done 两秒回落 / failed 常亮）
 * @param disabledReason 禁用原因码
 * @param disabledReasonLabel 禁用原因的人话（只禁用而不解释是谎报，见 props 注释）
 * @returns 可直接替换存量 `<button>` 的按钮元素；点击行为与文案由调用方给
 */
export function DeskButton({
  action,
  variant = 'line',
  busy = false,
  result,
  disabledReason,
  disabledReasonLabel,
  compact = false,
  doneLabel,
  markers,
  disabled,
  className = '',
  onClick,
  children,
  ...rest
}: DeskButtonProps) {
  const isDead = disabled === true || busy;
  const markerAttrs = Object.fromEntries(
    Object.entries(markers ?? {}).map(([name, value]) => [`data-${name}`, value]),
  ) as Record<string, string>;
  // 根节点**不带** `overflow-hidden`：flex 子项的自动最小尺寸在 overflow 非 visible 时会塌成 0，
  // 于是窄列里的按钮会被压成"只剩内边距的空壳"（活体读数：页序行那颗页码键宽 30px、文字整条裁掉）。
  // 结果态 wash 因此自己带一份圆角，不靠父级裁切。
  return (
    <button
      type="button"
      data-action={action}
      data-effect={variant}
      {...markerAttrs}
      {...(disabledReason ? { 'data-disabled-reason': disabledReason } : {})}
      {...(result ? { 'data-result': result } : {})}
      aria-disabled={isDead || undefined}
      // 不用原生 `disabled`：Chromium 对禁用控件不派发鼠标事件，title 提示也就不会出现，
      // 人只会看到"按不动"而看不到为什么按不动（07 稿④）。改走 aria-disabled + 这里挡下 onClick。
      {...(isDead ? {} : { onClick })}
      {...(isDead && disabledReasonLabel ? { title: disabledReasonLabel } : {})}
      className={`relative rounded-control ${buttonClass(variant, isDead, compact)} ${className}`}
      {...rest}
    >
      {/* 底色 wash 压在文字后面：结果态不改变按钮尺寸，只加一层颜色与一枚角标。
          圆角自己带一份——根节点不裁切（见上面那条注释），不裁就得自己贴合。 */}
      {result && !busy ? (
        <span className={`pointer-events-none absolute inset-0 rounded-control ${RESULT_WASH[result]}`} />
      ) : null}
      {/* 转针与结果角标共用这一格预留位（`w-3.5`）：07 稿④ 的「宽度锁死不跳版」管的正是进行中与结果
          这两态。活体差值原先是 109 → 127px（角标挤在文案后面长出 18px），挪进已有的状态位后五态同宽。 */}
      <span className={SPINNER_SLOT}>
        {busy ? <LoaderCircle size={14} className="animate-needle" aria-hidden="true" /> : null}
        {result && !busy ? RESULT_ICON[result] : null}
      </span>
      <span className="relative flex items-center gap-1">
        {doneLabel ? (
          // 完成态换文案（07 稿⑤）与「宽度锁死不跳版」（④）是同一条规矩的两半，所以两句话叠在同一个
          // 网格里同时参与排版：不可见那一句照样占宽，按钮的宽度因此是两态里的较长者，按下去不会自己变宽也不会变窄。
          <span className="grid items-center" data-result-text={result === 'done' && !busy ? 'done' : 'idle'}>
            <span className={`row-start-1 col-start-1 ${result === 'done' && !busy ? 'invisible' : ''}`}>
              {children}
            </span>
            <span className={`row-start-1 col-start-1 ${result === 'done' && !busy ? '' : 'invisible'}`}>
              {doneLabel}
            </span>
          </span>
        ) : (
          children
        )}
      </span>
    </button>
  );
}

/** `useDeskResult` 的返回：按动作标签取结果态 + 三个落点。 */
export interface DeskResultState {
  /**
   * 这一格动作的结果态；一屏同时只有**最近那一次动作**带结果，所以按标签问。
   * @param label 与 `useBridgeAction` 的 `run` 同一个动作标签
   */
  resultOf: (label: string) => DeskResult | undefined;
  /** 置为成功态并在 `doneMs` 后自动回落（07 稿：jade 只闪一下，不占着界面）。 */
  markDone: (label: string) => void;
  /** 置为失败态并**不**自动回落，等用户再动一次。 */
  markFailed: (label: string) => void;
  /** 清除结果态；下一次动作开始时由外壳自己调，用户不需要看见这个动作。 */
  clearResult: () => void;
}

/** `deskReason` 摊给 DeskButton 的那三个 props。 */
export type DeskDisabledProps = Pick<DeskButtonProps, 'disabled' | 'disabledReason' | 'disabledReasonLabel'>;

/**
 * 「按不动」三件套的唯一工厂：把原因码翻成人话、再摊成 DeskButton 的三个 props。
 * 只挂 `disabledReason` 不挂 `disabled` 是 6.4 第七片活体抓到的谎报（按钮挂着说法明的理由却照样能按），
 * 所以这三项必须一次给齐、不许在各面板各写一份（§2.2）。
 * @param translate 调用方的翻译函数（`useTranslation` 的那个 `t`）
 * @param reasonNamespace 原因码文案的命名空间，键形如 `<reasonNamespace>.reason.<CODE>`
 * @param busyReason 在途那一档的原因码；有它时它压过该键自己的前置条件，与转针读数一致
 * @returns `label`（码→话）、`reason`（在途优先的理由链）、`dead`（摊成三个 props，直接 spread）
 */
export function deskReason(
  translate: TFunction,
  reasonNamespace: string,
  busyReason?: string,
): {
  label: (code?: string) => string | undefined;
  reason: (blocked: boolean, code: string) => string | undefined;
  dead: (reason?: string) => DeskDisabledProps;
} {
  const label = (code?: string): string | undefined =>
    code === undefined ? undefined : translate(`${reasonNamespace}.reason.${code}`);
  return {
    label,
    reason: (blocked, code) => busyReason ?? (blocked ? code : undefined),
    dead: (reason) => ({
      disabled: reason !== undefined,
      disabledReason: reason,
      disabledReasonLabel: label(reason),
    }),
  };
}

/**
 * 结果态的计时回落。jade 是「已经办完」的回执，留久了会被误读成常驻状态；
 * seal 是「办砸了」，自动消失等于谎报，所以只有成功一侧挂定时器。
 * @param doneMs 成功态停留毫秒数，默认 2000（07 稿读数）
 * @returns 按动作标签取结果态的读数器，与三个落点
 */
export function useDeskResult(doneMs = 2000): DeskResultState {
  const [current, setCurrent] = useState<{ kind: DeskResult; label: string }>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearResult = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setCurrent(undefined);
  }, []);

  const markDone = useCallback(
    (label: string) => {
      if (timer.current) clearTimeout(timer.current);
      setCurrent({ kind: 'done', label });
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setCurrent(undefined);
      }, doneMs);
    },
    [doneMs],
  );

  const markFailed = useCallback((label: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setCurrent({ kind: 'failed', label });
  }, []);

  const resultOf = useCallback(
    (label: string): DeskResult | undefined => (current?.label === label ? current.kind : undefined),
    [current],
  );

  // 卸载时必须清掉，否则残留定时器会在组件销毁后 setState（本项目的句柄判据：不许变多）。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { resultOf, markDone, markFailed, clearResult };
}

/**
 * 副作用归属三档（工具卡片、算子标签、闸门提示都用这一套配色）。
 * 直接取 `@auto-cc/shared` 的 `ToolEffect`：注册表里是 `read / local-write / outbound`，
 * 界面自己另起一套驼峰命名就会出现"同一个概念两个名字"（§3.6 术语一致）。
 */
export type EffectTone = ToolEffect;

/** 效果色 → 描边/底色/文字：调色板分区与节点标签共用这一份，两处不许各写一档（§2.2）。
 *  文字取色相的**文字档** `-ink`：这三条都是「同色文字压在自己淡洗上」的载体，色相档在墨案朱砂
 *  那一档上只有 4.0（spec 6.1-06/6.1-09 普查），描边与淡洗继续走色相档。 */
export const EFFECT_TONE_CLASS: Record<EffectTone, string> = {
  read: 'border-jade/40 bg-jade-wash text-jade-ink',
  'local-write': 'border-amber/40 bg-amber-wash text-amber-ink',
  outbound: 'border-seal/45 bg-seal-wash text-seal-ink',
};

/**
 * 效果档 → 按钮语义档：算子调色板里每一颗「加入画布」的键必须与它所在分区同色（6.5-01 的归属规则），
 * 分区色与键色由同一份映射给出，不在调色板里另写一遍三档对应关系（§2.2）。
 */
export const EFFECT_BUTTON_VARIANT: Record<EffectTone, DeskVariant> = {
  read: 'jade',
  'local-write': 'amber',
  outbound: 'seal',
};

const EFFECT_ICON: Record<EffectTone, ReactNode> = {
  read: <BadgeCheck size={11} aria-hidden="true" />,
  'local-write': <Stamp size={11} aria-hidden="true" />,
  outbound: <Send size={11} aria-hidden="true" />,
};

export interface EffectChipProps {
  /** 副作用档位，与 `agent.tools` 的 sideEffect 枚举同名，界面不许自己发明第四档。 */
  effect: EffectTone;
  children: ReactNode;
}

/**
 * 副作用归属标签：一眼看出这个动作会不会离开这台机器（§8.3 的界面表达）。
 * @param effect 副作用档位
 * @param children 标签文案（调用方负责 i18n）
 */
export function EffectChip({ effect, children }: EffectChipProps) {
  return (
    <span
      data-effect={effect}
      className={`inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${EFFECT_TONE_CLASS[effect]}`}
    >
      {EFFECT_ICON[effect]}
      {children}
    </span>
  );
}

/** 横幅的四档底色：celadon=系统在说话，amber=等人，seal=风险，jade=办好了。 */
export type BannerTone = 'celadon' | 'amber' | 'seal' | 'jade';

/**
 * 语气档决定三件事：洗底、描边、**文字色**（稿 `assets/shared.css:1102-1116` 的 `.banner` 就是这么写的：
 * `background: var(--*-wash)` + `border-color: 同色 35%` + `color: var(--*)`）。
 * 文字按语气着色不是装饰：这四档在毡案被专门压深过（`globals.css:274-291`），就是为"当文字用"准备的，
 * 而统一成中性灰会把"系统在担心什么"这层信息只留给底色——色盲与低亮度下那条提示条就读不出来了。
 * **文字色取的是各档的「文字档」`-ink`，不是色相档**（6.1-09 色相半边裁定：先在令牌层把毡案四档压深，
 * 使文字档与色相档在毡案同值；墨案只有朱砂两档不同值，文案走浅一档的 `-ink`）。
 * 于是这条载体在两案里都过 AA，消费侧不需要按主题分支。
 */
const BANNER_CLASS: Record<BannerTone, string> = {
  celadon: 'border-celadon/40 bg-celadon-wash text-celadon-ink',
  amber: 'border-amber/45 bg-amber-wash text-amber-ink',
  seal: 'border-seal/50 bg-seal-wash text-seal-ink',
  jade: 'border-jade/45 bg-jade-wash text-jade-ink',
};

/**
 * 图标跟着语气走，不给调用方旋钮：语气到图标是这条形状的固有部分，
 * 开一个 `icon` 入参就是允许下一档自己挑图标（那才是第二套）。
 * `jade` 用 `BadgeCheck` 与结果态（本文件 `RESULT_ICON`）同一只——同一份事实只该有一张脸。
 */
const BANNER_ICON: Record<BannerTone, LucideIcon> = {
  celadon: Info,
  amber: CircleAlert,
  seal: TriangleAlert,
  jade: BadgeCheck,
};

/**
 * 提示条的尺寸档（6.2-18 裁定②：给 `Banner` 加一档，而不是让紧凑的条继续自己手写皮）。
 * 与 `FIELD_SIZE` 同一做法：**只换几何**（圆角 / 内边距 / 字号 / 图标边长），洗底、描边、
 * 文字色、图标形状一律由 `tone` 决定，两档共用——紧凑档不是第五种语气。
 */
const BANNER_SIZE = {
  /** 整条档：面板里绝大多数提示行，与 6.2 已验收的读数同一签名（7px 圆角 / 8px·12px 内边距 / 12px 字号）。 */
  full: 'rounded-control px-3 py-2 text-xs',
  /** 紧凑档：夹在列表与按钮之间的那几行，读起来贴着它所属的那一格，所以缩一档几何而不换皮。 */
  compact: 'rounded-md px-2 py-1 text-[10px]',
} as const;

/** 尺寸档的名字，也是对外接口。 */
export type BannerSize = keyof typeof BANNER_SIZE;

/** 图标边长跟着尺寸档走：写死 13 会让紧凑档的文字比图标还矮。 */
const BANNER_ICON_SIZE: Record<BannerSize, number> = { full: 13, compact: 11 };

export interface BannerProps {
  /** 语气档 */
  tone: BannerTone;
  /** 尺寸档，默认整条档；只换几何，不换语气（见 `BANNER_SIZE`） */
  size?: BannerSize;
  /** 挂在节点上的原因码，方便 harness 直接断言（09 稿的 ⊘ 类控件全靠它） */
  reason?: string;
  /** 附加的 `data-*` 标记（横幅常常要带读数：接管原因、时长、条数……） */
  markers?: Record<string, string>;
  /** 追加 class（贴在整条横幅外框上，例如去掉圆角改成通栏） */
  className?: string;
  children: ReactNode;
}

/**
 * 常驻提示条。设计稿规定：可逆的动作只用提示条，不用遮罩弹窗（09 稿 RULE）。
 * 洗底、描边、文字色、图标四件都由 `tone` 一档决定（见 `BANNER_CLASS` / `BANNER_ICON`），
 * 圆角、内边距、字号、图标边长由 `size` 一档决定，调用方只喂文案与外边档。
 * @param tone 语气档
 * @param size 尺寸档（可选，默认整条档）
 * @param reason 原因码（可选）
 * @param markers 附加 `data-*` 读数（可选）
 * @param className 追加在外框上的 class（可选，只放外边/宽度档）
 * @param children 文案（调用方负责 i18n）
 */
export function Banner({ tone, size = 'full', reason, markers, className = '', children }: BannerProps) {
  const Icon = BANNER_ICON[tone];
  const markerAttrs = Object.fromEntries(
    Object.entries(markers ?? {}).map(([name, value]) => [`data-${name}`, value]),
  ) as Record<string, string>;
  return (
    <div
      {...markerAttrs}
      {...(reason ? { 'data-reason': reason } : {})}
      className={`flex items-start gap-2 border leading-relaxed ${BANNER_SIZE[size]} ${BANNER_CLASS[tone]} ${className}`}
    >
      <Icon size={BANNER_ICON_SIZE[size]} className="mt-0.5 shrink-0 opacity-80" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{children}</div>
    </div>
  );
}

/**
 * 语气档 → 芯片的描边 / 洗底 / 文字（稿 `assets/shared.css:521-551` 的 `.tag.<tone>` 就这三件）。
 * **全渲染层只有 `src/ui/**` 里写 `*-wash` 字面量**：面板要读状态色就交一个 tone 名出去，
 * 不再自己拼 class（§2.5，也是 6.2-19 之后那条机检能成立的前提）。
 * 一条刻意的偏离写在这里而不是悄悄改：稿上墨案描边是 0.3、毡案是 0.4（`shared.css:1287-1296`），
 * 实现取 `/40` 一支共用——它同时是现状多数芯片已经在用的读数，为 0.1 的 alpha 开一条主题分支不值。
 */
const TAG_TONE_CLASS: Record<BannerTone, string> = {
  celadon: 'border-celadon/40 bg-celadon-wash text-celadon-ink',
  amber: 'border-amber/40 bg-amber-wash text-amber-ink',
  seal: 'border-seal/40 bg-seal-wash text-seal-ink',
  jade: 'border-jade/40 bg-jade-wash text-jade-ink',
};

/** 稿上 `.tag` 本体（不点语气档那一档）：`--ink-750` 底 + `--fg-2` 文字，即中性回执档。 */
const TAG_NEUTRAL_CLASS = 'border-line bg-ink-750 text-slate-300';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * 语气档；不给就是中性回执档。与 `Banner` 共用同一套四档名，界面不许发明第五档。
   * 语义按 §5 的效果归属：celadon=系统在说话，amber=等人，seal=风险/失败，jade=办好了。
   */
  tone?: BannerTone;
  /** 追加 class（只放外边与宽度档：`mr-1`、`mt-2` 这类，颜色与几何由原件管） */
  className?: string;
}

/**
 * 状态芯片（稿上的 `.tag`）：读"这一格/这一条此刻是什么状态"的那颗小标签。
 * 它与 `EffectChip` 是稿上两种形状，不是同一件事的两份实现——`EffectChip` 画"会不会离开这台机器"
 * （带前置点与 `data-effect`），`Tag` 画"此刻的状态"；两者都只有一只入口（§2.5）。
 * 行与卡片的语气**不归它管**：稿上行与卡片用描边表状态、底材留在墨面上（`shared.css:861-900`），
 * 那一族是 6.2-20 的射程。
 * @param tone 语气档（可选，不给走中性档）
 * @param className 只放外边/宽度档的追加 class
 * @param rest 透传给 `span` 的原生属性（harness 的 `data-*` 锚点从这里逐字过）
 */
export function Tag({ tone, className = '', ...rest }: TagProps) {
  return (
    <span
      {...(tone ? { 'data-tone': tone } : {})}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-chip border px-[7px] py-px text-[10.5px] ${tone ? TAG_TONE_CLASS[tone] : TAG_NEUTRAL_CLASS} ${className}`}
      {...rest}
    />
  );
}

/**
 * 块级语气（列表行、内容卡片、读数块）的描边档——**这一族在稿上从不吃 wash**。
 * 四档 alpha 逐条对稿：jade 0.5 = `.node.ok`（`shared.css:888-890`），amber 0.45 = `.btn-warn`（`469-473`），
 * celadon 0.5 = `.composer:focus-within`（`911-913`）；seal 在稿上是满色 + 一圈光（`.node.fail`），
 * 而这里的块级没有那圈光，就取面板现用区间（0.45~0.55）的中值 0.5，不开主题分支。
 * 面板要表状态就交 `BannerTone` 档名过来拼这一张表，不许在自己文件里写 `bg-*-wash`（§2.5）。
 */
export const BLOCK_EDGE_CLASS: Record<BannerTone, string> = {
  celadon: 'border-celadon/50',
  amber: 'border-amber/45',
  seal: 'border-seal/50',
  jade: 'border-jade/50',
};

/**
 * 块级的底材：墨面 `--ink-850` 那一档（稿上 `.tool` 与 `.card-foot` 用的都是它，
 * 见 `shared.css:660-667`、`357-362`）。语气**不上底材**——底材一旦跟着语气走，
 * 一块面板里三行不同状态就会长出三块色斑，读起来比描边慢。
 */
export const BLOCK_SURFACE_CLASS = 'bg-ink-850';

/**
 * 块级的「选中」档：稿上选中态不借语气色，而是把描边升到前景色第二档并提一层墨面
 * （`.node.on` = `border-color: var(--fg-2)`，`shared.css:898-901`）。
 * 所以"被选中"与"这一格在跑"可以同屏共存，而不是互相涂掉。
 * 一条如实的偏离：稿上还补了一圈 2px 的浅环，实现没有加——`ring-*` 会与画布节点已有的
 * `shadow-sm`、校验点的 `outline` 打架，那一圈留给画布自己的选中逻辑（`WorkflowCanvas.tsx:74-79`）。
 */
export const BLOCK_SELECTED_CLASS = 'border-slate-300/70 bg-ink-800';

/**
 * 字段档的尺寸档。**只有 `DeskTextarea` 用得上第二档**（用户 2026-10-06 裁定：对话输入区
 * 「原件加一个尺寸档」而不是并入元信息档）——composer 是全渲染层唯一让人连续打字的格子，
 * 11px 的元信息档读着像表格、敲着像填错地方，所以它单独占一档而不改别人。
 * 这一档只换几何与底材（圆角 / 内边距 / 字号 / 底色），描边色、文字色、聚焦环一律共用，
 * 否则同一件事又会长出两种画法（§2.5）。
 */
const FIELD_SIZE = {
  /** 元信息档：面板里绝大多数格子，与 6.1 普查的统一桶同一签名。 */
  meta: 'rounded-md bg-ink-950 px-2 py-1 text-[11px]',
  /** 对话输入区那一档：8px 圆角、12px 字号、半透底（它压在聊天面板的底色上）。 */
  composer: 'rounded-lg bg-ink-950/60 px-3 py-2 text-xs',
} as const;

/** 尺寸档的名字，也是对外接口。 */
export type DeskFieldSize = keyof typeof FIELD_SIZE;

/**
 * 校验失败必须**换掉**描边而不是在后面追加一条：Tailwind 生成的样式表按它自己的顺序排，
 * `border-seal` 与 `border-line-strong` 谁赢取决于令牌声明顺序，写在 class 属性里的先后不作数
 * （6.4 第十片量到的正是这一类「同族两条互相覆盖」）。同一道理，尺寸档也是在这**一条**串里换档，
 * 不是往串尾再拼一条 `rounded-lg`——那等于把 6.2-10 的坑原地复现一次。
 * @param isInvalid 该格是否处于「必填未填 / 未过契约」那一态
 * @param size 尺寸档，默认元信息档（只有文本域有第二档）
 * @returns 完整 class 串
 */
const fieldClass = (isInvalid: boolean, size: DeskFieldSize = 'meta'): string =>
  `min-w-0 border ${isInvalid ? 'border-seal ring-1 ring-seal/40' : 'border-line-strong'} ` +
  `${FIELD_SIZE[size]} text-slate-200 outline-none focus:border-celadon/60`;

/** 行内编辑的输入框 class：青瓷描边是「正在编辑」的唯一信号，不加阴影不放大。 */
const EDIT_INPUT =
  'w-full rounded-chip border border-celadon/60 bg-ink-900 px-2 py-1 text-xs text-slate-50 ' +
  'focus:outline-none focus:ring-1 focus:ring-celadon/70';

/**
 * 表单五件原件（输入框 / 下拉 / 文本域 / 勾选 / 滑杆）共用的外档。`action` 强制（6.2-03：无 `action` 不可编译），
 * `className` **只许放宽度与外边档**（`flex-1`、`w-24`、`mt-2`），描边/底色/字号一律在原件里——
 * 面板再各写一遍这一串就是回到 54 处裸控件的老路（§2.2），所以它不导出。
 */
interface DeskFieldShell {
  /** `data-action` 值：harness 定位这只控件的凭据。 */
  action: string;
  /** 控件上方的说明文案（调用方翻译好传入）；不传就只出控件本身，用于贴在行里的紧凑档。 */
  label?: ReactNode;
  /** 宽度/外边档，追加在原件样式之后。 */
  className?: string;
  /** 该格处于「必填未填 / 没过大写约束」那一态：整圈朱砂，见 `fieldClass`。 */
  isInvalid?: boolean;
}

/** 带 label 那一档的排法：文案在上、控件在下，11px 的元信息档。 */
const STACK_LABEL = 'flex flex-col gap-1 text-[11px] text-slate-400';

export interface DeskFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'className'>, DeskFieldShell {
  /** 当前值（数字档也是字符串草稿，解析由调用方在提交时做）。 */
  value: string;
  /** 取值回调：原件已经把 `event.target.value` 收掉。 */
  onValueChange: (value: string) => void;
}

/**
 * 单行输入框（`type` 覆盖 text / number / date 等原生档）。
 * @param action `data-action` 凭据
 * @param label 上方说明文案（可省）
 * @param className 宽度/外边档
 * @param isInvalid 校验失败档（整圈朱砂，见 `fieldClass`）
 * @param value 当前值
 * @param onValueChange 取值回调
 * @param rest 其余原生属性照旧透传（`placeholder`/`min`/`step`/`disabled`/`data-*`/`onKeyDown`……）
 * @returns 输入框；带 `label` 时套一层 `<label>`
 */
export function DeskField({ action, label, className = '', isInvalid, value, onValueChange, ...rest }: DeskFieldProps) {
  const field = (
    <input
      data-action={action}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      className={`${fieldClass(isInvalid === true)} ${className}`}
      {...rest}
    />
  );
  return label ? (
    <label className={STACK_LABEL}>
      {label}
      {field}
    </label>
  ) : (
    field
  );
}

export interface DeskSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'className'>, DeskFieldShell {
  /** 当前选中值。 */
  value: string;
  /** 选中回调（收人话签名）。 */
  onValueChange: (value: string) => void;
}

/**
 * 下拉框：`children` 由调用方给 `<option>` 列表（选项常常是动态的，不在原件里造数据）。
 * @param action `data-action` 凭据
 * @param label 上方说明文案（可省）
 * @param className 宽度/外边档
 * @param isInvalid 校验失败档（整圈朱砂）
 * @param value 当前值
 * @param onValueChange 选中回调
 * @param rest 原生 select 属性透传
 * @returns 下拉框；带 `label` 时套一层 `<label>`
 */
export function DeskSelect({
  action,
  label,
  className = '',
  isInvalid,
  value,
  onValueChange,
  children,
  ...rest
}: DeskSelectProps) {
  const field = (
    <select
      data-action={action}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      className={`${fieldClass(isInvalid === true)} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
  return label ? (
    <label className={STACK_LABEL}>
      {label}
      {field}
    </label>
  ) : (
    field
  );
}

export interface DeskTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'className'>, DeskFieldShell {
  /** 当前文本。 */
  value: string;
  /** 取值回调（收人话签名）。 */
  onValueChange: (value: string) => void;
  /** 尺寸档，默认 `meta`；对话输入区用 `composer`（见 `FIELD_SIZE`）。 */
  size?: DeskFieldSize;
}

/**
 * 多行文本域：与 `DeskField` 同一支 `fieldClass`，只多一条「不许斜着拖坏布局」与一档尺寸。
 * @param action `data-action` 凭据
 * @param label 上方说明文案（可省）
 * @param className 宽度/高度档
 * @param isInvalid 校验失败档（整圈朱砂）
 * @param value 当前文本
 * @param onValueChange 取值回调
 * @param size 尺寸档（`meta` 元信息 / `composer` 对话输入区）
 * @param rest 原生 textarea 属性透传（`rows`/`spellCheck`/`data-*`……）
 * @returns 文本域；带 `label` 时套一层 `<label>`
 */
export function DeskTextarea({
  action,
  label,
  className = '',
  isInvalid,
  value,
  onValueChange,
  size = 'meta',
  ...rest
}: DeskTextareaProps) {
  const field = (
    <textarea
      data-action={action}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      className={`${fieldClass(isInvalid === true, size)} resize-none leading-relaxed ${className}`}
      {...rest}
    />
  );
  return label ? (
    <label className={STACK_LABEL}>
      {label}
      {field}
    </label>
  ) : (
    field
  );
}

/** 勾选档的归属色：celadon=系统里的常态选择，seal=签字类，jade=已读类，amber=本机写入类。 */
const CHECK_TONE = {
  celadon: 'accent-celadon',
  seal: 'accent-seal',
  jade: 'accent-jade',
  amber: 'accent-amber',
} as const;

export interface DeskCheckProps
  extends
    Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'checked' | 'className'>,
    Omit<DeskFieldShell, 'isInvalid'> {
  /** 是否勾上。 */
  checked: boolean;
  /** 勾选回调（收人话签名：布尔，不是事件）。 */
  onCheckedChange: (checked: boolean) => void;
  /** 归属色档，默认青瓷——默认值刻意不给浏览器那支蓝（6.1-06 普查里勾选框是全 app 唯一的离色控件）。 */
  tone?: keyof typeof CHECK_TONE;
  /** 复选还是单选：两者只差在原生 `type` 与语义（单选靠同 `name` 归组），样式同源。 */
  type?: 'checkbox' | 'radio';
}

/**
 * 勾选控件（复选 / 单选同一件）：`data-checked` 由原件统一写，面板不再各自抹一遍。
 * @param action `data-action` 凭据
 * @param label 旁边的文案（可省；需要"勾选后变色"这类判据时由调用方自己配 `<label htmlFor>`）
 * @param className 追加档（`mt-0.5` 这类对齐微调）
 * @param checked 当前勾选态
 * @param onCheckedChange 勾选回调
 * @param tone 归属色档
 * @param type 复选 / 单选
 * @param rest 原生 input 属性透传（`name`/`id`/`disabled`/`data-*`……）
 * @returns 勾选框；带 `label` 时套一层横排的 `<label>`
 */
export function DeskCheck({
  action,
  label,
  className = '',
  checked,
  onCheckedChange,
  tone = 'celadon',
  type = 'checkbox',
  ...rest
}: DeskCheckProps) {
  const box = (
    <input
      type={type}
      data-action={action}
      data-checked={checked ? 'true' : 'false'}
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      className={`mt-0.5 size-3.5 shrink-0 ${CHECK_TONE[tone]} ${className}`}
      {...rest}
    />
  );
  return label ? (
    <label className="flex items-start gap-2 text-xs text-slate-300">
      {box}
      {label}
    </label>
  ) : (
    box
  );
}

export interface DeskRangeProps
  extends
    Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'checked' | 'className'>,
    Omit<DeskFieldShell, 'isInvalid'> {
  /** 当前读数（草稿也是字符串，解析与夹取由调用方做）。 */
  value: string | number;
  /** 拖动回调（收人话签名：字符串读数，与 `DeskField` 同一条口径）。 */
  onValueChange: (value: string) => void;
}

/**
 * 滑杆（`type="range"`）：与勾选框同族——两者都不吃 `fieldClass` 那套描边，
 * 只把归属色交给原生的 `accent`，所以它独立一件而不是 `DeskField` 的一个 `type` 档。
 * @param action `data-action` 凭据
 * @param label 上方说明文案（可省）
 * @param className 宽度档（滑杆的长短是这一屏唯一的排布变量）
 * @param value 当前读数
 * @param onValueChange 拖动回调
 * @param rest 原生 input 属性透传（`min`/`max`/`step`/`disabled`/`data-*`……）
 * @returns 滑杆；带 `label` 时套一层 `<label>`
 */
export function DeskRange({ action, label, className = '', value, onValueChange, ...rest }: DeskRangeProps) {
  const slider = (
    <input
      type="range"
      data-action={action}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      className={`h-1.5 shrink-0 cursor-pointer accent-celadon ${className}`}
      {...rest}
    />
  );
  return label ? (
    <label className={STACK_LABEL}>
      {label}
      {slider}
    </label>
  ) : (
    slider
  );
}

export interface DeskDisclosureProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `data-action` 值：harness 定位这只披露键的凭据。 */
  action: string;
  /** 正文当前在不在页面上。原件只负责把它挂成 `data-open` 与 `aria-expanded`，正文本身归调用方持有。 */
  open: boolean;
}

/**
 * 行内披露（"看证据 / 看出处"那一类）：只有下划线档的文案，无框无底——它展开的是紧挨其下的一小段正文，
 * 不是一次动作，所以既不能涂 `DeskButton` 的六档（那会造出"按钮长得像文字链"的第四种画法），
 * 也不许留在面板里各写一遍 class（`GeneratePanel` 与 `GapPanel` 原先抄的是同一条字面量，§2.2 的第二 occurrence）。
 * @param action `data-action` 凭据
 * @param open 正文此刻在不在（由调用方判，例如"这一条的正文有没有取回来"）
 * @param className 追加档（一般是行内对齐的微调，不写颜色与字号）
 * @param rest 原生 button 属性透传（`onClick`、`data-*`、`disabled`……）
 * @returns 一只可展开/收起的文字键
 */
export function DeskDisclosure({ action, open, className = '', ...rest }: DeskDisclosureProps) {
  return (
    <button
      type="button"
      data-action={action}
      data-open={open ? 'true' : 'false'}
      aria-expanded={open}
      className={`text-left text-[11px] text-slate-400 hover:text-celadon ${className}`}
      {...rest}
    />
  );
}

/** `DeskSegmented` 的一格。类型参数是这一组取值的联合（调用方不必再把回调实参断言回去）。 */
export interface DeskSegmentOption<T extends string = string> {
  /** 该格的值（回报给 `onSelect`，同时是 `data-action` 后缀）。 */
  readonly value: T;
  /** 该格的文案（调用方翻译好传入）。 */
  readonly label: ReactNode;
  /**
   * 选中那一格涂朱砂。**只有"选上它就把风险抬高"的档才给**（plan §5 的归属表：朱砂=外发与不可逆），
   * 普通选中不给这一档，否则"选中态"本身会被读成"已经在冒险"。
   */
  readonly isRisk?: boolean;
  /** 附加 `data-*` 读数（迁移旧消费者时保住既有验收凭据，照 `Banner` 的 `markers` 同形）。 */
  readonly markers?: Record<string, string>;
}

export interface DeskSegmentedProps<T extends string = string> {
  /** 这一组的 `data-action` 前缀：每格拿到 `<action>-<value>`。 */
  action: string;
  /** 互斥的若干格，顺序即从左到右。 */
  options: readonly DeskSegmentOption<T>[];
  /** 当前选中值；`undefined` 表示还没有读数（一格都不涂选中档）。 */
  value: T | undefined;
  /** 选中回调（收人话签名：值，不是事件）。 */
  onSelect: (value: T) => void;
  /** 在途：整组按不动，且**不**派发 `onSelect`。 */
  busy?: boolean;
  /** 按不动时挂到每只格上的原因码（与 `DeskButton` 同一口径）。 */
  disabledReason?: string;
  /** 原因码对人说的话（只给码不给这句话就是谎报，见 `DeskButton` 的 props 注释）。 */
  disabledReasonLabel?: string;
  /** 整组的外边/对齐档。 */
  className?: string;
  /** 挂在组容器上的附加 `data-*`（旧消费者常拿它当 testid）。 */
  markers?: Record<string, string>;
}

/**
 * 分段控件：N 只互斥格共用一个框，选中那一格实底。
 * 它存在的理由是档位这类"选一档"的形态在 07 稿里既不是按钮也不是页签；
 * 「按不动」走 `aria-disabled` 而不是原生 `disabled`（原生禁用不派发鼠标事件，`title` 就不出现）。
 * @param action 每只格的 `data-action` 前缀
 * @param options 互斥格列表
 * @param value 当前选中值
 * @param onSelect 选中回调
 * @param busy 是否在途
 * @param disabledReason 禁用原因码（可选）
 * @param disabledReasonLabel 禁用原因的人话（可选）
 * @param className 整组的外边/对齐档
 * @param markers 组容器上的附加 `data-*`
 * @returns 一条带框的分段控件
 */
export function DeskSegmented<T extends string>({
  action,
  options,
  value,
  onSelect,
  busy = false,
  disabledReason,
  disabledReasonLabel,
  className = '',
  markers,
}: DeskSegmentedProps<T>) {
  const groupAttrs = Object.fromEntries(
    Object.entries(markers ?? {}).map(([name, attr]) => [`data-${name}`, attr]),
  ) as Record<string, string>;
  return (
    <span
      role="group"
      {...groupAttrs}
      className={`inline-flex gap-0.5 rounded-lg border border-line-strong bg-ink-950 p-0.5 ${className}`}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            data-action={`${action}-${option.value}`}
            data-on={isSelected ? 'true' : 'false'}
            aria-pressed={isSelected}
            {...Object.fromEntries(Object.entries(option.markers ?? {}).map(([name, attr]) => [`data-${name}`, attr]))}
            {...(busy
              ? { 'aria-disabled': true, ...(disabledReason ? { 'data-disabled-reason': disabledReason } : {}) }
              : { onClick: () => onSelect(option.value) })}
            {...(busy && disabledReasonLabel ? { title: disabledReasonLabel } : {})}
            // 选中档按"是不是风险档"分两支；未选中档永远只提亮文字，不预支任何语气。
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors duration-150 ${busy ? 'opacity-40 ' : ''}${
              isSelected
                ? option.isRisk
                  ? 'bg-seal-wash text-seal-ink ring-1 ring-inset ring-seal/35'
                  : 'bg-ink-750 text-slate-100'
                : 'text-slate-500 hover:bg-ink-800 hover:text-slate-300'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

/**
 * 页签的尺寸档。`muted` 不是"次要按钮"，而是 6.3-02 那条「诊断视图低一档」的兑现：
 * 图标、字号、字重与选中描线一起降一档，让导航六格里有一格在视觉上退后。
 */
export type DeskTabTier = 'primary' | 'muted';

export interface DeskTabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** 这一格的 `data-action`（导航档固定 `nav-<view>`，是 harness 与冒烟脚本的既有凭据）。 */
  action: string;
  /** 这一格承载的视图 id，原样挂到 `data-view`（`chat` / `workflow` 两支锚点不许改名）。 */
  view: string;
  /** 是否是当前视图：选中只改「一道短线 + 文字提亮 + 底色提一档」，不换成实底按钮。 */
  selected: boolean;
  /** 图标组件。尺寸由档位决定（原件唯一出路：调用方各抄 15/12 就会长回两套）。 */
  icon: ComponentType<{ size?: number; className?: string }>;
  /** 尺寸档，默认 `primary`。 */
  tier?: DeskTabTier;
  /** 只放宽度/外边档；描边、底色、字号一律在原件里。 */
  className?: string;
}

/**
 * 导航页签（01 稿左栏那一格）：非六档按钮语义，所以不进 `DeskButton`。
 * 选中态按稿上是「贴在轨道左缘的一道 3×17 短线」而不是整块高亮——一眼知道我在哪，又不抢内容；
 * 短线颜色走 **celadon 不走 seal**（plan §5 的归属表：seal 只给外发/不可逆/风险，
 * "此刻指向哪一格"不是风险）。低一档那格的短线用 slate-500，与已入库的 6.3-02 读数一致。
 */
export function DeskTab({
  action,
  view,
  selected,
  icon: Icon,
  tier = 'primary',
  className = '',
  children,
  ...rest
}: DeskTabProps) {
  const isMuted = tier === 'muted';
  const marker = selected ? (isMuted ? 'before:bg-slate-500' : 'before:bg-celadon') : 'before:bg-transparent';
  return (
    <button
      type="button"
      data-action={action}
      data-view={view}
      data-selected={selected ? 'true' : 'false'}
      aria-current={selected ? 'page' : undefined}
      className={`relative flex items-center rounded-control before:absolute before:-left-2 before:top-1/2 before:h-[17px] before:w-[3px] before:-translate-y-1/2 before:rounded-r-[2px] before:content-[''] ${marker} ${
        isMuted
          ? `gap-2 px-2.5 py-1.5 text-[11px] ${
              selected ? 'bg-ink-800 text-slate-300' : 'text-slate-500 hover:bg-ink-850 hover:text-slate-400'
            }`
          : `gap-2.5 px-2.5 py-2 text-xs font-medium ${
              selected ? 'bg-ink-800 text-slate-50' : 'text-slate-400 hover:bg-ink-850 hover:text-slate-100'
            }`
      } ${className}`}
      {...rest}
    >
      <Icon size={isMuted ? 12 : 15} className="shrink-0" />
      {children}
    </button>
  );
}

export interface InlineEditFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  /** 该字段的 `data-action` 值（保存那一下的凭据）。 */
  action: string;
  /** 当前值，由调用方持有——输入框自己不留草稿，否则「按钮读的那份」和「人敲的那份」会分家。 */
  value: string;
  /** 每次敲键回报当前值。 */
  onValueChange: (next: string) => void;
  /** 保存（Enter）；空串一类的业务校验由调用方判。 */
  onSave: () => void;
  /** 还原（Esc）；退出编辑态由调用方决定草稿怎么收。 */
  onCancel?: () => void;
  /** 编辑提示文案（例如「Enter 保存 · Esc 还原」），由调用方翻译。 */
  hint?: ReactNode;
}

/**
 * 就地编辑（09 稿的形态②）：点「修改」不长弹窗，字段原地变输入框。
 * Enter 保存、Esc 还原；这两个键是设计稿承诺的键盘等价，不是可选增强。
 * @param action 输入框的 `data-action`
 * @param value 当前值（受控）
 * @param onValueChange 敲键回报
 * @param onSave 保存回调
 * @param onCancel 还原回调
 * @param hint 提示行
 * @returns 一个自动聚焦的输入框加一行提示
 */
export function InlineEditField({
  action,
  value,
  onValueChange,
  onSave,
  onCancel,
  hint,
  ...rest
}: InlineEditFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <input
        data-action={action}
        data-editing="true"
        className={EDIT_INPUT}
        value={value}
        autoFocus
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSave();
          else if (event.key === 'Escape') onCancel?.();
        }}
        {...rest}
      />
      {hint ? <span className="text-[10px] text-slate-500">{hint}</span> : null}
    </div>
  );
}

/**
 * 武装有效期。倒计时条与这张表必须是同一个数：条走满就是解除的那一刻（09 稿形态⑤′：4 秒）。
 * 原先它是 `armMs` prop（默认 4000）而条的时长写死在 class 里——传别的数就会"条还在、闸已关"，
 * 且没有任何调用方用过非默认值，所以收成模块常量（时长要由 Tailwind 扫得到，动态拼不出 class）。
 */
const ARM_MS = 4000;

/** armed 倒计时条的动画宽度：与 `ARM_MS` 同步走满，走满即解除。 */
const ARM_COUNTDOWN = 'h-0.5 rounded-chip bg-seal/70 origin-left animate-[wash_4s_linear_forwards]';

/**
 * 两步 armed 键的输入：除 `action` / `confirmAction` / `onConfirm` / `armedLabel` 四位，
 * 其余（`variant`/`compact`/`busy`/禁用三件套/`className`/`markers`）**整份转给两态共用的 `DeskButton`**，
 * 面板不必为第二步再写一遍样式。
 */
export interface ArmButtonProps extends Omit<DeskButtonProps, 'action' | 'onClick' | 'children'> {
  /** 第一步（进入 armed）的 `data-action`。 */
  action: string;
  /** 第二步（真正执行）的 `data-action`：harness 与判据都点这一只。 */
  confirmAction: string;
  /** 第二步按下后真正执行的动作。 */
  onConfirm: () => void;
  /** 未武装时的文案。 */
  children: ReactNode;
  /** 已武装时的文案（例如「再点一次才写入」）。 */
  armedLabel: ReactNode;
}

/**
 * 两步就地确认（09 稿形态⑤′）：轻率点一下只武装，四秒内再点一下才动手。
 * 用来替代弹窗——「不可逆但一眼看得清」的动作不该再盖一层遮罩。
 *
 * 两态的 `data-action` 是**两个值**（`action` → `confirmAction`）：判据要能单凭 DOM 断言
 * 「第一次点没有执行」，同一只键换属性不够显眼，而 harness 点的必须是第二只。
 * @param action 武装那一步的 `data-action`
 * @param confirmAction 确认那一步的 `data-action`（武装后节点上同时挂 `data-armed="true"`）
 * @param onConfirm 真执行的动作
 * @param children 未武装时的文案
 * @param armedLabel 武装时的文案
 * @param markers 附加的 `data-*`（两态都带，armed 那位由本组件补）
 * @param variant 语义档，默认朱砂（只有不可逆的动作才用两步 armed）
 * @returns 一只按钮；武装时附一条四秒倒计时
 */
export function ArmButton({
  action,
  confirmAction,
  onConfirm,
  children,
  armedLabel,
  markers,
  variant = 'seal',
  ...rest
}: ArmButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <DeskButton action={action} variant={variant} markers={markers} {...rest} onClick={() => setArmed(true)}>
        {children}
      </DeskButton>
    );
  }

  return (
    <span className="relative inline-flex">
      <DeskButton
        action={confirmAction}
        variant={variant}
        markers={{ ...markers, armed: 'true' }}
        {...rest}
        // 确认一次就解除武装：下一次写入必须重新武装一遍，
        // 不然倒计时条走完后的那几帧里连点两下会写进两条。
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {armedLabel}
      </DeskButton>
      <span aria-hidden="true" className={`absolute -bottom-1 left-0 right-0 ${ARM_COUNTDOWN}`} />
    </span>
  );
}

/** `DeskViewTrail` 的入参：所有文案都是调用方翻好的字符串（§5.7，原件不拼句子）。 */
export interface DeskViewTrailProps {
  /** 面包屑条的 harness 凭据；「返回」那颗渲染成 `<action>-back`。 */
  action: string;
  /** 「来自」这一格的标签文案。 */
  fromLabel: string;
  /** 来源视图的标题（第一只 chip，稿上吃 celadon——是系统在说话）。 */
  sourceTitle: string;
  /** 来源视图里被带走的那个对象（岗位标题、会话标题），可缺。 */
  sourceDetail?: string;
  /** 目标视图的标题（第二只 chip，稿上是中性档）。 */
  targetTitle: string;
  /** 目标视图里落到的那一段，可缺。 */
  targetDetail?: string;
  /** 「返回〈来源〉」的已翻译整句。 */
  backLabel: string;
  /** 返回回调：切回来源视图并收起这一跳。 */
  onBack: () => void;
}

/**
 * 跨视图推进顶上的来源面包屑（09 稿形态⑥，spec 6.2-24）。
 *
 * 稿上的规则只有两句：**跨视图跳转一定要长这条**（同视图内的锚点跳转不需要，所以它只由
 * `viewTrail.ts` 那一跳的存在与否决定，不由视图决定），以及**「返回」回来源视图时滚动位置不变**
 * （视图靠 `hidden` 收起、从不卸载，这里因此只负责清掉这一跳，不做任何恢复动作）。
 * 推进类控件按下瞬间不给 loading——目标是本地已渲染的视图，出现转针就说明实现走错了路。
 *
 * @param props 见 `DeskViewTrailProps`
 * @returns 一条 42px 高的横栏，返回键贴右
 */
export function DeskViewTrail({
  action,
  fromLabel,
  sourceTitle,
  sourceDetail,
  targetTitle,
  targetDetail,
  backLabel,
  onBack,
}: DeskViewTrailProps) {
  return (
    <div
      data-view-trail={action}
      className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-ink-850 px-3 py-2"
    >
      <span className="font-mono text-[11px] text-slate-500">{fromLabel}</span>
      <Tag tone="celadon" data-trail-segment="source">
        {sourceTitle}
      </Tag>
      {sourceDetail ? (
        <span data-trail-segment="source-detail" className="max-w-[18rem] min-w-0 truncate text-[11px] text-slate-300">
          {sourceDetail}
        </span>
      ) : null}
      <span aria-hidden="true" className="font-mono text-[11px] text-slate-500">
        ›
      </span>
      <Tag data-trail-segment="target">{targetTitle}</Tag>
      {targetDetail ? (
        <span data-trail-segment="target-detail" className="font-mono text-[11px] text-slate-300">
          {targetDetail}
        </span>
      ) : null}
      <DeskButton action={`${action}-back`} variant="line" compact className="ml-auto" onClick={onBack}>
        {backLabel}
      </DeskButton>
    </div>
  );
}
