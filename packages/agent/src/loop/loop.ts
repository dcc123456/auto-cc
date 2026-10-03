/**
 * `agent.loop`：一次任务的「规划 → 执行 → 观察 → 续推」循环（spec 5.2-01 / 02 / 05 / 08 / 11）。
 *
 * 硬规矩长在结构里，不是长在注释里（编号按落片顺序追加）：
 * 1. **每一步都问 `agent.policy`**（5.2-02）：循环里只有「判闸门 → 调工具」这一条顺序，
 *    没有旁路——`registry.call` 只在 `decide()` 放行之后出现，读这段代码时一眼能对上。
 * 2. **模型没有裁量口**（5.2-07，判定在 5.2-b 演）：`LoopModel` 只有起草与摘要两条口，
 *    步骤的副作用分级是循环现读注册表贴上去的，模型自述一概不进判定。
 * 3. **一次 run 一份作用域**（5.2-08）：游标、token 账、取消句柄都长在 `RunScope` 上并按 runId 存，
 *    服务字段里不放「上一次的进度」；改配置重建插件后作用域表会空，`ensureScope` 因此能从库里把它重建回来
 *    （AGENTS.md §9 的 2.5 实测：热改配置会重建下游插件，本地存第二份事实必然静默变空）。
 * 4. **步数与 token 双上限**（5.2-11）：两条都在动下一步之前判，撞到就把 run 落成 `failed`
 *    并写明 `stopReason`，不无限自转。上限是**这条 run 的**（起草时从配置定下并落进
 *    `agent_run` 的两列），不是服务的当前配置——否则改一次配置就会回改正在跑的旧任务的额度，
 *    而那两列也就成了摆设。
 * 5. **要人表态的那一步挂在人身上**（5.3-08 / 09 / 10）：策略交回 `CONFIRMATION_REQUIRED` 与模型入参
 *    过不了工具自己的 strict schema 这两件事，各开一张暂停单（经 `agent.pause`），批准/补够才继续；
 *    拒绝、超时、叫停都落 `refused` 步行。判定的顺序写死在这里：**先问能不能做，再问缺什么**——
 *    反过来就会出现「这一步本来就不该做，却还在替它收字段值」。
 *
 * 叫停（5.2-10）取「安全点」语义：正在跑的那一步**不硬切**——所以不把 abort 信号递给注册表，
 * 半途掐断一次打招呼比让它跑完更糟；信号只在下一步开始之前生效。挂在人身上的那一步用的就是
 * 同一个信号（`ask(..., scope.controller.signal)`）：叫停一张开着的单是 `cancelled`，
 * 而 `cancelled` 在循环这一侧**永远读不成「同意了」**（spec 5.3-10）。
 *
 * 6. **人在动页面的时候一步都不发**（5.5-a / 5.5-02）：接管态不进这份作用域，每轮都现问一次
 *    （`browser.takeover` 是那份事实的唯一持有者，本地存副本就会在改配置重建之后静默变空，§9 的 2.5 实测）。
 *    命中就把 run 落成 `paused` + `stopReason = TAKEOVER_HELD`——**不落 refused 步行、不开确认单**
 *    （人就在页面上，再让他点一次「批准」是骗他），正在跑的那一步照上面那条不硬切，
 *    所以「停在安全点」这件事由两处置地生效：步与步之间的那次现问，以及订阅 `browser/takeover-changed`
 *    去叫醒那些**正挂在暂停单上**的 run（它们走不到下一次现问）。
 *    恢复只能由人按（`resume`），与 `confirm` / `respond` / 写档位 / 加白撤白同属「人表态」的那一类口。
 * 7. **要在下一步动手之前把页面重读一遍**（5.5-c / spec 5.5-03）：交还页面之后的第一件事不是动手，是
 *    「现在这页长成什么样」。`resume` 在游标回拨**之后**现问一次重读口（配置里的 `rereadToolId`，
 *    只认 `effect === 'read'` 的那只手——重读是一道保险，不能变成另一只动手的口），
 *    读不到就**拒绝恢复**并把 run 留在安全点（`AGENT_LOOP_REREAD_UNAVAILABLE`）：
 *    「按了继续却没重读」正是要防的那种静默失效，接管前那份快照不许再带进下一步。
 *    这道保险按**下一步的副作用级**扳机（回拨之后才知道下一步是谁）：下一步本身是只读的手时不重读——
 *    它要的现状就是它自己现读的那一份，没有旧快照可复用，而为了一个 KB 检索去要求浏览器开着，
 *    会把 5.5-b 已经验过的那条恢复路径拒成「重读页面失败」（那是自造的失效，不是 spec 要的保险）。
 *    同一次重读也用在「页面与声明不符」那一条（5.5-04）：那一格落空后先重读、再让模型带着新读数
 *    续推；续推给出的**还是同一只手**时不重跑（那叫硬点），停在安全点把原因说清。
 * 8. **进程停过一次就重新对账**（5.5-d / spec 5.5-05 的 run 半边）：挂在暂停单上的那几步里状态一直是
 *    `running`（第 5 条），所以崩一次之后库里留下的是一行「正在跑」——它既不在跑，也没被任何人事先停过。
 *    `[Service.init]` 把这样的行落成 `paused` + `stopReason = INTERRUPTED`：与 `TAKEOVER_HELD` **分开**，
 *    因为 `resume` 只认后者；混用就成了「重启后按继续＝替人重跑崩溃那一刻的动作」。这条 run 的续跑口
 *    不在本片（崩溃后自动续推没有判据要它），这里只保证读数是真的、界面有对应文案，不谎报完成。
 * 9. **人做完的那一步不再动手**（5.5-e / spec 5.5-08）：`resume` 里那份重读读数除了「给下一步当现状」，
 *    还回答一个问题——页面上是不是已经出现这件事的结果。判据是那只手**自己声明**的文本哨兵
 *    （`AgentToolDeclaration.doneMarker`，经 `agent.tools.doneMarkerOf` 现读，不过 IPC），
 *    命中就把那一格落成 `skipped`（`code = DONE_BY_HUMAN`）并推进游标：那只手一次都不许被按，
 *    外发的那三道闸门与确认单也因此都不会开——重复打招呼比多问一句「要不要批准」严重得多。
 *    没标定哨兵（`null`）**永远不跳过**，比对只发生在恢复那一条路上且只看**这一次**的新读数；
 *    `skipped` 在终态判定里与 `ok` 同权（第 8 步那种「跑到的每一步都成功」不能因为人代劳了就变假）。
 */
