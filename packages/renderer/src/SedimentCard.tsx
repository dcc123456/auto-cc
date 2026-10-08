/**
 * 沉淀预览卡（spec 5.4-01 / 04 / 05 的界面半边）：把「这次对话会变成哪条工作流」摆在人按下之前。
 *
 * 整张卡只有两个来源：`agent.sediment.preview` 的逐格读数与 `agent.sediment.save` 的回执。
 * 界面不判「这一段算不算全成功」、不猜「哪个值该当变量」——那些是服务侧投影的事实（AGENTS.md §2.7）；
 * 名字那一格的校验也**只在服务侧那一道**，这里只负责把「还没填名字」说给人听（5.4-05 的界面半边）。
 * 拒因（整段一句 + 逐格一句）是主进程产出的人读原话，按内容显示、不进语言包，与 `lastError` 同一口径。
 */
import { Bookmark, Check, Save, Workflow, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentRunView, SavedWorkflowPlanView, SedimentPreviewView } from '@auto-cc/shared';
import {
  Banner,
  BLOCK_EDGE_CLASS,
  BLOCK_SURFACE_CLASS,
  DeskButton,
  DeskField,
  Tag,
  deskReason,
  type BannerTone,
} from './ui/controls';

/**
 * 已经不再往前跑的 run 状态：只有收口了才有得沉淀。
 *
 * `paused` 也算收口（叫停之后前面那几步是真跑通了的，投影只认落库的步记录），
 * `proposed` / `running` 不算——那时候这一段还在变，投出来的计划下一刻就不作数了。
 */
const SETTLED_RUN_STATUSES = new Set<AgentRunView['status']>(['paused', 'completed', 'failed']);

/**
 * 一张插在对话流里的沉淀卡。
 * @param runId 这条 run 的 id（预览读数按它认领，换了 run 旧预览自动作废）
 * @param runStatus run 的当前状态，决定给不给沉淀入口
 * @param preview 上一次点开出到的投影读数；undefined = 还没点过
 * @param saved 刚落库的计划读数；undefined = 这次还没存成
 * @param nameDraft 名字输入框的原值
 * @param busy 正在执行的动作标签；非空时按钮全禁用
 * @param notice 动作提示行（失败原因留在界面上，截图才拿得到证据）
 * @param noticeTone 那一行的语气档，与 `notice` 同源（6.2-18 裁定①：判定只在 `useBridgeAction` 做一次）
 * @param onNameChange 名字输入
 * @param onOpen 点「保存为工作流」（只要读数，不写库）
 * @param onSave 点「存为自定义计划」（人按的那一格）
 * @param onClose 收起这张卡
 * @returns 对话流里的一个 `<li>`
 */
