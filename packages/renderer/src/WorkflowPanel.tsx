import {
  AlertCircle,
  Ban,
  Network,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BridgeReply, WorkflowRunView } from '@auto-cc/shared';
import { ConsentOverlay, ConsentStatusRow } from './ConsentModal';
import { ScheduleSection } from './SchedulePanel';
import { useBridgeAction } from './useBridgeAction';
import { useConsent } from './useConsent';
import { useWorkflowRun } from './useWorkflowRun';
import { Banner, DeskButton } from './ui/controls';
import { NodeEvidenceSection } from './WorkflowEvidence';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowPlansSection } from './WorkflowPlans';
/**
 * 步骤行的配色按状态取，状态本身一律来自主进程返回的 `run.steps`（界面不自己判进度）。
 *
 * 5.10-a 起这份映射与画布节点卡片共用同一个模块：同一个 run 在步骤行是蓝色、在画布上却是别的颜色，
 * 用户就没法把两处对上（AGENTS.md §2.5「功能重复的实现合并到一个入口」）。
 */
import { STEP_STATUS_STYLE } from './stepStatusStyle';

/**
 * 「待接管」叠加态的描边。
 *
 * 用 `ring` 而不是改 `border-*`（spec 2.8-01）：叠加态不是第五种步骤状态——它就是「这一步停住了、
 * 等人来做一次人工动作」，底下的四种状态一个都没变。改 border 会和状态自己的颜色打架（Tailwind
 * 两条 border-color 谁生效取决于样式表顺序），ring 是另一层，永远画得出来。
 */
const TAKEOVER_OVERLAY = 'ring-1 ring-inset ring-amber/70';

/**
 * 工作流面板：`workflow.runner` 的界面镜像（spec 1.10 / 2.4-02）。
 *
 * 这里**没有**任何业务判断：槽位、状态、耗时全部来自主进程返回的 `run`（槽位数就是当前计划的
 * 节点数，换一条计划就换一批格子），进度靠 `workflow/progress` 事件推送（1.10-08）。
 * P2 换成真实的搜 JD / 生成话术 / 打招呼 / 投递时，本组件一行不用改。
 * 接管点（spec 2.1-08 / 2.4-06）也只是把 `run.requiresHuman` 这份**数据**按 `reason` 翻译成一句话：
 * 主进程不再拼中文句子，所以换语言时界面不会漏出中文硬编码。
 *
 * 2.7-e 起「开始工作流」先过 `consent.ensure`（spec 2.7-06 的界面拦截点 ①）：要问哪个平台的签字
 * 不写在界面里，而是从 `runner.nodes()` 的计划参数里数出来——runner 不认识平台，所以节点参数是
 * 唯一能对上事实的源头；数不出平台时放行，交给释放路径上的硬拦（拦截点 ②）。
 *
 * 2.8-a 加了三样，都不新增判定：「中止」调 `runner.abort`（停推进 + 库里记 `USER_ABORT`，读回仍是
 * `paused` + 接管位，见 spec 2.8-03）；「待接管」是画在停住那一格上的叠加态而不是第五种步骤状态
 * （spec 2.8-01）；失败那一格可以展开证据，内容整份来自 `runner.readEvidence`（spec 2.8-04）。
 *
 * 5.4-b 在这里加了计划库（spec 5.4-03 的「挑中它跑」+ 5.4-08 的重命名 / 复制 / 删除）。放在这个面板而不是
 * 诊断页的 `WorkflowLabPanel`，因为那三条判据字面说的都是「面板」，而第二视图才是用户每天看的那一屏。
 * 下拉选中一条计划时先调 `runner.selectPlan(planId)`（plan 裁定七 / 5.10-j）把主进程的当前计划换掉、
 * 成功了才落本地 state；`runner.start(planId)` 那一次实参照旧带着，界面不据此推导任何进度：装载哪条计划、
 * 跑得起来吗，全在服务侧那一次 `resolvePlan` 里定——挑中一条坏计划在起点就被 `INVALID_ARGUMENT` 拒掉，
 * 原话留在提示行，内存态一行都不动。
 */