import {
  AGENT_RUN_STATUSES,
  AppError,
  PAGE_DRIFT_CODES,
  Service,
  asApp,
  takeoverStateOf,
  type AgentPauseView,
  type AgentPlanStepView,
  type AgentRunStatus,
  type AgentRunView,
  type AgentStepView,
  type AutonomyLevel,
  type Context,
  type TakeoverStateSource,
  type ToolEffect,
  type ToolResult,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { MAX_USER_INPUT_CHARS } from '../session.js';
import type { ChatSessionService } from '../session.js';
import type { AgentToolsService } from '../tools.js';
import { StubLoopModel, type LoopModel, type ModelContext } from './model.js';
import { pauseKindLabel, type AgentPauseService } from './pause.js';
import type { AgentPolicyService } from './policy.js';

/** 迁移号段 16（plan §7.2 的 5.2-a 落点）：`agent_run` + `agent_step` 同一次迁移建出。 */
export const AGENT_RUN_MIGRATION_VERSION = 16;

/**
 * 「这一步被人工接管挡住了」的步行码，同时是 run 的 `stop_reason`（spec 5.5-09 的回看判据）。
 *
 * 与 `agent.policy` 的 `PolicyCode` 里那一位同值，但刻意不在这里 import 那个类型：循环要的是写进
 * `agent_step.code` 与 `agent_run.stop_reason` 的那串字符，判定读数的类型改名不该牵动已落库的历史值。
 */
const TAKEOVER_HELD = 'TAKEOVER_HELD';

/**
 * 「这条 run 所在的进程停过一次」的对账位（spec 5.5-05 的 run 半边，plan 5.5-d 的 D3）。
 *
 * 必须与 `TAKEOVER_HELD` 分开：`resume` 只认后者。混为一谈就是把「重启后按继续」变成「替人重跑崩溃
 * 那一刻的动作」——那正是 5.5 整片反对的那只手（崩溃后的续跑没有判据要它，见 plan「5.5-d 不做的事」）。
 * 与 workflow 那侧同一条口径：`workflow.run_store.markInterrupted` 用落库侧专有的 `interrupted` 状态，
 * 这里 `AGENT_RUN_STATUSES` 不动，中断只作为「它为什么停在 paused 上」的原因出现——两种形态说的是同一件事，
 * 而界面不需要为它新增一态（§2.5 一件事一个入口，§2.3 扩展现有读数而不是再造一维）。
 */
const INTERRUPTED = 'INTERRUPTED';

/**
 * 「这一步由人在页面上做完了」的步行码（spec 5.5-08，文件头第 9 条）。
 *
 * 它与 `TAKEOVER_HELD` 一样只出现在 `agent_step.code`，不进 `agent_run.stop_reason`——
 * 被跳过的这一步不会把 run 停在安全点上，它让 run **更像**跑完了。
 * 界面要能把这一格和「成功了」区分开：`code` 是唯一的区分位（`status` 那边已经有 `skipped` 这一态，
 * 而读数里「这只手一次都没被按」这件事必须有原话可查，见 `skipStepDoneByHuman` 写的观察）。
 */
const DONE_BY_HUMAN = 'DONE_BY_HUMAN';

/** 一条观察摘要里最多留多少个字（5.2-06 的「只带摘要」：整段工具正文不进 prompt）。 */
const OBSERVATION_TEXT_CAP = 80;

/**
 * 「人已做完」那次比对能读进去多少字（spec 5.5-08）。
 *
 * 它与 `OBSERVATION_TEXT_CAP` 是两个数，刻意不合并：80 字是给 prompt 与观察用的正文上限，
 * 而哨兵可能出现在整页正文的任何位置——拿被截成 80 字的那一份去比，就会把「页面明明已经做完」
 * 判成没做完。这个上限只管内存里的一次子串比对，读完即丢，既不进 prompt 也不落库（§8.5）。
 */
const DONE_CHECK_HAYSTACK_CAP = 4000;

/** 单条输入文本的边界校验：与 `chat.session` 共用同一个上限常量（§2.2 同一逻辑只留一份）。 */
const MAX_GOAL_CHARS = MAX_USER_INPUT_CHARS;

/** 循环配置：两条上限是 5.2-11 的判据对象，上下文长度上限是 5.2-06 的判据对象。 */
export const agentLoopSchema = z.strictObject({
  /** 单次 run 最多执行多少步（无解任务靠它兜底，默认 12）。 */
  stepLimit: z.number().int().min(1).max(50).default(12),
  /** 单次 run 的 token 预算（桩按 2 字≈1 token 粗估，见 `estimateTokens`）。 */
  tokenBudget: z.number().int().min(50).max(200000).default(4000),
  /** 递给模型的上下文字数上限（5.2-06：有界摘要，不含整页 HTML）。 */
  contextCharsCap: z.number().int().min(100).max(8000).default(1200),
  /**
   * 恢复前那道「重读页面」走的手（5.5-03）。
   *
   * 它是**接线**而不是业务映射：循环不认识浏览器，也不猜「该读哪一页」，只按装配给出的这只手现问一次，
   * 并且硬要求它的副作用级是 `read`（见 `rereadPage`）——写在这里的默认值是装配面板上那一行
   * （`cordis.yml` 的 `agent-loop` 配置）可以改的，改了名字循环照问新那只。
   */
  rereadToolId: z.string().min(1).default('browser.page.snapshot'),
  /** 一条 run 里最多重规划几次（5.5-04 的自转保险丝；0 就是「页面不符即停，不重规划」）。 */
  replanLimit: z.number().int().min(0).max(5).default(2),
});

/** 校验后的循环配置。 */
export type AgentLoopConfig = z.output<typeof agentLoopSchema>;

/**
 * 一次「现问页面」的读数（5.5-03 / 04 共用的那份新快照）。
 *
 * `ref` 是给步行与证据用的指针，`excerpt` 是**已经去标记并截过**的一句摘要（整页正文永不进 prompt，
 * 5.2-06 的口径对新读数同样成立），`note` 是说给下一步观察用的那句话——谁生的读数谁写措辞，
 * 于是循环里只有「消费一次」这一处逻辑（§2.2）。
 *
 * `haystack` 是 5.5-08 补的第二份文本，口径与 `excerpt` 相反：它**只**拿来做一次子串比对，
 * 不进 prompt、不进观察、不落库（页面上的原文可能带着候选人姓名与联系方式，§8.5 默认脱敏；
 * 落进账里的只有那句哨兵本身与快照引用）。为什么不能复用 `excerpt`——见 `DONE_CHECK_HAYSTACK_CAP`。
 */
type FreshPageRead = { ref: string; excerpt: string; haystack: string; at: number; note: string };

/**
 * 一次 run 的作用域：进度只活在这一份对象里，按 runId 存放。
 *
 * `planConfirmed` 与 `controller` 都在这里而不是服务字段上：跨 run 的隐式延续正是
 * plan §1.1 取证结论里 Cordis「state is preserved across calls」那条坑的形态（5.2-08 判的就是它）。
 */
type RunScope = {
  runId: string;
  cursor: number;
  plan: AgentPlanStepView[];
  tokensUsed: number;
  /** 这条 run 的步上限（起草时从配置定下并落进 `agent_run.step_limit`，之后改配置不回改旧 run）。 */
  stepLimit: number;
  /** 这条 run 的 token 预算（同上，落在 `agent_run.token_budget`）。 */
  tokenBudget: number;
  planConfirmed: boolean;
  controller: AbortController;
  /**
   * 刚重读到的页面读数，只在**紧接的下一步**消费一次（5.5-03）。
   *
   * 它是「这份新快照要落在哪一行的引用里」的指针，不是第二份页面事实：页面长什么样永远以现问为准，
   * 这一位一旦被某一步用掉就清空，绝不跟着 run 走完全程（留着它就会把恢复时那次读数当成现状）。
   */
  freshRead: FreshPageRead | null;
  /** 已经用掉的重规划次数（5.5-04 的自转保险丝，只活在内存：重建服务时这条 run 本来也没在跑）。 */
  replanUsed: number;
};

/** `agent_run` 的一行原始读数。 */
type RunRow = {
  id: string;
  session_id: string;
  goal: string;
  status: string;
  autonomy: string;
  plan_step_index: number | bigint;
  plan_json: string;
  step_limit: number | bigint;
  token_budget: number | bigint;
  tokens_used: number | bigint;
  stop_reason: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
};

/** `agent_step` 的一行原始读数。 */
type StepRow = {
  run_id: string;
  plan_step_index: number | bigint;
  tool_id: string;
  status: string;
  snapshot_refs_json: string;
  observation: string;
  evidence_refs_json: string;
  duration_ms: number | bigint | null;
  code: string | null;
};

/** 两张表的建表迁移；`up` 只写 DDL（与 `chat_message` 同一口径）。 */
const agentRunMigration = {
  version: AGENT_RUN_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_run (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      autonomy TEXT NOT NULL,
      plan_step_index INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      step_limit INTEGER NOT NULL,
      token_budget INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL,
      stop_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // 主键取 (run_id, plan_step_index)：同一步重跑是覆盖而不是补一行，读进度因此不需要「取最新那条」。
    db.exec(`CREATE TABLE IF NOT EXISTS agent_step (
      run_id TEXT NOT NULL,
      plan_step_index INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_refs_json TEXT NOT NULL,
      observation TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      duration_ms INTEGER,
      code TEXT,
      PRIMARY KEY (run_id, plan_step_index)
    )`);
  },
};

/**
 * 把可能带 HTML 的读数摊成一行纯文本（去标记 → 压空白）。
 *
 * 两步的顺序是刻意的：先截断再去标记，就会拿「<htm」这种半截碎片去猜标签边界，
 * 页面上那种畸形串会直接漏进正文。
 * @param reading 工具读数或失败原话（可能是一整页正文）
 * @returns 不含标签、空白压成单空格的文本（未截断）
 */
function toPlainText(reading: string): string {
  return reading
    .replace(/<[^>]*>/g, ' ') // 成对标签（含属性、整段 script/style）一律摘掉
    .replace(/<[\s\S]*$/, ' ') // 畸形或截断留下的半个开标签：后面没有 `>` 也要一起掉
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把工具读数收成一句**可进 prompt** 的话（5.2-06）。
 *
 * 先去标记（`toPlainText`），再截到 `OBSERVATION_TEXT_CAP`——整页原文要看就去证据引用里看，不进正文。
 * @param reading 工具读数或失败原话（可能是一整页正文）
 * @returns 不超过 `OBSERVATION_TEXT_CAP + 1` 字的纯文本（末位可能是省略号；全空的读数回空串）
 */
function clipReading(reading: string): string {
  const plain = toPlainText(reading);
  return plain.length > OBSERVATION_TEXT_CAP ? `${plain.slice(0, OBSERVATION_TEXT_CAP)}…` : plain;
}

/**
 * 递归收一个读数里的字符串叶子（spec 5.5-08 的比对文本从这里来）。
 *
 * 只认形状不认字段名：`ToolResult.value` 必须可 JSON 序列化（spec 5.1-11），所以这里没有环，
 * 也就不需要访问标记。数组与对象的值都往下走，键名不收——哨兵是页面上的话，不是字段名。
 * @param value 工具交回的产出（`unknown`，按不可信的形状处理）
 * @param sink 收集清单（就地追加）
 */
function collectStrings(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, sink);
    return;
  }
  if (isPlainRecord(value)) {
    for (const nested of Object.values(value)) collectStrings(nested, sink);
  }
}

/**
 * 把一次只读读数摊平成「页面上现在写着什么」的比对文本（文件头第 9 条 / spec 5.5-08）。
 *
 * 摘要 + 产出的全部字符串叶子，一起去标记再截到 `DONE_CHECK_HAYSTACK_CAP`。
 * 为什么不用 `clipReading` 的产物：那一份只有 80 字，是给 prompt 与观察用的上限，
 * 而哨兵可以出现在整页正文的任何位置——拿那 80 字去比就是把 5.5-08 变成看运气的判据。
 * 这一份**只活在一次调用里**：不进 prompt、不落库、界面读不到（§8.5 的脱敏口径对它同样成立，
 * 落进账里的只有那句哨兵与快照引用）。
 * @param result 那只只读手交回的 `ToolResult`
 * @returns 截断后的纯文本；一只都没有字符串时为空串
 */
function textHaystack(result: ToolResult): string {
  const parts: string[] = [result.summary];
  collectStrings(result.value, parts);
  const plain = toPlainText(parts.join(' ｜ '));
  return plain.length > DONE_CHECK_HAYSTACK_CAP ? `${plain.slice(0, DONE_CHECK_HAYSTACK_CAP)}…` : plain;
}

