/**
 * 会话这一条入口的三个动作（spec 5.6-07）：新建、重命名、软删，外加一栏「已删除的会话」作为恢复途径。
 *
 * 为什么单独成一个组件（AGENTS.md §5.10）：这三只按钮改的是 `chat_session` 那一行的标题与删除标记，
 * 与消息流、档位、免确认白名单都不是同一件事；混进 ChatPanel 的头部就会让「当前会话叫什么」有两个来源。
 * 标题显示只读快照里那一份（`session` prop 递进来），组件自己不留副本（§2.7 禁第二份事实）。
 * 恢复途径为什么是一栏而不是一句「撤销」提示：撤销一旦只存在于内存里，重启之后那行数据就再没有途径捞回来，
 * 「软删」在用户眼里就等同于硬删——判据要防的正是这个。
 *
 * 2026-10-19 对话面板按参考图重排（设计稿 v2 的 `.bar`）：这一条**就是面板唯一的顶栏**——
 * 原先它上面还有一条 `Bot` 图标 + 「对话」标题的横条，两条都在说"这是对话"，而参考图那一行说的是
 * "这是哪一条会话"。于是那条退掉，这一条收到 46px：文件夹图标 + 会话名 + 行级动作（改名/删除收成图标键），
 * 右侧留给「新建会话」与调用方递进来的那一位读数（`headExtra`）。
 */
import { FolderOpen, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSessionView } from '@auto-cc/shared';
import { DeskButton, InlineEditField } from './ui/controls';
import { DeskExplainer } from './ui/disclosure';
import { useBridgeAction } from './useBridgeAction';

/**
 * 取会话 id 的短码，给没起过名的那条一个指得名的称呼。
 * @param id 会话 id（UUID 串，主进程 `randomUUID()` 生成的那一份）
 * @returns 前 8 位；它只是显示用的抓手，真正定位一条会话靠的还是完整 id
 */
function shortCode(id: string): string {
  return id.slice(0, 8);
}

/**
 * 顶栏那两只行级动作（改名 / 删除）的几何：设计稿 v2 的 `.icon` 是一枚 30px 的 ghost 方块。
 * 文案收进 `sr-only` 与 `title`（同一做法的先前例证是 PDF 编辑屏的墨色键），图标居中靠 `justify-center`：
 * 原件的 `compact` 档给的是 `px-2`，不居中时 11px 的图标会贴在左边。
 */
const BAR_ICON_CLASS = 'h-[30px] w-[30px] justify-center';

/**
 * 会话操作带（面板的唯一顶栏）：标题 + 改名/删除/新建 + 已删栏 + 一行提示。
 * @param session 当前会话的读数，来自 ChatPanel 那份快照；快照未回来时为 undefined（按钮先禁用）
 * @param read ChatPanel 的快照读取函数；每个动作跑完都调一次，界面不猜主进程当下的状态
 * @param headExtra 条尾右侧的那一位读数（对话面板把 `chat-workflow-mirror` 递进来）：
 *   它说的是"此刻哪个 runner 在动"，归属顶栏的几何，但事实只有 ChatPanel 那份订阅知道，所以走槽位而不是让本组件去订阅（§2.5）
 * @returns 面板最上面的一条 46px 窄带，没有软删过会话时已删栏整块不渲染
 */