export function WorkflowPanel() {
  const { t } = useTranslation();
  const { run: current, live, refresh: read } = useWorkflowRun();
  const bridge = window.autoCC;
  /** 下拉里挑中的计划；undefined = 不改动 runner 当前装载的那份（1.10 起的默认路径）。 */
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  /**
   * 算子图是否挂载（5.10-a）。
   *
   * 默认收起：画布要占一块固定高度的视口，而步骤行才是每天看的那一屏。
   * 做成**按需挂载**而不是"画布常驻、只改 display"，是为了让 5.10-11 的判据（离开画布无残留句柄）
   * 真的可测——收起就是卸载，库自己那套 resize/pan 观察者跟着走（plan §7.8.2 裁定一）。
   */
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);

  const { busy, notice, noticeTone, run: call } = useBridgeAction(read);
  const { refresh: refreshConsent, ...consent } = useConsent();
  /**
   * 当前计划要动的平台（从 `runner.nodes()` 的 `params.platform` 里数出来）。
   *
   * 「开始工作流」这一口的拦截点要知道该问哪个平台的签字（spec 2.7-06 ①），而 runner 本身
   * 不认识平台（plan §11.3 第 5 条），所以唯一诚实的事实源就是计划里每个节点自己带的参数。
   * 读不到就是空列表：界面不猜平台名，放行动作后由释放路径上的硬拦（拦截点 ②）说话。
   *
   * 5.4-b 起下拉可以换一条计划，而「这条计划里有哪些平台」要等 `start(planId)` 真把计划装载进来之后
   * 才读得到（`runner.nodes()` 没有按 id 读的那一口，也不该有：那等于让界面预先算一遍服务侧的解析）。
   * 所以这里数出的可能是**上一份**装载的计划——这一处偏旧是有意接受的：它只会让签字询问少问一次，
   * 不会多放行一步，真正拦外发的是释放路径上那道硬拦（它认的是节点当下要动的平台）。
   */
  const [planPlatforms, setPlanPlatforms] = useState<string[]>([]);

  const readPlan = useCallback(async () => {
    const reply = await bridge?.workflow['runner.nodes']();
    if (!reply?.ok) return;
    const platforms = reply.value
      .map((spec) => spec.params['platform'])
      .filter((value): value is string => typeof value === 'string');
    const unique = [...new Set(platforms)];
    setPlanPlatforms(unique);
    await refreshConsent(unique);
  }, [bridge, refreshConsent]);

  useEffect(() => {
    void readPlan();
  }, [readPlan]);

  /**
   * 触发一个 runner 动作。
   *
   * 刻意**不**把接口返回值写进镜像：主进程是在 `start()` 返回之前就把 `step-started` 推出去了，
   * 所以返回值必然比已经收到的事件旧一帧，写回去会让界面闪回「全部待执行」（实测抓到过）。
   * 状态只由事件流与 `useBridgeAction` 收尾的那次重读决定。
   * @param label 动作标签（禁用态凭据 + 提示文案）
   * @param invoke 实际调用
   */
  const act = (label: string, invoke: () => Promise<BridgeReply<WorkflowRunView>> | undefined) =>
    void call(label, invoke, {
      describe: (view) => t('workflow.nowStatus', { status: t(`workflow.status.${view.status}`) }),
    });

  const status = current?.status;
  // idle（挂载后还没跑过）和 done（跑完一轮）都允许再起一次；中间态必须先暂停/重试。
  const canStart = !current || status === 'idle' || status === 'done';
  /** 在途那一拍共用的原因码：六只动作口都靠它挡重复触发。 */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  /**
   * 归属色按「这个动作动到谁」分，一句规则管整屏（plan §5 / §8.3）：
   * `start` 与 `retry` 是这条链上唯二会真的动到平台的口 → `seal`；
   * `pause` / `resume` / `abort` 只改本机那份 run 的状态（含库里那一行 `USER_ABORT`）→ `amber`；
   * `refresh` 什么都不写 → `line`；开合画布是同一批节点的另一种画法 → `solid`。
   * 「中止」看着危险，但它做的是**把外发拦住**，涂朱砂就等于让保护动作与风险动作同一个色。
   */
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`workflow.reason.${code}`);
  const refreshReason = busyReason;
  const startReason = busyReason ?? (canStart ? undefined : 'RUN_IN_FLIGHT');
  const pauseReason = busyReason ?? (status === 'running' ? undefined : 'NOT_RUNNING');
  const resumeReason = busyReason ?? (status === 'paused' ? undefined : 'NOT_PAUSED');
  const canAbort = status === 'running' || status === 'paused';
  const abortReason = busyReason ?? (canAbort ? undefined : 'NO_RUN_TO_ABORT');

  return (
    <section data-testid="workflow-panel" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <WorkflowIcon size={16} />
          {t('workflow.heading')}
        </h2>
        <DeskButton
          action="refresh"
          variant="line"
          compact
          busy={!!busy}
          disabled={refreshReason !== undefined}
          disabledReason={refreshReason}
          disabledReasonLabel={reasonLabel(refreshReason)}
          onClick={() => void read()}
        >
          <RefreshCw size={14} />
          {t('workflow.refresh')}
        </DeskButton>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DeskButton
          action="start"
          variant="seal"
          compact
          busy={!!busy}
          disabled={startReason !== undefined}
          disabledReason={startReason}
          disabledReasonLabel={reasonLabel(startReason)}
          onClick={() =>
            void consent.ensure(planPlatforms, () =>
              act(t('workflow.actionStart'), () => bridge?.workflow['runner.start'](selectedPlanId)),
            )
          }
        >
          <Play size={12} />
          {t('workflow.start')}
        </DeskButton>
        <DeskButton
          action="pause"
          variant="amber"
          compact
          busy={!!busy}
          disabled={pauseReason !== undefined}
          disabledReason={pauseReason}
          disabledReasonLabel={reasonLabel(pauseReason)}
          onClick={() => act(t('workflow.actionPause'), () => bridge?.workflow['runner.pause']())}
        >
          <Pause size={12} />
          {t('workflow.pause')}
        </DeskButton>
        <DeskButton
          action="resume"
          variant="amber"
          compact
          busy={!!busy}
          disabled={resumeReason !== undefined}
          disabledReason={resumeReason}
          disabledReasonLabel={reasonLabel(resumeReason)}
          onClick={() => act(t('workflow.actionResume'), () => bridge?.workflow['runner.resume']())}
        >
          <Play size={12} />
          {t('workflow.resume')}
        </DeskButton>
        <DeskButton
          action="abort"
          variant="amber"
          compact
          busy={!!busy}
          disabled={abortReason !== undefined}
          disabledReason={abortReason}
          disabledReasonLabel={reasonLabel(abortReason)}
          onClick={() => act(t('workflow.actionAbort'), () => bridge?.workflow['runner.abort']())}
        >
          <Ban size={12} />
          {t('workflow.abort')}
        </DeskButton>
        {/* 画布开关放在动作行末尾而不是新起一行：它切换的是同一批节点的另一种画法，不是又一个 runner 动作。 */}
        <DeskButton
          action="canvas-toggle"
          variant="solid"
          compact
          aria-pressed={isCanvasOpen}
          onClick={() => setIsCanvasOpen((open) => !open)}
        >
          <Network size={12} />
          {t(isCanvasOpen ? 'workflow.canvas.close' : 'workflow.canvas.open')}
        </DeskButton>
        {current ? (
          <span className="ml-auto text-[11px] text-slate-500" data-testid="workflow-state">
            {t(`workflow.status.${current.status}`)}
            {' · '}
            <span className="break-all font-mono" data-testid="workflow-run-id">
              {current.runId}
            </span>
          </span>
        ) : null}
      </div>

      <WorkflowPlansSection selectedId={selectedPlanId} onSelect={setSelectedPlanId} />

      {/* 定时任务紧跟计划库（spec 5.7-05）：一条任务就是"这条已保存计划 + 这个时刻"，隔开放要跨面板对计划名。 */}
      <ScheduleSection />

      <ConsentOverlay consent={consent} />
      {planPlatforms.map((platform) => (
        <ConsentStatusRow key={platform} view={consent.views[platform]} />
      ))}

      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'workflow-notice' }} className="mt-2">
          {notice}
        </Banner>
      )}

      {current?.requiresHuman && (
        <Banner
          tone="amber"
          reason={current.requiresHuman.reason}
          markers={{
            testid: 'workflow-takeover',
            'takeover-subject': current.requiresHuman.subject,
            'takeover-reason': current.requiresHuman.reason,
            'takeover-step': current.requiresHuman.stepId,
          }}
          className="mt-2"
        >
          <div className="w-full">
            <p className="font-semibold">{t('workflow.takeoverTitle')}</p>
            <p className="mt-1 break-all">
              {/* 接管原因有会话类与节点类两种，句子形状不同，所以按 reason 取条目而不是拼一句通用模板。 */}
              {t(`workflow.takeoverBody.${current.requiresHuman.reason}`, {
                subject: current.requiresHuman.subject,
                step: t(`workflow.step.${current.requiresHuman.stepId}`, current.requiresHuman.stepId),
              })}
            </p>
          </div>
        </Banner>
      )}

      {live?.message && (
        <p className="mt-2 text-[11px] text-slate-400" data-testid="workflow-live">
          {t('workflow.live', { message: live.message })}
        </p>
      )}

      {current ? (
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="workflow-steps">
          {current.steps.map((step, index) => {
            /** 这一步是不是那个「run 级待接管」的落点：只有停住的那一步该被描出来，别的格子不加戏。 */
            const isTakeoverStep = current.requiresHuman?.stepId === step.id;
            /**
             * 这一步是不是**刚刚被人接管过**（spec 2.8-11）：接管横幅在续跑那一刻就消失了，
             * 没有这枚角标的话「谁处理过」在界面上查不到任何痕迹。还在等的时候不叠着画，两者互斥。
             */
            const isHandledStep = !isTakeoverStep && current.takeoverHandled?.stepId === step.id;
            return (
              <li
                key={step.id}
                data-step-id={step.id}
                data-step-status={step.status}
                data-step-takeover={isTakeoverStep ? 'true' : undefined}
                data-step-takeover-handled={isHandledStep ? (current.takeoverHandled?.reason ?? 'true') : undefined}
                className={`rounded-lg border px-3 py-2 text-[11px] ${STEP_STATUS_STYLE[step.status]} ${isTakeoverStep ? TAKEOVER_OVERLAY : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="break-all">
                    {/* 序号跟着这一行的字号（11px），不单独放大：整行是元信息档（slate-500 只过 3:1），
                        一到 12px 就落进正文的 4.5 门槛，同一个数字在两档之间会假失守（spec 6.1-06）。 */}
                    <span className="font-mono">{String(index + 1)}</span>
                    {' · '}
                    {/* 节点 id 是计划数据（外部输入）：语言包缺条目时退回显示 id 本身，而不是漏出 `workflow.step.xxx` 这种键名。 */}
                    {t(`workflow.step.${step.id}`, step.id)}
                    {step.error ? (
                      <span
                        className="ml-1 inline-flex items-center gap-1 break-all text-seal"
                        data-step-error={step.error}
                      >
                        <AlertCircle size={12} />
                        {step.error}
                      </span>
                    ) : null}
                    {isTakeoverStep ? (
                      <span
                        className="ml-1 inline-flex items-center gap-1 text-amber"
                        data-testid="workflow-step-takeover-badge"
                      >
                        <ShieldAlert size={12} />
                        {t('workflow.takeoverTitle')}
                      </span>
                    ) : null}
                    {isHandledStep ? (
                      <span
                        className="ml-1 inline-flex items-center gap-1 text-jade"
                        data-testid="workflow-step-takeover-handled"
                      >
                        <ShieldCheck size={12} />
                        {t('workflow.takeoverHandled')}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {step.durationMs !== null ? (
                      <span data-step-duration={String(step.durationMs)}>
                        {t('workflow.duration', { ms: step.durationMs })}
                      </span>
                    ) : null}
                    <span>{t(`workflow.stepStatus.${step.status}`)}</span>
                    {/* 两种「停在这一步」都要能从这一步出去：普通失败，以及挂着接管点的暂停
                        （spec 2.4-06 的未观察外发只有从这里走，否则用户在界面上只剩重新开跑一条路）。 */}
                    {step.status === 'failed' || isTakeoverStep ? (
                      <DeskButton
                        action="retry"
                        markers={{ step: step.id }}
                        variant="seal"
                        compact
                        busy={!!busy}
                        disabled={busyReason !== undefined}
                        disabledReason={busyReason}
                        disabledReasonLabel={reasonLabel(busyReason)}
                        onClick={() =>
                          act(t('workflow.actionRetry', { step: t(`workflow.step.${step.id}`, step.id) }), () =>
                            bridge?.workflow['runner.retryStep'](step.id),
                          )
                        }
                      >
                        <RotateCw size={12} />
                        {t('workflow.retry')}
                      </DeskButton>
                    ) : null}
                  </span>
                </div>
                {/* 失败证据是「这一步为什么停」的真相，只在真的失败过的那一格按需读一次（spec 2.8-04）。 */}
                {step.status === 'failed' ? <NodeEvidenceSection runId={current.runId} nodeId={step.id} /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-[11px] text-slate-500" data-testid="workflow-loading">
          {t('workflow.loading')}
        </p>
      )}

      {/* 按需挂载（裁定一）：收起就是卸载，画布那套 resize/pan 观察者跟着一起走，不留残留句柄。
          运行态数据仍取 current.steps——画布是同一份运行读数的第二种画法，不是第二个状态源。
          5.10-c 起放开「没有 run 也要能开画布」：摆算子、填参数是编辑态的事，不该等一次执行。 */}
      {isCanvasOpen ? (
        <WorkflowCanvas
          steps={current?.steps ?? []}
          planId={selectedPlanId}
          // 5.10-11 的运行时只读：判据在父层（它握着 run 状态），画布不自己去问 runner
          isReadOnly={status === 'running' || status === 'paused'}
        />
      ) : null}
    </section>
  );
}