export function SedimentCard({
  runId,
  runStatus,
  preview,
  saved,
  nameDraft,
  busy,
  notice,
  noticeTone,
  onNameChange,
  onOpen,
  onSave,
  onClose,
}: {
  runId: string;
  runStatus: AgentRunView['status'];
  preview?: SedimentPreviewView;
  saved?: SavedWorkflowPlanView;
  nameDraft: string;
  busy?: string;
  notice?: string;
  noticeTone: BannerTone;
  onNameChange: (value: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  /** 只认这条 run 的读数：`preview` 是上一次点开的，换了 run 就不能沿用（§2.7 禁第二份事实）。 */
  const view = preview && preview.runId === runId ? preview : undefined;
  const isSettled = SETTLED_RUN_STATUSES.has(runStatus);
  /** 名字必填的判据只看 trim 后空不空；「超长 / 有非法字符」那一道的真相在服务侧，拒了会写进提示行。 */
  const nameMissing = nameDraft.trim().length === 0;
  /** 在途那一档压过本卡自己的前置条件（与第十二/十三片同一优先级写法），三件套走 `deskReason`。 */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const { dead, reason: afterBusy } = deskReason(t, 'chat.sediment', busyReason);
  const saveReason = afterBusy(!view?.canSediment, 'NOT_SEDIMENTABLE') ?? (nameMissing ? 'NAME_REQUIRED' : undefined);

  return (
    <li
      data-testid="sediment-card"
      data-run-id={runId}
      data-run-status={runStatus}
      data-has-preview={String(!!view)}
      className="rounded-xl border border-line bg-ink-900/60 px-3 py-2 text-[11px] text-slate-300"
    >
      <div className="flex items-center gap-2">
        <Bookmark size={13} />
        <h4 className="text-xs font-semibold text-slate-200">{t('chat.sediment.heading')}</h4>
        {view ? (
          <DeskButton
            action="sediment-close"
            variant="ghost"
            compact
            className="ml-auto"
            busy={!!busy}
            {...dead(busyReason)}
            onClick={onClose}
          >
            <X size={11} />
            {t('chat.sediment.close')}
          </DeskButton>
        ) : null}
      </div>

      {!view ? (
        <>
          <p className="mt-1 text-slate-400">{t('chat.sediment.hint')}</p>
          {isSettled ? (
            <DeskButton
              action="sediment-open"
              variant="solid"
              className="mt-2"
              busy={!!busy}
              {...dead(busyReason)}
              onClick={onOpen}
            >
              <Workflow size={12} />
              {t('chat.sediment.open')}
            </DeskButton>
          ) : (
            <p className="mt-1 text-slate-500" data-testid="sediment-not-settled">
              {t('chat.sediment.notSettled')}
            </p>
          )}
        </>
      ) : (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="break-words" data-preview-goal={view.goal}>
            {t('chat.sediment.goal', { goal: view.goal })}
          </p>
          <p
            data-testid="sediment-verdict"
            data-can-sediment={String(view.canSediment)}
            className={view.canSediment ? 'text-jade' : 'text-seal'}
          >
            {view.canSediment ? (
              t('chat.sediment.canSediment', { count: view.steps.length })
            ) : (
              /* 两段并排而不是拼一句：前半句是外壳文案走语言包，后半句是服务侧产出的人读原话，
                 拼进同一个插值就等于把主进程的句子塞进翻译里（与 `lastError` 同一口径）。 */
              <>
                <span data-testid="sediment-blocked-label">{t('chat.sediment.blocked')}</span>
                <span data-testid="sediment-blocking-reason">{view.blockingReason}</span>
              </>
            )}
          </p>

          <ul className="flex flex-col gap-1" data-testid="sediment-steps">
            {view.steps.map((step) => (
              <li
                key={String(step.planStepIndex)}
                data-sediment-step={String(step.planStepIndex)}
                data-step-tool-id={step.toolId}
                data-step-status={step.stepStatus}
                data-step-sedimentable={String(step.sedimentable)}
                className={`rounded-md border px-2 py-1 ${BLOCK_SURFACE_CLASS} ${
                  step.sedimentable ? BLOCK_EDGE_CLASS.jade : BLOCK_EDGE_CLASS.seal
                }`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-slate-500">
                    {t('chat.sediment.stepIndex', { index: step.planStepIndex + 1 })}
                  </span>
                  <span className="break-all font-mono">{step.toolId}</span>
                  <span>{t(`chat.sediment.stepStatus.${step.stepStatus}`)}</span>
                  {step.node ? (
                    <span className="text-slate-400" data-step-node-kind={step.node.kind}>
                      {t('chat.sediment.nodeKind', { kind: step.node.kind })}
                    </span>
                  ) : null}
                </span>
                {!step.sedimentable ? (
                  <span className="mt-0.5 block break-all text-seal" data-step-reason={step.reason ?? ''}>
                    {step.reason}
                  </span>
                ) : null}
                {step.params.length > 0 ? (
                  <span className="mt-0.5 flex flex-wrap gap-2" data-testid="sediment-params">
                    {step.params.map((param) =>
                      param.isVariable ? (
                        <span
                          key={`${param.nodeId}-${param.paramKey}`}
                          data-param-key={param.paramKey}
                          data-param-variable={String(param.isVariable)}
                          className="text-celadon"
                        >
                          {t('chat.sediment.paramVariable', { key: param.paramKey, value: String(param.value) })}
                        </span>
                      ) : (
                        // 「残留参数」是要人补的洞：语气档交进 `Tag`，wash 从此不在面板里拼（6.2-19）。
                        <Tag
                          key={`${param.nodeId}-${param.paramKey}`}
                          tone="seal"
                          data-param-key={param.paramKey}
                          data-param-variable={String(param.isVariable)}
                        >
                          {t('chat.sediment.paramResidual', { key: param.paramKey, value: String(param.value) })}
                        </Tag>
                      ),
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-slate-500">{t('chat.sediment.residualHint')}</p>

          <label className="mt-1 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">{t('chat.sediment.nameLabel')}</span>
            <DeskField
              action="sediment-name"
              data-testid="sediment-name"
              value={nameDraft}
              onValueChange={onNameChange}
              placeholder={t('chat.sediment.namePlaceholder')}
            />
          </label>
          {nameMissing ? (
            <p className="text-[10px] text-amber" data-testid="sediment-name-required">
              {t('chat.sediment.nameRequired')}
            </p>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <DeskButton action="sediment-save" variant="amber" busy={!!busy} {...dead(saveReason)} onClick={onSave}>
              <Save size={12} />
              {t('chat.sediment.save')}
            </DeskButton>
            {!view.canSediment ? (
              <span className="text-[10px] text-slate-500">{t('chat.sediment.saveBlocked')}</span>
            ) : null}
          </div>

          {saved ? (
            <p
              className="flex flex-wrap items-center gap-1 text-jade"
              data-testid="sediment-saved"
              data-plan-id={saved.id}
            >
              <Check size={12} />
              {t('chat.sediment.saved', { name: saved.name, count: saved.nodeCount })}
              <span className="text-[10px] text-slate-400">{t('chat.sediment.savedHint')}</span>
            </p>
          ) : null}
        </div>
      )}

      {notice ? (
        <Banner tone={noticeTone} size="compact" markers={{ testid: 'sediment-notice' }} className="mt-1 break-all">
          {notice}
        </Banner>
      ) : null}
    </li>
  );
}
