import { ListChecks, MessageSquare, Send, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppErrorPayload,
  BridgeReply,
  GreetReceiptView,
  JobRowView,
  KbSearchRowResult,
  ScriptDraftRowView,
  ScriptGenerateRequestView,
  ScriptKindView,
} from '@auto-cc/shared';
import { ConsentCard } from './ConsentCard';
import { DeskButton, FIELD_CLASS } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';
import { useConsent } from './useConsent';

/**
 * 一次点按最多拿几条检索命中当经历候选。
 *
 * 上限放在界面侧而不是服务侧：服务只知道"这次喂进来的证据"，它不知道界面准备并列几条；
 * 而真打模型时这里是 N 次调用（现在没有 key，走的是模板腿，一次网络都不发）。
 */
const CANDIDATE_EVIDENCE_LIMIT = 3;

/** 三类话术的展示顺序：对话推进的顺序，与 `SCRIPT_KINDS` 一致。 */
const KIND_ORDER: ScriptKindView[] = ['greeting', 'follow-up', 'rejection'];

/** 必须带对方原话的两类（判据在服务侧，这里只是提前把注定失败的那一次调用挡住）。 */
const KINDS_NEEDING_QUOTE: ScriptKindView[] = ['follow-up', 'rejection'];

/**
 * 语言包里备了专名的平台码。表外的码原样显示（不给"未知平台"编一个名字，也不新增翻译键）。
 */
const NAMED_PLATFORMS: string[] = ['boss'];

/** 一次生成点按的完整读数：候选列表 + 那次检索本身的状态（空态要能说清为什么少）。 */
interface CandidateBundle {
  drafts: ScriptDraftRowView[];
  search: KbSearchRowResult | null;
}

/**
 * 话术候选面板（spec 4.6-03 / 06 / 07，plan §4.6 的 4.6-d 那一片）。
 *
 * 五件事在界面上是刻意的，读代码的人不该重新推断：
 * 1. **一条候选 = 一次 `outbound.script.generate` 调用**：候选的维度是"引用哪一条知识库经历"，
 *    最后再给一条**不引用任何经历**的通用候选。为什么用这个维度：模型腿此刻不可用（没有 key），
 *    多条"随机变体"在零网络下会退化成同一句，并列摆出来是假的多条；而证据维度过的是模板腿，
 *    每条候选的 `evidenceRefs` 天然不同（4.6-02 的回指在界面上就是看得见的）。
 * 2. **判据一条都不在界面里重算**：正文、`origin`、`fallbackReason`、`evidenceRefs` 全是服务读数，
 *    界面只做去重（同一条实体可能以两个切片进前三）与展示。
 * 3. **「模板」必须显形**：`origin === 'template'` 时同时给出标识与回落原因，通用候选另外标「未引用经历」
 *    ——这两处就是 4.6-06 的"不冒充个性化"。
 * 4. **选中不等于发送**：选中一条只把「打招呼」那一只按钮放开，真正外发还是走 `outbound.greet.perform`
 *    （它自己过闸门、频控、黑名单；这条面板口只生成内容，不产生任何离开 app 的字节）。
 * 5. **平台专名与岗位名一律走插值**（§5.7）：`{{platform}}` / `{{title}}` 是参数，不进翻译主句，
 *    `en` 下的语序由语言包那一句自己决定（4.6-03 的截图判据就看这个）。
 */
