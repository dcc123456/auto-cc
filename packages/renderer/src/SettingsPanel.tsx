import { Info, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShellStatus } from '@auto-cc/shared';
import { DeskButton } from './ui/controls';
import { DeskSection } from './ui/disclosure';

/**
 * 设置页的「关于」段（spec 9.1-02）：只摆用户需要知道的应用版本与运行环境。
 *
 * 原来的桥接自检、主进程崩溃探针、定位实验室、工作流实验台与插件树都已退场；
 * 这些能力仍在主进程与 harness 里，产品界面不再给它们入口。
 * @returns 一格只读运行环境读数 + 一颗重新读取键
 */
export function SettingsPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ShellStatus>();
  const bridge = window.autoCC;

  /** 读一次主进程状态；失败时保留上一份读数（界面不拿空白冒充成功）。 */
  const read = useCallback(async () => {
    const reply = await bridge?.shell.getStatus();
    if (reply?.ok) setStatus(reply.value);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const value = (reading?: string | boolean): string =>
    reading === undefined ? t('status.idle') : reading === '' ? t('status.none') : String(reading);

  return (
    <DeskSection
      id="settings.about"
      defaultOpen
      markers={{ testid: 'settings-panel' }}
      title={
        <span className="flex items-center gap-2">
          <Info size={14} />
          {t('settings.aboutHeading')}
        </span>
      }
      summary={
        <span data-testid="settings-version">
          {status === undefined ? t('status.idle') : t('settings.versionReading', { version: status.appVersion })}
        </span>
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-[11px] leading-relaxed text-slate-400">{t('settings.aboutHint')}</p>
        <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2" data-testid="settings-runtime">
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] text-slate-500">{t('status.app')}</dt>
            <dd className="break-all text-[11px] text-slate-300">{value(status?.appVersion)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] text-slate-500">{t('status.electron')}</dt>
            <dd className="break-all text-[11px] text-slate-300">{value(status?.electronVersion)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] text-slate-500">{t('status.node')}</dt>
            <dd className="break-all text-[11px] text-slate-300">{value(status?.nodeVersion)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-[11px] text-slate-500">{t('status.platform')}</dt>
            <dd className="break-all text-[11px] text-slate-300">{value(status?.platform)}</dd>
          </div>
        </dl>
        <DeskButton action="settings-refresh" variant="line" compact onClick={() => void read()}>
          <RefreshCw size={12} />
          {t('settings.refresh')}
        </DeskButton>
      </div>
    </DeskSection>
  );
}
