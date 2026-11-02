/**
 * 会话这一条入口的两个动作（spec 5.6-07）：新建、重命名；删除与继续对话搬进右侧的会话历史抽屉。
 *
 * 为什么单独成一个组件（AGENTS.md §5.10）：这几只按钮改的是 `chat_session` 那一行的标题，
 * 与消息流、档位、免确认白名单都不是同一件事；混进 ChatPanel 的头部就会让「当前会话叫什么」有两个来源。
 * 标题显示只读快照里那一份（`session` prop 递进来），组件自己不留副本（§2.7 禁第二份事实）。
 * 2026-11-02 用户裁定把「删除会话」从顶栏拿掉、换成「会话历史」：删除要在看得见全部会话的地方做，
 * 恢复栏随这条裁定一起退场（删除从此是一条单向的表态），历史抽屉里既能选一条继续，也能删掉任意一条。
 *
 * 2026-10-19 对话面板按参考图重排（设计稿 v2 的 `.bar`）：这一条**就是面板唯一的顶栏**——
 * 原先它上面还有一条 `Bot` 图标 + 「对话」标题的横条，两条都在说"这是对话"，而参考图那一行说的是
 * "这是哪一条会话"。于是那条退掉，这一条收到 46px：文件夹图标 + 会话名 + 改名，右侧是调用方递进来的
 * 那一组图标档动作（`rightActions`：免确认白名单）与「会话历史」「新建会话」。
 */
import { FolderOpen, Pencil, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSessionView } from '@auto-cc/shared';
import { ChatHistoryDrawer } from './ChatHistoryDrawer';
import { DeskButton, InlineEditField } from './ui/controls';
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
 * 行级动作（改名）的几何：设计稿 v2 的 `.icon` 是一枚 30px 的 ghost 方块。
 * 文案收进 `sr-only` 与气泡（`tip`），图标居中靠 `justify-center`：
 * 原件的 `compact` 档给的是 `px-2`，不居中时 11px 的图标会贴在左边。
 */
const BAR_ICON_CLASS = 'h-[30px] w-[30px] justify-center';

/**
 * 会话操作带（面板的唯一顶栏）：标题 + 改名 + 历史/新建 + 一行提示。
 * @param session 当前会话的读数，来自 ChatPanel 那份快照；快照未回来时为 undefined（按钮先禁用）
 * @param read ChatPanel 的快照读取函数；每个动作跑完都调一次，界面不猜主进程当下的状态
 * @param rightActions 条尾右侧的那一组图标档动作（对话面板递进免确认白名单那一颗）：
 *   状态只有 ChatPanel 知道，本组件不另存一份（§2.7）
 * @returns 面板最上面的一条 46px 窄带
 */
export function ChatSessionBar({
  session,
  read,
  rightActions,
}: {
  session: ChatSessionView | undefined;
  read: () => Promise<unknown>;
  rightActions?: ReactNode;
}) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const { busy, notice, run: call } = useBridgeAction(read);
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
              tip={t('chat.session.rename')}
              tipPlacement="bottom"
              tipAlign="start"
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
            {/* 条尾右侧：调用方递进来的那一组图标档（免确认白名单）+ 会话历史 + 新建会话。
                历史换掉了原先那颗删除键：删除要在看得见全部会话的地方做，而不是对屏上这一条盲删。 */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {rightActions}
              <ChatHistoryDrawer sessionId={session?.id} onChanged={read} />
              <DeskButton
                action="new-session"
                variant="ghost"
                compact
                className={BAR_ICON_CLASS}
                busy={isBusy}
                tip={t('chat.newSession')}
                tipPlacement="bottom"
                tipAlign="end"
                onClick={() => void call(t('chat.actionNewSession'), () => bridge?.chat['session.startSession']())}
              >
                <Plus size={13} />
                <span className="sr-only">{t('chat.newSession')}</span>
              </DeskButton>
            </div>
          </>
        )}
      </div>

      {/* 改名那两句规矩原先常驻在会话条下面一行，把「名字 + 图标组」这一条撑成两行高
          （活体读数 75 而稿上是 46）。2026-10-19 按裁定搬进输入卡下面那只说明气泡；
          顶栏从此只有一条 46px。 */}

      {notice ? (
        <p className="border-t border-line px-4 py-1.5 text-[11px] text-slate-300" data-testid="chat-session-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
