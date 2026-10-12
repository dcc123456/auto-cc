import { ListChecks, RefreshCw, Save, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KbSkillReadRowView, RequiredInfoRowView } from '@auto-cc/shared';
import { formatClock } from './format';
import { countRequired, REQUIRED_STATUS_LABEL_KEY, REQUIRED_STATUS_TONE } from './required-info';
import { Banner, BLOCK_EDGE_CLASS, BLOCK_SURFACE_CLASS, DeskButton, DeskTextarea, Tag } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/**
 * 书写技能面板（spec 4.9-10 / 4.9-11：用户能看、能改、能一键还原，唯独删不掉）。
 *
 * 四件事在界面上是刻意的：
 * 1. **没有删除那颗键**——`kb.skill.*` 白名单里就只有读/存/还原/核对四句，第五句在服务面上根本
 *    不存在（4.9-04 的结构性判据）。这里也不写一句「删除已禁用」的假出口：没有这件事就该读成没有。
 * 2. **正文只有一份**：生效的那一份由主进程合成（覆盖 ?? 内置），界面拿 `content` 与 `builtinContent`
 *    两个读数，不在渲染层再存一份内置正文（§2.7）。
 * 3. **还原键的判据是来源而不是字数**：`source === 'builtin'` 时它按不动，因为此刻已经没有覆盖可删了。
 * 4. **必备信息清单是这份文档的读数，不是技能的读数**，所以它跟着 `docId` 现问，切换简历即重取。
 * @param docId  desk 上当前这份工作副本的 id（空串 = 还没选简历，清单那一格就不问）
 * @returns 面板节点
 */
