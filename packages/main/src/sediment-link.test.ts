/**
 * 对话 → 工作流沉淀的**跨包真链路**（spec 5.4-01 / 03 / 05 / 06 / 09 的运行半边）。
 *
 * 为什么这条住在 `packages/main`（与 5.3-11 / 4.4-09 同一理由）：判据是「一次跑通的对话，经
 * `agent.sediment` 投影、经 `workflow.runner.savePlan` 这个唯一写入口落库，再被面板按 id 挑中起跑」，
 * 而 `agent` 包 import 不到 `workflow`（AGENTS.md §4.1 禁止同级横向引用）。在 agent 包里只能拿替身
 * 演一遍「存下来了」，而替身既不建表也不认执行器，那条断言是空的（plan §5.3-d 的同一条判据）。
 *
 * 真身：`agent.loop`（含 5.2 的落库与 5.3 的判定口）、`agent.sediment`、`workflow.store`、
 * `workflow.executors`、`workflow.runner`。替身只有两只假工具与它们对应的假执行器——
 * 于是 5.4-03 的「与 2.4 节点模型同构」是被**真 runner 真跑过一次**证明的，不是被注释证明的
 * （2.4-08 的「mock 适配器跑完整条链」在此复用）。全程不出网、不碰真实招聘平台（§7.2）；
 * 模型腿是 5.2 那台桩（输入即脚本），所以这里没有任何真机调用。
 *
 * 档位是 `auto` 而**没有**把假工具加进免确认名单：带条款的那只声明自己是 `outbound` 级，
 * 所以判定口照旧开一张确认单，由本测试扮人按下「批准」（与 5.3-11 的 `watchPauses` 同一手法）。
 * 沉淀判的不是闸门，但也没有为此把闸门调松——那条 run 是带着真实的批准痕迹跑出来的。
 *
 * 沉淀出的节点参数取自 `agent_run.plan_json` 里那一步的**草案入参**（plan §5.4-a 如实条 ⑤）：
 * 人在确认卡上补过的值只活在 `observation` 文本里，结构上取不到，所以断言里对的是草案那份。
 */
import {
  asApp,
  Context,
  toolResult,
  type AgentRunView,
  type Fiber,
  type SavedWorkflowPlanView,
  type SedimentPreviewView,
  type WorkflowNodeExecutor,
  type WorkflowNodeInvocation,
} from '@auto-cc/core';
import {
  AgentLoopService,
  AgentPauseService,
  AgentPolicyService,
  AgentSedimentService,
  AgentToolsService,
  ChatSessionService,
  agentLoopSchema,
  agentPauseSchema,
  chatConfigSchema,
  type AgentTool,
} from '@auto-cc/plugin-agent';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import {
  WorkflowExecutorRegistryService,
  WorkflowRunnerService,
  WorkflowRunStoreService,
  workflowConfigSchema,
} from '@auto-cc/plugin-workflow';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/** 假工具与假执行器共用的名字（一处给全，避免条款与登记各说一份）。 */
const TOOL_ID = 'demo.greet';

/** 这只工具沉淀出去的那个节点 kind（面板那边只认登记处里有的名字）。 */
const NODE_KIND = 'demo.greeting';

/** 第二只「有手但没有节点」的工具：它的产物是给用户读的，没有可跑的对应节点。 */
const READ_ONLY_TOOL_ID = 'demo.readonly';

/** 一次假执行的调用清单条目。 */
type ExecutorCall = { nodeId: string; kind: string; params: Record<string, unknown>; target: string };

/** workflow 那一侧挂到哪一层（见 `boot` 的 `workflow` 参数）。 */
type WorkflowMount = 'full' | 'registry-only' | 'none';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 清理，产物不进仓库，§7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-sediment-link-'));
  sandboxes.push(dir);
  return dir;
}

/** 两只假工具共用的入参：沉淀条款按 `request.*` 的点路径从这份草案里取值。 */
const DEMO_INPUT = z.strictObject({
  request: z.strictObject({ platform: z.string(), jobId: z.string(), text: z.string() }),
});

