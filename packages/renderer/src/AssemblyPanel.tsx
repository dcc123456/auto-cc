import { Boxes, RefreshCw, ScrollText, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LogLineView, LogStatusView, PluginNodeView } from '@auto-cc/shared';

/** 状态 → 颜色：只有 Tailwind 静态类名，避免运行期拼类名导致样式缺失。 */
const STATE_CLASS: Record<PluginNodeView['state'], string> = {
  active: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  pending: 'bg-amber-950 text-amber-300 border-amber-800',
  failed: 'bg-rose-950 text-rose-300 border-rose-800',
  loading: 'bg-sky-950 text-sky-300 border-sky-800',
  disposed: 'bg-slate-800 text-slate-400 border-slate-700',
  unloading: 'bg-slate-800 text-slate-400 border-slate-700',
};

/** 日志区最多显示的行数，事件推送时按此截断。 */
const LOG_LIMIT = 30;

interface Tree {
  nodes: PluginNodeView[];
  manifestError?: string;
}

/**
 * 装配面板：把 `cordis.yml` 实际装出来的插件树与主进程日志摆到界面上。
 *
 * 1.3 的验收要求「注掉一行，界面上就少一个节点」「依赖缺席显示等待而不是整屏报错」，
 * 这些都只能从进程内读出来，所以这里是只读观察窗，不提供任何写操作。
 *
 * 1.4 起数据走网关直连：树来自 `kernel.tree`，日志来自 `log.tail` / `log.status`，
 * 并且订阅 `log/line` 事件实时追加——不再轮询，也不再由 shell 代理。
 */
export function AssemblyPanel() {
  const { t } = useTranslation();
  const [tree, setTree] = useState<Tree | undefined>();
  const [lines, setLines] = useState<LogLineView[] | undefined>();
  const [logStatus, setLogStatus] = useState<LogStatusView | undefined>();
  /** 本次会话里由 `log/line` 事件推进来的条数，是 1.4-03 的界面证据。 */
  const [pushed, setPushed] = useState(0);
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [treeReply, tailReply, statusReply] = await Promise.all([
      bridge?.kernel.tree(),
      bridge?.log.tail(LOG_LIMIT),
      bridge?.log.status(),
    ]);
    if (treeReply?.ok) setTree(treeReply.value);
    if (tailReply?.ok) setLines(tailReply.value);
    if (statusReply?.ok) setLogStatus(statusReply.value);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('log/line', (line) => {
      setPushed((count) => count + 1);
      setLines((current) => [...(current ?? []), line].slice(-LOG_LIMIT));
    });
  }, [bridge]);

  const probeRedact = async () => {
    await bridge?.shell.probeRedact();
    await read();
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Boxes size={16} />
            {t('assembly.heading')}
          </h2>
          <button
            type="button"
            onClick={() => void read()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw size={14} />
            {t('assembly.refresh')}
          </button>
        </div>

        {tree?.manifestError && (
          <p className="mt-3 rounded-md border border-rose-800 bg-rose-950 px-3 py-2 text-xs text-rose-300">
            {t('assembly.manifestError', { message: tree.manifestError })}
          </p>
        )}

        <ul className="mt-3 flex flex-col gap-2">
          {(tree?.nodes ?? []).map((node) => (
            <li key={node.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-200">{node.id}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATE_CLASS[node.state]}`}>
                  {t(`state.${node.state}`)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {node.dependsOn.length > 0
                  ? t('assembly.dependsOn', { names: node.dependsOn.join(', ') })
                  : t('assembly.root')}
                {' · '}
                {node.keys.length > 0
                  ? t('assembly.configKeys', { names: node.keys.join(', ') })
                  : t('assembly.configNone')}
              </p>
              {node.error && <p className="mt-1 break-all text-[11px] text-rose-300">{node.error}</p>}
            </li>
          ))}
          {(tree?.nodes.length ?? 0) === 0 && <li className="text-xs text-slate-500">{t('assembly.empty')}</li>}
        </ul>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <ScrollText size={16} />
            {t('assembly.logHeading')}
          </h2>
          <button
            type="button"
            onClick={() => void probeRedact()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <ShieldCheck size={14} />
            {t('assembly.probeRedact')}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {logStatus?.file ? t('assembly.logFile', { path: logStatus.file }) : t('assembly.logNoFile')}
          {' · '}
          {t('assembly.logLevel', { level: logStatus?.level ?? 'none' })}
          {' · '}
          {t('assembly.logPushed', { count: pushed })}
        </p>
        <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto font-mono text-[11px] leading-relaxed text-slate-400">
          {(lines ?? []).map((line, index) => (
            <li key={`${String(line.ts)}-${String(index)}`} className="break-all">
              <span className="text-slate-600">{new Date(line.ts).toLocaleTimeString()}</span>{' '}
              <span className="text-slate-500">{line.level.toUpperCase()}</span>{' '}
              <span className="text-slate-300">[{line.name}]</span> {line.text}
            </li>
          ))}
          {(lines?.length ?? 0) === 0 && <li className="text-slate-500">{t('assembly.logEmpty')}</li>}
        </ul>
      </section>
    </div>
  );
}
