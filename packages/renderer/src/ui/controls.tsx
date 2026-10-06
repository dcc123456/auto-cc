import { BadgeCheck, CircleAlert, LoaderCircle, Send, Stamp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
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
      ? 'cursor-not-allowed border-line bg-ink-850 text-slate-500 '
      : // 默认 → 悬停（提亮一档、无位移）→ 按下（下移 1px + 回到 ink-800）
        'active:translate-y-px active:bg-ink-800 ');
  const tone =
    variant === 'seal'
      ? 'border-seal/45 bg-seal/18 text-seal hover:border-seal/70 hover:bg-seal/28 hover:text-slate-50'
      : variant === 'jade'
        ? 'border-jade/40 bg-jade/14 text-jade hover:border-jade/65 hover:bg-jade/24 hover:text-slate-50'
        : variant === 'amber'
          ? 'border-amber/40 bg-amber/14 text-amber hover:border-amber/65 hover:bg-amber/24 hover:text-slate-50'
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
  done: <BadgeCheck size={14} className="text-jade" aria-hidden="true" />,
  failed: <Stamp size={14} className="text-seal" aria-hidden="true" />,
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
  return (
    <button
      type="button"
      data-action={action}
      data-effect={variant}
      {...markerAttrs}
      {...(disabledReason ? { 'data-disabled-reason': disabledReason } : {})}
      aria-disabled={isDead || undefined}
      // 不用原生 `disabled`：Chromium 对禁用控件不派发鼠标事件，title 提示也就不会出现，
      // 人只会看到"按不动"而看不到为什么按不动（07 稿④）。改走 aria-disabled + 这里挡下 onClick。
      {...(isDead ? {} : { onClick })}
      {...(isDead && disabledReasonLabel ? { title: disabledReasonLabel } : {})}
      className={`relative overflow-hidden rounded-control ${buttonClass(variant, isDead, compact)} ${className}`}
      {...rest}
    >
      {/* 底色 wash 压在文字后面：结果态不改变按钮尺寸，只加一层颜色与一枚角标 */}
      {result && !busy ? <span className={`pointer-events-none absolute inset-0 ${RESULT_WASH[result]}`} /> : null}
      <span className={SPINNER_SLOT}>
        {busy ? <LoaderCircle size={14} className="animate-needle" aria-hidden="true" /> : null}
      </span>
      <span className="relative flex items-center gap-1">
        {children}
        {result && !busy ? RESULT_ICON[result] : null}
      </span>
    </button>
  );
}

/** `useDeskResult` 的返回：读数 + 两个落点 + 手动清除。 */
export interface DeskResultState {
  /** 当前结果态，undefined 表示无结果或已回落。 */
  result?: DeskResult;
  /** 置为成功态并在 `doneMs` 后自动回落（07 稿：jade 只闪一下，不占着界面）。 */
  markDone: () => void;
  /** 置为失败态并**不**自动回落，等用户再动一次。 */
  markFailed: () => void;
  /** 清除结果态；下一次点击前组件自己调，用户不需要看见这个动作。 */
  clearResult: () => void;
}

/**
 * 结果态的计时回落。jade 是「已经办完」的回执，留久了会被误读成常驻状态；
 * seal 是「办砸了」，自动消失等于谎报，所以只有成功一侧挂定时器。
 * @param doneMs 成功态停留毫秒数，默认 2000（07 稿读数）
 * @returns 结果态读数与三个动作
 */
export function useDeskResult(doneMs = 2000): DeskResultState {
  const [result, setResult] = useState<DeskResult>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearResult = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setResult(undefined);
  }, []);

  const markDone = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setResult('done');
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setResult(undefined);
    }, doneMs);
  }, [doneMs]);

  const markFailed = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setResult('failed');
  }, []);

  // 卸载时必须清掉，否则残留定时器会在组件销毁后 setState（本项目的句柄判据：不许变多）。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { result, markDone, markFailed, clearResult };
}

/**
 * 副作用归属三档（工具卡片、算子标签、闸门提示都用这一套配色）。
 * 直接取 `@auto-cc/shared` 的 `ToolEffect`：注册表里是 `read / local-write / outbound`，
 * 界面自己另起一套驼峰命名就会出现"同一个概念两个名字"（§3.6 术语一致）。
 */
export type EffectTone = ToolEffect;

