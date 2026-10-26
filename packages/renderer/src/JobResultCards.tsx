/**
 * 岗位结果卡（spec 8.10-04）：对话里抓完一批 JD 之后，把库里的结构化行摆成人能扫的样子。
 *
 * 为什么不让主进程把卡片塞进 `ToolResult`：5.1-11 的三键契约（摘要 + 结构化产出 + 证据引用）
 * 是给模型与证据回看用的，界面要的是另一份读数；往结果里再加一张"界面专用"的卡片就是两份事实。
 * 所以卡片由渲染层在展开时现调 `jd.store.list`，画的是库里的真行——重复抓取、重启之后仍然是同一份。
 *
 * 末尾那句「要点」取 `requirements[0]`：它**不是**匹配打分（本仓没有那套东西，编一句"匹配度 92%"就是
 * 对用户说谎），只把 JD 的第一条要求原文摆出来让人自己判断；首行要求往往就是这一岗的门槛。
 */
import { useTranslation } from 'react-i18next';
import type { JobListResultView } from '@auto-cc/shared';

/**
 * 一组岗位卡。
 * @param result `jd.store.list` 的读数：总条数 + 行（行序已由服务排好，界面不再排序）
 * @returns 空库时一句空态；否则「库内共 N 条」+ 每行一张紧凑卡
 */
export function JobResultCards({ result }: { result: JobListResultView }) {
  const { t } = useTranslation();
  if (result.rows.length === 0) {
    return (
      <p className="text-[11px] text-slate-500" data-testid="job-result-empty">
        {t('agent.tool.jobs.empty')}
      </p>
    );
  }
  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="job-result-cards" data-job-total={result.total}>
      <p className="text-[10px] text-slate-500">
        {t('agent.tool.jobs.total', { total: result.total, shown: result.rows.length })}
      </p>
      <ul className="flex flex-col gap-1.5">
        {result.rows.map((row) => (
          <li
            key={`${row.platform}/${row.jobId}/${String(row.id)}`}
            data-job-id={row.jobId}
            data-job-platform={row.platform}
            // 已回复的整行左侧描一道青瓷：这是「下一步先做谁」的排序依据（2.5-08），不是装饰。
            className={`rounded-lg border border-line bg-ink-950/40 px-2.5 py-2 ${
              row.replied ? 'border-l-2 border-l-celadon' : ''
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[12.5px] font-medium text-slate-100" data-job-title>
                {row.title}
              </span>
              <span className="text-[11px] text-slate-400">{row.company}</span>
              <span className="ml-auto font-mono text-[11px] text-amber" data-job-salary>
                {row.salaryText || t('agent.tool.jobs.salaryUnknown')}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-slate-500">
              {row.city ? <span>{row.city}</span> : null}
              {row.experience ? <span>{row.experience}</span> : null}
              {row.education ? <span>{row.education}</span> : null}
              {row.replied ? (
                <span className="text-celadon" data-job-replied={String(row.inboundCount)}>
                  {t('agent.tool.jobs.replied', { count: row.inboundCount })}
                </span>
              ) : null}
            </div>
            {row.requirements[0] ? (
              <p className="mt-1 break-words text-[10.5px] leading-[1.5] text-slate-400" data-job-requirement>
                {t('agent.tool.jobs.requirement', { text: row.requirements[0] })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
