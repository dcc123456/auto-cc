import { formatClock } from '../format';

/**
 * 一条动作进度（已经翻译好的一段话 + 步号与时刻）。
 *
 * 文案由调用方从语言包取：同一份日志原件要同时给打招呼与定向生成用，
 * 两套阶段码各归各的面板翻译（AGENTS.md §5.5）。
 */
export interface DeskProgressEntry {
  /** React key；同一阶段可能出现两次（模型重试），所以不能只用步号 */
  key: string;
  /** 阶段码，只用于 `data-*` 取证，不上屏 */
  phase: string;
  /** 第几步（1 起） */
  step: number;
  /** 一共几步 */
  total: number;
  /** 已翻译的一句话 */
  text: string;
  /** 推送时刻（毫秒） */
  at: number;
  /** 最新一条（此刻所在的那一步）画亮一档 */
  active?: boolean;
}

export interface DeskProgressLogProps {
  /** 进度条目，最新在前（与事件推送顺序相反） */
  entries: readonly DeskProgressEntry[];
  /** `data-testid` 凭据：日志本身与它的空态各用一份 */
  testId: string;
  /** 还没有任何进度时显示的一句话；省略则整块不画 */
  emptyLabel?: string;
  className?: string;
}

/**
 * 动作进度日志：把「按钮在转圈」换成看得懂的阶段流水（spec 2.5-16 / 4.5-17）。
 *
 * 只做呈现，不判断动作是否失败、也不自己计时：每条都来自主进程的进度事件，
 * 面板负责把阶段码翻译成人话。最新一条是此刻所在的那一步，因此画亮一档。
 * @param props 见 `DeskProgressLogProps`
 * @returns 有序日志；无条目且给了空态文案时只画空态
 */
export function DeskProgressLog({ entries, testId, emptyLabel, className = '' }: DeskProgressLogProps) {
  if (entries.length === 0) {
    return emptyLabel === undefined ? null : (
      <p className="text-[11px] leading-relaxed text-slate-500" data-testid={`${testId}-empty`}>
        {emptyLabel}
      </p>
    );
  }
  return (
    <ol className={`flex flex-col gap-1 ${className}`} data-testid={testId}>
      {entries.map((entry) => (
        <li
          key={entry.key}
          className="flex items-baseline gap-2 text-[11px] leading-relaxed"
          data-progress-phase={entry.phase}
          data-progress-step={entry.step}
          data-progress-active={entry.active === true ? 'true' : 'false'}
        >
          <span className="w-9 shrink-0 tabular-nums text-slate-500">
            {entry.step}/{entry.total}
          </span>
          <span className={entry.active === true ? 'min-w-0 flex-1 text-slate-200' : 'min-w-0 flex-1 text-slate-400'}>
            {entry.text}
          </span>
          <span className="shrink-0 text-slate-500">{formatClock(entry.at, '')}</span>
        </li>
      ))}
    </ol>
  );
}
