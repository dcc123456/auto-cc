import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';

/**
 * 可拖宽度的那一栏（右侧栏）共用的形状：一根把手 + 一份持久化的百分比。
 *
 * 为什么要有这一支文件：整套宽度模型先在 `KernelViewSlot.tsx` 里落地（spec 8.8-08/10，活体复测过四轮），
 * 2026-10-10 简历屏的纸栏要的是**同一件事**（plan §3.27 裁定 1）。§2.2 的门槛在第二次出现就必须抽，
 * 抽出来而不是复刻一份——复刻会得到两根把手、两套越界夹取、两份"拖到一半松手"的时序，
 * 而其中一套一定比另一套先坏。
 *
 * 三条从活体学来的约束一起搬过来了，别再各自踩：
 * ① 拖拽监听在 `pointerdown` **当场**挂上，放进后续渲染的 effect 会错过 `pointerup`（3.6 那条，
 *    `harness drag` 在几毫秒里把 down/move/up 派发完）；
 * ② 整段拖拽只改**一个节点**上的 CSS 变量，松手才落 state 与盘（`pointermove` 里 setState
 *    会把每帧变成一次重渲；plan §3.24 记了这条对 §5.2 的刻意偏离）；
 * ③ 比例的分母是**整行**的宽度而不是这一栏自己，所以"往左拖是变宽"——把手必须挂在这一栏的左外侧
 *    （同一条 flex 行的前一个兄弟），内核视图那边还多一条理由：原生视图会盖住 aside 内的命中测试。
 *
 * 组件本身**不带任何文案**：把手的 `aria-label` / `title` 由调用方翻译好传进来（§5.5）。
 */

/** 把手自身的宽度（px），与下面 `SPLIT_HANDLE_CLASS` 里的 `w-1.5` 是同一个数；调用方算"对面那一栏还剩多少"时要用它。 */
export const SPLIT_HANDLE_PX = 6;

/**
 * 把手的形状（app 自己画的那对双向箭头就是这 6px 的竖条）。
 * `onPointerDown` + `onKeyDown` 同时是这条 `hover:` 的交互凭据（机检第 13 节只认这些，`cursor-col-resize` 本身不算）；
 * `relative z-10` 是活体逼出来的：对面那一栏内容溢出到自己盒子之外时会盖住这根 6px，
 * 于是"加宽之后再也拖不回来"（`KernelViewSlot.tsx:255-257` 那条读数）。
 */
const SPLIT_HANDLE_CLASS =
  'relative z-10 w-1.5 shrink-0 cursor-col-resize self-stretch bg-line transition-colors duration-150 hover:bg-celadon focus-visible:bg-celadon';

export interface SplitWidthConfig {
  /** localStorage 键（整数百分比）；与 `auto-cc.lang`、`auto-cc.desk.disclosure` 同一份盘、同一个前缀口径。 */
  storageKey: string;
  /** 命令式写在栏本体上的那一枚 CSS 变量名（宽度 class 由调用方以字面量挂上，Tailwind 只扫得见字面量）。 */
  cssVar: string;
  /** 可拖到的最窄百分比。 */
  minPercent: number;
  /** 可拖到的最宽百分比。 */
  maxPercent: number;
  /** 键盘微调的步长（百分点）。 */
  stepPercent: number;
  /** 库里没有记录时的回落档，也是双击那一手的落点。 */
  defaultPercent: number;
  /**
   * 这一栏此刻在不在 DOM 里。默认 `true`；会整栏卸载的消费者（内核视图收起时画的是竖条）必须把它传进来，
   * 否则重新挂载时那一格变量不会被写回：活体读数——拖到 66% 收起再打开，aside 量回 456px（= 38%）而持久值是 66。
   */
  active?: boolean;
}

