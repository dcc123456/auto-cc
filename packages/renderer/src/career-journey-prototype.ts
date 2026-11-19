/** 主链六步的稳定 ID：界面锚点、reducer 与验收共用，不用译文当状态。 */
export const JOURNEY_STEPS = ['resume', 'search', 'tailor', 'delivery', 'interview', 'prepare'] as const;
export type JourneyStep = (typeof JOURNEY_STEPS)[number];

/** 样例简历事实的稳定 ID：所有生成内容只能引用这三条，不携带真实个人信息。 */
export const SAMPLE_FACT_IDS = ['experience', 'performance', 'testing'] as const;
export type SampleFactId = (typeof SAMPLE_FACT_IDS)[number];
export const SAMPLE_RESUME_VERSION = 'fixture.resume.v1';

/** 一份本地样例 JD；画面文案只存 i18n key，事实与要求使用稳定 ID。 */
export interface SampleJob {
  id: string;
  jdVersion: string;
  titleKey: string;
  companyKey: string;
  summaryKey: string;
  matchReasonKeys: readonly string[];
  requirementIds: readonly string[];
  greetingKey: string;
  tailoredKey: string;
}

/** 三份虚构岗位仅用于交互验证，不代表任何真实招聘平台结果。 */
export const SAMPLE_JOBS: readonly SampleJob[] = [
  {
    id: 'fixture.job.frontend',
    jdVersion: 'fixture.jd.frontend.v1',
    titleKey: 'journey.fixture.jobs.frontend.title',
    companyKey: 'journey.fixture.jobs.frontend.company',
    summaryKey: 'journey.fixture.jobs.frontend.summary',
    matchReasonKeys: ['journey.fixture.jobs.frontend.match1', 'journey.fixture.jobs.frontend.match2'],
    requirementIds: ['JD-A.R1', 'JD-A.R2', 'JD-A.R3'],
    greetingKey: 'journey.fixture.jobs.frontend.greeting',
    tailoredKey: 'journey.fixture.jobs.frontend.tailored',
  },
  {
    id: 'fixture.job.platform',
    jdVersion: 'fixture.jd.platform.v1',
    titleKey: 'journey.fixture.jobs.platform.title',
    companyKey: 'journey.fixture.jobs.platform.company',
    summaryKey: 'journey.fixture.jobs.platform.summary',
    matchReasonKeys: ['journey.fixture.jobs.platform.match1', 'journey.fixture.jobs.platform.match2'],
    requirementIds: ['JD-B.R1', 'JD-B.R2', 'JD-B.R3'],
    greetingKey: 'journey.fixture.jobs.platform.greeting',
    tailoredKey: 'journey.fixture.jobs.platform.tailored',
  },
  {
    id: 'fixture.job.quality',
    jdVersion: 'fixture.jd.quality.v1',
    titleKey: 'journey.fixture.jobs.quality.title',
    companyKey: 'journey.fixture.jobs.quality.company',
    summaryKey: 'journey.fixture.jobs.quality.summary',
    matchReasonKeys: ['journey.fixture.jobs.quality.match1', 'journey.fixture.jobs.quality.match2'],
    requirementIds: ['JD-C.R1', 'JD-C.R2', 'JD-C.R3'],
    greetingKey: 'journey.fixture.jobs.quality.greeting',
    tailoredKey: 'journey.fixture.jobs.quality.tailored',
  },
];

/** 面试问题模板的来源位置；requirementIndex 指向当前 JD，避免换岗后沿用旧要求 ID。 */
interface SampleQuestionTemplate {
  questionKey: string;
  answerKey: string;
  factId: SampleFactId;
  requirementIndex: number;
}

/** 八条固定问题模板只提供结构，实际来源由所选岗位现算。 */
const QUESTION_TEMPLATES: readonly SampleQuestionTemplate[] = [
  { questionKey: 'q1', answerKey: 'a1', factId: 'experience', requirementIndex: 0 },
  { questionKey: 'q2', answerKey: 'a2', factId: 'performance', requirementIndex: 1 },
  { questionKey: 'q3', answerKey: 'a3', factId: 'testing', requirementIndex: 2 },
  { questionKey: 'q4', answerKey: 'a4', factId: 'experience', requirementIndex: 0 },
  { questionKey: 'q5', answerKey: 'a5', factId: 'performance', requirementIndex: 1 },
  { questionKey: 'q6', answerKey: 'a6', factId: 'testing', requirementIndex: 2 },
  { questionKey: 'q7', answerKey: 'a7', factId: 'experience', requirementIndex: 0 },
  { questionKey: 'q8', answerKey: 'a8', factId: 'performance', requirementIndex: 1 },
];

