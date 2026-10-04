/**
 * 「节点行用的是哪一份读数」这一句（spec 2.4-05 的口径：内存里那次 run 与库里可续的那次不许混着说）。
 *
 * 抽成组件是因为它已经是第二处需要（审计段 + 画布的点格弹层，AGENTS.md §2.2）：这句话一旦在两处
 * 各写一遍，就会出现「一处说 runId、另一处只说状态」这种同一事实的两种讲法。
 * 取数规则本身在 `runStateReading.ts`，这里只负责把那一份读数的来源讲出来。
 */
import { useTranslation } from 'react-i18next';
import type { NodeRunReading } from './runStateReading';

export interface NodeRunSourceLineProps {
  /** 一次取数的结果（选中那份 run 状态 + 它来自哪一口） */
  reading: NodeRunReading;
  /** harness 定位这一句用的 testid（两处各自的活体判据不同，只有这一项是调用方的） */
  testId: string;
}

/**
 * 渲染读数来源那一行。
 * @param props 见 `NodeRunSourceLineProps`
 * @returns 一行文本：事实源 + runId + 那次 run 的状态
 */
export function NodeRunSourceLine({ reading, testId }: NodeRunSourceLineProps) {
  const { t } = useTranslation();
  return (
    <p className="mt-1 text-[11px] text-slate-500" data-testid={testId} data-node-source={reading.source}>
      {t('audit.sourceNodes')} ·{' '}
      {t(reading.source === 'state' ? 'audit.nodesFromState' : 'audit.nodesFromResumable', {
        runId: reading.state.runId,
        status: t(`audit.runStatus.${reading.state.status}`),
      })}
    </p>
  );
}
