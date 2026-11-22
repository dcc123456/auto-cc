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
import type { BridgeReply } from '@auto-cc/shared';

/**
 * 从一条地址里取出主机名用于提示文案；解析不了就原样给出（不吞掉那条地址，人还得看得到它）。
 * @param url 待解析的地址
 * @returns 主机名（含端口）或原字符串
 */
const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** 可刷新的地址：协议闸只放 http/https，占位页（`data:`）与空串都不是。 */
const isRefreshableUrl = (url: string): boolean => /^https?:/i.test(url);

/** 地址栏本体的读数：当前地址与忙碌态。 */
export function KernelAddressBar() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [draft, setDraft] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  /** 内核视图当下的模式（spec 10.11-30）：`web` 时这里多一个标记与「回到平台」出口，且助手对它只读。 */
  const [mode, setMode] = useState<'platform' | 'web'>('platform');
  /** 任意网页模式下落在平台域名上的那条地址（裁定 (a)：不自动切模式，只给一条可点的提示）。 */
  const [platformHint, setPlatformHint] = useState<string | null>(null);
  // 上一次从主进程读到的地址：输入框只在「人没改过」时跟着它走，人打过字就不抢人的草稿。
  const lastReadUrl = useRef('');

  /**
   * 把一份地址落到本栏的两个 state：输入框只在「人没改过」时跟随，人的草稿不抢。
   * @param url 主进程给的地址（可能是占位页）
   */
  const applyUrl = useCallback((url: string): void => {
    // 先把「上一次的地址」取出来再改 ref：函数式 updater 是稍后跑的，那时 ref 已经是新值，
    // 拿它去比会把刚读到的地址自己判成"人改过"而丢掉（本轮实测：事件到了、输入框还停在占位页）。
    const previousUrl = lastReadUrl.current;
    lastReadUrl.current = url;
    setCurrentUrl(url);
    setDraft((previous) => (previous === '' || previous === previousUrl ? url : previous));
  }, []);

  /**
   * 读一次内核视图当前 URL（只读，不触发导航）。
   * @returns 主进程此刻报的地址（读不到时为空串）；调用方按它决定能不能刷新
   */
  const read = useCallback(async (): Promise<string> => {
    const reply = await bridge?.shell['getStatus']();
    if (!reply?.ok) return '';
    applyUrl(reply.value.kernelViewUrl);
    setMode(reply.value.kernelViewMode);
    setPlatformHint(reply.value.kernelViewPlatformHint);
    return reply.value.kernelViewUrl;
  }, [bridge, applyUrl]);

  useEffect(() => {
    void read();
    // 地址栏挂载时内核视图可能刚被挂上、`shell.getStatus()` 还回占位 URL；补一次短延迟重读，
    // 让输入框里出现真实地址（否则「刷新」会因为没有当前地址而按不动）。
    const timer = window.setTimeout(() => {
      void read();
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [read]);

  // 模式一变（切进任意网页 / 回到平台 / 首帧挂上）视图就是新建的，`getStatus` 那一瞬还读不到地址；
  // 补一次短延迟重读，让人看到的是真实地址而不是一串空白（与挂载那次补读同一口径）。
  useEffect(() => {
    const timer = window.setTimeout(() => void read(), 1_200);
    return () => window.clearTimeout(timer);
  }, [mode, read]);

  // 地址变了由主进程推（`shell/kernel-view-url`，2026-11-22 裁定②：只在值真的变了时发）；
  // 显隐与窗口回前台再各补读一次，兜住「推送错过一次也还在」——读数仍以主进程那份为准。
  useEffect(() => {
    if (!bridge) return;
    // 地址事件的载荷只是地址，**模式**也在同一份读数里：统一走一次 `read`，
    // 免得「切进任意网页后输入框空着 / 标记不出现」这种两处各更新一半的状态（地址栏只有一个读数来源）。
    const offUrl = bridge.on('shell/kernel-view-url', () => void read());
    const offVisible = bridge.on('shell/kernel-view-visible', () => void read());
    const onFocus = (): void => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      offUrl?.();
      offVisible?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge, read, applyUrl]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);

  /**
   * 打开一份地址：按当下模式分流。
   * - 平台模式：仍走 `browser.page.navigate`（平台名单与签字判据一字不动）；
   * - 任意网页模式：走 `shell.openWebPage`（独立分区 `persist:web`，不过平台名单——正因如此助手只读）。
   * @param rawUrl 输入框里的地址（不可信输入；协议校验在壳层那一口做）
   */
  const open = (rawUrl: string): void => {
    const url = rawUrl.trim();
    if (url === '') return;
    // 两条通道的返回类型不同（快照 vs 壳层状态），这里只关心 ok/error，所以按 unknown 收口。
    const call = async (): Promise<BridgeReply<unknown>> =>
      mode === 'web' ? await bridge!.shell.openWebPage(url) : await bridge!.browser['page.navigate'](url);
    void run(t('kernel.address.navigate'), call);
  };
  const navigate = () => open(draft);
  /** 切进「任意网页」模式：显式入口，输入框里那条地址就是第一页（空输入给原因、什么都不发）。 */
  const enterWebMode = () => {
    if (draft.trim() === '') {
      setNotice(t('kernel.web.reasonEmpty'), 'seal');
      return;
    }
    void run(t('kernel.web.enter'), () => bridge?.shell.openWebPage(draft.trim()));
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
    const call = async (): Promise<BridgeReply<unknown>> =>
      mode === 'web' ? await bridge!.shell.openWebPage(url) : await bridge!.browser['page.navigate'](url);
    await run(t('kernel.address.reload'), call);
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
        {/* 模式标记与模式入口（spec 10.11-30）：web 模式下写明「助手只读」并给「回到平台」出口；
            平台模式下这里就是切进「任意网页」的显式入口——两条通道分开，平台名单判据一字不动。 */}
        {mode === 'web' ? (
          <span
            data-testid="kernel-address-web-mode"
            className="flex min-w-0 shrink items-center gap-1 text-[10.5px] text-amber"
            title={t('kernel.web.marker')}
          >
            <span className="truncate">{t('kernel.web.marker')}</span>
            <DeskButton
              action="kernel-web-back"
              variant="line"
              compact
              onClick={() => void run(t('kernel.web.back'), () => bridge?.shell.closeWebPage())}
            >
              {t('kernel.web.back')}
            </DeskButton>
          </span>
        ) : (
          <DeskButton
            action="kernel-web-enter"
            variant="ghost"
            compact
            title={t('kernel.web.enter')}
            onClick={enterWebMode}
          >
            {t('kernel.web.enter')}
          </DeskButton>
        )}
      </div>
      {platformHint ? (
        <p
          className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-amber"
          data-testid="kernel-web-platform-hint"
        >
          {t('kernel.web.platformHint', { host: safeHost(platformHint) })}
          <DeskButton
            action="kernel-web-switch-platform"
            variant="line"
            compact
            onClick={() => {
              // 人按的才算切换：先回到平台分区，再按平台名单导航到这条地址（判据一字不动）。
              void run(t('kernel.web.switchPlatform'), async (): Promise<BridgeReply<unknown>> => {
                const back = await bridge!.shell.closeWebPage();
                if (!back.ok) return back;
                return await bridge!.browser['page.navigate'](platformHint);
              });
            }}
          >
            {t('kernel.web.switchPlatform')}
          </DeskButton>
        </p>
      ) : null}
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
