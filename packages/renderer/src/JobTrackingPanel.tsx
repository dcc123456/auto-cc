/**
 * 岗位追踪与约面登记（spec 10.4-01 / 10.8-01/02/04 的界面半边）。
 *
 * 独立组件而不是塞进 `MetricsPanel`：后者的静态判据是「只读、只允许 `funnel.query` 一句、恰好一只重读键」
 * （spec 5.8-02，`scripts/check-dashboard-readonly.ts` 机检）。岗位追踪要写状态、登记约面，天然不是只读看板；
 * 放一起会让那条机检变成例外清单。趋势（`funnel.trend`）与漏斗同源同区间，也归这个面板。
 *
 * 数据全部来自主进程：状态/约面走 `journey.tracking.*`，趋势走 `funnel.trend`；渲染层不自己按天分桶（决策十七）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useReloadWhenVisible } from './ui/view-visibility';
import { useTranslation } from 'react-i18next';
import {
  startOfDay,
  type FunnelRange,
  type FunnelTrendView,
  type InterviewMode,
  type JobCloseReason,
  type JobTrackingView,
} from '@auto-cc/shared';
import { Banner, DeskButton, DeskField, DeskSelect, HAIRLINE_ROW_CLASS } from './ui/controls';
import { DeskPathGuide, DeskSection } from './ui/disclosure';

/** 近 7 天（含今天），与看板的「近 7 天」同一口径。 */
const rangeOf = (): FunnelRange => ({
  fromMs: startOfDay(Date.now()) - 6 * 86_400_000,
  toMs: startOfDay(Date.now()) + 86_400_000,
});

/** 八态与结束原因的界面文案键（与主进程枚举一一对应）。 */
const stageKey = (stage: JobTrackingView['state']): string => `metrics.stage.${stage ?? 'none'}`;

/**
 * 岗位追踪面板。
 * @returns 趋势一行 + 岗位清单（可结束/重开）+ 约面登记表单
 */
