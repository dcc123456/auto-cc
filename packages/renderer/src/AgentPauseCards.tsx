/**
 * 挂在人身上的那几张卡（spec 5.3-08 的界面半边 + 5.7-14）：`approval` 与 `elicitation` 形状不同，因为要问人的事不是一回事。
 *
 * 一张问「这一步可以动手吗」（是 / 否），一张问「这一步还缺哪些信息」（填一段 / 放弃 + 第几轮）。
 * 组件自己不判「这一步要不要批准」、不数「缺哪几个字段」：那些都在主进程的 `pending()` 读数里
 * 由服务侧算好（AGENTS.md §2.5），`reason` / `missing` 是服务侧产出的人读原话，按内容显示、不进语言包
 * （与 `AgentPlanStepView.intent` 同一条口径）。
 *
 * 投递服务自己的确认单也画在这里（`origin:'deliver'` 那一路）：它与 `approval` 暂停单问的是同一句话
 * ——「这只手现在能不能动」——所以复用同一对按钮与同一片外壳，只有正文来自 `DeliverApprovalView`
 * 那份真实读数（发哪个岗位、附的哪个文件）。两路各有应答口，路由在 `useAgentPause.respond` 里做。
 *
 * 卡片**由读数驱动**：事件只负责提醒去读（见 `useAgentPause`），所以刷新、错过的推送、
 * 甚至表态之后的那张卡，走的都是同一条路——界面上不存在「以为还有卡片」的余地。
 */
import { Check, CircleAlert, Clock, ShieldQuestion, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentPauseAnswer,
  AgentPauseView,
  DeliverApprovalView,
  ToolDescriptorView,
  ToolSupplyField,
} from '@auto-cc/shared';
import { greetTargetLabel } from '@auto-cc/shared';
import { Banner, DeskButton, DeskField, DeskSelect, DeskTextarea } from './ui/controls';
import type { PendingDecision, ResolvedPause } from './useAgentPause';

/**
 * 「是 / 否」那一对按钮（`approval` 暂停单与投递确认单共用，同一逻辑不写第二遍）。
 *
 * 归属：批准那颗是 `seal`——按下之后这一步就可能真的动到平台（与 `consent-grant` 同一口径，
 * 08 稿原先给它的是 jade，那是"已经办成"的读数色，不给待表态的按钮）；
 * 拒绝那颗退成 `ghost`——拒绝什么都不发，不该被涂成危险色。
 * @param busy 正在执行的动作标签；非空时两颗都禁用，防止同一张单被按两次
 * @param requestId 这两颗键所属的暂停单号（2026-11-24 第 13 片：同一时刻可能挂着多张单，
 *   人只看得见卡片外形、脚本只能靠「哪只可见」猜，猜错就点到别的单上——`APPROVAL_NOT_FOUND` 之后
 *   run 一直等到超时。单号挂在按钮上，「我按的是哪张单」就是从 DOM 直接读得到的事实）
 * @param onDecide 把人按下的那颗交出去（`approve` / `deny`）
 * @returns 一行两颗按钮
 */
