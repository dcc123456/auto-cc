import { Boxes, Play, RefreshCw, Repeat, ScrollText, ShieldCheck, SlidersHorizontal, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BridgeReply,
  LogLineView,
  LogStatusView,
  PluginCycleView,
  PluginNodeView,
  PluginStatusView,
  PluginTreeSnapshot,
} from '@auto-cc/shared';

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

/** 泄漏巡检的默认轮次（spec 1.5-08 要求 20 次）。 */
const CYCLE_ROUNDS = 20;

/**
 * 装配面板：插件树、运行指标、错误历史与启停 / 热更新入口。
 *
 * 1.3 时它是只读观察窗；1.4 起数据走网关直连；1.5 起它变成**可操作**的调试器——
 * 停一个插件、把它挂回来、改它的配置并立刻生效，全部不重启进程（spec 1.5-02 … 1.5-08）。
 *
 * 所有动作都只调白名单里的 `plugins.*` 能力，面板自己不知道也不需要知道主进程的内部结构；
 * 每次动作之后统一 `read()` 重读快照，所以界面显示的永远是主进程当下的真相而不是乐观猜测。
 */
export function AssemblyPanel() {
  const { t } = useTranslation();
  const [tree, setTree] = useState<PluginTreeSnapshot>();
  const [status, setStatus] = useState<PluginStatusView>();
  const [lines, setLines] = useState<LogLineView[]>();
  const [logStatus, setLogStatus] = useState<LogStatusView>();
  /** 本次会话里由 `log/line` 事件推进来的条数，是 1.4-03 的界面证据。 */
  const [pushed, setPushed] = useState(0);
  /** 正在执行的动作标签，用来禁用按钮——重复点 Stop 会在同一个插件上叠两次卸载。 */
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [cycle, setCycle] = useState<PluginCycleView>();
  /** 配置编辑器：打开时先把当前生效值读进来，保存走 JSON 补丁。 */
  const [editing, setEditing] = useState<{ id: string; text: string; mounted: boolean }>();
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [treeReply, statusReply, tailReply, logStatusReply] = await Promise.all([
      bridge?.kernel.tree(),
      bridge?.plugins.status(),
      bridge?.log.tail(LOG_LIMIT),
      bridge?.log.status(),
    ]);
    if (treeReply?.ok) setTree(treeReply.value);
    if (statusReply?.ok) setStatus(statusReply.value);
    if (tailReply?.ok) setLines(tailReply.value);
    if (logStatusReply?.ok) setLogStatus(logStatusReply.value);
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

  /**
   * 跑一个动作并把结果写成一行提示。
   *
   * 面板是自测工具，不弹窗：失败原因（含字段级的配置错误）留在界面上，截图才能当验收证据。
   * 无论成败都重读快照——失败的插件状态是主进程改的，界面不该自己猜。
   * `describe` 用来覆盖提示：调用成功但插件重建失败时，「保存配置：成功」是句假话。
   */
  const run = async <T,>(
    label: string,
    call: () => Promise<BridgeReply<T>> | undefined,
    describe?: (value: T) => string | undefined,
  ) => {
    setBusy(label);
    const reply = await call();
    setBusy(undefined);
    if (!reply) setNotice(t('assembly.noBridge'));
    else if (reply.ok) setNotice(describe?.(reply.value) ?? t('assembly.actionOk', { action: label }));
    else setNotice(t('assembly.actionFailed', { message: reply.error.message }));
    await read();
  };

  /** 插件没起来时把它的错误抬到提示行，而不是让用户去树里找那行红字。 */
  const failedNotice = (node: PluginNodeView) =>
    node.state === 'failed' ? t('assembly.actionPluginFailed', { id: node.id, message: node.error ?? '' }) : undefined;

  const probeRedact = async () => {
    await bridge?.shell.probeRedact();
    await read();
  };

  const openEditor = async (id: string) => {
    const reply = await bridge?.plugins.readConfig(id);
    if (reply?.ok)
      setEditing({
        id: reply.value.id,
        text: JSON.stringify(reply.value.values, null, 2),
        mounted: reply.value.mounted,
      });
  };

  /**
   * 反复启停巡检（spec 1.5-08）：结果不止「跑完了」，而是把三项漂移摊在界面上，
   * 截图本身就能当验收证据。
   */
  const runCycle = async (id: string) => {
    setBusy(t('assembly.actionCycle', { id }));
    const reply = await bridge?.plugins.cycle(id, CYCLE_ROUNDS);
    setBusy(undefined);
    if (reply?.ok) {
      setCycle(reply.value);
      setNotice(t('assembly.cycleOk', { id: reply.value.id, rounds: reply.value.rounds }));
    } else if (reply) {
      setNotice(t('assembly.actionFailed', { message: reply.error.message }));
    }
    await read();
  };

  const saveConfig = async () => {
    if (!editing) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editing.text);
    } catch (error) {
      // 解析失败根本不该发进主进程：先把原因留在界面上，省得用户以为已经保存了。
      setNotice(t('assembly.jsonInvalid', { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setNotice(t('assembly.jsonInvalid', { message: t('assembly.jsonRootObject') }));
      return;
    }
    await run(
      t('assembly.actionSave'),
      () => bridge?.plugins.saveConfig(editing.id, parsed as Record<string, unknown>),
      failedNotice,
    );
  };

  const metrics = status?.metrics;

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

        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span>
            {t('assembly.metricRegistry', { size: metrics?.registrySize ?? 0, counter: metrics?.registryCounter ?? 0 })}
          </span>
          <span>{t('assembly.metricEffects', { total: metrics?.effectTotal ?? 0 })}</span>
          <span>{t('assembly.metricResources', { num: metrics?.activeResources ?? 0 })}</span>
          <span>{t('assembly.metricGuarded', { names: (status?.guarded ?? []).join(', ') })}</span>
        </p>

        {notice && (
          <p
            className="mt-2 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
            data-testid="action-notice"
          >
            {notice}
          </p>
        )}

        <ul className="mt-3 flex flex-col gap-2">
          {(tree?.nodes ?? []).map((node) => {
            const guarded = status?.guarded.includes(node.id) ?? false;
            const mounted = node.state === 'active' || node.state === 'loading' || node.state === 'unloading';
            return (
              <li key={node.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-200">{node.id}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATE_CLASS[node.state]}`}>
                      {t(`state.${node.state}`)}
                    </span>
                    {guarded && (
                      <span className="flex items-center gap-1 text-[11px] text-slate-500">
                        <ShieldCheck size={12} />
                        {t('assembly.guarded')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void openEditor(node.id)}
                      className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                    >
                      <SlidersHorizontal size={12} />
                      {t('assembly.editConfig')}
                    </button>
                    {mounted && !guarded && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() =>
                          void run(t('assembly.actionStop', { id: node.id }), () => bridge?.plugins.stop(node.id))
                        }
                        className="flex items-center gap-1 rounded-md border border-rose-800 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950 disabled:opacity-40"
                      >
                        <Square size={12} />
                        {t('assembly.stop')}
                      </button>
                    )}
                    {(node.state === 'disposed' || node.state === 'failed') && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() =>
                          void run(
                            t('assembly.actionStart', { id: node.id }),
                            () => bridge?.plugins.start(node.id),
                            failedNotice,
                          )
                        }
                        className="flex items-center gap-1 rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
                      >
                        <Play size={12} />
                        {t('assembly.start')}
                      </button>
                    )}
                    {mounted && !guarded && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void runCycle(node.id)}
                        className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                      >
                        <Repeat size={12} />
                        {t('assembly.cycle')}
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {node.dependsOn.length > 0
                    ? t('assembly.dependsOn', { names: node.dependsOn.join(', ') })
                    : t('assembly.root')}
                  {' · '}
                  {node.keys.length > 0
                    ? t('assembly.configKeys', { names: node.keys.join(', ') })
                    : t('assembly.configNone')}
                  {' · '}
                  {t('assembly.effectCount', {
                    num: metrics?.effects.find((item) => item.id === node.id)?.effects ?? 0,
                  })}
                </p>
                {node.error && <p className="mt-1 break-all text-[11px] text-rose-300">{node.error}</p>}
              </li>
            );
          })}
          {(tree?.nodes.length ?? 0) === 0 && <li className="text-xs text-slate-500">{t('assembly.empty')}</li>}
        </ul>

        {editing && (
          <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/80 p-3">
            <p className="text-[11px] text-slate-400">
              {t('assembly.editorHeading', { id: editing.id })}
              {' · '}
              {editing.mounted ? t('assembly.editorMounted') : t('assembly.editorUnmounted')}
            </p>
            <textarea
              className="mt-2 h-32 w-full rounded-md border border-slate-700 bg-slate-900 p-2 font-mono text-[11px] text-slate-200"
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              spellCheck={false}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void saveConfig()}
                className="flex items-center gap-1 rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
              >
                <Play size={12} />
                {t('assembly.saveConfig')}
              </button>
              <button
                type="button"
                onClick={() => setEditing(undefined)}
                className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              >
                {t('assembly.cancel')}
              </button>
            </div>
          </div>
        )}

        {cycle && (
          <p
            className="mt-3 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
            data-testid="cycle-report"
          >
            {t('assembly.cycleReport', {
              id: cycle.id,
              rounds: cycle.rounds,
              size: cycle.sizeDrift,
              effects: cycle.effectDrift,
              resources: cycle.resourceDrift,
              before: cycle.before.registrySize,
              after: cycle.after.registrySize,
            })}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <ShieldCheck size={16} />
          {t('assembly.errorHeading', { num: status?.errorCount ?? 0 })}
        </h2>
        <ul className="mt-2 flex flex-col gap-1">
          {(status?.errors ?? []).map((error, index) => (
            <li key={`${error.id}-${String(index)}`}>
              <details className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                <summary className="cursor-pointer text-[11px] text-rose-300">
                  <span className="font-mono">{error.id}</span> · {error.message}
                </summary>
                <p className="mt-1 text-[11px] text-slate-500">{new Date(error.at).toLocaleTimeString()}</p>
                {error.stack && <pre className="mt-1 overflow-x-auto text-[11px] text-slate-400">{error.stack}</pre>}
              </details>
            </li>
          ))}
          {(status?.errors.length ?? 0) === 0 && (
            <li className="text-[11px] text-slate-500">{t('assembly.errorEmpty')}</li>
          )}
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
