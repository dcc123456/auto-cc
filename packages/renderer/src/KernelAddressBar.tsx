/**
 * 内嵌浏览器的地址栏（spec 10.11-27）：手输网址 + 刷新，落在内核视图上报矩形之外。
 *
 * 为什么抽成共用组件：画布分栏（`KernelCanvasSlot`）与侧栏（`KernelViewSlot`）两处都要这一条，
 * 复制第二份就是 §2.5 的两个入口。导航复用既有 `browser.page.navigate`，判据仍是
 * `URL_EMPTY` / `ACTION_BUSY` 两个原因码，不写第二套 URL 校验。
 *
 * 后退：`packages/shared` 的 bridge 里没有历史后退口（只有 navigate / snapshot），
 * 这里不擅自新增 IPC，按钮置灰并把原因写在可见处。
 */
import { ArrowLeft, CornerDownLeft, RefreshCw } from 'lucide-react';
import { advanceViewTrail } from './viewTrail';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton, DeskField } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/** 可刷新的地址：协议闸只放 http/https，占位页（`data:`）与空串都不是。 */
const isRefreshableUrl = (url: string): boolean => /^https?:/i.test(url);

/** 地址栏本体的读数：当前地址与忙碌态。 */
export function KernelAddressBar() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [draft, setDraft] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  // 上一次从主进程读到的地址：输入框只在「人没改过」时跟着它走，人打过字就不抢人的草稿。
  const lastReadUrl = useRef('');

  /**
   * 读一次内核视图当前 URL（只读，不触发导航）。
   * @returns 主进程此刻报的地址（读不到时为空串）；调用方按它决定能不能刷新
   */
  const read = useCallback(async (): Promise<string> => {
    const reply = await bridge?.shell['getStatus']();
    if (!reply?.ok) return '';
    const url = reply.value.kernelViewUrl;
    setCurrentUrl(url);
    setDraft((previous) => (previous === '' || previous === lastReadUrl.current ? url : previous));
    lastReadUrl.current = url;
    return url;
  }, [bridge]);

  useEffect(() => {
    void read();
    // 地址栏挂载时内核视图可能刚被挂上、`shell.getStatus()` 还回占位 URL；补一次短延迟重读，
    // 让输入框里出现真实地址（否则「刷新」会因为没有当前地址而按不动）。
    const timer = window.setTimeout(() => {
      void read();
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [read]);

  // 站点视图显隐、窗口回到前台都重读一次：会话有可能是在「面板已经开着」的时候才被打开的，
  // 那时没有任何推送会告诉我们地址变了（事件白名单里没有导航事件），只靠挂载那一次会一直停在占位 URL。
  useEffect(() => {
    if (!bridge) return;
    const offVisible = bridge.on('shell/kernel-view-visible', () => void read());
    const onFocus = (): void => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      offVisible?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge, read]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);
  const navigate = () => {
    const url = draft.trim();
    if (url === '') return;
    void run(t('kernel.address.navigate'), () => bridge?.browser['page.navigate'](url));
  };

  /**
   * 刷新：**先现读一次地址再导航**。挂载时读到的可能是占位 `data:` 页，拿它去导航会被协议闸拒
   * （实测提示「刷新 失败：不允许的协议 data:」），而这正是「面板开着时站点才被打开」的那条路径。
   */
  const reload = async (): Promise<void> => {
    const url = await read();
    if (!isRefreshableUrl(url)) {
      setNotice(t('kernel.address.reasonNoCurrent'), 'seal');
      return;
    }
    await run(t('kernel.address.reload'), () => bridge?.browser['page.navigate'](url));
  };

  // 还没有打开过站点：内核视图停在 data: 占位页或 URL 为空。给「为什么没有 + 怎么起来」，
  // 不留一张空白页（spec 10.11-29）；恢复入口就是既有会话屏，不新开页面。
  const noSession = currentUrl === '' || currentUrl.startsWith('data:');
  const urlEmpty = draft.trim() === '';
  const reason = busy !== undefined ? 'ACTION_BUSY' : urlEmpty ? 'URL_EMPTY' : undefined;

  return (
    <div
      className="flex h-10 shrink-0 flex-col justify-center border-b border-line px-2"
      data-testid="kernel-address-bar"
    >
      <div className="flex min-w-0 items-center gap-1">
        <DeskButton
          action="kernel-address-back"
          variant="ghost"
          compact
          disabled
          disabledReason="HISTORY_UNAVAILABLE"
          disabledReasonLabel={t('kernel.address.backUnavailable')}
        >
          <ArrowLeft size={12} />
          <span className="sr-only">{t('kernel.address.back')}</span>
        </DeskButton>
        <DeskField
          action="kernel-address-url"
          data-testid="kernel-address-url"
          value={draft}
          onValueChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              navigate();
            }
          }}
          placeholder={t('kernel.address.placeholder')}
          className="min-w-0 flex-1"
        />
        <DeskButton
          action="kernel-address-go"
          variant="solid"
          compact
          busy={busy !== undefined}
          disabled={reason !== undefined}
          disabledReason={reason}
          disabledReasonLabel={
            reason === 'ACTION_BUSY'
              ? t('kernel.address.reasonBusy')
              : reason === 'URL_EMPTY'
                ? t('kernel.address.reasonUrlEmpty')
                : undefined
          }
          onClick={navigate}
        >
          <CornerDownLeft size={12} />
          <span className="sr-only">{t('kernel.address.go')}</span>
        </DeskButton>
        <DeskButton
          action="kernel-address-reload"
          variant="ghost"
          compact
          busy={busy !== undefined}
          disabled={currentUrl === '' || busy !== undefined}
          disabledReason={currentUrl === '' ? 'NO_CURRENT_URL' : busy !== undefined ? 'ACTION_BUSY' : undefined}
          disabledReasonLabel={
            currentUrl === ''
              ? t('kernel.address.reasonNoCurrent')
              : busy !== undefined
                ? t('kernel.address.reasonBusy')
                : undefined
          }
          onClick={() => void reload()}
        >
          <RefreshCw size={12} />
          <span className="sr-only">{t('kernel.address.reload')}</span>
        </DeskButton>
      </div>
      {noSession ? (
        <p
          className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400"
          data-testid="kernel-address-no-session"
        >
          {t('kernel.address.noSession')}
          <DeskButton
            action="kernel-address-open-session"
            variant="line"
            compact
            onClick={() =>
              advanceViewTrail({
                sourceView: 'chat',
                sourceTitle: t('nav.chat'),
                targetView: 'trust',
                targetTitle: t('desk.trust.title'),
                targetDetail: t('kernel.address.noSession'),
              })
            }
          >
            {t('kernel.address.openSession')}
          </DeskButton>
        </p>
      ) : null}
      {notice ? (
        <p
          className={`text-[10.5px] ${noticeTone === 'seal' ? 'text-seal-ink' : 'text-slate-400'}`}
          data-testid="kernel-address-notice"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