function ApproveDenyButtons({
  busy,
  requestId,
  onDecide,
}: {
  busy?: string;
  requestId: string;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  const { t } = useTranslation();
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const busyLabel = busyReason === undefined ? undefined : t('agent.pause.reason.ACTION_BUSY');
  return (
    <div className="mt-2 flex items-center gap-2">
      <DeskButton
        action="pause-approve"
        variant="seal"
        compact
        busy={!!busy}
        disabled={busyReason !== undefined}
        disabledReason={busyReason}
        disabledReasonLabel={busyLabel}
        markers={{ 'pause-request-id': requestId }}
        onClick={() => onDecide('approve')}
      >
        <Check size={12} />
        {t('agent.pause.approve')}
      </DeskButton>
      <DeskButton
        action="pause-deny"
        variant="ghost"
        compact
        busy={!!busy}
        disabled={busyReason !== undefined}
        disabledReason={busyReason}
        disabledReasonLabel={busyLabel}
        markers={{ 'pause-request-id': requestId }}
        onClick={() => onDecide('deny')}
      >
        <X size={12} />
        {t('agent.pause.deny')}
      </DeskButton>
    </div>
  );
}

/**
 * 一张在等的单共有的抬头：工具名 + 副作用级 + 哪一步 + 单号。
 * @param card 主进程给的那份读数
 * @param meta 注册表读数（读不到时按未登记画，不猜名字）
 * @returns 一行抬头（卡片自己不带外壳，两种卡共用这一段）
 */
function PauseHeader({ card, meta }: { card: AgentPauseView; meta: ToolDescriptorView | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <span className="font-medium text-slate-200">{t(meta?.titleKey ?? 'agent.tool.unregistered')}</span>
      {/* 注册表读不到这只手时不猜副作用级：与 `AgentRunPanel` 里未登记那格用同一个读数（§2.5）。 */}
      <span className="text-slate-400">
        {t(meta ? `agent.tool.effect.${meta.effect}` : 'agent.run.effectUnregistered')}
      </span>
      <span className="text-slate-500" data-pause-step={String(card.planStepIndex)}>
        {t('agent.pause.step', { index: card.planStepIndex + 1 })}
      </span>
      <span className="break-all font-mono text-[10px] text-slate-500" data-pause-tool-id={card.toolId}>
        {card.toolId}
      </span>
    </div>
  );
}

/**
 * 确认单（`approval`）：能不能动手这一步，只有是 / 否两颗按钮。
 * @param card 在等的这张单
 * @param meta 注册表读数
 * @param busy 正在执行的动作标签；非空时按钮禁用，防止同一张单被按两次
 * @param onRespond 把表态交回上层（上层只负责发送，落库与放行都在主进程）
 */
function ApprovalCard({
  card,
  meta,
  busy,
  onRespond,
}: {
  card: AgentPauseView;
  meta: ToolDescriptorView | undefined;
  busy?: string;
  onRespond: (card: AgentPauseView, answer: AgentPauseAnswer) => void;
}) {
  const { t } = useTranslation();
  return (
    <Banner
      tone="amber"
      markers={{
        testid: 'agent-pause-approval',
        'pause-request-id': card.requestId,
        'pause-kind': card.kind,
        'pause-expires-at': String(card.expiresAt),
      }}
      className="mt-2"
    >
      <div className="w-full">
        <p className="text-xs font-semibold">{t('agent.pause.approvalHeading')}</p>
        <PauseHeader card={card} meta={meta} />
        {/* 判定口的原话是人唯一会读到的下一步指引，界面不复述、不改写。 */}
        <p className="mt-1 break-words text-[11px] text-slate-300" data-pause-reason={card.reason}>
          {card.reason}
        </p>
        <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-500">
          <Clock size={10} />
          {t('agent.pause.timeoutNote')}
        </p>
        <ApproveDenyButtons
          busy={busy}
          requestId={card.requestId}
          onDecide={(decision) => onRespond(card, { decision })}
        />
      </div>
    </Banner>
  );
}

/**
 * 投递服务自己的确认单（spec 5.7-14）：semi 档下对话那一路的第二道表态。
 *
 * 正文只列主进程读数里真有的东西——发哪个岗位、附的哪个文件——
 * 措辞复用 `JobLabPanel` 那两张卡片上的同一组键（`deliver.pendingTitle` / `deliver.pendingFile`，
 * 同一句话不翻译两遍，§2.1）。到点时刻这里由下面那句 `timeoutNote` 承担，岗位与文件不重复列。
 * @param approval `outbound.deliver.pending()` 里的那份读数
 * @param busy 正在执行的动作标签；非空时两颗按钮禁用
 * @param onDecide 把「发 / 不发」交回上层（上层按来源送回 `deliver.resolveApproval`）
 * @returns 一张与 `approval` 暂停单同外壳的确认卡
 */
function DeliverApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: DeliverApprovalView;
  busy?: string;
  onDecide: (answer: AgentPauseAnswer) => void;
}) {
  const { t } = useTranslation();
  // 「这一发递给谁」收在同一个 `greetTargetLabel`（会话坐标优先，裁定⑲ 搬到投递）：
  // 按岗位投递时它逐字等于 `approval.jobId`，按会话投递时它是那个联系人——摆 null 就是把
  // 一次真实的投递画成人读不懂的一格。标记名 `deliver-job-id` 不改（spec 6.2 的 markers 逐字保留）。
  const targetLabel = greetTargetLabel(approval);
  return (
    <Banner
      tone="amber"
      markers={{
        testid: 'agent-pause-approval',
        'pause-request-id': approval.approvalId,
        'pause-kind': 'approval',
        'pause-origin': 'deliver',
        'deliver-job-id': targetLabel,
        'pause-expires-at': String(approval.expiresAt),
      }}
      className="mt-2"
    >
      <div className="w-full">
        <p className="text-xs font-semibold">{t('agent.pause.deliverHeading')}</p>
        <p className="mt-1 break-words text-[11px] text-slate-100">
          {t('deliver.pendingTitle', { title: approval.title, company: approval.company })}
        </p>
        <p className="mt-1 break-words text-[11px] text-slate-300">
          {t('deliver.pendingFile', { fileName: approval.attachment.fileName })}
        </p>
        <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-500">
          <Clock size={10} />
          {t('agent.pause.timeoutNote')}
        </p>
        <ApproveDenyButtons
          busy={busy}
          requestId={approval.approvalId}
          onDecide={(decision) => onDecide({ decision })}
        />
      </div>
    </Banner>
  );
}

