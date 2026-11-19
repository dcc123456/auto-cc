import { describe, expect, it } from 'vitest';
import {
  careerJourneyReducer,
  INITIAL_JOURNEY_STATE,
  SAMPLE_JOBS,
  SAMPLE_RESUME_VERSION,
  samplePreparationForJob,
  selectedSampleJob,
  type CareerJourneyState,
} from './career-journey-prototype';

/** 把状态推进到已选第一岗，作为生成与确认用例的共同前置。 */
function stateWithSelectedJob(): CareerJourneyState {
  const loaded = careerJourneyReducer(INITIAL_JOURNEY_STATE, { type: 'LOAD_RESUME' });
  const searched = careerJourneyReducer(loaded, { type: 'SEARCH_JOBS' });
  return careerJourneyReducer(searched, { type: 'SELECT_JOB', jobId: SAMPLE_JOBS[0]?.id ?? '' });
}

describe('P10 主链本地样例状态机', () => {
  it('一轮六步共用同一母版与 JD，三个岗位均有匹配理由，八条问答逐条可溯源', () => {
    const selected = stateWithSelectedJob();
    const generated = careerJourneyReducer(selected, { type: 'GENERATE_MATERIALS' });
    const requested = careerJourneyReducer(generated, { type: 'REQUEST_CONFIRMATION' });
    const confirmed = careerJourneyReducer(requested, { type: 'CONFIRM_DEMO' });
    const interviewed = careerJourneyReducer(confirmed, { type: 'DRAFT_INTERVIEW' });
    const prepared = careerJourneyReducer(interviewed, { type: 'GENERATE_PREPARATION' });
    const job = selectedSampleJob(prepared);

    expect(SAMPLE_JOBS).toHaveLength(3);
    expect(SAMPLE_JOBS.every((sampleJob) => sampleJob.matchReasonKeys.length >= 2)).toBe(true);
    expect(job?.id).toBe(SAMPLE_JOBS[0]?.id);
    expect(prepared.resumeVersion).toBe(SAMPLE_RESUME_VERSION);
    expect(prepared.tailoredResumeVersion).toBe(`${SAMPLE_RESUME_VERSION}+${job?.jdVersion ?? ''}`);
    expect(prepared.preparationJobId).toBe(job?.id);
    expect(prepared.outboundAttempts).toBe(0);

    const preparation = samplePreparationForJob(job ?? SAMPLE_JOBS[0]!);
    expect(preparation.questions).toHaveLength(8);
    expect(preparation.checklistKeys.length).toBeGreaterThanOrEqual(3);
    for (const question of preparation.questions) {
      expect(question.sources).toHaveLength(2);
      expect(question.sources[1]).toMatch(/^JD-A\.R[123]$/);
    }
  });

  it('换岗作废旧变体、招呼、确认、约面与准备材料，不把上一 JD 的来源带过去', () => {
    const selected = stateWithSelectedJob();
    const generated = careerJourneyReducer(selected, { type: 'GENERATE_MATERIALS' });
    const confirmed = careerJourneyReducer(careerJourneyReducer(generated, { type: 'REQUEST_CONFIRMATION' }), {
      type: 'CONFIRM_DEMO',
    });
    const prepared = careerJourneyReducer(careerJourneyReducer(confirmed, { type: 'DRAFT_INTERVIEW' }), {
      type: 'GENERATE_PREPARATION',
    });
    const changed = careerJourneyReducer(prepared, { type: 'SELECT_JOB', jobId: SAMPLE_JOBS[1]?.id ?? '' });

    expect(changed.resumeVersion).toBe(SAMPLE_RESUME_VERSION);
    expect(changed.selectedJobId).toBe(SAMPLE_JOBS[1]?.id);
    expect(changed.tailoredResumeVersion).toBeNull();
    expect(changed.greetingKey).toBeNull();
    expect(changed.confirmation).toBe('idle');
    expect(changed.interviewDraftId).toBeNull();
    expect(changed.preparationJobId).toBeNull();
    expect(changed.outboundAttempts).toBe(0);

    const preparation = samplePreparationForJob(SAMPLE_JOBS[1]!);
    expect(preparation.questions.every((question) => question.sources[1]?.startsWith('JD-B.'))).toBe(true);
  });

  it('未确认、请求确认与演示确认三阶段外发都为 0，越级确认和非法生成不改变状态', () => {
    const generated = careerJourneyReducer(stateWithSelectedJob(), { type: 'GENERATE_MATERIALS' });
    expect(generated.outboundAttempts).toBe(0);
    expect(careerJourneyReducer(generated, { type: 'CONFIRM_DEMO' })).toBe(generated);

    const requested = careerJourneyReducer(generated, { type: 'REQUEST_CONFIRMATION' });
    expect(requested.confirmation).toBe('pending');
    expect(requested.outboundAttempts).toBe(0);

    const confirmed = careerJourneyReducer(requested, { type: 'CONFIRM_DEMO' });
    expect(confirmed.confirmation).toBe('confirmed-demo');
    expect(confirmed.outboundAttempts).toBe(0);
    expect(confirmed.events.at(-1)?.kind).toBe('confirmation-demonstrated');
    expect(careerJourneyReducer(INITIAL_JOURNEY_STATE, { type: 'GENERATE_MATERIALS' })).toBe(INITIAL_JOURNEY_STATE);
    expect(careerJourneyReducer(INITIAL_JOURNEY_STATE, { type: 'SEARCH_JOBS' })).toBe(INITIAL_JOURNEY_STATE);
  });

  it('取消确认可回到待确认前，复位清空全部样例上下文', () => {
    const generated = careerJourneyReducer(stateWithSelectedJob(), { type: 'GENERATE_MATERIALS' });
    const requested = careerJourneyReducer(generated, { type: 'REQUEST_CONFIRMATION' });
    const cancelled = careerJourneyReducer(requested, { type: 'CANCEL_CONFIRMATION' });
    expect(cancelled.confirmation).toBe('idle');
    expect(cancelled.outboundAttempts).toBe(0);
    expect(careerJourneyReducer(cancelled, { type: 'RESET' })).toBe(INITIAL_JOURNEY_STATE);
  });
});
