/**
 * 会话历史（2026-11-02 用户裁定）：顶栏右侧那颗历史键打开的抽屉。
 *
 * 它同时承担两件事：选一条会话继续（`chat.session.select`）与删掉任意一条（`chat.session.remove(id)`）。
 * 删除入口从顶栏那颗盲删键搬到这里之后，人在删之前先看得见这条会话叫什么、有多少条消息；
 * 恢复口随同一条裁定退场，所以删除是单向的，抽屉里用两步 armed 键代替一次误点。
 * 读的一侧只认 `chat.session.list()`（未删会话），组件不另存一份清单（§2.7）。
 */
import { History } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSessionView } from '@auto-cc/shared';
import { ArmButton, DeskButton, Tag } from './ui/controls';
import { Drawer } from './ui/overlays';
import { formatClock } from './format';
import { useBridgeAction } from './useBridgeAction';

/** 顶栏图标档的几何，与 `ChatSessionBar` 那几颗同一档（30px ghost 方块）。 */
const ICON_CELL_CLASS = 'h-[30px] w-[30px] justify-center';

/**
 * 取会话 id 的短码，给没起过名的那条一个指得名的称呼。
 * @param id 会话 id
 * @returns 前 8 位
 */
function shortCode(id: string): string {
  return id.slice(0, 8);
}

/**
 * 会话历史键 + 历史抽屉。
 * @param sessionId 当前会话 id（快照未回来时为 undefined）；历史里用它标出「此刻在看哪一条」
 * @param onChanged 选中/删除之后让 ChatPanel 重读快照的回调（界面不猜主进程当下的会话）
 * @returns 一颗历史图标键与它按需展开的抽屉
 */
export function ChatHistoryDrawer({ sessionId, onChanged }: { sessionId?: string; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChatSessionView[]>();

  /** 重读未删会话清单；事实只有 `chat.session.list()` 那一份。 */
  const readList = useCallback(async () => {
    const reply = await bridge?.chat['session.list']();
    if (reply?.ok) setRows(reply.value);
  }, [bridge]);

  /** 动作跑完同时刷新清单与 ChatPanel 的快照：删掉/选中当前会话时两边都得跟着动。 */
  const refresh = useCallback(async () => {
    await Promise.all([readList(), onChanged()]);
  }, [onChanged, readList]);

  const { busy, notice, run: call } = useBridgeAction(refresh);
  const isBusy = busy !== undefined;

  useEffect(() => {
    if (open) void readList();
  }, [open, readList]);

  return (
    <>
      <DeskButton
        action="chat-history"
        variant="ghost"
        compact
        className={ICON_CELL_CLASS}
        tip={t('chat.session.history')}
        tipPlacement="bottom"
        tipAlign="end"
        busy={isBusy}
        onClick={() => setOpen(true)}
      >
        <History size={13} />
        <span className="sr-only">{t('chat.session.history')}</span>
      </DeskButton>
      <Drawer
        action="chat-history"
        open={open}
        title={t('chat.session.historyTitle')}
        subtitle={t('chat.session.historySubtitle')}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col gap-2">
          {rows && rows.length === 0 ? (
            <p data-testid="chat-history-empty" className="text-[12px] text-slate-400">
              {t('chat.session.historyEmpty')}
            </p>
          ) : null}
          <ul data-testid="chat-history-list" className="flex flex-col gap-1.5">
            {(rows ?? []).map((row) => {
              const isCurrent = row.id === sessionId;
              return (
                <li
                  key={row.id}
                  data-history-session-id={row.id}
                  data-current={isCurrent ? 'true' : 'false'}
                  className={`flex items-center gap-2 rounded-control border px-2.5 py-2 ${
                    isCurrent ? 'border-slate-300/70 bg-ink-800' : 'border-line bg-ink-900/60'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] text-slate-100">
                      {row.title ?? t('chat.session.untitled', { code: shortCode(row.id) })}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-500">
                      <span>{formatClock(row.createdAt, '', 'minute')}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t('chat.session.historyCount', { count: row.messageCount })}</span>
                    </p>
                  </div>
                  {isCurrent ? (
                    <Tag tone="jade" data-testid="chat-history-current">
                      {t('chat.session.historyCurrent')}
                    </Tag>
                  ) : (
                    <DeskButton
                      action="history-continue"
                      variant="line"
                      compact
                      busy={isBusy}
                      markers={{ testid: 'chat-history-continue', 'session-id': row.id }}
                      onClick={() =>
                        void call(
                          t('chat.session.historyActionSelect', { code: shortCode(row.id) }),
                          () => bridge?.chat['session.select'](row.id),
                          { apply: () => setOpen(false) },
                        )
                      }
                    >
                      {t('chat.session.historyContinue')}
                    </DeskButton>
                  )}
                  <ArmButton
                    action="history-delete"
                    confirmAction="history-delete-confirm"
                    variant="seal"
                    compact
                    busy={isBusy}
                    markers={{ testid: 'chat-history-delete', 'session-id': row.id }}
                    onConfirm={() =>
                      void call(
                        t('chat.session.historyActionDelete', { code: shortCode(row.id) }),
                        () => bridge?.chat['session.remove'](row.id),
                        { describe: (view) => t('chat.session.historyDeleted', { code: shortCode(view.id) }) },
                      )
                    }
                    armedLabel={t('chat.session.historyDeleteConfirm')}
                  >
                    {t('chat.session.historyDelete')}
                  </ArmButton>
                </li>
              );
            })}
          </ul>
          {notice ? (
            <p data-testid="chat-history-notice" className="text-[11px] text-slate-300">
              {notice}
            </p>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}