/**
 * 把「按格子填的值」组装成工具的入参对象（R13-8）。
 *
 * 描述里只有一件事值得解释：**嵌套由代码拼**。`request.platform` 这种点路径按段建对象，
 * 于是人只填值、不写 `{request:{…}}`；可选项留空就整格不写（写空串会让 `min(1)` 之类当场判红，
 * 那是把「没填」记成「填了空」）。本函数不校验——校验仍然只有 `agent.tools.validateInput` 一处。
 * @param fields 工具声明的格子（顺序即界面顺序）
 * @param values 每格的值（按 `path` 索引，未填为 undefined 或空串）
 * @returns 组装好的入参对象
 */
function assembleSupply(
  fields: readonly ToolSupplyField[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const assembled: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.path] ?? '').trim();
    if (raw === '' && field.optional) continue;
    const segments = field.path.split('.');
    let cursor = assembled;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      const branch: Record<string, unknown> =
        typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : {};
      cursor[segment] = branch;
      cursor = branch;
    }
    cursor[segments[segments.length - 1] ?? field.path] = raw;
  }
  return assembled;
}

/**
 * 补充信息单（`elicitation`）：入参过不了工具自己声明的 schema，动手之前按契约问一句人。
 *
 * 文本域的内容只活在本组件里：它是**还没交出去的表态**，不是界面状态，交给主进程那一刻才算数（§2.5）。
 * @param card 在等的这张单（`round` 是第几轮：上一轮补的没过校验才会再开一张新单）
 * @param meta 注册表读数
 * @param busy 正在执行的动作标签
 * @param onRespond 把 `supply` / `deny` 交回上层
 */