export function JobTrackingPanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [trend, setTrend] = useState<FunnelTrendView>();
  const [trackings, setTrackings] = useState<JobTrackingView[]>([]);
  const [notice, setNotice] = useState<string>();
  const [interviewJob, setInterviewJob] = useState('');
  const [interviewAt, setInterviewAt] = useState('');
  const [interviewMode, setInterviewMode] = useState<InterviewMode>('video');
  const [interviewSource, setInterviewSource] = useState('');

  /** 重读趋势与岗位清单；失败只留一行原话，不猜数。 */
  const read = useCallback(async () => {
    const [trendReply, trackingReply] = await Promise.all([
      bridge?.funnel.trend(rangeOf()),
      bridge?.journey['tracking.list'](),
    ]);
    if (trendReply?.ok) setTrend(trendReply.value);
    if (trackingReply?.ok) setTrackings(trackingReply.value);
    if (trendReply && !trendReply.ok) setNotice(trendReply.error.message);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);
  // 切回「运行记录」就重读：投递/打招呼之后追踪表会多行，而这一屏不卸载（2026-11-24 萌新 P1）。
  useReloadWhenVisible('trust', () => {
    void read();
  });

  /** 结束一个岗位：原因从四种里挑，来源写成界面动作（人按的）。 */
  const closeJob = (item: JobTrackingView, reason: JobCloseReason) => {
    const call = bridge?.journey['tracking.close'];
    if (!call) {
      setNotice(t('action.noBridge'));
      return;
    }
    void call({ platform: item.platform, jobId: item.jobId, reason, sourceRef: `ui:${item.jobId}` }).then((reply) => {
      setNotice(reply.ok ? undefined : reply.error.message);
      void read();
    });
  };

  /** 重开一个已结束岗位（只允许一次，原因由主进程判）。 */
  const reopenJob = (item: JobTrackingView) => {
    const call = bridge?.journey['tracking.reopen'];
    if (!call) {
      setNotice(t('action.noBridge'));
      return;
    }
    void call({ platform: item.platform, jobId: item.jobId, reason: 'ui', sourceRef: `ui:${item.jobId}` }).then(
      (reply) => {
        setNotice(reply.ok ? undefined : reply.error.message);
        void read();
      },
    );
  };

  /** 登记一条约面（约面唯一来源；来源引用必填）。 */
  const registerInterview = () => {
    const scheduledAt = new Date(interviewAt).getTime();
    const platform = trackings[0]?.platform ?? 'boss';
    const call = bridge?.journey['tracking.registerInterview'];
    if (!call) {
      setNotice(t('action.noBridge'));
      return;
    }
    void call({ platform, jobId: interviewJob, scheduledAt, mode: interviewMode, sourceRef: interviewSource }).then(
      (reply) => {
        setNotice(reply.ok ? undefined : reply.error.message);
        void read();
      },
    );
  };

  return (
    <DeskSection
      id="trust.tracking"
      markers={{ testid: 'tracking-panel' }}
      title={t('metrics.trackHeading')}
      summary={<span data-testid="tracking-summary">{t('metrics.trackSummary', { jobs: trackings.length })}</span>}
    >
      <DeskPathGuide
        testid="tracking-path-guide"
        className="mb-2"
        here={t('guide.tracking.here')}
        next={t('guide.tracking.next')}
        exit={t('guide.tracking.exit')}
        focusSelector='[data-action="interview-job"]'
        focusLabel={t('guide.focus')}
      />
      <div className="mb-2 flex justify-end">
        <DeskButton action="tracking-refresh" variant="line" compact onClick={() => void read()}>
          {t('metrics.refresh')}
        </DeskButton>
      </div>

      {notice && (
        <Banner tone="amber" size="compact" markers={{ testid: 'tracking-notice' }} className="mb-2">
          {notice}
        </Banner>
      )}

      <h4 className="text-[11px] font-semibold text-slate-300">{t('metrics.trendHeading')}</h4>
      {trend === undefined ? (
        <p className="mt-1 text-[11px] text-slate-500">{t('metrics.awaitRead')}</p>
      ) : (
        <ul className="mt-1 flex flex-col" data-testid="metrics-trend">
          {trend.days.map((day) => (
            <li key={day.day} data-trend-day={day.day} className={`${HAIRLINE_ROW_CLASS} text-[11px] text-slate-400`}>
              <span className="w-24 shrink-0 font-mono text-slate-300">{day.day}</span>
              {day.levels.map((level) => (
                <span key={level.level} data-trend-level={level.level} data-trend-count={level.count ?? 'null'}>
                  {t(`metrics.level.${level.level}`)}{' '}
                  {level.count === null ? t('metrics.noNumber') : String(level.count)}
                </span>
              ))}
              <span data-trend-sends={day.sends ?? 'null'}>
                {t('metrics.trendSends', { count: day.sends ?? t('metrics.noNumber') })}
              </span>
              {day.failures && day.failures.length > 0 ? (
                <span data-trend-failures={day.failures.map((item) => `${item.code}:${item.count}`).join(',')}>
                  {t('metrics.trendFailures', {
                    top: day.failures.map((item) => `${item.code}×${item.count}`).join(' · '),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-3 text-[11px] font-semibold text-slate-300">{t('metrics.trackHeading')}</h4>
      <ul className="mt-1 flex flex-col" data-testid="metrics-tracking">
        {trackings.length === 0 ? (
          <li className="text-[11px] text-slate-500">{t('metrics.trackEmpty')}</li>
        ) : (
          trackings.map((item) => (
            <li
              key={`${item.platform}:${item.jobId}`}
              data-track-job={item.jobId}
              data-track-state={item.state ?? 'none'}
              className={`${HAIRLINE_ROW_CLASS} text-[11px] text-slate-400`}
            >
              <span className="font-mono text-slate-200">{item.jobId}</span>
              <span>{t(stageKey(item.state))}</span>
              {item.closedReason ? (
                <span className="text-amber">{t(`metrics.closeReason.${item.closedReason}`)}</span>
              ) : null}
              <span className="ml-auto">
                {item.updatedAt === null ? t('metrics.noNumber') : new Date(item.updatedAt).toLocaleTimeString()}
              </span>
              {item.state !== 'closed' && item.state !== null ? (
                <DeskSelect
                  action={`track-close-${item.jobId}`}
                  label=""
                  value=""
                  onValueChange={(value) => {
                    if (value !== '') closeJob(item, value as JobCloseReason);
                  }}
                >
                  <option value="">{t('metrics.trackClose')}</option>
                  <option value="rejected">{t('metrics.closeReason.rejected')}</option>
                  <option value="no_reply">{t('metrics.closeReason.no_reply')}</option>
                  <option value="gave_up">{t('metrics.closeReason.gave_up')}</option>
                  <option value="offline">{t('metrics.closeReason.offline')}</option>
                </DeskSelect>
              ) : item.state === 'closed' ? (
                <DeskButton
                  action={`track-reopen-${item.jobId}`}
                  variant="line"
                  compact
                  onClick={() => reopenJob(item)}
                >
                  {t('metrics.trackReopen')}
                </DeskButton>
              ) : null}
            </li>
          ))
        )}
      </ul>

      <div className="mt-2 flex flex-wrap items-end gap-2" data-testid="metrics-interview-form">
        <DeskField
          action="interview-job"
          label={t('metrics.interviewJob')}
          value={interviewJob}
          onValueChange={setInterviewJob}
          className="w-28"
        />
        <DeskField
          action="interview-at"
          label={t('metrics.interviewAt')}
          type="datetime-local"
          value={interviewAt}
          onValueChange={setInterviewAt}
          className="w-44"
        />
        <DeskSelect
          action="interview-mode"
          label={t('metrics.interviewMode')}
          value={interviewMode}
          onValueChange={(value) => setInterviewMode(value as InterviewMode)}
        >
          <option value="phone">{t('metrics.interviewModes.phone')}</option>
          <option value="video">{t('metrics.interviewModes.video')}</option>
          <option value="onsite">{t('metrics.interviewModes.onsite')}</option>
        </DeskSelect>
        <DeskField
          action="interview-source"
          label={t('metrics.interviewSource')}
          value={interviewSource}
          onValueChange={setInterviewSource}
          className="w-40"
        />
        <DeskButton
          action="interview-register"
          variant="jade"
          compact
          disabled={interviewJob.trim() === '' || interviewAt === ''}
          disabledReason={
            interviewJob.trim() === '' ? 'INTERVIEW_JOB_EMPTY' : interviewAt === '' ? 'INTERVIEW_AT_EMPTY' : undefined
          }
          disabledReasonLabel={
            interviewJob.trim() === ''
              ? t('metrics.interviewJobEmpty')
              : interviewAt === ''
                ? t('metrics.interviewAtEmpty')
                : undefined
          }
          onClick={registerInterview}
        >
          {t('metrics.interviewRegister')}
        </DeskButton>
        {/* 键按不动时把原因写在旁边（spec 10.10-18）。 */}
        {interviewJob.trim() === '' || interviewAt === '' ? (
          <span className="text-[11px] text-amber" data-testid="interview-register-reason">
            {interviewJob.trim() === '' ? t('metrics.interviewJobEmpty') : t('metrics.interviewAtEmpty')}
          </span>
        ) : null}
      </div>
    </DeskSection>
  );
}