/**
 * 造一只假工具。
 *
 * 带条款的那只按它真正做的事声明自己（`outbound` + 每次要批准），不为了省一张确认单把副作用级写成
 * `read`——那会让"沉淀来的那段对话是真跑通过的"这句话打折。
 * @param calls 副作用清单（每次真被调用追加一条）
 * @param id 工具 id
 * @param withClause 是否带沉淀条款（false 演「这只手没有可跑的对应节点」，它也就只是一次读取）
 * @returns 可直接 `register` 的工具声明
 */
function makeDemoTool(calls: ExecutorCall[], id: string, withClause: boolean): AgentTool<z.output<typeof DEMO_INPUT>> {
  return {
    id,
    titleKey: 'agent.tool.labels.demoGreet',
    description: '假的外发手（只记清单，不出网）',
    input: DEMO_INPUT,
    effect: withClause ? 'outbound' : 'read',
    requiresConfirmation: withClause,
    ...(withClause
      ? {
          workflow: {
            kind: NODE_KIND,
            target: 'request.jobId',
            params: { platform: 'request.platform', job: 'request.jobId', text: 'request.text' },
          },
        }
      : {}),
    run: ({ request }) => {
      calls.push({ nodeId: 'tool', kind: id, params: { ...request }, target: request.jobId });
      return Promise.resolve(
        toolResult(
          { sent: true },
          { summary: `已向 ${request.jobId} 发出`, evidenceRefs: [`fixture:${request.jobId}`] },
        ),
      );
    },
  };
}

/**
 * 装到「对话能跑 + 计划能存能跑」为止。
 * @param workflow workflow 那一侧挂到哪一层：
 *        `full` 挂 store + executors + runner（沉淀能存、存下来的能跑）；
 *        `registry-only` 只挂 store + executors，**摘掉 runner**（演「有节点实现、没有计划存储口」，
 *        装配面板可以单个摘插件，这就是那条路）；
 *        `none` 全摘（演「工作流域整个不在」，此时投影第一道就拒在 kind 未登记）
 * @returns 上下文、`agent.sediment`、`agent.loop`、`workflow.runner`（未挂为 null）、
 *          `workflow.store`（未挂为 null）、裸连接、假执行器的调用清单
 */
