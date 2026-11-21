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
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton, DeskField } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/** 地址栏本体的读数：当前地址与忙碌态。 */
export function KernelAddressBar() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [draft, setDraft] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');

  /** 读一次内核视图当前 URL（只读，不触发导航）。 */
  const read = useCallback(async () => {
    const reply = await bridge?.shell['getStatus']();
    if (reply?.ok) {
      setCurrentUrl(reply.value.kernelViewUrl);
      setDraft((previous) => (previous === '' ? reply.value.kernelViewUrl : previous));
    }
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

  const { busy, notice, noticeTone, run } = useBridgeAction(read);
  const navigate = () => {
    const url = draft.trim();
    if (url === '') return;
    void run(t('kernel.address.navigate'), () => bridge?.browser['page.navigate'](url));
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
          onClick={() => void run(t('kernel.address.reload'), () => bridge?.browser['page.navigate'](currentUrl))}
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