function ElicitationCard({
  card,
  meta,
  busy,
  onRespond,
}: {
  card: AgentPauseView;
  meta: ToolDescriptorView | undefined;
  busy?: string;
  onRespond: (card: AgentPauseView, answer: AgentPauseAnswer) => void;
}) {
  const { t, i18n } = useTranslation();
  const [supplement, setSupplement] = useState('');
  // 工具声明了格子就按格子画（R13-8）：人只填值，`{request:{…}}` 这层由 `assembleSupply` 拼。
  const supplyFields = meta?.supply ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [platforms, setPlatforms] = useState<readonly string[]>([]);
  // 平台下拉的取值现问登记处（不在这里存第二份平台清单）；问不到就退回可手输，不拦人。
  const needsPlatforms = supplyFields.some((field) => field.optionsFrom === 'platforms');
  useEffect(() => {
    if (!needsPlatforms) return;
    let alive = true;
    void window.autoCC?.platform['registry.list']().then((reply) => {
      if (!alive || !reply?.ok) return;
      setPlatforms(reply.value.platforms.map((platform) => platform.id));
    });
    return () => {
      alive = false;
    };
  }, [needsPlatforms]);
  const assembled = assembleSupply(supplyFields, values);
  const missingRequired = supplyFields.some((field) => !field.optional && (values[field.path] ?? '').trim() === '');
  // 「缺字段」是工具现报的，这张卡在墨案里属于「系统在说话」那一档（青瓷），与琥珀的待批准卡分开画法；
  // 提交那颗只是把人写的补充交回去让判定再跑一次，本身不外发，所以是 amber 而不是 seal。
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const busyLabel = busyReason === undefined ? undefined : t('agent.pause.reason.ACTION_BUSY');
  const isStructured = supplyFields.length > 0;
  const supplementEmpty = isStructured ? missingRequired : supplement.trim() === '';
  const supplyReason = busyReason ?? (supplementEmpty ? 'SUPPLEMENT_EMPTY' : undefined);
  /** 提交这一格：结构化时交组装好的对象（JSON 只做交换格式），否则交人写的那段原文。 */
  const submitSupply = (): void => {
    onRespond(card, {
      decision: 'supply',
      text: isStructured ? JSON.stringify(assembled) : supplement,
    });
  };
  return (
    <Banner
      tone="celadon"
      markers={{
        testid: 'agent-pause-elicitation',
        'pause-request-id': card.requestId,
        'pause-kind': card.kind,
        'pause-round': String(card.round),
        'pause-missing': card.missing.join(','),
        'pause-expires-at': String(card.expiresAt),
      }}
      className="mt-2"
    >
      <div className="w-full">
        <p className="text-xs font-semibold">{t('agent.pause.elicitationHeading')}</p>
        <PauseHeader card={card} meta={meta} />
        <p className="mt-1 break-words text-[11px] text-slate-300" data-pause-reason={card.reason}>
          {card.reason}
        </p>
        {/* 「还缺哪些字段」由工具的 strict schema 现报（`agent.tools.validateInput`），界面只列名字。 */}
        <p className="mt-1 break-all text-[11px] text-slate-400">
          {t('agent.pause.missing', { fields: card.missing.join('、') })}
        </p>
        <p className="mt-1 text-[10px] text-slate-500" data-pause-round-label={String(card.round)}>
          {t('agent.pause.round', { round: card.round })}
        </p>
        {isStructured ? (
          <div className="mt-2 flex flex-col gap-2" data-testid="agent-pause-supply-fields">
            <p className="text-[10px] text-slate-500">{t('agent.supply.hint')}</p>
            {supplyFields.map((field) => {
              const options = field.options ?? (field.optionsFrom === 'platforms' ? platforms : []);
              const segment = field.path.split('.').at(-1) ?? field.path;
              const label = i18n.exists(field.labelKey) ? t(field.labelKey) : field.path;
              return (
                <label key={field.path} className="flex flex-col gap-1 text-[11px] text-slate-300">
                  <span>
                    {label}
                    {field.optional ? <span className="text-slate-500">{t('agent.supply.optional')}</span> : null}
                  </span>
                  {field.kind === 'textarea' ? (
                    <DeskTextarea
                      action={`agent-pause-supply-${segment}`}
                      data-testid={`agent-pause-supply-input-${segment}`}
                      rows={2}
                      value={values[field.path] ?? ''}
                      onValueChange={(value) => setValues((previous) => ({ ...previous, [field.path]: value }))}
                      className="w-full"
                    />
                  ) : field.kind === 'select' ? (
                    <DeskSelect
                      action={`agent-pause-supply-${segment}`}
                      data-testid={`agent-pause-supply-input-${segment}`}
                      value={values[field.path] ?? ''}
                      onValueChange={(value) => setValues((previous) => ({ ...previous, [field.path]: value }))}
                      className="w-full"
                    >
                      <option value="">{t('agent.supply.pick')}</option>
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </DeskSelect>
                  ) : (
                    <DeskField
                      action={`agent-pause-supply-${segment}`}
                      data-testid={`agent-pause-supply-input-${segment}`}
                      value={values[field.path] ?? ''}
                      onValueChange={(value) => setValues((previous) => ({ ...previous, [field.path]: value }))}
                      className="w-full"
                    />
                  )}
                </label>
              );
            })}
          </div>
        ) : (
          <DeskTextarea
            action="agent-pause-supply"
            data-testid="agent-pause-supply-input"
            rows={2}
            value={supplement}
            onValueChange={setSupplement}
            placeholder={t('agent.pause.supplyPlaceholder')}
            className="mt-2 w-full"
          />
        )}
        <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-500">
          <Clock size={10} />
          {t('agent.pause.timeoutNote')}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <DeskButton
            action="pause-supply"
            variant="amber"
            compact
            busy={busy !== undefined}
            disabled={supplyReason !== undefined}
            disabledReason={supplyReason}
            disabledReasonLabel={supplyReason === undefined ? undefined : t(`agent.pause.reason.${supplyReason}`)}
            onClick={submitSupply}
          >
            <Check size={12} />
            {t('agent.pause.submit')}
          </DeskButton>
          <DeskButton
            action="pause-deny"
            variant="ghost"
            compact
            busy={busy !== undefined}
            disabled={busyReason !== undefined}
            disabledReason={busyReason}
            disabledReasonLabel={busyLabel}
            onClick={() => onRespond(card, { decision: 'deny' })}
          >
            <X size={12} />
            {t('agent.pause.giveUp')}
          </DeskButton>
        </div>
      </div>
    </Banner>
  );
}