/** 一条可溯源问答：问题与答案文案在语言包，sources 是供核对的稳定证据 ID。 */
export interface SampleQuestion {
  questionKey: string;
  answerKey: string;
  sources: readonly string[];
}

/** 当前岗位的面试准备材料；checklistKeys 与自我介绍同样走 i18n。 */
export interface SamplePreparation {
  selfIntroductionKey: string;
  questions: readonly SampleQuestion[];
  checklistKeys: readonly string[];
}

/**
 * 按当前 JD 生成面试材料来源，防止把上一岗位的要求 ID 带进新材料。
 * @param job 当前选中的本地样例岗位
 * @returns 一段自我介绍、八条问答及三项准备清单；无岗位时不允许调用
 */
export function samplePreparationForJob(job: SampleJob): SamplePreparation {
  return {
    selfIntroductionKey: 'journey.fixture.preparation.selfIntroduction',
    questions: QUESTION_TEMPLATES.map((template) => ({
      questionKey: `journey.fixture.preparation.${template.questionKey}`,
      answerKey: `journey.fixture.preparation.${template.answerKey}`,
      sources: [
        template.factId,
        job.requirementIds[template.requirementIndex] ?? job.requirementIds[0] ?? job.jdVersion,
      ],
    })),
    checklistKeys: [
      'journey.fixture.preparation.checklist1',
      'journey.fixture.preparation.checklist2',
      'journey.fixture.preparation.checklist3',
    ],
  };
}

/** 原型操作记录只存动作与岗位 ID，不存时间、个人信息或正式账本行号。 */
export type JourneyEventKind =
  | 'resume-loaded'
  | 'jobs-listed'
  | 'job-selected'
  | 'materials-generated'
  | 'confirmation-requested'
  | 'confirmation-cancelled'
  | 'confirmation-demonstrated'
  | 'interview-drafted'
  | 'preparation-generated';

export interface JourneyEvent {
  kind: JourneyEventKind;
  jobId?: string;
}

/** 六步共享的唯一原型状态；outboundAttempts 在所有动作中保持 0。 */
export interface CareerJourneyState {
  activeStep: JourneyStep;
  resumeVersion: string | null;
  isJobListVisible: boolean;
  selectedJobId: string | null;
  tailoredResumeVersion: string | null;
  greetingKey: string | null;
  confirmation: 'idle' | 'pending' | 'confirmed-demo';
  interviewDraftId: string | null;
  preparationJobId: string | null;
  outboundAttempts: number;
  events: readonly JourneyEvent[];
}

/** 初始空载态：没有简历、岗位或任何生成产物，也没有外发。 */
export const INITIAL_JOURNEY_STATE: CareerJourneyState = {
  activeStep: 'resume',
  resumeVersion: null,
  isJobListVisible: false,
  selectedJobId: null,
  tailoredResumeVersion: null,
  greetingKey: null,
  confirmation: 'idle',
  interviewDraftId: null,
  preparationJobId: null,
  outboundAttempts: 0,
  events: [],
};

/** 原型动作使用大写类型，非法跃迁由 reducer 原样拒绝而不是由按钮禁用单独保证。 */
export type CareerJourneyAction =
  | { type: 'LOAD_RESUME' }
  | { type: 'SEARCH_JOBS' }
  | { type: 'SELECT_JOB'; jobId: string }
  | { type: 'GENERATE_MATERIALS' }
  | { type: 'GO_TO_STEP'; step: JourneyStep }
  | { type: 'REQUEST_CONFIRMATION' }
  | { type: 'CANCEL_CONFIRMATION' }
  | { type: 'CONFIRM_DEMO' }
  | { type: 'DRAFT_INTERVIEW' }
  | { type: 'GENERATE_PREPARATION' }
  | { type: 'RESET' };

/**
 * 取当前选中的样例岗位，所有派生材料都从这一份重新计算。
 * @param state 当前原型快照
 * @returns 选中岗位；未选或 id 已失效时返回 undefined
 */
