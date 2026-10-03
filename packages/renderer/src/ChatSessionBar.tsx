/**
 * 会话这一条入口的三个动作（spec 5.6-07）：新建、重命名、软删，外加一栏「已删除的会话」作为恢复途径。
 *
 * 为什么单独成一个组件（AGENTS.md §5.10）：这三只按钮改的是 `chat_session` 那一行的标题与删除标记，
 * 与消息流、档位、免确认白名单都不是同一件事；混进 ChatPanel 的头部就会让「当前会话叫什么」有两个来源。
 * 标题显示只读快照里那一份（`session` prop 递进来），组件自己不留副本（§2.7 禁第二份事实）。
 * 恢复途径为什么是一栏而不是一句「撤销」提示：撤销一旦只存在于内存里，重启之后那行数据就再没有途径捞回来，
 * 「软删」在用户眼里就等同于硬删——判据要防的正是这个。
 */
import { Check, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSessionView } from '@auto-cc/shared';
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
 * 会话操作带：标题 + 改名/删除/新建三只按钮 + 已删栏 + 一行提示。
 * @param session 当前会话的读数，来自 ChatPanel 那份快照；快照未回来时为 undefined（按钮先禁用）
 * @param read ChatPanel 的快照读取函数；每个动作跑完都调一次，界面不猜主进程当下的状态
 * @returns 贴在对话面板头部下方的一条窄带，没有软删过会话时已删栏整块不渲染
 */
export function ChatSessionBar({
  session,
  read,
}: {
  session: ChatSessionView | undefined;
  read: () => Promise<unknown>;
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

  /**
   * 改名输入框的键盘语义：回车提交、Esc 放弃（与发送框那套一致，不另立规则）。
   * @param event 键盘事件
   */
  const onTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveTitle();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
  };

  return (
    <div data-testid="chat-session-bar" className="border-b border-slate-800">
      <div className="flex items-center gap-2 px-4 py-2">
        {editing ? (
          <>
            <input
              data-testid="chat-session-title-input"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={onTitleKeyDown}
              placeholder={t('chat.session.titlePlaceholder')}
              disabled={isBusy}
              className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
            />
            <button
              type="button"
              data-action="save-title"
              disabled={isBusy || !titleDraft.trim()}
              onClick={saveTitle}
              className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
            >
              <Check size={11} />
              {t('chat.session.saveTitle')}
            </button>
            <button
              type="button"
              data-action="cancel-rename"
              onClick={() => setEditing(false)}
              className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              <X size={11} />
              {t('chat.session.cancel')}
            </button>
          </>
        ) : (
          <>
            <span
              data-session-title={session?.title ?? ''}
              data-session-id={session?.id ?? ''}
              className="min-w-0 max-w-[40%] truncate text-xs font-medium text-slate-200"
            >
              {session?.title ?? t('chat.session.untitled', { code })}
            </span>
            <button
              type="button"
              data-action="rename-session"
              disabled={session === undefined || isBusy}
              onClick={() => {
                setTitleDraft(session?.title ?? '');
                setEditing(true);
              }}
              className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Pencil size={11} />
              {t('chat.session.rename')}
            </button>
            <button
              type="button"
              data-action="delete-session"
              disabled={session === undefined || isBusy}
              onClick={() =>
                void call(t('chat.session.actionDelete', { code }), () => bridge?.chat['session.remove'](), {
                  apply: () => setEditing(false),
                  describe: (view) => t('chat.session.deleted', { code: shortCode(view.id) }),
                })
              }
              className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Trash2 size={11} />
              {t('chat.session.delete')}
            </button>
            <button
              type="button"
              data-action="new-session"
              disabled={isBusy}
              onClick={() => void call(t('chat.actionNewSession'), () => bridge?.chat['session.startSession']())}
              className="ml-auto flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Plus size={12} />
              {t('chat.newSession')}
            </button>
          </>
        )}
      </div>

      {editing ? (
        <p className="px-4 pb-2 text-[10px] text-slate-500" data-testid="chat-session-title-hint">
          {t('chat.session.titleHint')}
        </p>
      ) : (
        <p className="px-4 pb-2 text-[10px] text-slate-500" data-testid="chat-session-delete-hint">
          {t('chat.session.deleteHint')}
        </p>
      )}

      {trash && trash.length > 0 ? (
        <div data-testid="chat-session-trash" className="border-t border-slate-800 bg-slate-950/40 px-4 py-2">
          <p className="text-[10px] text-slate-500" data-trash-count={String(trash.length)}>
            {t('chat.session.trashHeading', { total: trash.length })}
          </p>
          <ul className="mt-1 max-h-24 space-y-1 overflow-y-auto">
            {trash.map((row) => (
              <li
                key={row.id}
                data-trash-session-id={row.id}
                className="flex items-center gap-2 rounded-md border border-slate-800 px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 max-w-[50%] truncate text-slate-400">
                  {row.title ?? t('chat.session.untitled', { code: shortCode(row.id) })}
                </span>
                <button
                  type="button"
                  data-action="restore-session"
                  disabled={isBusy}
                  onClick={() =>
                    void call(t('chat.session.actionRestore', { code: shortCode(row.id) }), () =>
                      bridge?.chat['session.restore'](row.id),
                    )
                  }
                  className="ml-auto flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                >
                  <RotateCcw size={10} />
                  {t('chat.session.restore')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? (
        <p
          className="border-t border-slate-800 px-4 py-1.5 text-[11px] text-slate-300"
          data-testid="chat-session-notice"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