/**
 * 一张暂停单的三种「没等到放行」定局映射成的拒因（spec 5.3-10 的落点）。
 *
 * 映射权在循环这一侧而不是在通道里（plan §5.3-c）：通道只报「人给了值 / 到点了 / 这一等不再有人接」，
 * 至于到点在账上写成什么码、run 落成终态里的哪一档，是循环的领域。
 */
type PauseRejection = {
  code: 'PAUSE_DENIED' | 'PAUSE_TIMEOUT' | 'PAUSE_CANCELLED';
  message: string;
  runStatus: Extract<AgentRunStatus, 'failed' | 'paused'>;
};

/**
 * 把「没有表态」的两种定局说成一句能对账的话。
 * @param kind `timed-out` 或 `cancelled`（`answered` 不走这里——那是人表了态，另一种拒因）
 * @param request 那张已经收掉的单，只为把**单号与到期时刻**写进原话：5.3-10 的验收要看的是
 *   「回报里说得清是超时不是拒绝」，一个不含时刻与 id 的「未获批准」做不到这一点
 * @returns 超时是 `failed`（这一步没做、也不会补做），叫停是 `paused`（人在安全点按了停）
 */
function rejectionFor(kind: 'timed-out' | 'cancelled', request: AgentPauseView): PauseRejection {
  const label = pauseKindLabel(request.kind);
  if (kind === 'timed-out') {
    return {
      code: 'PAUSE_TIMEOUT',
      message: `${label} ${request.requestId} 等到 ${String(request.expiresAt)} 无人表态：超时按未确认收，这一步不执行（不是人拒绝了它）`,
      runStatus: 'failed',
    };
  }
  return {
    code: 'PAUSE_CANCELLED',
    message: `${label} ${request.requestId} 的等待被叫停：没有人表过态，这一步不执行`,
    runStatus: 'paused',
  };
}

/**
 * 把人补的那段原话并进当前入参，交给**同一次** schema 校验去判（spec 5.3-09 的「多轮」）。
 *
 * 只做两种看得见的合并，不做任何猜测式映射：给的是 JSON 对象就**逐字段并进**（是补充不是整体替换——
 * 模型已经写对的那几个字段，不该因为人只补了一个字段而丢掉）；给的不是对象（普通一句话、裸数字、裸串）
 * 而这次**恰好只缺一个顶层字段**时，把这句话当作那个字段的值。其余情形原样返回旧候选值，于是下一张卡片
 * 会说「还是缺这几个字段」——那比循环替用户猜「他大概想说的是 jobId」诚实，也是 §8 第 4 条「不许编造」
 * 在同一个小口子上的落实。
 * @param text 人在文本域里的原话（系统边界输入，本函数负责去空白）
 * @param candidate 上一次校验没过的那份入参（可能就是空对象，也可能是非对象的原文串）
 * @param missing 上一次校验给出的**问题字段名**清单（缺的、值不对的、多出来的都在里面），既用来定位「只缺一个就填它」，
 *   也用来把上一版的旧值丢掉
 * @returns 并进之后的候选入参；**本函数不判合不合法**，判由调用方交给 `agent.tools.validateInput`
 */
function mergeSupplement(text: string, candidate: unknown, missing: readonly string[]): unknown {
  const trimmed = text.trim();
  if (!trimmed) return candidate;
  const base: Record<string, unknown> = isPlainRecord(candidate) ? { ...candidate } : {};
  // 上一轮被点名有问题的字段，旧值不许带进下一份候选：留着它就是把同一份不合格的入参再递一遍，
  // 「补了几轮还是不过」就成了死局（`strictObject` 下最明显——多出来的那个键永远不会被收）。
  for (const field of missing) delete base[field];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 不是 JSON 就当普通一句话看（人在文本域里回「boss/123」是最自然的答法，不该要求他补一对花括号）。
    parsed = undefined;
  }
  if (isPlainRecord(parsed)) return { ...base, ...parsed };
  const onlyField = missing.length === 1 && !missing[0]?.includes('.') ? missing[0] : undefined;
  return onlyField ? { ...base, [onlyField]: trimmed } : candidate;
}

/**
 * 是不是一个可以按字段并的普通对象（数组与 null 都不算——它们没有「补一个字段」这种读法）。
 * @param value 待判的值
 * @returns 收窄成 `Record<string, unknown>` 的判定结果
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把一行 run 与它的步行拼成界面读数。
 * @param run 运行行
 * @param steps 步行（按 plan_step_index 升序）
 * @returns 跨进程可用的 `AgentRunView`
 */
function toRunView(run: RunRow, steps: StepRow[]): AgentRunView {
  return {
    runId: run.id,
    sessionId: run.session_id,
    goal: run.goal,
    status: run.status as AgentRunStatus,
    autonomy: run.autonomy as AutonomyLevel,
    planStepIndex: Number(run.plan_step_index),
    plan: JSON.parse(run.plan_json) as AgentPlanStepView[],
    steps: steps.map((step) => ({
      runId: step.run_id,
      planStepIndex: Number(step.plan_step_index),
      toolId: step.tool_id,
      status: step.status as AgentStepView['status'],
      snapshotRefs: JSON.parse(step.snapshot_refs_json) as string[],
      observation: step.observation,
      evidenceRefs: JSON.parse(step.evidence_refs_json) as string[],
      durationMs: step.duration_ms === null ? null : Number(step.duration_ms),
      code: step.code,
    })),
    stepLimit: Number(run.step_limit),
    tokenBudget: Number(run.token_budget),
    tokensUsed: Number(run.tokens_used),
    stopReason: run.stop_reason,
    createdAt: Number(run.created_at),
    updatedAt: Number(run.updated_at),
  };
}

export class AgentLoopService extends Service {
  static provide = 'agent.loop';
  static Config = agentLoopSchema;
  static inject = ['store', 'agent.tools', 'agent.policy', 'agent.pause', 'chat.session', 'browser.takeover'];

  constructor(
    ctx: Context,
    private readonly config: AgentLoopConfig,
  ) {
    super(ctx, 'agent.loop');
  }

  /** 按 runId 存的作用域表；终态即摘行，跨 run 看不见彼此（5.2-08）。 */
  private readonly scopes = new Map<string, RunScope>();

  /**
   * 模型端口。
   *
   * 5.2 只有确定性桩一种实现（真模型要花钱且须用户单独授权，本片不接），所以直接 new 在这里；
   * 等接真模型时改的是这一行与 `model.ts` 的实现，循环与判定一行都不动。
   */
  private readonly model: LoopModel = new StubLoopModel();

  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  private get registry(): AgentToolsService {
    return asApp(this.ctx)['agent.tools'];
  }

  private get policy(): AgentPolicyService {
    return asApp(this.ctx)['agent.policy'];
  }

  /** 暂停通道（5.3-c）：开单等人用的那一条，循环自己不持有任何等待状态。 */
  private get pause(): AgentPauseService {
    return asApp(this.ctx)['agent.pause'];
  }

  private get session(): ChatSessionService {
    return asApp(this.ctx)['chat.session'];
  }

  /**
   * 接管态的那份当下读数（文件头第 6 条的唯一事实源）。
   *
   * 每次用都现问、不存进 `RunScope`：本服务不持有任何「上一次的接管」，那一位只属于 `browser.takeover`
   * （AGENTS.md §9 的 2.5 实测：改配置会重建下游插件，本地存第二份事实就会静默变空——
   * 对循环来说那不是「读不到」，那是「接管中却照动手」，5.5-02 当场失效）。
   * 走 core 的 `takeoverStateOf`（硬依赖）而不是 `maybeService`：拿不到接管态时**没有任何安全的读数**，
   * 静默按「未接管」放行是这条护栏唯一要防的那件事；装配缺这一行就该在挂载期响亮失败。
   */
  private get takeover(): TakeoverStateSource {
    return takeoverStateOf(this.ctx);
  }