/** 效果色 → 描边/底色/文字：调色板分区与节点标签共用这一份，两处不许各写一档（§2.2）。 */
export const EFFECT_TONE_CLASS: Record<EffectTone, string> = {
  read: 'border-jade/40 bg-jade-wash text-jade',
  'local-write': 'border-amber/40 bg-amber-wash text-amber',
  outbound: 'border-seal/45 bg-seal-wash text-seal',
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

const BANNER_CLASS: Record<BannerTone, string> = {
  celadon: 'border-celadon/40 bg-celadon-wash text-slate-100',
  amber: 'border-amber/45 bg-amber-wash text-slate-100',
  seal: 'border-seal/50 bg-seal-wash text-slate-100',
  jade: 'border-jade/45 bg-jade-wash text-slate-100',
};

export interface BannerProps {
  /** 语气档 */
  tone: BannerTone;
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
 * @param tone 语气档
 * @param reason 原因码（可选）
 * @param markers 附加 `data-*` 读数（可选）
 * @param className 追加在外框上的 class（可选）
 * @param children 文案（调用方负责 i18n）
 */
export function Banner({ tone, reason, markers, className = '', children }: BannerProps) {
  const markerAttrs = Object.fromEntries(
    Object.entries(markers ?? {}).map(([name, value]) => [`data-${name}`, value]),
  ) as Record<string, string>;
  return (
    <div
      {...markerAttrs}
      {...(reason ? { 'data-reason': reason } : {})}
      className={`flex items-start gap-2 rounded-control border px-3 py-2 text-xs leading-relaxed ${BANNER_CLASS[tone]} ${className}`}
    >
      <CircleAlert size={13} className="mt-0.5 shrink-0 opacity-70" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{children}</div>
    </div>
  );
}

/** 行内编辑的输入框 class：青瓷描边是「正在编辑」的唯一信号，不加阴影不放大。 */
const EDIT_INPUT =
  'w-full rounded-chip border border-celadon/60 bg-ink-900 px-2 py-1 text-xs text-slate-50 ' +
  'focus:outline-none focus:ring-1 focus:ring-celadon/70';

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

/** armed 倒计时条的动画宽度：4 秒走满，走满即解除（09 稿形态⑤′）。 */
const ARM_COUNTDOWN = 'h-0.5 rounded-chip bg-seal/70 origin-left animate-[wash_4s_linear_forwards]';

export interface ArmButtonProps {
  /** 第一步（进入 armed）的 `data-action`。 */
  action: string;
  /** 第二步（真正执行）的 `data-action`，harness 要点这一只。 */
  confirmAction: string;
  /** 第二步按下后真正执行的动作。 */
  onConfirm: () => void;
  /** 未武装时的文案。 */
  children: ReactNode;
  /** 已武装时的文案（例如「再按一次确认」）。 */
  armedLabel: ReactNode;
  /** 武装有效期毫秒数，默认 4000（09 稿读数）。 */
  armMs?: number;
  /** 禁用原因码。 */
  disabledReason?: string;
  disabled?: boolean;
  /** 语义档，默认朱砂（不可逆才用两步 armed）。 */
  variant?: DeskVariant;
}

/**
 * 两步就地确认（09 稿形态⑤′）：轻率点一下只武装，四秒内再点一下才动手。
 * 用来替代弹窗——「不可逆但一眼看得清」的动作不该再盖一层遮罩。
 * @param action 武装动作的 `data-action`
 * @param confirmAction 确认动作的 `data-action`
 * @param onConfirm 真执行的动作
 * @param armedLabel 武装态文案
 * @param armMs 武装有效期
 * @returns 一只按钮；武装时附一条倒计时
 */
export function ArmButton({
  action,
  confirmAction,
  onConfirm,
  children,
  armedLabel,
  armMs = 4000,
  disabledReason,
  disabled,
  variant = 'seal',
}: ArmButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), armMs);
    return () => clearTimeout(timer);
  }, [armed, armMs]);

  if (!armed) {
    return (
      <DeskButton
        action={action}
        variant={variant}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={() => setArmed(true)}
      >
        {children}
      </DeskButton>
    );
  }

  return (
    <span className="relative inline-flex">
      <DeskButton action={confirmAction} markers={{ armed: 'true' }} variant={variant} onClick={onConfirm}>
        {armedLabel}
      </DeskButton>
      <span aria-hidden="true" className={`absolute -bottom-1 left-0 right-0 ${ARM_COUNTDOWN}`} />
    </span>
  );
}