export function selectedSampleJob(state: CareerJourneyState): SampleJob | undefined {
  return SAMPLE_JOBS.find((job) => job.id === state.selectedJobId);
}

/**
 * 给操作记录追加一条带当前岗位的动作，界面只负责翻译，不自行拼接事件。
 * @param state 当前原型快照
 * @param kind 本地动作类型
 * @returns 包含新动作的新记录数组，原记录不改写
 */
function appendEvent(state: CareerJourneyState, kind: JourneyEventKind): readonly JourneyEvent[] {
  return [...state.events, { kind, ...(state.selectedJobId ? { jobId: state.selectedJobId } : {}) }];
}

/**
 * 推进本地主链样例；任何分支都不调用桥接、网络、数据库或外发服务。
 * @param state 当前完整快照，换岗时用它识别需要作废的下游材料
 * @param action 用户动作；缺少前置上下文或越级确认时视为非法动作
 * @returns 新快照；非法动作原样返回，outboundAttempts 恒为 0
 */
export function careerJourneyReducer(state: CareerJourneyState, action: CareerJourneyAction): CareerJourneyState {
  switch (action.type) {
    case 'RESET':
      return INITIAL_JOURNEY_STATE;
    case 'LOAD_RESUME':
      return {
        ...INITIAL_JOURNEY_STATE,
        activeStep: 'resume',
        resumeVersion: SAMPLE_RESUME_VERSION,
        events: [{ kind: 'resume-loaded' }],
      };
    case 'SEARCH_JOBS':
      if (!state.resumeVersion) return state;
      return { ...state, activeStep: 'search', isJobListVisible: true, events: appendEvent(state, 'jobs-listed') };
    case 'GO_TO_STEP':
      return { ...state, activeStep: action.step };
    case 'SELECT_JOB': {
      if (!state.isJobListVisible || !SAMPLE_JOBS.some((job) => job.id === action.jobId)) return state;
      return {
        ...state,
        activeStep: 'tailor',
        selectedJobId: action.jobId,
        tailoredResumeVersion: null,
        greetingKey: null,
        confirmation: 'idle',
        interviewDraftId: null,
        preparationJobId: null,
        outboundAttempts: 0,
        events: [...state.events, { kind: 'job-selected', jobId: action.jobId }],
      };
    }
    case 'GENERATE_MATERIALS': {
      const job = selectedSampleJob(state);
      if (!state.resumeVersion || !job) return state;
      return {
        ...state,
        activeStep: 'tailor',
        tailoredResumeVersion: `${state.resumeVersion}+${job.jdVersion}`,
        greetingKey: job.greetingKey,
        confirmation: 'idle',
        interviewDraftId: null,
        preparationJobId: null,
        outboundAttempts: 0,
        events: appendEvent(state, 'materials-generated'),
      };
    }
    case 'REQUEST_CONFIRMATION':
      if (!state.tailoredResumeVersion || !state.greetingKey) return state;
      return {
        ...state,
        activeStep: 'delivery',
        confirmation: 'pending',
        outboundAttempts: 0,
        events: appendEvent(state, 'confirmation-requested'),
      };
    case 'CANCEL_CONFIRMATION':
      if (state.confirmation !== 'pending') return state;
      return {
        ...state,
        confirmation: 'idle',
        outboundAttempts: 0,
        events: appendEvent(state, 'confirmation-cancelled'),
      };
    case 'CONFIRM_DEMO':
      if (state.confirmation !== 'pending') return state;
      return {
        ...state,
        activeStep: 'delivery',
        confirmation: 'confirmed-demo',
        outboundAttempts: 0,
        events: appendEvent(state, 'confirmation-demonstrated'),
      };
    case 'DRAFT_INTERVIEW': {
      const job = selectedSampleJob(state);
      if (!job || state.confirmation !== 'confirmed-demo') return state;
      return {
        ...state,
        activeStep: 'interview',
        interviewDraftId: `fixture.interview.${job.id}.v1`,
        preparationJobId: null,
        outboundAttempts: 0,
        events: appendEvent(state, 'interview-drafted'),
      };
    }
    case 'GENERATE_PREPARATION': {
      const job = selectedSampleJob(state);
      if (!job || !state.interviewDraftId) return state;
      return {
        ...state,
        activeStep: 'prepare',
        preparationJobId: job.id,
        outboundAttempts: 0,
        events: appendEvent(state, 'preparation-generated'),
      };
    }
  }
}