  /**
   * 起草一份计划并落一条 `proposed` 的 run（spec 5.2-03 的代码半边）。
   * @param goalRaw 用户原文（按系统边界校验：去空、限长）
   * @returns 尚未执行任何动作的 run 读数，`status` 为 `proposed`
   * @throws 空输入 `AGENT_LOOP_EMPTY_GOAL`；超长 `AGENT_LOOP_GOAL_TOO_LONG`
   */
  async propose(goalRaw: string): Promise<AgentRunView> {
    const goal = goalRaw.trim();
    if (!goal) throw new AppError('AGENT_LOOP_EMPTY_GOAL', '任务目标为空，不起草计划', 'agent.loop', {});
    if (goal.length > MAX_GOAL_CHARS) {
      throw new AppError('AGENT_LOOP_GOAL_TOO_LONG', `任务目标最长 ${String(MAX_GOAL_CHARS)} 字`, 'agent.loop', {
        length: goal.length,
      });
    }
    // `autonomy` 列存**起草时**的档位（计划卡要说「当时按哪档起的草」）；能不能动手按执行当下的档位现判，
    // 所以这一位是记录，不是授权凭据——判定只读 `agent.policy`，见 `execute` 里的 `decide`。
    const tier = this.session.current().session.autonomy;
    const draft = await this.model.draftPlan({
      goal,
      tier,
      knownToolIds: this.registry.list().map((descriptor) => descriptor.id),
      context: { refs: [], text: '' },
    });
    const runId = randomUUID();
    const at = Date.now();
    const plan: AgentPlanStepView[] = draft.steps.map((step, index) =>
      this.enrich(index, step.toolId, step.input, step.intent),
    );
    this.store.db
      .prepare(
        `INSERT INTO agent_run (id, session_id, goal, status, autonomy, plan_step_index, plan_json,
         step_limit, token_budget, tokens_used, stop_reason, created_at, updated_at)
         VALUES (?, ?, ?, 'proposed', ?, 0, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        runId,
        this.session.current().session.id,
        goal,
        tier,
        JSON.stringify(plan),
        this.config.stepLimit,
        this.config.tokenBudget,
        draft.usage.inputTokens + draft.usage.outputTokens,
        at,
        at,
      );
    this.scopes.set(runId, {
      runId,
      cursor: 0,
      plan,
      tokensUsed: draft.usage.inputTokens + draft.usage.outputTokens,
      stepLimit: this.config.stepLimit,
      tokenBudget: this.config.tokenBudget,
      planConfirmed: false,
      controller: new AbortController(),
      freshRead: null,
      replanUsed: 0,
    });
    return this.read(runId);
  }

  /**
   * 确认计划并跑完整条循环（5.2-03 的「确认之后才动」）。
   * @param runId 一次 `proposed` 的 run
   * @returns 跑完（或停在安全点）之后的读数
   * @throws 不在待确认态（已确认过、正在跑、或已终态）`AGENT_LOOP_NOT_PROPOSED`
   */
  async confirm(runId: string): Promise<AgentRunView> {
    const scope = this.ensureScope(runId);
    const view = this.read(runId);
    // 并发确认只有一道闸，就是这一位落库的状态：`updateRun('running')` 在下一个 `await` 之前发生，
    // 所以同一 tick 里按第二次必然读到 `running` 而被拒。再存一个「正在跑」的 promise 就是第二份事实（§2.5）。
    if (view.status !== 'proposed') {
      throw new AppError('AGENT_LOOP_NOT_PROPOSED', `run ${runId} 不是待确认态（现在：${view.status}）`, 'agent.loop', {
        status: view.status,
      });
    }
    scope.planConfirmed = true;
    this.updateRun(runId, { status: 'running', planStepIndex: scope.cursor, tokensUsed: scope.tokensUsed });
    // 起跑就先推一次：界面画的是「第 0 步也已经开始」这一态，而不是等第一个工具返回才有动静。
    this.publish(scope.runId);
    await this.execute(scope);
    return this.read(runId);
  }

  /**
   * 从「因人工接管而停住」的那个安全点继续跑（spec 5.5-01 的恢复半边，**只有人能按**）。
   *
   * 为什么不复用 `confirm`：那条口的语义是「这张计划我认了」，只吃 `proposed` 态；把两种表态合并成一只口，
   * 界面上就没有「确认计划」与「交还页面后继续」这两件不同的事可说了（§2.5 同一件事一个入口，反之两个入口）。
   * 为什么它**不登记为 agent 工具**：恢复自动化是人的表态，与 `confirm` / `respond` / 写档位 /
   * 加白撤白同族——模型若能自己按「继续」，接管就挡不住任何东西（5.5-02 当场失效；静态那半边由
   * `scripts/check-agent-model-authority.ts` 的 ⑧ 钉住）。
   * 与判定口的分工：`agent.policy.decide` 管「这一步能不能动手」（接管中它连只读工具都拒），
   * 这一张口只管「人已经把页面交回来了，可以再往下走」。所以这里先现问一次接管态、**仍在接管中就拒**：
   * 放行会做出「按了继续却没继续」那种要人猜的形态，而拒因说得很清楚——先交还页面，再按继续。
   * @param runIdRaw 一条 `paused` + `stopReason = TAKEOVER_HELD` 的 run（界面原样递回它读到的 id）
   * @returns 跑完（或再次停在下一个安全点）之后的读数
   * @throws 库里没有这条 run `AGENT_LOOP_RUN_NOT_FOUND`；仍在接管中 `AGENT_LOOP_TAKEOVER_HELD`；
   *   不是被接管按住的那条 run（`proposed` / `failed` / 被真人叫停的 `paused`）`AGENT_LOOP_NOT_RESUMABLE`
   */
  async resume(runIdRaw: string): Promise<AgentRunView> {
    const runId = runIdRaw.trim();
    const view = this.read(runId);
    if (view.status !== 'paused' || view.stopReason !== TAKEOVER_HELD) {
      throw new AppError(
        'AGENT_LOOP_NOT_RESUMABLE',
        `run ${runId} 不是被人工接管按住的（现在：${view.status} / ${String(view.stopReason)}）：` +
          '「继续」只在那条 run 因接管停在安全点时才管用，其余态各回各的口',
        'agent.loop',
        { status: view.status, stopReason: view.stopReason },
      );
    }
    if (this.takeover.held().isHeld) {
      throw new AppError(
        'AGENT_LOOP_TAKEOVER_HELD',
        '页面仍在人工接管中，自动化不能恢复：先交还页面（那是人的手，系统不代按），再按这一次「继续」',
        'agent.loop',
        { runId, reason: this.takeover.held().reason },
      );
    }
    const scope = this.ensureScope(runId);
    // 游标可能要**回拨一格**：停在暂停单上被打断的那种形态落了一行 `refused` 步行
    // （`code = TAKEOVER_HELD`，见 `refuseStep`），而 `ensureScope` 按「已有步行的最大下标 + 1」重建游标，
    // 于是那一格被跳过——它一次都没真的执行过，跳过之后再由 `allSucceeded` 读数就成了「这一步失败了」。
    // 只回拨这一种码：真人按过「拒绝」的那一步不重跑，那是他的表态（spec 5.3-10）。
    const interrupted = view.steps.at(-1);
    if (interrupted && interrupted.status === 'refused' && interrupted.code === TAKEOVER_HELD) {
      scope.cursor = interrupted.planStepIndex;
    }
    // 交还页面之后的第一件事是**看一眼现在这页长成什么样**（spec 5.5-03），不是动手。
    // 人在页面上做过什么，接管前那份快照里一个字都没有；要动手却读不到这份新读数就**拒绝恢复**、
    // run 原样停在安全点（不先翻成 `running` 再失败——那样界面上会闪过「正在跑」）：
    // 「按了继续却没重读」是这片最不能留的一种形态，它会让人以为自动化看过了页面。
    // 扳机看**下一步的副作用级**（所以排在回拨之后，回拨之前还不知道下一步是谁）：
    // 只读的手要的现状就是它自己现读的那一份，为它要求浏览器开着只会自造一种失效（文件头第 7 条）。
    // 下一步指向一只不存在的手时也不重读——那种形态由判定口按 5.1-05 原话拒，这里不抢它的入口（§2.5）。
    const nextEffect = this.effectOf(scope.plan[scope.cursor]?.toolId);
    if (nextEffect !== null && nextEffect !== 'read') {
      const reread = await this.rereadPage();
      if (!reread.ok) {
        throw new AppError(
          'AGENT_LOOP_REREAD_UNAVAILABLE',
          `run ${runId} 没有恢复：交还页面之后没能重读一遍现在的页面（${reread.reason}）。` +
            '这一步不读页面就照动手，等于拿接管前那份快照当现状',
          'agent.loop',
          { runId, toolId: this.config.rereadToolId, reason: reread.reason },
        );
      }
      // 这份新读数交给**紧接的那一步**落进引用与观察（`execute` 里消费一次）：恢复口自己不写步行，
      // 但「重读发生在恢复之后、动手之前」这件事要在下一步的行里留得下凭据，否则 5.5-03 只能靠日志证明。
      scope.freshRead = reread.read;
      // 交还页面时先问一句「这件事是不是人已经顺手做完了」（spec 5.5-08）：
      // 做过就记 `skipped` 并推进游标，那只手一次都不许被按——重复打招呼比多问一句「要不要批准」严重得多。
      this.skipStepDoneByHuman(scope, reread.read);
    }
    this.updateRun(runId, {
      status: 'running',
      planStepIndex: scope.cursor,
      tokensUsed: scope.tokensUsed,
      // 停住原因就地改写：留着 `TAKEOVER_HELD` 会让这条 run 同时读成「正在跑」与「被接管按住」。
      stopReason: 'RESUMED_AFTER_TAKEOVER',
    });
    this.publish(scope.runId);
    await this.execute(scope);
    return this.read(runId);
  }

  /**
   * 叫停一次 run（5.2-10 的入口半边）。
   *
   * 正在跑的那一步不硬切：这里只置信号，循环在**下一个安全点**（取步之前）看见信号就停，
   * 已经发出去的动作照常收尾并落它的观察记录。
   * @param runId 要停的 run
   * @returns 停下之后的读数；已经终态的 run 原样返回读数，不报错。
   * **running 分支返回的是置信号那一刻的读数（仍是 `running`）**——这是事实不是缺陷：
   * 那一步确实还在飞，真正的 `paused` 由收尾时的 `agent/run-progress` 带出来，
   * 界面因此在这一刻只能说「已受理叫停」，不能说「已停止」（5.2-c 的文案口径）。
   */
  stop(runId: string): AgentRunView {
    const view = this.read(runId);
    if (view.status === 'running') {
      // 只置信号：正在跑的那一步照常收尾，循环在取下一步之前看见它。
      this.ensureScope(runId).controller.abort();
      return view;
    }
    if (view.status === 'proposed') {
      const scope = this.ensureScope(runId);
      scope.controller.abort();
      this.finish(scope, 'paused', 'USER_STOPPED');
      return this.read(runId);
    }
    return view;
  }

  /**
   * 读一次 run 的整份落库读数（界面与日志的唯一去处）。
   * @param runId 运行 id
   * @returns run + 计划 + 已跑到的步
   * @throws 库里没有这条 run 时 `AGENT_LOOP_RUN_NOT_FOUND`
   */
  read(runId: string): AgentRunView {
    const run = this.store.db.prepare('SELECT * FROM agent_run WHERE id = ?').get(runId) as RunRow | undefined;
    if (!run) throw new AppError('AGENT_LOOP_RUN_NOT_FOUND', `找不到 run ${runId}`, 'agent.loop', { runId });
    const steps = this.store.db
      .prepare('SELECT * FROM agent_step WHERE run_id = ? ORDER BY plan_step_index ASC')
      .all(runId) as unknown as StepRow[];
    return toRunView(run, steps);
  }

  [Service.init](): void {
    // 卸载时把在跑的循环都停在安全点，别留下「服务已经没了、循环还在调注册表」的形态。
    // 必须是「返回一个函数」：cordis 会立刻执行这里的第一层来取回收器（AGENTS.md §9 实测 1.3），
    // 写成单层箭头就成了「刚挂载就 abort 一遍」，而那时一个 scope 都还没有。
    this.ctx.effect(() => () => {
      for (const scope of this.scopes.values()) scope.controller.abort();
      this.scopes.clear();
    });
    // 接管开始的那一刻叫醒在跑的 run（文件头第 6 条）。这里**只置信号、不落终态**：
    // 正在飞的那一步照常收尾（第 5 条），`paused` + `TAKEOVER_HELD` 由循环自己在下一个安全点落——
    // 终态只有 `finish()` 一个出口（§2.5），在这儿再写一次就会有两处地方宣称同一条 run 停了。
    // 为什么信号已经够用、不需要在这里再问一次 `held()`：载荷为 `isHeld: true` 就是那件事发生了，
    // 而循环随后那次现问（`execute` 取步之前）读到什么就以什么为准，两者之间没有缓存的状态（§9 的 2.5 实测）。
    // `isHeld === false`（交还页面）这条路**不**自动恢复：恢复是人的手（`resume`，spec 5.5-01），
    // 系统在毫秒级把页面还给自动化正是 5.5 要避免的那种「没人看见就跑起来了」。
    this.ctx.on('browser/takeover-changed', (event) => {
      if (!event.isHeld) return;
      for (const scope of this.scopes.values()) {
        scope.controller.abort();
        this.ctx.logger.info(`run ${scope.runId} 已受理人工接管信号：最迟在下一步之前停在安全点`);
      }
    });
    this.ensureSchema();
    // 崩过一次的对账排在建表之后、就绪日志之前：那一刻库里那行「正在跑」已经不会再有人来写终态了（D3）。
    const interrupted = this.reconcileInterruptedRuns();
    this.ctx.logger.info(
      `对话循环就绪：步上限 ${String(this.config.stepLimit)} · token 预算 ${String(this.config.tokenBudget)} · 上下文 ${String(this.config.contextCharsCap)} 字 · 模型腿 确定性桩` +
        (interrupted > 0 ? ` · 本次启动把 ${String(interrupted)} 条 run 判为中断（上次进程停过，不是有人叫的停）` : ''),
    );
  }

  /**
   * 启动对账：把库里写着「正在跑」的 run 落成 `paused` + `INTERRUPTED`（spec 5.5-05 的 run 半边 / plan D3）。
   *
   * 为什么这里不必再问「有没有在跑的 execute」：本实例的作用域表在 `[Service.init]` 这一刻必然是空的，
   * 而 `running` 只有 `confirm` / `resume` 在同一进程内才写得出来——所以库里那一行「正在跑」背后已经没有人
   * 会再来写它的终态。真·被 kill 是那一种；同进程内热改配置重建也走到同一位，因为回收器 abort 之后那一步
   * 若还压在不可硬切的工具里（第 3 条叫停的语义），它醒来时旧实例的上下文已经失效，那一行没人能改写。
   * 留着不判，界面就长期显示一行假账，违反 §7.1「读数是真的」。挂在确认单上的那一步尤其如此：
   * 那期间循环整条 `await` 在人的表态上，状态一直是 `running`（plan 现状 3 实测）。
   * @returns 被判定为中断的 run 条数；0 表示干净退出（终态都已落）或这台库里没跑过东西
   */
  private reconcileInterruptedRuns(): number {
    // 游标与 token 账按原值写回：`updateRun` 是这条 run 行唯一的写入口（§2.5），
    // 中断改的是「为什么停」，不是「停在哪」——进度属于那条 run 自己，不在这段对账的职权里。
    const rows = this.store.db
      .prepare("SELECT id, plan_step_index, tokens_used FROM agent_run WHERE status = 'running'")
      .all() as unknown as { id: string; plan_step_index: number | bigint; tokens_used: number | bigint }[];
    for (const row of rows) {
      this.updateRun(row.id, {
        status: 'paused',
        planStepIndex: Number(row.plan_step_index),
        tokensUsed: Number(row.tokens_used),
        stopReason: INTERRUPTED,
      });
      this.publish(row.id);
    }
    return rows.length;
  }

  /** 幂等登记号段 16 并建表（`plugins.start('agent-loop')` 会重跑 init）。 */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((migration) => migration.version === AGENT_RUN_MIGRATION_VERSION)) {
      migrations.push(agentRunMigration);
    }
    // 接管那段账不在这里：号段 21 的 `takeover_events` 归 `browser.takeover`（那份事实的主人），
    // 循环只把自己的 `stop_reason` 落成 TAKEOVER_HELD，两边靠 run id 与时刻对上，不各存一份。
    this.store.upgrade();
  }

  /**
   * 循环主体：每轮只做「取当前步 → 判闸门 → 调工具 → 写观察」四件事。
   * @param scope 本次 run 的作用域（游标、token 账、两条上限、取消句柄都在里面）
   */
  private async execute(scope: RunScope): Promise<void> {
    // 空计划不是「做完了」：桩没被点名任何手，一步都没跑却报 `completed` 就是 5.2-13 要防的谎报形态。
    if (scope.plan.length === 0) {
      this.finish(scope, 'failed', 'PLAN_EMPTY');
      return;
    }
    while (scope.cursor < scope.plan.length) {
      // 接管排在叫停**之前**，这是 5.5-02 的账而不是排版：叫醒这些 run 的信号正是本服务在
      // `browser/takeover-changed` 里自己置的（见 `[Service.init]`），先读 `aborted` 就会把
      // 「人在页面上打字」落成「用户停止了任务」——同一次接管被记成用户的决定，`resume` 也认不出这条 run。
      // 这一问与判定口那次不是两份判据：判定口答「这一步能不能动手」，这里只答「这个安全点该记哪个原因」，
      // 两边读的都是 `browser.takeover` 那一份当下事实，没有第三份状态。
      if (this.takeover.held().isHeld) {
        this.finish(scope, 'paused', TAKEOVER_HELD);
        return;
      }
      if (scope.controller.signal.aborted) {
        this.finish(scope, 'paused', 'USER_STOPPED');
        return;
      }
      if (scope.cursor >= scope.stepLimit) {
        this.finish(scope, 'failed', 'STEP_LIMIT');
        return;
      }
      if (scope.tokensUsed >= scope.tokenBudget) {
        this.finish(scope, 'failed', 'TOKEN_LIMIT');
        return;
      }
      const step = scope.plan[scope.cursor]!;
      // 档位**用的时候现问**而不是存进作用域：档位是人在此刻的授权表态，不是起草时的存档。
      // 存下来会留一个洞——起草之后把档位从 `auto` 降回 `suggest`，确认这条旧计划照样动手。
      // 现问的效果是人随时降档都能在最下一个安全点生效（AGENTS.md §9 的 2.5 实测同一口径）。
      const decision = this.policy.decide({
        tier: this.session.current().session.autonomy,
        planConfirmed: scope.planConfirmed,
        toolId: step.toolId,
      });
      if (!decision.canRun) {
        // 接管中：**不落 refused 步行、不开确认单**，只停在安全点、游标不动（文件头第 6 条）。
        // 不落步行等于把这一步判死——恢复后它再也不会被走一遍，人交还页面看到的还是「这一步没做」；
        // 开确认单则是骗他再按一次「批准」，而此刻真正缺的那一句话不在卡片上，在他的手上。
        // 游标不动是 `resume` 能接上的全部凭据：那一格没有步行，`ensureScope` 重建出的游标就是它。
        // 接管这段账本身在号段 21 的 `takeover_events` 里（谁、何时、因为什么），这里不重复记。
        if (decision.code === TAKEOVER_HELD) {
          this.finish(scope, 'paused', TAKEOVER_HELD);
          return;
        }
        // 只有 `CONFIRMATION_REQUIRED` 是「等人一句话就能继续」的拒因：档位只读与「这只手不在开放面上」
        // 问人也问不出结果，照 5.2-02 的结局直接落 refused。把这两种情形也做成卡片，等于在一条用户
        // 根本批不了的路上让他按「批准」——那张按钮按下去还是不动，那就是骗他点一下。
        if (decision.code !== 'CONFIRMATION_REQUIRED') {
          this.writeStep(scope, step, 'refused', decision.message, [], null, decision.code);
          this.finish(scope, 'failed', 'POLICY_REFUSED');
          return;
        }
        const approved = await this.awaitStepApproval(scope, step, decision.message);
        if (!approved.ok) {
          this.refuseStep(scope, step, approved.rejection);
          return;
        }
      }
      // 入参这一问排在判定之后（文件头第 5 条）：这只手本来就不许动的时候，不该有人在替它收简历号。
      const inputResolution = await this.resolveStepInput(scope, step);
      if (!inputResolution.ok) {
        this.refuseStep(scope, step, inputResolution.rejection);
        return;
      }
      this.writeStep(scope, step, 'pending', '', [], null, null);
      // 步一开工就推：卡片要先出现在流里（running 态），否则界面只能等它跑完，
      // 5.2-04 要的「逐步出现」就成了「批量出现」。
      this.publish(scope.runId);
      const at = Date.now();
      const reply = await this.registry.call(step.toolId, inputResolution.input);
      const durationMs = Date.now() - at;
      const outcome = reply.ok ? 'ok' : 'failed';
      const reading = reply.ok ? reply.result.summary : `${reply.code}：${reply.message}`;
      // 恢复或重规划时那份**新**页面读数只在这一行落一次账：引用进 `evidence_refs`、原话进观察，
      // 用完就地清空（下一步要现状就再问一次，而不是把这一次读数当现状带着跑完整条 run，5.5-03）。
      const fresh = scope.freshRead;
      scope.freshRead = null;
      const evidenceRefs = reply.ok
        ? [...(fresh ? [fresh.ref] : []), ...reply.result.evidenceRefs]
        : [...(fresh ? [fresh.ref] : [])];
      const context = this.buildContext(scope);
      const summary = await this.model.summarizeObservation({ step, reading: clipReading(reading), outcome, context });
      scope.tokensUsed += summary.usage.inputTokens + summary.usage.outputTokens;
      // 入参经人补过就要在步行里留一句：计划里那份是模型的草案，实际动用的是补过之后的值，
      // 两者不同却只记一个数，5.2-09 的「对话里如实指向证据」就成了半句话。
      const notes = [inputResolution.note, fresh?.note].filter((note): note is string => Boolean(note));
      const observation = notes.length > 0 ? `${summary.text}｜${notes.join('｜')}` : summary.text;
      this.writeStep(scope, step, outcome, observation, evidenceRefs, durationMs, reply.ok ? null : reply.code);
      if (!reply.ok && PAGE_DRIFT_CODES.includes(reply.reasonCode ?? '')) {
        // 「这一步落空是因为页面不是计划里那个样子」——这一格既不再按旧入参点一次（那叫硬点），
        // 也不退回按索引找元素（那叫猜），而是重读页面 + 让模型带着新读数续推（`replanStep`，5.5-04）。
        // 上面那一行 `failed` 步行是**这一次尝试的账**：重规划成功时同下标覆盖（DDL 主键就是覆盖口径），
        // 顶替它的那只手会把落空原因原样带在观察里；重规划失败时这一行就停在 `failed`，run 如实报失败。
        const replanned = await this.replanStep(scope, step, `${String(reply.reasonCode)}：${reply.message}`);
        if (!replanned.ok) {
          this.finish(scope, 'failed', replanned.stopReason);
          return;
        }
        continue;
      }
      scope.cursor += 1;
      // 观察落库后立刻**写回游标与账**再推：失败那一步的 `code` 与观察要出现在同一张卡片上，
      // 否则 5.2-09 的「对话里如实指向证据」就变成界面自己编的安慰话。
      // 写回是这片补上的：原先 run 行的两列只在起跑和收尾各写一次，执行途中读到的额度停在起草值——
      // 活体截图上出现过「已落 11 / 12 步」配「已用 545 token」，那个不动的数会被人当成事实读。
      this.sync(scope);
    }
    const finished = this.store.db
      .prepare('SELECT status FROM agent_step WHERE run_id = ?')
      .all(scope.runId) as unknown as { status: string }[];
    // 「跑到了」不等于「做成了」：任何一步不是 ok，这条 run 就不能自称 completed（5.2-09 的凭据）。
    // 唯一的例外是 `skipped`：人在接管期间把这件事做完了（5.5-08），页面上那条结果是真的，只是不由本 agent 做出。
    // 把它算成失败会让最常态的那种协助把界面那句「做完了」变成「有步骤没成功」——那是谎报的反方向，但同样没人要。
    const allSucceeded = scope.cursor > 0 && finished.every((row) => row.status === 'ok' || row.status === 'skipped');
    this.finish(scope, allSucceeded ? 'completed' : 'failed', allSucceeded ? 'COMPLETED' : 'STEP_UNSUCCESSFUL');
  }

  /**
   * 等一张确认单（spec 5.3-08 的 `approval` 那一路，也是 5.3-10 的主判据现场）。
   * @param scope 本次 run 的作用域——叫停信号从这里递给通道，所以卡片还开着时按「停止」，单子按 `cancelled` 收
   * @param step 被策略要求「每次都要人批准」的那一步
   * @param reason 策略交回的人读原话（为什么这一步要批准），原样进卡片，不在这里另编一句
   * @returns 批准是 `{ ok: true }`；拒绝 / 超时 / 叫停三种都带拒因与终态，**没有第四种**，也不存在「默认批准」
   */
  private async awaitStepApproval(
    scope: RunScope,
    step: AgentPlanStepView,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; rejection: PauseRejection }> {
    const { request, outcome } = await this.pause.ask(
      {
        runId: scope.runId,
        planStepIndex: step.planStepIndex,
        toolId: step.toolId,
        kind: 'approval',
        reason,
        missing: [],
        round: 1,
      },
      scope.controller.signal,
    );
    if (outcome.kind !== 'answered') return { ok: false, rejection: rejectionFor(outcome.kind, request) };
    if (outcome.answer.decision === 'approve') return { ok: true };
    return {
      ok: false,
      rejection: {
        code: 'PAUSE_DENIED',
        message: `人在${pauseKindLabel(request.kind)} ${request.requestId} 上按了拒绝：这一步不执行`,
        runStatus: 'failed',
      },
    };
  }

  /**
   * 把这一步的入参收到「过得了工具自己的 schema」为止（spec 5.3-09 的多轮补充信息）。
   *
   * 校验走 `agent.tools.validateInput`——就是 `call()` 里那一次 `safeParse` 的同一份实现，
   * 循环只是提前问了同一个问题，没有第二套「什么叫合法」。每补一轮**重开一张新单**（新 `requestId`），
   * 于是一单里的分页状态、超时重置、路由特化这三件事一件都不存在。
   * @param scope 本次 run 的作用域（同样把叫停信号交给通道）
   * @param step 计划里的那一步，`step.input` 是模型给的草案
   * @returns 合格入参（收窄后的值，递给 `call`）与一句「经人补过」的注记；或拒因与终态
   */
  private async resolveStepInput(
    scope: RunScope,
    step: AgentPlanStepView,
  ): Promise<{ ok: true; input: unknown; note: string | null } | { ok: false; rejection: PauseRejection }> {
    let candidate = step.input;
    let suppliedRounds = 0;
    for (;;) {
      const check = this.registry.validateInput(step.toolId, candidate);
      if (check.ok) {
        return {
          ok: true,
          input: check.input,
          note:
            suppliedRounds === 0
              ? null
              : `入参经人补充 ${String(suppliedRounds)} 轮，实际使用：${clipReading(JSON.stringify(check.input))}`,
        };
      }
      const { request, outcome } = await this.pause.ask(
        {
          runId: scope.runId,
          planStepIndex: step.planStepIndex,
          toolId: step.toolId,
          kind: 'elicitation',
          reason: check.message,
          missing: check.missing,
          round: suppliedRounds + 1,
        },
        scope.controller.signal,
      );
      if (outcome.kind !== 'answered') return { ok: false, rejection: rejectionFor(outcome.kind, request) };
      if (outcome.answer.decision !== 'supply') {
        return {
          ok: false,
          rejection: {
            code: 'PAUSE_DENIED',
            message: `人在${pauseKindLabel(request.kind)} ${request.requestId} 上按了放弃：这一步不执行`,
            runStatus: 'failed',
          },
        };
      }
      suppliedRounds += 1;
      candidate = mergeSupplement(outcome.answer.text, candidate, check.missing);
    }
  }

  /**
   * 把「等人表态没等到」落成账：一行 `refused` 步行 + 一个终态。
   *
   * 两处调用（确认单与补充信息单）走同一个入口（§2.2）——「没批就不能做」这条性质只写一遍，
   * 免得将来加第三种暂停时漏掉一处的 `code`，那正是 5.3-10 会静默失效的形态。
   * @param scope 本次 run 的作用域
   * @param step 被拒的那一步
   * @param rejection 拒因（码、要显示给人看的一句原话、run 该落的终态）
   */
  private refuseStep(scope: RunScope, step: AgentPlanStepView, rejection: PauseRejection): void {
    // 接管把这张卡片收掉的那一路改记成接管（文件头第 6 条）：`PAUSE_CANCELLED` 的原话是「等待被叫停」，
    // 而叫停它的是本服务在 `browser/takeover-changed` 里自己置的信号，不是人在这张卡片上表过的态。
    // 记成「用户停止了任务」就是谎报（5.3-10 说 `cancelled` 永远读不成「同意了」，它也永远不是「按了停止」），
    // 而 `stop_reason` 错了的那条 run 在 `resume` 那里再也认不出自己是因接管停的——恢复口就关上了。
    // 步行照落：这张卡片确实开过、确实没等到了，它与「被真人拒绝」的区分就在 `code` 上，
    // 于是 `resume` 只回拨这一种码的那一格（见那里的注释），其余拒因都不重跑。
    const hold = this.takeover.held();
    if (hold.isHeld) {
      this.writeStep(
        scope,
        step,
        'refused',
        `${rejection.message}｜此刻页面由人工接管（原因：${String(hold.reason)}），这一步未执行`,
        [],
        null,
        TAKEOVER_HELD,
      );
      this.finish(scope, 'paused', TAKEOVER_HELD);
      return;
    }
    this.writeStep(scope, step, 'refused', rejection.message, [], null, rejection.code);
    this.finish(scope, rejection.runStatus, rejection.code);
  }

  /**
   * 现问注册表：这一只手声明的副作用级是什么（文件头第 7 条那道扳机）。
   * @param toolId 要问的工具 id；计划已经跑到头时传进来的是 undefined
   * @returns 声明的副作用级；没有下一步、或那只手根本不在对 agent 开放的工具面上时为 `null`——
   *   调用方据此**不猜名**（与 5.1-05 同一口径：指向不存在的手由判定口按原话拒，这里不抢它的入口）
   */
  private effectOf(toolId: string | undefined): ToolEffect | null {
    if (toolId === undefined) return null;
    return this.registry.list().find((entry) => entry.id === toolId)?.effect ?? null;
  }

  /**
   * 人已经在页面上把这一步做完了，就把那一格记成跳过（spec 5.5-08，文件头第 9 条的唯一实现处）。
   *
   * 三条口径写死在这里：
   * ① 判据来自**那只手自己的声明**（经 `agent.tools.doneMarkerOf` 现读，见那里的注释为什么是一个窄口）——
   *    循环不认识平台、也不猜页面文案；没标定就是 `null`，`null` 就永不跳过。把「大概长这样」猜进来
   *    换来的是悄悄跳掉一次外发（plan 5.5-e 的 E4：假阳性看得见，假阴性才是没人管的）；
   * ② 只看**这一次恢复时**的新读数（`haystack`），不看接管前那份快照，也不再读第二次页面：
   *    5.5-03 那一道重读就是这里唯一的事实来源，读两次就有了两条互相可能的「现在」（§2.5）；
   * ③ 命中即落一行 `skipped` + 推进游标 + 消费掉这份读数，**一次都不调工具**：
   *    判定口、确认单、`entitlement.gate` 那三道闸门因此全都不参与——它们拦的是"动手"，这一步没动手。
   * @param scope 本次 run 的作用域（游标停在要判的那一格）
   * @param read 恢复时那份新读数（比对完即丢，正文不进 prompt 也不落库，§8.5）
   * @returns 是否真的跳过了那一格；跳过时那一行已落库、游标已推进、这份读数已被消费
   */
  private skipStepDoneByHuman(scope: RunScope, read: FreshPageRead): boolean {
    const step = scope.plan[scope.cursor];
    if (!step) return false;
    const marker = this.registry.doneMarkerOf(step.toolId);
    if (marker === null || !read.haystack.includes(marker)) return false;
    this.writeStep(
      scope,
      step,
      'skipped',
      `这一步由人在页面上做完了：重读到的现状里出现「${marker}」，那只手一次都没被按｜${read.note}`,
      [read.ref],
      null,
      DONE_BY_HUMAN,
    );
    scope.freshRead = null;
    scope.cursor += 1;
    this.ctx.logger.info(
      `run ${scope.runId} 第 ${String(step.planStepIndex + 1)} 步 ${step.toolId} 人已做完，记为 skipped（哨兵「${marker}」· 证据 ${read.ref}）`,
    );
    return true;
  }

  /**
   * 现问一次「现在这页长成什么样」（spec 5.5-03 / 04 共用的那道重读）。
   *
   * 三条口径写死在这里，因为它们正是这片要防的三件事：
   * ① 只许用**只读**的手（`effect === 'read'`）——重读是一道保险，装配把它配成动手的那只就得响亮失败，
   *    而不是让循环借着「重读」的名义在页面上按一下；
   * ② 读不到就返回原因而不是抛——调用方一处是「拒绝恢复」、一处是「停在安全点报原因」，
   *    两种处置说的话不同（`resume` 与 `replanStep`），但读页面这个动作只此一份实现（§2.2）；
   * ③ 回来的正文一律先去标记、截断之后才进上下文（`clipReading`），整页 HTML 不进 prompt（5.2-06）。
   * @returns 成功带 `{ref, excerpt, haystack, at, note}`（`ref` 每次都是新的时间戳，所以接管前后的两份快照
   *   在步行里必然不同名——5.5-03 要的就是这个可对比性；`haystack` 只给 5.5-08 的比对用，见 `textHaystack`）；
   *   失败带一句能对账的原因
   */
  private async rereadPage(): Promise<{ ok: true; read: FreshPageRead } | { ok: false; reason: string }> {
    const toolId = this.config.rereadToolId;
    const descriptor = this.registry.list().find((entry) => entry.id === toolId);
    if (!descriptor) {
      return {
        ok: false,
        reason: `重读口 ${toolId} 不在对 agent 开放的工具面上（能力包未挂载，或它没把这只手登记进来）`,
      };
    }
    if (descriptor.effect !== 'read') {
      return {
        ok: false,
        reason: `重读口 ${toolId} 声明的副作用级是 ${descriptor.effect}，重读只许用只读的手（配错就停下，不借道动手）`,
      };
    }
    const reply = await this.registry.call(toolId, {});
    if (!reply.ok) return { ok: false, reason: `${reply.code}：${reply.message}` };
    const at = Date.now();
    const ref = `snapshot:${toolId}@${String(at)}`;
    return {
      ok: true,
      read: {
        ref,
        excerpt: clipReading(reply.result.summary),
        haystack: textHaystack(reply.result),
        at,
        note: `动手前已重读页面（${ref}）`,
      },
    };
  }

  /**
   * 页面与声明不符时把这一步重新规划（spec 5.5-04 的唯一实现处）。
   *
   * 四步都在挡同一件事——「拿着旧页面认知继续动手」：
   * ① 先重读（复用 `rereadPage`，同 5.5-03 那一道），读不到就停在安全点，不带着旧快照续推；
   * ② 续推走 `draftPlan` 这一条**已有**的口（机检 ① 钉死模型只有两条口，多一条「请求重规划」
   *    就是给它开一条表态通道），递进去的上下文带着新读数与那一步的落空原话；
   * ③ `knownToolIds` 里**摘掉刚落空的那一只手**：它在页面上已经找不到目标了，续推若还选它，要么等于
   *    原地再点一次（硬点），要么就是没接住新读数。换一只手做同一件事才配叫「重规划」；
   * ④ 顶替只发生在**同一格**（游标不动，计划从这一格起被续推序列替换）。同下标覆盖那一行是 DDL 的既有
   *    口径，落空原因由顶替者的观察原样带出，不另存第二份计划（§2.5）。
   * @param scope 本次 run 的作用域
   * @param step 刚落空的那一步（就是 `scope.plan[scope.cursor]`）
   * @param failure 工具交回的落空原话（进上下文，也给顶替者的观察用）
   * @returns `ok: true` 表示计划已换、下一轮照常先过判定口；否则带一个终态码（`REPLAN_*` / `REREAD_UNAVAILABLE`）
   */
  private async replanStep(
    scope: RunScope,
    step: AgentPlanStepView,
    failure: string,
  ): Promise<{ ok: true } | { ok: false; stopReason: string }> {
    if (scope.replanUsed >= this.config.replanLimit) {
      this.ctx.logger.warn(
        `run ${scope.runId} 第 ${String(step.planStepIndex + 1)} 步落空（${failure}），但重规划额度已用完（上限 ${String(this.config.replanLimit)}）：停在安全点，不重试到底`,
      );
      return { ok: false, stopReason: 'REPLAN_EXHAUSTED' };
    }
    const reread = await this.rereadPage();
    if (!reread.ok) {
      this.ctx.logger.warn(`run ${scope.runId} 重规划前没能重读页面（${reread.reason}）：停在安全点`);
      return { ok: false, stopReason: 'REREAD_UNAVAILABLE' };
    }
    const base = this.buildContext(scope);
    const draft = await this.model.draftPlan({
      goal: this.read(scope.runId).goal,
      tier: this.session.current().session.autonomy,
      knownToolIds: this.registry
        .list()
        .map((descriptor) => descriptor.id)
        .filter((id) => id !== step.toolId),
      context: {
        refs: [...base.refs, reread.read.ref],
        text: [
          base.text,
          `页面现状（刚重读 ${reread.read.ref}）：${reread.read.excerpt}`,
          `落空的是第 ${String(step.planStepIndex + 1)} 步 ${step.toolId}：${clipReading(failure)}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    });
    scope.tokensUsed += draft.usage.inputTokens + draft.usage.outputTokens;
    if (draft.steps.length === 0 || draft.steps[0]?.toolId === step.toolId) {
      // 续推给不出别的手就是「无法定位目标」：明说并停住，而不是把同一只手按第二遍。
      this.ctx.logger.warn(
        `run ${scope.runId} 重新规划没能给出可换的手（第 ${String(step.planStepIndex + 1)} 步 ${step.toolId} 落空后续推仍指向同一只或没有新路）：停在安全点`,
      );
      return { ok: false, stopReason: 'REPLAN_UNCHANGED' };
    }
    const tail = draft.steps.map((draftStep, offset) =>
      this.enrich(step.planStepIndex + offset, draftStep.toolId, draftStep.input, draftStep.intent),
    );
    scope.plan = [...scope.plan.slice(0, step.planStepIndex), ...tail];
    scope.replanUsed += 1;
    scope.freshRead = {
      ...reread.read,
      note: `这一步由重规划顶替（前一次落空：${clipReading(failure)}），顶替前已重读页面`,
    };
    this.updateRun(scope.runId, {
      status: 'running',
      planStepIndex: scope.cursor,
      tokensUsed: scope.tokensUsed,
      plan: scope.plan,
    });
    this.publish(scope.runId);
    this.ctx.logger.warn(
      `run ${scope.runId} 第 ${String(step.planStepIndex + 1)} 步已重新规划：${step.toolId} → ${String(tail.length)} 步新序列（${tail.map((entry) => entry.toolId).join(', ')}）`,
    );
    return { ok: true };
  }

  /**
   * 拼递给模型的上下文：只有已落步的**引用 + 摘要**（5.2-06）。
   * @param scope 本次 run 的作用域
   * @returns 引用清单与有界文本；整页 HTML 与工具正文都不在这里出现
   */
  private buildContext(scope: RunScope): ModelContext {
    // 上下文从**落库的步行**取而不是从内存里的计划取：改配置重建服务之后，内存里什么都没有了，
    // 而模型该看到的观察仍然是那几行已写回的观察（§9 的 2.5 实测换来的口径）。
    const rows = this.store.db
      .prepare(
        'SELECT plan_step_index, tool_id, status, observation FROM agent_step WHERE run_id = ? AND plan_step_index < ? ORDER BY plan_step_index ASC',
      )
      .all(scope.runId, scope.cursor) as unknown as {
      plan_step_index: number | bigint;
      tool_id: string;
      status: string;
      observation: string;
    }[];
    const entries = rows.map((row) => ({
      ref: `run:${scope.runId}/step:${String(Number(row.plan_step_index))}`,
      line: `#${String(Number(row.plan_step_index) + 1)} ${row.tool_id} ${row.status} → ${clipReading(row.observation)}`,
    }));
    // 装不下的从**最早**的几条开始丢：离当前越近的越要留给模型看。
    // 预算连「前 N 步已略」那一行自己也算进去——它是会进 prompt 的文本，不算账外，
    // 不然 5.2-06 的长度上限就成了约等于。丢到连最近一条都放不下时，正文只剩这一行说明：
    // 宁可让模型看见「这一轮没有上下文」，也不能给它一句被腰斩的观察，那才是会被当成事实读的东西。
    const noteFor = (omittedCount: number) => `（前 ${String(omittedCount)} 步已略）`;
    // 一份保留清单写进 prompt 实际占用的字符数（行之间与说明之后各有一个换行）。
    const charsOf = (keptRows: typeof entries) =>
      keptRows.reduce((sum, entry) => sum + entry.line.length, 0) +
      Math.max(0, keptRows.length - 1) +
      (keptRows.length < entries.length ? noteFor(entries.length - keptRows.length).length + 1 : 0);
    let kept: typeof entries = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      // 只往「放得下」的方向加：再加一条更早的观察只会更长，一旦超长就可以停了。
      const candidate = [entries[index]!, ...kept];
      if (charsOf(candidate) > this.config.contextCharsCap) break;
      kept = candidate;
    }
    const omitted = entries.length - kept.length;
    return {
      refs: kept.map((entry) => entry.ref),
      text:
        omitted > 0
          ? `${noteFor(omitted)}\n${kept.map((entry) => entry.line).join('\n')}`
          : kept.map((entry) => entry.line).join('\n'),
    };
  }

  /**
   * 把模型草案里的一步补上注册表的真相。
   * @param index 步序号
   * @param toolId 模型点名的手
   * @param input 模型给的入参（不可信，注册表那侧还要过 schema）
   * @param intent 模型给的说明
   * @returns 计划步读数；工具不在开放面上时 `effect` 为 null，由策略直接拒
   */
  private enrich(index: number, toolId: string, input: unknown, intent: string): AgentPlanStepView {
    const descriptor = this.registry.list().find((entry) => entry.id === toolId);
    return {
      planStepIndex: index,
      toolId,
      input,
      intent,
      effect: descriptor?.effect ?? null,
      requiresConfirmation: descriptor?.requiresConfirmation ?? false,
    };
  }

  /**
   * 覆盖一条步行（同一 `(runId, planStepIndex)` 只有一行，见 DDL 主键）。
   * @param scope 本次 run 的作用域
   * @param step 计划里的那一步
   * @param status 落库状态
   * @param observation 观察文本（`pending` 时是空串）
   * @param evidenceRefs 工具交回的证据引用
   * @param durationMs 耗时；未跑完为 null
   * @param code 拒因或失败码；成功为 null
   */
  private writeStep(
    scope: RunScope,
    step: AgentPlanStepView,
    status: AgentStepView['status'],
    observation: string,
    evidenceRefs: readonly string[],
    durationMs: number | null,
    code: string | null,
  ): void {
    const context = this.buildContext(scope);
    this.store.db
      .prepare(
        `INSERT INTO agent_step (run_id, plan_step_index, tool_id, status, snapshot_refs_json, observation,
         evidence_refs_json, duration_ms, code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, plan_step_index) DO UPDATE SET
           tool_id = excluded.tool_id,
           status = excluded.status,
           snapshot_refs_json = excluded.snapshot_refs_json,
           observation = excluded.observation,
           evidence_refs_json = excluded.evidence_refs_json,
           duration_ms = excluded.duration_ms,
           code = excluded.code`,
      )
      .run(
        scope.runId,
        step.planStepIndex,
        step.toolId,
        status,
        JSON.stringify(context.refs),
        observation,
        JSON.stringify(evidenceRefs),
        durationMs,
        code,
      );
  }

  /**
   * 收尾：写终态、摘掉作用域、留一条可 grep 的日志。
   * @param scope 本次 run 的作用域
   * @param status 终态（`AGENT_RUN_STATUSES` 里的终态三选一）
   * @param stopReason 为什么停（界面与 5.2-09 的失败陈述都读这一位）
   */
  private finish(
    scope: RunScope,
    status: Extract<AgentRunStatus, 'paused' | 'completed' | 'failed'>,
    stopReason: string,
  ): void {
    this.updateRun(scope.runId, { status, planStepIndex: scope.cursor, tokensUsed: scope.tokensUsed, stopReason });
    this.scopes.delete(scope.runId);
    // 终态必须推一次：`stop()` 的 running 分支返回的还是 `running`，界面上那一格「已停止」只能从这里来。
    // 放在 `scopes.delete` 之后不影响——载荷从库里现读，不看内存里的作用域。
    this.publish(scope.runId);
    this.ctx.logger.info(`run ${scope.runId} 收尾：${status}（${stopReason}）· 跑到第 ${String(scope.cursor)} 步`);
  }

  /**
   * 把这份 run 的当前落库读数推给渲染层（`agent/run-progress`，spec 5.2-04）。
   *
   * 载荷刻意就是 `read()` 的原样返回值：不包事件外壳、不裁字段，界面与日志读的是同一个形状。
   * @param runId 刚被写过的那条 run
   */
  private publish(runId: string): void {
    this.ctx.emit('agent/run-progress', this.read(runId));
  }

  /**
   * 把内存里的游标与 token 账写回 run 行，随即推一次（执行途中只有数字真的动了的那一处用它）。
   *
   * 状态写死 `running` 是事实而不是猜测：能走到这里说明循环还在步与步之间，
   * 终态一律由 `finish()` 落，不从这条口出。
   * @param scope 本次 run 的作用域
   */
  private sync(scope: RunScope): void {
    this.updateRun(scope.runId, { status: 'running', planStepIndex: scope.cursor, tokensUsed: scope.tokensUsed });
    this.publish(scope.runId);
  }

  /**
   * 更新 run 行的可变列。
   *
   * 两个可选列按「给了才写」拼进 SET，因为 `undefined` 在这里是「这一列不动」而不是「抹成空」：
   * `stopReason` 不带就不擦已有的拒因（执行途中不该把上一次为什么停的话抹掉），
   * `plan` 不带就不重写 `plan_json`（只有 5.5-04 的重规划会换计划，其余调用点必须留着起草时那份）。
   * @param runId 运行 id
   * @param patch 要写的列（至少含 status）
   */
  private updateRun(
    runId: string,
    patch: {
      status: AgentRunStatus;
      planStepIndex: number;
      tokensUsed: number;
      stopReason?: string | null;
      plan?: AgentPlanStepView[];
    },
  ): void {
    if (!AGENT_RUN_STATUSES.includes(patch.status))
      throw new AppError('AGENT_LOOP_STATUS_INVALID', `未知 run 状态 ${patch.status}`, 'agent.loop', {
        status: patch.status,
      });
    const assignments = ['status = ?', 'plan_step_index = ?', 'tokens_used = ?'];
    const values: (string | number | null)[] = [patch.status, patch.planStepIndex, patch.tokensUsed];
    if (patch.plan !== undefined) {
      assignments.push('plan_json = ?');
      values.push(JSON.stringify(patch.plan));
    }
    if (patch.stopReason !== undefined) {
      assignments.push('stop_reason = ?');
      values.push(patch.stopReason);
    }
    assignments.push('updated_at = ?');
    values.push(Date.now(), runId);
    this.store.db.prepare(`UPDATE agent_run SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 取一次 run 的作用域，内存里没有就从库里重建。
   *
   * 必须能重建：改配置会重建本服务并把 `scopes` 清空（AGENTS.md §9 的 2.5 实测），
   * 那时若只能读内存，界面就得到「有 run 却没有进度」。
   * @param runId 运行 id
   * @returns 与落库进度一致的作用域
   */
  private ensureScope(runId: string): RunScope {
    const existing = this.scopes.get(runId);
    if (existing) return existing;
    const view = this.read(runId);
    const scope: RunScope = {
      runId,
      cursor: view.steps.length > 0 ? Math.max(...view.steps.map((step) => step.planStepIndex)) + 1 : 0,
      plan: view.plan,
      tokensUsed: view.tokensUsed,
      // 两条上限从 run 行取，不取服务的当前配置：那两列记的就是「这条任务自己的额度」。
      stepLimit: view.stepLimit,
      tokenBudget: view.tokenBudget,
      planConfirmed: view.status !== 'proposed',
      controller: new AbortController(),
      // 重建出来的作用域**不带**任何「上一次的重读」：那份读数属于内存里的那一次，
      // 而内存已经跟着服务一起没了（§9 的 2.5 实测）。宁可下一步重新问一次页面，
      // 也不把一份不知道还算不算数的旧快照当成现状（5.5-03 的反面形态）。
      freshRead: null,
      replanUsed: 0,
    };
    this.scopes.set(runId, scope);
    return scope;
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.loop': AgentLoopService;
  }
}