export interface SplitWidth<T extends HTMLElement = HTMLElement> {
  /** 已落盘的宽度（百分比）；拖拽进行中的即时值不在这上面，见 `panelRef` 那一格的 CSS 变量。 */
  ratio: number;
  /** 可拖区间，把手上的 `aria-valuemin` / `aria-valuemax` 用它。 */
  minPercent: number;
  maxPercent: number;
  /** 挂在**栏本体**上的 ref：变量写在这一个节点，拖拽时量整行也从它的父级取。 */
  panelRef: RefObject<T | null>;
  /** 吸附到合法区间（取整）并落盘——拖拽收尾、键盘、双击三条路径共用这一个口子（§2.5）。 */
  setRatio: (next: number) => void;
  /** 回到"上一次人真正定下来的宽度"（把手上的 `Escape`：拖到一半不满意时用它）。 */
  resetToStored: () => void;
  /** 回到默认档（把手上的双击）。 */
  snapToDefault: () => void;
  /** 把 `pointerdown` 交给把手；整段拖拽只改变量，`pointerup` 才走 `setRatio`。 */
  beginDrag: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 把 `keydown` 交给把手：`Arrow*` 走一步、`Home` / `End` 到边界、`Escape` 回持久值。 */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

/**
 * 读持久化的宽度。
 * @param config 宽度档（`storageKey` / 上下界 / 默认档）
 * @returns 合法整数百分比；形状不对（手改、越界、旧版本存的下标）一律回落默认档，不炸首屏
 */
function loadStoredRatio(config: SplitWidthConfig): number {
  const stored = Number(localStorage.getItem(config.storageKey));
  // 内核视图那一支的历史形状是**下标** `0|1|2`，与百分比值域算术上不相交（它的下界 38 > 2），
  // 所以上界一夹就判得出来——那是一条迁移的终点，不是兼容垫片（`KernelViewSlot.tsx:34-36` 原话）。
  return Number.isInteger(stored) && stored >= config.minPercent && stored <= config.maxPercent
    ? stored
    : config.defaultPercent;
}

/**
 * 一栏可拖宽度的状态：初值从 localStorage 取，拖完 / 键盘 / 双击都吸附到合法区间并落盘。
 *
 * 泛型参数是**栏本体那一个元素**的类型：`panelRef` 要能直接挂到 `<aside>`（内核视图，`HTMLElement`）
 * 或 `<div>`（简历纸栏，`HTMLDivElement`）上——写成 `RefObject<HTMLElement | null>` 时 React 的
 * `ref` 逆变会拒掉 `Ref<HTMLDivElement>`（实测 TS2322：`align` 属性缺失），而不是给调用方加一次断言。
 * @param config 见 `SplitWidthConfig`（数字都是常量，把它们写成每次渲染新建的对象也不会改变行为，但配置请给字面量）
 * @returns 交给 `<SplitHandle>` 与栏本体 ref 的那一份状态
 */
export function useSplitWidth<T extends HTMLElement = HTMLElement>(config: SplitWidthConfig): SplitWidth<T> {
  // `storageKey` 与 `defaultPercent` 故意不在这行解构里：它们只被 `configRef.current` 那两处读
  // （落盘与双击都发生在动作当场，要的是**当下**那份配置），解构出来就成了没人读的变量，`--max-warnings 0` 即红。
  const { cssVar, minPercent, maxPercent, stepPercent, active = true } = config;
  const panelRef = useRef<T | null>(null);
  const [ratio, setRatioState] = useState(() => loadStoredRatio(config));
  /** 拖拽进行中的即时宽度：只写 CSS 变量与这一支 ref，不进 React state（每帧一次重渲拖不动）。 */
  const liveRatioRef = useRef(ratio);
  /** 进行中那对 window 监听的摘除口（先例：`ResumeEditor` 的区块拖拽，同一类"人在拖到一半时切走"）。 */
  const detachRef = useRef<(() => void) | undefined>(undefined);
  /** 回调要读当下的数字，但它们全是常量；用 ref 兜住配置可以让四个动作的引用一辈子稳定。 */
  const configRef = useRef(config);
  configRef.current = config;

  /**
   * 吸附到合法区间并落盘（取整：拖到 43.6% 存的是 44）。
   * @param next 目标百分比（调用方给什么都行，越界由这里夹）
   */
  const setRatio = useCallback(
    (next: number) => {
      const cfg = configRef.current;
      const clamped = Math.round(Math.max(cfg.minPercent, Math.min(next, cfg.maxPercent)));
      setRatioState(clamped);
      localStorage.setItem(cfg.storageKey, String(clamped));
    },
    // `setRatioState` 与 localStorage 都是稳定的，配置走 ref，这个回调因此只创建一次；
    // 拖拽里每帧都拿到同一个引用，不会因为重渲而换掉监听。
    [],
  );

  const resetToStored = useCallback(() => setRatio(loadStoredRatio(configRef.current)), [setRatio]);
  const snapToDefault = useCallback(() => setRatio(configRef.current.defaultPercent), [setRatio]);

  // 宽度落到 CSS 变量上：JSX 里不许出现 `style`（eslint），而连续拖出来的值 Tailwind 也扫不见，
  // 因此只能命令式写在**这一个节点**上（画面里不会有第二份宽度事实）。
  useLayoutEffect(() => {
    panelRef.current?.style.setProperty(cssVar, `${ratio}%`);
    // 键盘与双击都走 state，因此这里同时把 ref 对齐：拖拽与 `Arrow*` 读的是这支 ref，
    // 不同步就会从上一次的拖拽值起步（那是一条只在"拖过再用键盘"时才现身的错位）。
    liveRatioRef.current = ratio;
  }, [ratio, cssVar, active]);

  /**
   * 从把手起拖。
   * @param event 把手上的 `pointerdown`
   */
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current;
    // 比例的分母是**整行**的宽度，不是这一栏自己：`ratio` 的定义就是"占这一行多少"。
    const row = panel?.parentElement;
    if (!panel || !row) return;
    const cfg = configRef.current;
    const rowWidth = row.getBoundingClientRect().width;
    if (rowWidth < 1) return;
    event.preventDefault();
    const startX = event.clientX;
    // 起点取的是**这一帧的 state 值**，不是 `liveRatioRef`：ref 在拖的过程中会被每帧覆盖，
    // 而起点必须固定，否则位移会叠加自己。
    const startRatio = ratio;
    const move = (moveEvent: PointerEvent) => {
      // 把手在栏的左外侧，所以**往左拖是变宽**：位移取负号再换算成百分比。
      const dragged = (((startRatio / 100) * rowWidth - (moveEvent.clientX - startX)) / rowWidth) * 100;
      const clamped = Math.max(cfg.minPercent, Math.min(dragged, cfg.maxPercent));
      liveRatioRef.current = clamped;
      panel.style.setProperty(cfg.cssVar, `${clamped}%`);
    };
    const up = () => {
      detach();
      setRatio(liveRatioRef.current);
    };
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      detachRef.current = undefined;
    };
    detachRef.current = detach;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * 把手上的键盘微调：让"能拖"不是唯一的到达方式。
   * @param event 把手（`role="slider"`）上的 `keydown`
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // 方向按**手势**而不是按"值变大"：把手在左缘，向左按是变宽，与拖拽同向。
    const step = { ArrowLeft: stepPercent, ArrowUp: stepPercent, ArrowRight: -stepPercent, ArrowDown: -stepPercent }[
      event.key
    ];
    if (step !== undefined) {
      event.preventDefault();
      setRatio(liveRatioRef.current + step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setRatio(minPercent);
    } else if (event.key === 'End') {
      event.preventDefault();
      setRatio(maxPercent);
    } else if (event.key === 'Escape') {
      // 拖到一半不满意：回到持久化的那一档（拖完才会落盘，所以这里读的是上一次人真正定下来的宽度）。
      event.preventDefault();
      resetToStored();
    }
  };