export function ChatSessionBar({
  session,
  read,
  headExtra,
}: {
  session: ChatSessionView | undefined;
  read: () => Promise<unknown>;
  headExtra?: ReactNode;
}) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [trash, setTrash] = useState<ChatSessionView[]>();
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  /** 重读已删栏：能不能恢复、要恢复哪一条，都以库里 `deleted_at` 那一列为准。 */
  const readTrash = useCallback(async () => {
    const reply = await bridge?.chat['session.trashed']();
    if (reply?.ok) setTrash(reply.value);
  }, [bridge]);

  const refresh = useCallback(async () => {
    await Promise.all([read(), readTrash()]);
  }, [read, readTrash]);

  useEffect(() => {
    void readTrash();
  }, [readTrash]);

  const { busy, notice, run: call } = useBridgeAction(refresh);
  const code = session ? shortCode(session.id) : '';
  const isBusy = busy !== undefined;

  /**
   * 把输入框里的名字交给主进程（空串不提交：那只按钮此刻是禁用的，键盘回车也要挡在同一判据上）。
   * 成功后收起输入框；失败时留着草稿——拒因原文已经在那行提示里，怎么改由人决定。
   */
  const saveTitle = () => {
    if (!titleDraft.trim()) return;
    void call(t('chat.session.actionRename', { code }), () => bridge?.chat['session.rename'](titleDraft), {
      apply: () => {
        setEditing(false);
        setTitleDraft('');
      },
    });
  };

  return (
    <div data-testid="chat-session-bar">
      <div className="flex min-h-[46px] items-center gap-1.5 px-4">
        {editing ? (
          <>
            {/* 形态②「就地编辑」（09 稿）：标题原地变输入框，Enter 提交 / Esc 还原由原件负责，本组件不再自己长一套键盘语义 */}
            <div className="min-w-0 flex-1">
              <InlineEditField
                action="edit-session-title"
                data-testid="chat-session-title-input"
                value={titleDraft}
                onValueChange={setTitleDraft}
                placeholder={t('chat.session.titlePlaceholder')}
                disabled={isBusy}
                disabledReason={isBusy ? 'ACTION_BUSY' : undefined}
                disabledReasonLabel={isBusy ? t('chat.session.reason.ACTION_BUSY') : undefined}
                onSave={saveTitle}
                onCancel={() => setEditing(false)}
              />
            </div>
            {/* 存标题写的是本机那半张会话表 → amber，不是 jade：jade 只给「读过了 / 核过了」，
                一个还没落笔的保存键不该自称已核（流程屏的计划保存同一口径）。 */}
            <DeskButton
              action="save-title"
              variant="amber"
              compact
              busy={isBusy}
              disabled={!titleDraft.trim()}
              disabledReason={!titleDraft.trim() ? 'INPUT_EMPTY' : undefined}
              disabledReasonLabel={titleDraft.trim() ? undefined : t('chat.session.reasonEmptyTitle')}
              onClick={saveTitle}
            >
              {t('chat.session.saveTitle')}
            </DeskButton>
            <DeskButton action="cancel-rename" variant="ghost" compact onClick={() => setEditing(false)}>
              {t('chat.session.cancel')}
            </DeskButton>
          </>
        ) : (
          <>
            {/* 图标 + 会话名是这一条的身份（设计稿 v2 `.bar .title`）：原先那条「对话」标题横条退掉后，
                顶栏只说"这是哪一条会话"，不再说"这是对话"。 */}
            <FolderOpen size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
            <span
              data-session-title={session?.title ?? ''}
              data-session-id={session?.id ?? ''}
              className="min-w-0 truncate text-sm font-medium text-slate-50"
            >
              {session?.title ?? t('chat.session.untitled', { code })}
            </span>
            <DeskButton
              action="rename-session"
              variant="ghost"
              compact
              className={BAR_ICON_CLASS}
              title={t('chat.session.rename')}
              disabled={session === undefined || isBusy}
              disabledReason={session === undefined ? 'NO_SESSION_SNAPSHOT' : undefined}
              disabledReasonLabel={session === undefined ? t('chat.session.reasonNoSession') : undefined}
              onClick={() => {
                setTitleDraft(session?.title ?? '');
                setEditing(true);
              }}
            >
              <Pencil size={12} />
              <span className="sr-only">{t('chat.session.rename')}</span>
            </DeskButton>
            <DeskButton
              action="delete-session"
              variant="ghost"
              compact
              className={BAR_ICON_CLASS}
              title={t('chat.session.delete')}
              busy={isBusy}
              disabled={session === undefined}
              disabledReason={session === undefined ? 'NO_SESSION_SNAPSHOT' : undefined}
              disabledReasonLabel={session === undefined ? t('chat.session.reasonNoSession') : undefined}
              onClick={() =>
                void call(t('chat.session.actionDelete', { code }), () => bridge?.chat['session.remove'](), {
                  apply: () => setEditing(false),
                  describe: (view) => t('chat.session.deleted', { code: shortCode(view.id) }),
                })
              }
            >
              <Trash2 size={12} />
              <span className="sr-only">{t('chat.session.delete')}</span>
            </DeskButton>
            {/* 条尾右侧：调用方那一位读数 + 「新建会话」。新建与改名/删除不是一类动作（它换掉整段上下文），
                所以留文案、用描边档，而两件行级动作收成图标。 */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {headExtra}
              <DeskButton
                action="new-session"
                variant="line"
                compact
                busy={isBusy}
                onClick={() => void call(t('chat.actionNewSession'), () => bridge?.chat['session.startSession']())}
              >
                <Plus size={12} />
                {t('chat.newSession')}
              </DeskButton>
            </div>
          </>
        )}
      </div>

      {/* 这两句规矩（改名 28 字 / 删除 30 字）原先常驻在会话条下面一行，把「名字 + 三颗键」这一条
          撑成两行高。收进披露层：明面只留一行短问句，两支既有 testid 跟着搬进正文（不改名，
          5.6-07 的读数还按同一支取）。 */}
      <DeskExplainer
        id="chat.session.hints"
        className="px-4 pb-2"
        label={t('chat.session.hintsToggle')}
        markers={{ testid: 'chat-session-hints' }}
      >
        {editing ? (
          <p data-testid="chat-session-title-hint">{t('chat.session.titleHint')}</p>
        ) : (
          <p data-testid="chat-session-delete-hint">{t('chat.session.deleteHint')}</p>
        )}
      </DeskExplainer>

      {trash && trash.length > 0 ? (
        <div data-testid="chat-session-trash" className="border-t border-line bg-ink-850 px-4 py-2">
          <p className="text-[10px] text-slate-500" data-trash-count={String(trash.length)}>
            {t('chat.session.trashHeading', { total: trash.length })}
          </p>
          <ul className="mt-1 max-h-24 space-y-1 overflow-y-auto">
            {trash.map((row) => (
              <li
                key={row.id}
                data-trash-session-id={row.id}
                className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 max-w-[50%] truncate text-slate-400">
                  {row.title ?? t('chat.session.untitled', { code: shortCode(row.id) })}
                </span>
                <DeskButton
                  action="restore-session"
                  variant="amber"
                  compact
                  busy={isBusy}
                  className="ml-auto"
                  onClick={() =>
                    void call(t('chat.session.actionRestore', { code: shortCode(row.id) }), () =>
                      bridge?.chat['session.restore'](row.id),
                    )
                  }
                >
                  <RotateCcw size={10} />
                  {t('chat.session.restore')}
                </DeskButton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? (
        <p className="border-t border-line px-4 py-1.5 text-[11px] text-slate-300" data-testid="chat-session-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