export function ScriptPanel() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<JobRowView[]>([]);
  const [targetId, setTargetId] = useState<number>();
  const [kind, setKind] = useState<ScriptKindView>('greeting');
  const [quoteDraft, setQuoteDraft] = useState('');
  const [keywordsDraft, setKeywordsDraft] = useState('');
  const [bundle, setBundle] = useState<CandidateBundle>();
  const [selected, setSelected] = useState<number>();
  const [lastGreet, setLastGreet] = useState<GreetReceiptView>();
  const [bridgeError, setBridgeError] = useState<AppErrorPayload>();
  const bridge = window.autoCC;
  const { refresh: refreshConsent, ...consent } = useConsent();

  /**
   * 只读库内清单：面板的下拉永远转述 `jd.store.list` 的读数，界面不缓存"我以为有哪些 JD"。
   * 一次都不传 limit——用服务默认（20 条），免得同一个上限在两处长出两份字面值。
   */
  const read = useCallback(async () => {
    const reply = await bridge?.jd['store.list']();
    if (!reply?.ok) return;
    setRows(reply.value.rows);
    // 签字状态跟着这一遍一起刷（与打招呼面板同一钩子、同一口径）：要发的行属于哪个平台只有读数知道。
    await refreshConsent([...new Set(reply.value.rows.map((row) => row.platform))]);
  }, [bridge, refreshConsent]);

  const { busy, notice, run } = useBridgeAction(read);

  useEffect(() => {
    void read();
  }, [read]);

  /**
   * 别的面板（JD 抓取实验台、工作流节点）抓完一轮就重读清单：下拉的选项必须跟库一致。
   *
   * 只在 `phase === 'done'` 时读——`listing` / `detail` 阶段每推一次就查一遍库，
   * 等于把进度推送当轮询用，而那一轮的行数还没有变化。
   */
  useEffect(() => {
    if (!bridge) return;
    return bridge.on('jd/progress', (event) => {
      if (event.phase === 'done') void read();
    });
  }, [bridge, read]);

  const target = rows.find((row) => row.id === targetId) ?? rows[0];
  const drafts = bundle?.drafts ?? [];
  const selectedDraft = selected === undefined ? undefined : drafts[selected];
  const needsQuote = KINDS_NEEDING_QUOTE.includes(kind);
  /**
   * 归属色按「这个动作动到谁」分（plan §5），本屏两只动作口正好落在两端：
   * `generate` 只是取证据 + 生成正文，一个字节都不离开这台机器、一行都不写 → `line`；
   * `send` 走 `outbound.greet.perform`，那一条链上有闸门、频控与账本，发出去的是给陌生人的消息 → `seal`。
   * 三类话术的切换键不写任何东西，选中态用 `solid`、未选中用 `ghost`（同一批数据的另一种画法）。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const noTargetReason = target === undefined ? 'NO_TARGET' : undefined;
  const generateReason =
    busyReason ?? noTargetReason ?? (needsQuote && quoteDraft.trim().length === 0 ? 'QUOTE_REQUIRED' : undefined);
  const sendReason = busyReason ?? noTargetReason ?? (selectedDraft === undefined ? 'NO_CANDIDATE_PICKED' : undefined);
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`script.reason.${code}`);

  /**
   * 平台专名 → 页面上那三个字。
   * @param code 库内行的平台码
   * @returns 语言包里的专名；表外的码原样返回（不猜、不编）
   */
  const platformName = (code: string): string => (NAMED_PLATFORMS.includes(code) ? t(`script.platform.${code}`) : code);

  /**
   * 一次点按跑完「取证据 → 逐条生成」，把结局合成一份读数交给 `run` 的忙碌态与播报。
   *
   * 检索腿失败就整轮失败（没有证据还有意义，检索本身报错说明库没装配好）；
   * 生成腿只要有一条被拒就以那条的结构化错误上浮——界面不吞掉"追问没带原话"这类入参缺陷。
   */
  const generate = () => {
    if (!target) return;
    const keywords = keywordsDraft
      .split(/[,，\s]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
    const base: ScriptGenerateRequestView = {
      jdId: String(target.id),
      title: target.title,
      company: target.company,
      keywords,
      kind,
      ...(quoteDraft.trim().length > 0 ? { recruiterMessage: quoteDraft.trim() } : {}),
    };
    // 桥接不在（非 Electron 宿主里跑渲染层）时同步返回 undefined，`run` 自己会播报"桥接不可用"。
    const task = (): Promise<BridgeReply<CandidateBundle>> | undefined => {
      if (!bridge) return undefined;
      return (async (): Promise<BridgeReply<CandidateBundle>> => {
        const search = await bridge.kb['profile.search'](`${target.title} ${target.company} ${keywords.join(' ')}`);
        if (!search.ok) return { ok: false, error: search.error };
        const hits = search.value.hits.slice(0, CANDIDATE_EVIDENCE_LIMIT);
        const requests: ScriptGenerateRequestView[] = [
          ...hits.map((hit) => ({ ...base, evidence: [{ fact: hit.text, refId: hit.chunkId }] })),
          { ...base, evidence: [] },
        ];
        const replies = await Promise.all(requests.map((request) => bridge.outbound['script.generate'](request)));
        const drafts: ScriptDraftRowView[] = [];
        for (const reply of replies) {
          if (!reply.ok) return { ok: false, error: reply.error };
          // 去重在这里，不在服务里：同一个实体常以两个切片进前三，模板腿会把它们写成一模一样的一句，
          // 并列摆两条同样的话是假候选。判据（黑名单、长度、无据数字）一条都没在界面重算。
          if (!drafts.some((draft) => draft.text === reply.value.text)) drafts.push(reply.value);
        }
        return { ok: true, value: { drafts, search: search.value } };
      })();
    };
    void run(t('script.actionGenerate'), task, {
      apply: (value) => {
        setBundle(value);
        setSelected(undefined);
        setLastGreet(undefined);
        setBridgeError(undefined);
      },
      describe: (value) =>
        t('script.noticeGenerated', {
          count: value.drafts.length,
          template: value.drafts.filter((draft) => draft.origin === 'template').length,
        }),
      onError: (error) => {
        setBundle(undefined);
        setSelected(undefined);
        setBridgeError(error);
      },
    });
  };

  /**
   * 把选中的那一条发出去（spec 4.6-07 的"进入发送流程"就是这一步）。
   *
   * 走 `text` 那一路而不是 `script`：用户已经选定，服务不该再生成一遍。
   * 但来源不能跟着正文一起丢掉（spec 4.6-02 / 4.6-e）：候选视图上的 `scriptVersion` / `kind` /
   * `jdId` / `evidenceRefs` 原样递进 `provenance`，账本才写得出"发出去的是哪一版给哪条 JD 生成、
   * 引用了哪几条经历"。这四个字段全是服务读数，界面没有重算也没有补造。
   * 编排（幂等 → 黑名单 → 额度 → 频控 → 发送 → 落账）全在服务侧，面板只摆回执与结构化错误。
   * 先过 `consent.ensure`（spec 2.7-06 的界面拦截点 ①），与打招呼面板同一只钩子，不另写一套签字流程。
   */
  const send = () => {
    if (!target || !selectedDraft) return;
    return void consent.ensure([target.platform], () => {
      void run(
        t('script.actionSend', { platform: platformName(target.platform), title: target.title }),
        () =>
          bridge?.outbound['greet.perform']({
            platform: target.platform,
            jobId: target.jobId,
            text: selectedDraft.text,
            provenance: {
              jdId: selectedDraft.jdId,
              kind: selectedDraft.kind,
              scriptVersion: selectedDraft.scriptVersion,
              evidenceRefs: selectedDraft.evidenceRefs,
            },
          }),
        {
          apply: (receipt) => {
            setLastGreet(receipt);
            setBridgeError(undefined);
          },
          onError: setBridgeError,
        },
      );
    });
  };

  /**
   * 一次检索的三种"没拿到证据"分开说（与检索面板同一口径：切不出词与库里没有是两件事）。
   * @param search 那次检索的读数
   * @returns 一句播报
   */
  const evidenceText = (search: KbSearchRowResult): string => {
    if (search.status === 'no_query_tokens') return t('script.evidenceNoTokens');
    if (search.hits.length === 0) return t('script.evidenceNoHits');
    return t('script.evidenceHits', {
      used: Math.min(search.hits.length, CANDIDATE_EVIDENCE_LIMIT),
      total: search.hits.length,
    });
  };

  return (
    <div data-testid="script-panel" className="flex flex-col gap-4 rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center gap-2">
        <MessageSquare size={16} className="text-slate-300" />
        <h2 className="text-sm font-semibold text-slate-200">{t('script.heading')}</h2>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{t('script.hint')}</p>

      <div className="flex flex-col gap-2">
        <label className="text-[11px] text-slate-400" htmlFor="script-target">
          {t('script.targetLabel')}
        </label>
        {rows.length === 0 ? (
          <p data-script-target-empty className="text-[11px] leading-relaxed text-slate-500">
            {t('script.targetEmpty')}
          </p>
        ) : (
          <select
            id="script-target"
            data-script-field="target"
            value={String(target?.id ?? '')}
            onChange={(event) => setTargetId(Number(event.target.value))}
            className={`w-full ${FIELD_CLASS}`}
          >
            {rows.map((row) => (
              <option key={`${row.platform}-${row.id}`} value={String(row.id)}>
                {t('script.targetRow', {
                  platform: platformName(row.platform),
                  title: row.title,
                  company: row.company,
                })}
              </option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-2" data-script-field="kind">
          {KIND_ORDER.map((option) => (
            <DeskButton
              key={option}
              action={`script-kind-${option}`}
              markers={{ 'script-kind': option }}
              variant={option === kind ? 'solid' : 'ghost'}
              compact
              aria-pressed={option === kind}
              onClick={() => setKind(option)}
            >
              {t(`script.kind.${option}`)}
            </DeskButton>
          ))}
        </div>

        <input
          type="text"
          data-script-field="quote"
          value={quoteDraft}
          onChange={(event) => setQuoteDraft(event.target.value)}
          placeholder={t('script.quotePlaceholder')}
          className={`w-full ${FIELD_CLASS}`}
        />
        {!needsQuote && (
          <p data-script-quote-hint className="text-[11px] leading-relaxed text-slate-500">
            {t('script.quoteHintGreeting')}
          </p>
        )}
        <input
          type="text"
          data-script-field="keywords"
          value={keywordsDraft}
          onChange={(event) => setKeywordsDraft(event.target.value)}
          placeholder={t('script.keywordsPlaceholder')}
          className={`w-full ${FIELD_CLASS}`}
        />

        <DeskButton
          action="script-generate"
          markers={{ 'script-action': 'generate' }}
          variant="line"
          compact
          busy={!!busy}
          disabled={generateReason !== undefined}
          disabledReason={generateReason}
          disabledReasonLabel={reasonLabel(generateReason)}
          className="self-start"
          onClick={generate}
        >
          <Sparkles size={12} />
          {t('script.actionGenerate')}
        </DeskButton>
        {needsQuote && quoteDraft.trim().length === 0 && (
          <p data-script-quote-required className="text-[11px] leading-relaxed text-amber">
            {t('script.quoteRequired')}
          </p>
        )}
      </div>

      {consent.request && (
        <ConsentCard
          platform={consent.request.platform}
          view={consent.request.view}
          busy={consent.busy}
          error={consent.error}
          onGrant={() => void consent.grant()}
          onDeny={consent.deny}
        />
      )}

      {bundle && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1 text-xs font-semibold text-slate-300">
            <ListChecks size={12} />
            {t('script.candidatesHeading', { count: bundle.drafts.length })}
          </p>
          {bundle.search && (
            <p data-script-evidence className="text-[11px] leading-relaxed text-slate-500">
              {evidenceText(bundle.search)}
            </p>
          )}
          {bundle.drafts.length === 0 ? (
            <p data-script-candidates-empty className="text-[11px] leading-relaxed text-slate-500">
              {t('script.candidatesEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-script-candidates>
              {bundle.drafts.map((draft, index) => (
                <li
                  key={`${draft.scriptVersion}-${draft.kind}-${String(index)}`}
                  data-script-candidate={index}
                  data-script-origin={draft.origin}
                  data-script-selected={selected === index ? 'true' : 'false'}
                  className={`rounded-md border p-2 ${
                    selected === index ? 'border-celadon/50 bg-celadon-wash' : 'border-line bg-ink-950/70'
                  }`}
                >
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="script-candidate"
                      data-script-pick={index}
                      checked={selected === index}
                      onChange={() => setSelected(index)}
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                        <span
                          data-script-badge={draft.origin}
                          className={`rounded-chip border px-1.5 py-0.5 text-[11px] ${
                            draft.origin === 'template'
                              ? 'border-amber/50 bg-amber-wash text-amber'
                              : 'border-jade/45 bg-jade-wash text-jade'
                          }`}
                        >
                          {t(`script.origin.${draft.origin}`)}
                        </span>
                        <span data-script-refs={draft.evidenceRefs.length}>
                          {draft.evidenceRefs.length > 0
                            ? t('script.refs', {
                                count: draft.evidenceRefs.length,
                                ids: draft.evidenceRefs.join(' / '),
                              })
                            : t('script.refsNone')}
                        </span>
                        <span data-script-version={draft.scriptVersion}>
                          {t('script.version', { version: draft.scriptVersion })}
                        </span>
                      </span>
                      <span data-script-text={index} className="text-xs leading-relaxed text-slate-100">
                        {draft.text}
                      </span>
                      {draft.fallbackReason && (
                        <span data-script-fallback={index} className="text-[11px] leading-relaxed text-amber">
                          {t('script.fallback', { reason: draft.fallbackReason })}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <DeskButton
              action="script-send"
              markers={{ 'script-action': 'send' }}
              variant="seal"
              compact
              busy={!!busy}
              disabled={sendReason !== undefined}
              disabledReason={sendReason}
              disabledReasonLabel={reasonLabel(sendReason)}
              onClick={send}
            >
              <Send size={12} />
              {t('script.actionSend', {
                platform: target ? platformName(target.platform) : '-',
                title: target?.title ?? '-',
              })}
            </DeskButton>
            {selectedDraft === undefined && (
              <span data-script-pick-hint className="text-[11px] text-slate-500">
                {t('script.pickHint')}
              </span>
            )}
          </div>
        </div>
      )}

      {lastGreet && (
        <div
          data-script-receipt
          data-origin={lastGreet.origin}
          className="rounded-md border border-jade/45 bg-jade-wash p-2 text-[11px] leading-relaxed text-jade"
        >
          {t('script.receiptRow', {
            jobId: lastGreet.jobId,
            ledgerId: lastGreet.ledgerId,
            source: lastGreet.source,
            origin: t(`script.origin.${lastGreet.origin}`),
            reason: lastGreet.reason,
          })}
        </div>
      )}

      {bridgeError && (
        <div
          data-script-error
          data-error-code={bridgeError.code}
          className="rounded-md border border-seal/50 bg-seal-wash p-2 text-[11px] leading-relaxed text-seal"
        >
          {t('script.errorRow', { code: bridgeError.code, message: bridgeError.message })}
        </div>
      )}

      {notice && (
        <p data-script-notice className="text-xs leading-relaxed text-slate-400">
          {notice}
        </p>
      )}
    </div>
  );
}
