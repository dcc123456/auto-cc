/**
 * 计划库：下拉挑中要跑的那条，加上重命名 / 复制 / 删除三手（spec 5.4-03 的挑中口 + 5.4-08 的管理口）。
 *
 * 列表每次现读（`workflow.runner.plans` 在服务侧就是「现查表 + 现 parse」，界面这层再不缓存一份，
 * 就成了 §9 的 2.5 实测里那种「改一处、另一处静默变空」的第二份事实）。
 * 名字校验**不在这里**做第二道：空名 / 超长 / 非法字符由 `workflow_plans` 那唯一一处拒，
 * 拒下来的原话写进提示行留在界面上，截图才拿得到证据；这里只把「哪一行正在编辑」这份属于手的状态收着。
 * 删除的二次确认做成行内确认态而不是弹层：与 app 里其余确认口径一致（§5.10 的独立组件、不另起一套弹窗）。
 */
import { Check, Copy, Layers, Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BridgeReply, WorkflowPlanOptionView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';
import { Banner, DeskButton, DeskField, DeskSelect } from './ui/controls';

/** 一行的编辑态：`rename` / `duplicate` 带名字草稿，`remove` 只等一次确认。 */
type PlanEdit = { planId: string; mode: 'rename' | 'duplicate' | 'remove'; draft: string };

/**
 * 计划库区块。
 * @param selectedId 下拉里挑中的计划 id；undefined = 不改动 runner 当前装载的那份
 * @param onSelect 挑中另一条（或删除了正在挑的那条后要清空指针）
 * @returns 画在工作流面板里的计划库一节
 */
export function WorkflowPlansSection({
  selectedId,
  onSelect,
}: {
  selectedId: string | undefined;
  onSelect: (planId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<WorkflowPlanOptionView[]>([]);
  const [edit, setEdit] = useState<PlanEdit>();
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const reply = await bridge?.workflow['runner.plans']();
    if (reply?.ok) setPlans(reply.value);
  }, [bridge]);

  const { busy, notice, noticeTone, run: call } = useBridgeAction(read);
  /** 在途那一拍：这一节里六只手都靠它挡重复触发（改名与复制还会叠一条空名判据）。 */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`workflow.plans.reason.${code}`);

  useEffect(() => {
    void read();
  }, [read]);

  /**
   * 计划库被写过就重读（5.4-01 的「存成后计划库出现新条目」）。
   *
   * 为什么不能只靠挂载时那一次读：两个视图都留在 DOM 里（对话侧存成计划时工作流面板并未卸载），
   * 而写入发生在 `workflow.runner` 那唯一入口上、界面这边不经手。订阅事件后现查表，
   * 界面不存第二份事实（AGENTS.md §2.7 / §9 的 2.5 实测条）。
   */
  useEffect(() => {
    if (!bridge) return;
    return bridge.on('workflow/plans-changed', () => {
      void read();
    });
  }, [bridge, read]);

  /**
   * 跑一次计划管理动作，跑完收起这一行的编辑态。
   *
   * 收起发生在动作之后而不是之前：失败时草稿要留着让人改（名字被拒的那一句原话就在提示行里），
   * 但成功之后留着会让草稿指向一条已经改过名/已经删掉的计划。
   * @param label 动作标签（禁用态凭据）
   * @param invoke 白名单调用
   * @param describe 成功文案——返回值是 null / false 时说的是「那条已经不在了」，不是「成功」
   * @param planId 这一行对应的计划（删掉了挑中那条时要顺手把指针交回父组件）
   */
  const runPlanAction = async <T,>(
    label: string,
    invoke: () => Promise<BridgeReply<T>> | undefined,
    describe: (value: T) => string,
    planId?: string,
  ): Promise<void> => {
    await call(label, invoke, { describe });
    if (planId && selectedId === planId) onSelect(undefined);
    setEdit(undefined);
  };

  /**
   * 选中一条计划：先让主进程认它，**成功了才**把本地指针指过去（plan 裁定七第 3 条）。
   *
   * 顺序反过来会长出"下拉显示的是 B、主进程当前计划还是 A"这种第二状态源，而实验台那颗
   * 「从库里那次中断续跑」读的正是服务侧那一份（它比的指纹来自 `resumable()`）。
   * 选不中（计划已不在、有 run 正停在中途、`kind` 没人登记）时本地指针不动，拒因原话留在提示行。
   *
   * 回到默认那一格（空值）**不**调主进程：它的语义是"这一次 `start` 不传 id"，不是"把当前计划
   * 换回配置值"——服务侧没有"换回去"的入口，改配置会重建下游（AGENTS.md §9 的 2.5 实测条）。
   * @param planId 下拉里的原始值，空串表示默认那一格
   */
  const pickPlan = async (planId: string): Promise<void> => {
    if (planId === '') {
      onSelect(undefined);
      return;
    }
    await call(t('workflow.plans.actionSelect', { planId }), () => bridge?.workflow['runner.selectPlan'](planId), {
      apply: () => onSelect(planId),
      describe: (view) => t('workflow.plans.selected', { planId: view.planId, fingerprint: view.fingerprint }),
    });
  };

  /**
   * 起一个行内编辑态。
   * @param plan 目标计划行
   * @param mode 编辑种类
   */
  const startEdit = (plan: WorkflowPlanOptionView, mode: PlanEdit['mode']): void => {
    setEdit({ planId: plan.id, mode, draft: mode === 'duplicate' ? `${plan.name} 2` : plan.name });
  };

  /**
   * 存下名字那一格的草稿：改名与复制走的是同一份草稿 UI，但落到两只不同的口。
   * @param plan 目标计划行
   * @param draft 名字草稿原值（校验在主进程那一道）
   */
  const saveName = (plan: WorkflowPlanOptionView, draft: string): void => {
    if (edit?.mode === 'rename') {
      void runPlanAction(
        t('workflow.plans.actionRename', { name: plan.name, next: draft }),
        () => bridge?.workflow['runner.renamePlan'](plan.id, draft),
        (view) => (view ? t('workflow.plans.renamed', { name: view.name }) : t('workflow.plans.alreadyGone')),
      );
      return;
    }
    void runPlanAction(
      t('workflow.plans.actionDuplicate', { name: plan.name, next: draft }),
      () => bridge?.workflow['runner.duplicatePlan'](plan.id, draft),
      (view) => (view ? t('workflow.plans.duplicated', { name: view.name }) : t('workflow.plans.alreadyGone')),
    );
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-ink-950/40 px-3 py-2" data-testid="workflow-plans">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
        <Layers size={13} />
        {t('workflow.plans.heading')}
      </h3>

      <label className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-slate-400">{t('workflow.plans.selectLabel')}</span>
        <DeskSelect
          action="workflow-plan-select"
          data-testid="workflow-plan-select"
          data-selected-plan={selectedId ?? ''}
          value={selectedId ?? ''}
          disabled={busyReason !== undefined}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onValueChange={(value) => void pickPlan(value)}
        >
          <option value="">{t('workflow.plans.selectDefault')}</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {t('workflow.plans.option', {
                name: plan.name,
                source: t(plan.source === 'custom' ? 'workflow.plans.sourceCustom' : 'workflow.plans.sourceBuiltin'),
                count: plan.nodeCount,
              })}
            </option>
          ))}
        </DeskSelect>
      </label>

      {plans.length === 0 ? (
        <p className="mt-1 text-[10px] text-slate-500" data-testid="workflow-plans-empty">
          {t('workflow.plans.empty')}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1" data-testid="workflow-plans-list">
          {plans.map((plan) => {
            const isEditing = edit?.planId === plan.id;
            /** 名字空着的时候保存键按不动：计划名要在库里落一行，空名等于落一条读不出来的记录。 */
            const nameReason =
              edit !== undefined && edit.planId === plan.id && edit.draft.trim().length === 0
                ? 'NAME_EMPTY'
                : busyReason;
            return (
              <li
                key={plan.id}
                data-plan-id={plan.id}
                data-plan-source={plan.source}
                data-plan-edit={isEditing ? edit?.mode : ''}
                className="flex flex-col gap-1 rounded-md border border-line px-2 py-1 text-[11px]"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-slate-200">{plan.name}</span>
                  <span className="text-slate-500">
                    {t(plan.source === 'custom' ? 'workflow.plans.sourceCustom' : 'workflow.plans.sourceBuiltin')}
                  </span>
                  <span className="text-slate-500">{t('workflow.plans.nodes', { count: plan.nodeCount })}</span>
                  {plan.source === 'builtin' ? (
                    <span className="text-slate-500" data-plan-readonly="true">
                      {t('workflow.plans.builtinReadonly')}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1">
                    {plan.source === 'custom' ? (
                      <>
                        <DeskButton
                          action="plan-rename"
                          markers={{ 'plan-id': plan.id }}
                          variant="solid"
                          compact
                          busy={!!busy}
                          disabled={busyReason !== undefined}
                          disabledReason={busyReason}
                          disabledReasonLabel={reasonLabel(busyReason)}
                          onClick={() => startEdit(plan, 'rename')}
                        >
                          <Pencil size={10} />
                          {t('workflow.plans.rename')}
                        </DeskButton>
                        {/* 删除的**入口**不涂朱砂：它只是把这一行换成确认态，什么都没删。
                            涂色给那只真正落刀的「确认删除」——08 稿的「入口轻、落刀重」。 */}
                        <DeskButton
                          action="plan-remove"
                          markers={{ 'plan-id': plan.id }}
                          variant="line"
                          compact
                          busy={!!busy}
                          disabled={busyReason !== undefined}
                          disabledReason={busyReason}
                          disabledReasonLabel={reasonLabel(busyReason)}
                          onClick={() => startEdit(plan, 'remove')}
                        >
                          <Trash2 size={10} />
                          {t('workflow.plans.remove')}
                        </DeskButton>
                      </>
                    ) : null}
                    <DeskButton
                      action="plan-duplicate"
                      markers={{ 'plan-id': plan.id }}
                      variant="solid"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() => startEdit(plan, 'duplicate')}
                    >
                      <Copy size={10} />
                      {t('workflow.plans.duplicate')}
                    </DeskButton>
                  </span>
                </span>

                {isEditing && edit && edit.mode !== 'remove' ? (
                  <span className="flex flex-wrap items-center gap-1" data-testid="workflow-plan-name-editor">
                    <DeskField
                      action="plan-name-input"
                      data-testid="workflow-plan-name-input"
                      data-plan-edit-mode={edit.mode}
                      value={edit.draft}
                      onValueChange={(value) => setEdit({ ...edit, draft: value })}
                      placeholder={t('workflow.plans.namePlaceholder')}
                      className="min-w-32"
                    />
                    {/* 落名那一下写的是计划表 → amber（本机写入）。旧写法涂 emerald，那是 jade 族
                        「已经核过」的颜色，一个还没落笔的保存键不该自称已核（与知识库「保存」同一处纠偏）。 */}
                    <DeskButton
                      action={edit.mode === 'rename' ? 'plan-rename-save' : 'plan-duplicate-save'}
                      variant="amber"
                      compact
                      busy={!!busy}
                      disabled={nameReason !== undefined}
                      disabledReason={nameReason}
                      disabledReasonLabel={reasonLabel(nameReason)}
                      onClick={() => saveName(plan, edit.draft)}
                    >
                      <Check size={10} />
                      {t('workflow.plans.save')}
                    </DeskButton>
                    <DeskButton action="plan-edit-cancel" variant="ghost" compact onClick={() => setEdit(undefined)}>
                      <X size={10} />
                      {t('workflow.plans.cancel')}
                    </DeskButton>
                  </span>
                ) : null}

                {isEditing && edit?.mode === 'remove' ? (
                  <span className="flex flex-wrap items-center gap-1" data-testid="workflow-plan-remove-confirm">
                    <span className="break-all text-amber">
                      {t('workflow.plans.confirmRemove', { name: plan.name })}
                    </span>
                    <span className="break-all text-[10px] text-slate-500">
                      {t('workflow.plans.confirmRemoveHint')}
                    </span>
                    <DeskButton
                      action="plan-remove-confirm"
                      markers={{ 'plan-id': plan.id }}
                      variant="seal"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() =>
                        void runPlanAction(
                          t('workflow.plans.actionRemove', { name: plan.name }),
                          () => bridge?.workflow['runner.removePlan'](plan.id),
                          (removed) =>
                            removed
                              ? t('workflow.plans.removed', { name: plan.name })
                              : t('workflow.plans.alreadyGone'),
                          plan.id,
                        )
                      }
                    >
                      <Trash2 size={10} />
                      {t('workflow.plans.confirmButton')}
                    </DeskButton>
                    <DeskButton action="plan-remove-cancel" variant="ghost" compact onClick={() => setEdit(undefined)}>
                      {t('workflow.plans.cancel')}
                    </DeskButton>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {notice ? (
        <Banner
          tone={noticeTone}
          size="compact"
          markers={{ testid: 'workflow-plans-notice' }}
          className="mt-2 break-all"
        >
          {notice}
        </Banner>
      ) : null}
    </div>
  );
}