  // 拖到一半被卸载（切视图、整栏收起）：把 window 上的那对监听摘干净，别留孤儿。
  useEffect(
    () => () => {
      detachRef.current?.();
    },
    [],
  );

  return {
    ratio,
    minPercent,
    maxPercent,
    panelRef,
    setRatio,
    resetToStored,
    snapToDefault,
    beginDrag,
    onKeyDown,
  };
}

export interface SplitHandleProps {
  /** `useSplitWidth` 的那一份状态（栏本体的元素类型不参与把手，故取默认档）。 */
  split: SplitWidth;
  /** 把手的无障碍名与悬浮说明（调用方翻译好传入，原件里不留文案）。 */
  label: string;
  /** `data-action` 值（harness 的抓手名，调用方决定并保证不与其他格重名）。 */
  action: string;
  /** 额外的 `data-testid`；不给就不挂（同一根把手不必有两个读数名）。 */
  testid?: string;
  /** 追加 class（只放外边与显隐档）。 */
  className?: string;
}

/**
 * 那根 6px 的把手：`role="slider"` + 键盘四件 + 双击回落，拖拽与键盘汇成同一个 `setRatio`。
 * @param props 见 `SplitHandleProps`
 * @returns 一根可以拖的竖条；它必须是目标栏在同一行里的**前一个兄弟**（见文件头第 ③ 条）
 */
export function SplitHandle({ split, label, action, testid, className = '' }: SplitHandleProps) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={split.minPercent}
      aria-valuemax={split.maxPercent}
      aria-valuenow={split.ratio}
      data-action={action}
      {...(testid ? { 'data-testid': testid } : {})}
      title={label}
      onPointerDown={split.beginDrag}
      onKeyDown={split.onKeyDown}
      onDoubleClick={() => split.snapToDefault()}
      className={`${SPLIT_HANDLE_CLASS} ${className}`}
    />
  );
}