/**
 * 表态卡片带：把「此刻挂在人身上的每一步、以及投递欠的那一次表态」画在对话流里，并留一行最近收掉的单的结局回报。
 * @param cards 现读的在等清单（`agent.pause.pending()` + `outbound.deliver.pending()` 汇成的一份）；还没读到过时为 undefined
 * @param resolved 最近收掉的一张 agent 单与它的结局（5.3-10 的「回报超时」就落在这一行）
 * @param toolMetas 注册表读数按 id 建的索引，抬头用它显示副作用分级与标题
 * @param busy 正在执行的动作标签，非空时按钮禁用
 * @param notice 动作提示行（失败原因留在界面上，截图才拿得到证据）
 * @param onRespond 一句表态 + 那张单（含来源），交回 `useAgentPause` 送回各自的口
 * @returns 一条插在对话流末尾的 `<li>`；没有在等的单、也没有可回报的结局时不画任何东西
 */
export function AgentPauseCards({
  cards,
  resolved,
  toolMetas,
  busy,
  notice,
  onRespond,
}: {
  cards: PendingDecision[] | undefined;
  resolved: ResolvedPause | undefined;
  toolMetas: Map<string, ToolDescriptorView>;
  busy?: string;
  notice?: string;
  onRespond: (decision: PendingDecision, answer: AgentPauseAnswer) => void;
}) {
  const { t } = useTranslation();
  const count = cards?.length ?? 0;
  const deliverCount = cards?.filter((decision) => decision.origin === 'deliver').length ?? 0;
  // agent 那一路把「哪张单」由卡片自己带回来，这里按来源包一次；投递那一路在各自卡片里已经闭包了来源。
  const respondToAgent = (card: AgentPauseView, answer: AgentPauseAnswer): void =>
    onRespond({ origin: 'agent', card }, answer);
  // 单号清单（按开单顺序）：挂着多张单时**不写单数属性**——写一张就会撒谎；每张卡自己另有单数标记。
  const requestIds = (cards ?? [])
    .map((decision) => (decision.origin === 'deliver' ? decision.card.approvalId : decision.card.requestId))
    .join(' ');
  if (count === 0 && !resolved && !notice) return null;
  return (
    <li
      data-testid="agent-pause-band"
      data-pause-count={String(count)}
      data-pause-deliver-count={String(deliverCount)}
      data-pause-request-ids={requestIds}
      className="rounded-xl border border-line bg-ink-900/60"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ShieldQuestion size={14} />
        {/* 三个标签里只有最后那句说明是「可省的」：窄面板（助手停靠）下不钉住前两格，
            汉字会一个字一行地竖着排（本轮活体截图 1540×920 里「等人表态」整列拆开就是这条）。
            所以标题与单数 nowrap 不缩，说明占剩下的宽度、放不下就截。 */}
        <h3 className="shrink-0 whitespace-nowrap text-xs font-semibold text-slate-200">{t('agent.pause.heading')}</h3>
        <span
          className="shrink-0 whitespace-nowrap text-[10px] text-slate-400"
          data-pause-pending-count={String(count)}
        >
          {t('agent.pause.pendingCount', { total: count })}
        </span>
        <span className="ml-auto min-w-0 truncate text-[10px] text-slate-500">{t('agent.pause.hint')}</span>
      </header>
      <div className="px-3 pb-2">
        {count === 0 ? (
          <p className="mt-2 text-[11px] text-slate-500" data-testid="agent-pause-empty">
            {t('agent.pause.empty')}
          </p>
        ) : (
          cards?.map((decision) => {
            if (decision.origin === 'deliver') {
              return (
                <DeliverApprovalCard
                  key={decision.card.approvalId}
                  approval={decision.card}
                  busy={busy}
                  onDecide={(answer) => onRespond(decision, answer)}
                />
              );
            }
            const card = decision.card;
            return card.kind === 'elicitation' ? (
              <ElicitationCard
                key={card.requestId}
                card={card}
                meta={toolMetas.get(card.toolId)}
                busy={busy}
                onRespond={respondToAgent}
              />
            ) : (
              <ApprovalCard
                key={card.requestId}
                card={card}
                meta={toolMetas.get(card.toolId)}
                busy={busy}
                onRespond={respondToAgent}
              />
            );
          })
        )}

        {resolved ? (
          <p
            className="mt-2 flex items-start gap-1 text-[11px] text-slate-400"
            data-testid="agent-pause-resolved"
            data-pause-resolved-outcome={resolved.outcome}
            data-pause-resolved-request-id={resolved.card.requestId}
          >
            <CircleAlert size={11} className="mt-0.5 shrink-0" />
            {t(`agent.pause.outcome.${resolved.outcome}`, {
              kind: t(`agent.pause.kind.${resolved.card.kind}`),
              round: String(resolved.card.round),
            })}
          </p>
        ) : null}

        {notice ? (
          <p className="mt-2 text-[11px] text-slate-300" data-testid="agent-pause-notice">
            {notice}
          </p>
        ) : null}
      </div>
    </li>
  );
}
