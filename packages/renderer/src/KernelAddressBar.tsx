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
  }, [read]);

  const { busy, notice, noticeTone, run } = useBridgeAction(read);
  const navigate = () => {
    const url = draft.trim();
    if (url === '') return;
    void run(t('kernel.address.navigate'), () => bridge?.browser['page.navigate'](url));
  };

  const urlEmpty = draft.trim() === '';
  const reason = busy !== undefined ? 'ACTION_BUSY' : urlEmpty ? 'URL_EMPTY' : undefined;

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line px-2 py-1.5" data-testid="kernel-address-bar">
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