export function SkillPanel({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  /** 主进程的合成读数（生效正文 + 来源 + 字数上限），界面不自己拼第二份。 */
  const [view, setView] = useState<KbSkillReadRowView>();
  /** 编辑中的那一份。与 `view.content` 不同就是「有未保存的改动」，判据只用这两个字符串比。 */
  const [draft, setDraft] = useState('');
  /** 必备信息逐项读数；`undefined` = 还没问出来（没有工作副本，或副本已不在库里）。 */
  const [requiredRows, setRequiredRows] = useState<RequiredInfoRowView[]>();
  /** 上一次从主进程拿到的生效正文：只有"人没动过"时重读才覆盖草稿，否则改到一半的字会被冲掉。 */
  const loadedRef = useRef('');

  /**
   * 把一次读数落到 state。
   * @param value `kb.skill.read` / `save` / `reset` 共同的读数形状
   * @param force 是否连未保存的草稿一起覆盖：还原就是「把我的改动丢掉」，这一句必须算数；
   *              重读不能算数，否则改到一半的字会被别人（库变更事件）冲掉
   */
  const applyRead = useCallback((value: KbSkillReadRowView, force = false): void => {
    setDraft((current) => (force || current === loadedRef.current ? value.content : current));
    loadedRef.current = value.content;
    setView(value);
  }, []);

  /**
   * 重读生效的技能（真相在主进程，界面不缓存上一次的正文）。
   */
  const read = useCallback(async () => {
    const reply = await bridge?.kb['skill.read']();
    if (reply?.ok) applyRead(reply.value);
  }, [applyRead, bridge]);

  const { busy, notice, noticeTone, run } = useBridgeAction(read);

  /**
   * 对当前工作副本逐项核对必备信息（spec 4.9-09）。
   *
   * 走静默重读而不是 `run`：这一条挂在挂载与换简历上，每次进面板都刷一行「核对完成」是把播报
   * 当装饰；副本真不在时（`KB_SOURCE_MISSING`）清单整块不画，由「先导入简历」那一行说明。
   */
  const checkDocument = useCallback(async () => {
    if (docId === '') {
      setRequiredRows(undefined);
      return;
    }
    const reply = await bridge?.kb['skill.checkDocument'](docId);
    setRequiredRows(reply?.ok ? reply.value : undefined);
  }, [bridge, docId]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    void checkDocument();
  }, [checkDocument]);

  /** 有未保存的改动：草稿与主进程那份不一致就算，不看字数（改一个字也是改）。 */
  const isDirty = view !== undefined && draft !== view.content;
  /** 空正文不许存：想回到出厂写法应该点「还原为内置」，存一份空白等于把指引删了（那是第四句没出口口的东西）。 */
  const isBlankDraft = draft.trim() === '';

  /**
   * 保存按钮按不动的原因码（AGENTS.md §6.2-06：禁用态必须说得出为什么）。
   * @returns 原因码，可点时 `undefined`
   */
  const saveReason =
    view === undefined ? 'NO_SKILL' : isDirty ? (isBlankDraft ? 'DRAFT_BLANK' : undefined) : 'DRAFT_UNCHANGED';
  /** 还原按钮按不动的原因码：来源已经是内置，就没有覆盖可还原了。 */
  const resetReason = view === undefined ? 'NO_SKILL' : view.source === 'builtin' ? 'ALREADY_BUILTIN' : undefined;
  /** 原因码 → 人话（只给码不给这句话就是谎报，与 `GapPanel` 同一口径）。 */
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`resume.skill.reason.${code}`);

  /**
   * 存下人改过的那一份（整份覆盖，spec 4.9-02）。
   */
  const save = () => {
    void run(t('resume.skill.save'), () => bridge?.kb['skill.save'](draft), {
      apply: applyRead,
      describe: (value) => t('resume.skill.saved', { chars: value.chars }),
    });
  };

  /**
   * 一键还原：清掉库里的覆盖行，生效正文回到内置那一份（spec 4.9-03）。
   * 这里强制覆盖草稿：这颗键的语义就是「丢掉我的改动」，留着未保存的字会把还原显示成没生效。
   */
  const reset = () => {
    void run(t('resume.skill.reset'), () => bridge?.kb['skill.reset'](), {
      apply: (value) => applyRead(value, true),
      describe: () => t('resume.skill.resetDone'),
    });
  };

  /** 齐了几项 / 共几项：只数 `present`，`weak` 算不合格（在但不合格，说成齐了就是谎报）。 */
  const [presentCount, requiredTotal] = countRequired(requiredRows ?? []);
  /** 必备档里缺/不合格的行数：这一档缺了就是不合格，所以它单独占一行而不是混在计数里。 */
  const coreMissing = requiredRows?.filter((row) => row.severity === 'core' && row.status !== 'present').length ?? 0;

  return (
    <div data-testid="skill-panel" className="flex flex-col gap-4 rounded-lg border border-line bg-ink-950/60 p-4">
      <div className="flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-slate-300" />
        <h2 className="text-sm font-semibold text-slate-200">{t('resume.skill.heading')}</h2>
        {view && (
          <Tag tone={view.source === 'builtin' ? 'jade' : 'amber'} data-skill-source={view.source}>
            {t(view.source === 'builtin' ? 'resume.skill.sourceBuiltin' : 'resume.skill.sourceCustom')}
          </Tag>
        )}
        {isDirty && (
          <Tag tone="celadon" data-skill-dirty="true">
            {t('resume.skill.dirty')}
          </Tag>
        )}
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{t('resume.skill.hint')}</p>

      {view ? (
        <p data-skill-readout className="text-[11px] leading-relaxed text-slate-500">
          {t('resume.skill.version', { version: view.version })} ·{' '}
          {t('resume.skill.chars', { chars: view.chars, max: view.maxChars })} ·{' '}
          {t('resume.skill.updatedAt', {
            when: formatClock(view.updatedAt, t('resume.skill.neverSaved')),
          })}
        </p>
      ) : (
        <p data-skill-readout-empty className="text-[11px] leading-relaxed text-slate-500">
          {t('resume.skill.readoutEmpty')}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <DeskTextarea
          action="skill-body"
          data-skill-field="body"
          value={draft}
          onValueChange={setDraft}
          maxLength={view?.maxChars}
          rows={10}
          placeholder={t('resume.skill.bodyPlaceholder')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <DeskButton
            action="skill-save"
            markers={{ 'skill-action': 'save' }}
            variant="line"
            compact
            busy={busy === t('resume.skill.save')}
            disabled={saveReason !== undefined}
            disabledReason={saveReason}
            disabledReasonLabel={reasonLabel(saveReason)}
            onClick={save}
          >
            <Save size={12} />
            {t('resume.skill.save')}
          </DeskButton>
          <DeskButton
            action="skill-reset"
            markers={{ 'skill-action': 'reset' }}
            variant="amber"
            compact
            busy={busy === t('resume.skill.reset')}
            disabled={resetReason !== undefined}
            disabledReason={resetReason}
            disabledReasonLabel={reasonLabel(resetReason)}
            onClick={reset}
          >
            <RefreshCw size={12} />
            {t('resume.skill.reset')}
          </DeskButton>
          <span data-skill-no-delete className="text-[11px] leading-relaxed text-slate-500">
            {t('resume.skill.noDeleteHint')}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <ListChecks className="h-4 w-4 text-slate-300" />
            {t('resume.skill.requiredHeading')}
          </p>
          {requiredRows && (
            <p data-skill-required-summary className="text-[11px] text-slate-400">
              {t('resume.skill.requiredCount', { present: presentCount, total: requiredTotal })}
            </p>
          )}
        </div>
        {docId === '' ? (
          <p data-skill-required-empty="no_doc" className="text-[11px] leading-relaxed text-slate-500">
            {t('resume.skill.requiredNoDoc')}
          </p>
        ) : requiredRows === undefined ? (
          <p data-skill-required-empty="source_missing" className="text-[11px] leading-relaxed text-amber">
            {t('resume.skill.requiredSourceMissing')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {requiredRows.map((row) => (
              <li
                key={row.id}
                data-skill-required={row.id}
                data-skill-required-status={row.status}
                className={`flex flex-wrap items-baseline gap-2 rounded border px-2 py-1 text-[11px] ${BLOCK_EDGE_CLASS[REQUIRED_STATUS_TONE[row.status]]} ${BLOCK_SURFACE_CLASS}`}
              >
                <span className="text-slate-200">{t(row.labelKey)}</span>
                <Tag tone={row.severity === 'core' ? 'seal' : 'celadon'}>
                  {t(row.severity === 'core' ? 'resume.skill.severityCore' : 'resume.skill.severityRecommended')}
                </Tag>
                <Tag tone={REQUIRED_STATUS_TONE[row.status]}>{t(REQUIRED_STATUS_LABEL_KEY[row.status])}</Tag>
              </li>
            ))}
          </ul>
        )}
        {requiredRows !== undefined && coreMissing > 0 && (
          <p data-skill-core-missing={coreMissing} className="text-[11px] leading-relaxed text-seal">
            {t('resume.skill.coreMissing', { count: coreMissing })}
          </p>
        )}
      </div>

      {notice && (
        <Banner data-skill-notice tone={noticeTone} size="compact">
          {notice}
        </Banner>
      )}
    </div>
  );
}