async function boot(workflow: WorkflowMount = 'full') {
  const dir = tempDir();
  const ctx = new Context();
  /** 挂一个插件并把 fiber 记进收尾清单。 */
  const mount = async (fiber: Fiber | PromiseLike<Fiber>): Promise<void> => {
    fibers.push(await fiber);
  };
  await mount(ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  await mount(ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  await mount(ctx.plugin(AgentToolsService, {}));
  await mount(ctx.plugin(ChatSessionService, chatConfigSchema.parse({})));
  await mount(ctx.plugin(AgentPolicyService, {}));
  await mount(ctx.plugin(AgentPauseService, agentPauseSchema.parse({})));
  await mount(ctx.plugin(AgentLoopService, agentLoopSchema.parse({})));
  await mount(ctx.plugin(AgentSedimentService, {}));

  const app = asApp(ctx);
  /** 工具被调的清单（对话侧那一步有没有真出手，看它）。 */
  const toolCalls: ExecutorCall[] = [];
  /** 假执行器被调的清单（沉淀出来的计划有没有真跑，看它）。 */
  const nodeCalls: ExecutorCall[] = [];
  app['agent.tools'].register(makeDemoTool(toolCalls, TOOL_ID, true));
  app['agent.tools'].register(makeDemoTool(toolCalls, READ_ONLY_TOOL_ID, false));
  // 档位由测试扮演人显式改（`setAutonomy` 是那条唯一写入口并留审计）：默认最保守档下每一步都被拒，
  // 而本片要沉淀的是一段**真跑通过**的对话。
  app['chat.session'].setAutonomy('auto');
  // 人那一只手仍然在链路末端：`outbound` 那一步由判定口开确认单，这里经真应答口按下批准，
  // 不去改名单也不绕闸门（5.3 的三闸门在 5.3-11 已经判过，这里只演「人批了这一次」）。
  ctx.on('agent/pause-requested', (event) => {
    app['agent.pause'].respond(event.requestId, { decision: 'approve' });
  });

  if (workflow !== 'none') {
    await mount(ctx.plugin(WorkflowRunStoreService, {}));
    await mount(ctx.plugin(WorkflowExecutorRegistryService, {}));
    // 假执行器：登记处存在的意义就是让 runner 不认识平台包，所以这里能跑通本身就是同构的证据。
    const executor: WorkflowNodeExecutor = (invocation: WorkflowNodeInvocation) => {
      nodeCalls.push({
        nodeId: invocation.spec.id,
        kind: invocation.spec.kind,
        params: { ...invocation.spec.params },
        target: invocation.spec.target,
      });
      return Promise.resolve();
    };
    app['workflow.executors'].register(NODE_KIND, executor);
    if (workflow === 'full') {
      await mount(
        ctx.plugin(WorkflowRunnerService, workflowConfigSchema.parse({ retryBackoffMs: 0, retryBackoffCapMs: 0 })),
      );
    }
  }
  return {
    ctx,
    sediment: app['agent.sediment'],
    loop: app['agent.loop'],
    runner: workflow === 'full' ? app['workflow.runner'] : null,
    runs: workflow === 'none' ? null : app['workflow.store'],
    db: app.store.db,
    nodeCalls,
  };
}

/**
 * 起草并跑完一次「给某个岗位打招呼」的对话任务。
 * @param handles `boot` 的返回
 * @param jobId 岗位 id（同时是沉淀出来那格的 `target`）
 * @param toolId 点名的工具（默认那只带条款的）
 * @returns 跑完之后的 run 读数
 */
async function runConversation(
  handles: Awaited<ReturnType<typeof boot>>,
  jobId: string,
  toolId = TOOL_ID,
): Promise<AgentRunView> {
  const goal = `${toolId} ${JSON.stringify({ request: { platform: 'boss', jobId, text: `您好，关于 ${jobId} 想聊聊` } })}`;
  const proposed = await handles.loop.propose(goal);
  return handles.loop.confirm(proposed.runId);
}

/**
 * 轮询等条件成立（runner 的 `start()` 是同步起、异步跑，所以「跑完了」只能等）。
 * @param predicate 每 5ms 调一次
 * @param timeoutMs 上限（毫秒），到点抛错而不是静默返回，避免测试假通过
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('5.4-01 / 09 一次跑通的对话存成一条计划（真投影 + 真落库）', () => {
  it('预览说能沉淀 → 保存真写出 `workflow_plans` 一行，并带回来时的 runId', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9101');
    expect(finished.steps.map((step) => step.status)).toEqual(['ok']);

    const preview: SedimentPreviewView = handles.sediment.preview(finished.runId);
    // 格子数 == `agent_step` 行数：5.4-09 的「一步对一格」在真读数上的样子。
    expect(preview.steps).toHaveLength(finished.steps.length);
    expect(preview.canSediment).toBe(true);

    const saved: SavedWorkflowPlanView = handles.sediment.save(finished.runId, '  给 boss 打招呼  ');
    expect(saved).toMatchObject({ name: '给 boss 打招呼', sourceRunId: finished.runId, nodeCount: 1 });
    // 指纹是 `buildPlan` 现算的那一份：沉淀侧传过去的值一律不信（2.4 的 `plan.ts` 口径）。
    expect(saved.fingerprint).toMatch(/^[0-9a-f]{8}$/);

    const row = handles.db.prepare('SELECT * FROM workflow_plans WHERE id = ?').get(saved.id) as {
      name: string;
      plan_json: string;
      source_run_id: string;
    };
    expect(row.name).toBe('给 boss 打招呼');
    expect(row.source_run_id).toBe(finished.runId);
    // 库里存的节点表与预览算出来的逐字相同（中间没有人再改一遍）。
    expect(JSON.parse(row.plan_json) as { nodes: { id: string; kind: string; target: string }[] }).toMatchObject({
      nodes: [{ id: 'node-1', kind: NODE_KIND, target: 'job-9101' }],
    });
  });

  it('面板的计划下拉里就有它，且自定义排在内置前面（能选的就是能跑的）', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9102');
    const saved = handles.sediment.save(finished.runId, '下拉里的新面孔');
    const options = handles.runner?.plans() ?? [];
    expect(options[0]).toMatchObject({ id: saved.id, name: '下拉里的新面孔', source: 'custom', nodeCount: 1 });
    expect(options.filter((option) => option.source === 'builtin').length).toBeGreaterThan(0);
    // 每次现读表：第二次调用不是同一批对象（服务里没有那份内存镜像，§9 的 2.5 实测条）。
    expect(handles.runner?.plans()[0]).not.toBe(options[0]);
  });

  it('有失败步的那段对话不能沉淀，且库里一行都不写', async () => {
    const handles = await boot();
    // 演一个失败步：直接往库里那一步改状态，比造一只真会抛的工具更贴近 5.4-02 要判的那一幕
    //（真抛那一条由 5.2 的用例判，这里要的是「含失败步即整段拒」）。
    const finished = await runConversation(handles, 'job-9103');
    handles.db.prepare('UPDATE agent_step SET status = ? WHERE run_id = ?').run('failed', finished.runId);

    const preview = handles.sediment.preview(finished.runId);
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain('failed');
    expect(() => handles.sediment.save(finished.runId, '不该存在的计划')).toThrowError(/还不能沉淀成工作流/);
    expect(handles.runner?.plans().filter((option) => option.name === '不该存在的计划')).toEqual([]);
  });

  it('工具没有对应节点时拒得点名它，而不是猜一个 kind（5.4-09 的反向半边）', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9104', READ_ONLY_TOOL_ID);
    const preview = handles.sediment.preview(finished.runId);
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain(READ_ONLY_TOOL_ID);
    expect(preview.steps[0]?.node).toBeNull();
  });
});

describe('5.4-03 沉淀出的计划面板可直接运行（真 runner 跑一遍）', () => {
  it('按新 id 起 run：格子来自沉淀那份快照，参数逐字递给执行器', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9201');
    const saved = handles.sediment.save(finished.runId, '跑一遍给它看');

    const run = handles.runner?.start(saved.id);
    expect(run?.steps.map((step) => step.id)).toEqual(['node-1']);
    await waitFor(() => handles.runner?.current().status === 'done');
    // 执行器真被调了一次，且拿到的就是沉淀时那份参数——不是内置计划里的任何常量。
    expect(handles.nodeCalls).toEqual([
      {
        nodeId: 'node-1',
        kind: NODE_KIND,
        target: 'job-9201',
        params: { platform: 'boss', job: 'job-9201', text: '您好，关于 job-9201 想聊聊' },
      },
    ]);
    const state = handles.runs?.state(run?.runId ?? '');
    expect(state).toMatchObject({ planFingerprint: saved.fingerprint, totalNodes: 1 });
    expect(state?.nodes[0]).toMatchObject({ nodeId: 'node-1', kind: NODE_KIND, status: 'done', attempts: 1 });
  });

  it('内置计划与沉淀计划在同一台 runner 上换着跑，互不污染对方的快照', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9202');
    const saved = handles.sediment.save(finished.runId, '换着跑的那条');
    const customRun = handles.runner?.start(saved.id);
    await waitFor(() => handles.runner?.current().status === 'done');

    // 切回内置那条：内置 `boss-basic` 的 `jd.capture` 没有登记执行器，所以起跑前就被闸门拒掉——
    // 这正好证明「按哪个计划跑」这件事在切（拒的是那条计划的节点，不是上一份的）。
    expect(() => handles.runner?.start('boss-basic')).toThrowError(/没有登记/);
    expect(handles.runner?.current().runId).toBe(customRun?.runId);
    expect(handles.nodeCalls.map((call) => call.nodeId)).toEqual(['node-1']);
    expect(saved.nodeCount).toBe(1);
  });
});

describe('5.4-05 名字校验只有服务那一道（界面前拦不拦都不算数）', () => {
  it('空名 / 全空格 / 超长 / 非法字符都被拒，并且库里没有任何新行', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9301');
    const before = handles.runner?.plans().length ?? 0;
    for (const bad of ['', '   ', '字'.repeat(41), '<script>', 'a/b']) {
      expect(() => handles.sediment.save(finished.runId, bad)).toThrowError(/工作流名称/);
    }
    expect(handles.runner?.plans().length).toBe(before);
  });

  it('同一段对话存两次是两条计划，不是覆盖（各自新 id、同一指纹）', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9302');
    const first = handles.sediment.save(finished.runId, '同一个来源第一次');
    const second = handles.sediment.save(finished.runId, '同一个来源第二次');
    expect(second.id).not.toBe(first.id);
    // 指纹是"哪份计划文本"的身份，两条同内容的计划指纹相同是**对的**（各存一份 `plan_json` 才分得开）。
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(handles.runner?.plans().filter((option) => option.source === 'custom')).toHaveLength(2);
  });
});

describe('5.4-06 历史 run 带着自己的计划快照（改名与删除都不回头改它）', () => {
  it('沉淀 → 跑一次 → 改名 + 删计划 → 那次 run 的格子与指纹原样读回', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9401');
    const saved = handles.sediment.save(finished.runId, '会被改名的那条');
    const run = handles.runner?.start(saved.id);
    await waitFor(() => handles.runner?.current().status === 'done');
    const runId = run?.runId ?? '';
    const before = handles.runs?.state(runId);

    handles.runner?.renamePlan(saved.id, '改过名字的那条');
    expect(handles.runner?.removePlan(saved.id)).toBe(true);
    expect(handles.runner?.plans().some((option) => option.id === saved.id)).toBe(false);

    // 进度与快照都不受列表那一行的影响：删的是条目，不是那次会话跑过的东西。
    const after = handles.runs?.state(runId);
    expect(after).toEqual(before);
    expect(after?.planFingerprint).toBe(saved.fingerprint);
    expect(handles.runs?.planSnapshot(runId)?.nodes.map((node) => node.id)).toEqual(['node-1']);
  });

  it('复制出来的副本与源头各存一份 `plan_json`，删掉源头不影响副本被选中', async () => {
    const handles = await boot();
    const finished = await runConversation(handles, 'job-9402');
    const source = handles.sediment.save(finished.runId, '源头');
    const copy = handles.runner?.duplicatePlan(source.id, '副本');
    expect(copy).toMatchObject({ fingerprint: source.fingerprint, nodeCount: 1 });
    expect(copy?.id).not.toBe(source.id);
    expect(handles.runner?.removePlan(source.id)).toBe(true);
    // 副本仍然挑得起来（它带的是自己那份正文，不是对源头的一行引用）。
    const run = handles.runner?.start(copy?.id ?? '');
    await waitFor(() => handles.runner?.current().status === 'done');
    expect(run?.steps).toHaveLength(1);
  });
});

describe('摘掉 workflow 时对话侧仍然能用（唯一存储口与它的缺席）', () => {
  it('只摘掉 `workflow.runner`：预览说得出「能沉淀」，保存以 SERVICE_NOT_FOUND 结构化失败且不静默丢弃', async () => {
    // 这一层才是「没有存储口」那一幕：执行器与库都还在，所以投影挑不出毛病，缺的只有写入口。
    const handles = await boot('registry-only');
    const finished = await runConversation(handles, 'job-9501');
    expect(handles.sediment.preview(finished.runId).canSediment).toBe(true);
    expect(() => handles.sediment.save(finished.runId, '存不了的那条')).toThrowError(/工作流没挂载/);
    // 失败得彻底，但也仅此而已：库里没有半条计划，那条对话照旧读得回来。
    expect(handles.runs?.listPlans()).toEqual([]);
    expect(handles.loop.read(finished.runId).steps).toHaveLength(1);
  });

  it('整个工作流域都不在：投影第一道就拒在 kind 未登记，而不是「存失败了」', async () => {
    const handles = await boot('none');
    const finished = await runConversation(handles, 'job-9502');
    const preview = handles.sediment.preview(finished.runId);
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain('没登记');
    expect(() => handles.sediment.save(finished.runId, '存不了的那条')).toThrowError(/还不能沉淀成工作流/);
    expect(handles.loop.read(finished.runId).steps).toHaveLength(1);
  });
});
