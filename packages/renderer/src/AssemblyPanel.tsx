import { Boxes, Play, RefreshCw, Repeat, Save, ScrollText, ShieldCheck, SlidersHorizontal, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DevtoolsStatusView,
  IpcStatsView,
  LogLineView,
  LogStatusView,
  PluginCycleView,
  PluginNodeView,
  PluginStatusView,
  PluginTreeSnapshot,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';
import { Banner, DeskButton, DeskTextarea, Tag, type BannerTone } from './ui/controls';

/**
 * 插件状态 → 语气档，按「这一格现在系统在做什么」分四族（plan §5）：`active`（已挂上、正常）= 玉；
 * `loading` / `unloading`（正在挂或正在卸）= 青瓷——进行中的系统动作，和步骤行 `running` 同一档；
 * `failed` = 朱砂；`pending` / `disposed` 都还没有任何事在发生 = 不给档位（`Tag` 的中性回执档）。
 * 原先 `disposed` 与 `unloading` 共用一套灰，看起来像「卸载早就完了」，现在把在卸的那一档分开画。
 * 这里存 tone 名而不是 class 串：wash 只在 `src/ui/**` 里拼（6.2-19），面板只声明档位。
 */
const STATE_TONE: Record<PluginNodeView['state'], BannerTone | undefined> = {
  active: 'jade',
  pending: undefined,
  failed: 'seal',
  loading: 'celadon',
  disposed: undefined,
  unloading: 'celadon',
};

/** 日志区最多显示的行数，事件推送时按此截断。 */
const LOG_LIMIT = 30;
/** 面板自读间隔：太短会让网关统计被自家轮询刷满，太长则截图读不到刚发生的调用。 */
const READ_INTERVAL_MS = 2000;

/** 泄漏巡检的默认轮次（spec 1.5-08 要求 20 次）。 */
const CYCLE_ROUNDS = 20;

/**
 * 装配面板：插件树、运行指标、错误历史与启停 / 热更新入口。
 *
 * 1.3 时它是只读观察窗；1.4 起数据走网关直连；1.5 起它变成**可操作**的调试器——
 * 停一个插件、把它挂回来、改它的配置并立刻生效，全部不重启进程（spec 1.5-02 … 1.5-08）；
 * 1.6 起它是**可被脚本定位**的面板：行与动作带机读锚点，网关与 CDP 读数显示在顶部（spec 1.6-12 / 1.6-13）。
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
  /** 泄漏巡检的读数，跑完一轮就摊在界面上（spec 1.5-08）。 */
  const [cycle, setCycle] = useState<PluginCycleView>();
  /** 网关入站统计（spec 1.6-12）：harness 的成功率断言读界面上这三项，而不是猜时序。 */
  const [ipcStats, setIpcStats] = useState<IpcStatsView>();
  /** 主进程侧的自测通道读数（spec 1.6-01 / 1.6-06），与 CDP `/json/list` 三方对照。 */
  const [devtools, setDevtools] = useState<DevtoolsStatusView>();
  /** 配置编辑器：打开时先把当前生效值读进来，保存走 JSON 补丁。 */
  const [editing, setEditing] = useState<{ id: string; text: string; mounted: boolean }>();
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [treeReply, statusReply, tailReply, logStatusReply, ipcReply, devtoolsReply] = await Promise.all([
      bridge?.kernel.tree(),
      bridge?.plugins.status(),
      bridge?.log.tail(LOG_LIMIT),
      bridge?.log.status(),
      bridge?.ipc.stats(),
      bridge?.devtools.status(),
    ]);
    if (treeReply?.ok) setTree(treeReply.value);
    if (statusReply?.ok) setStatus(statusReply.value);
    if (tailReply?.ok) setLines(tailReply.value);
    if (logStatusReply?.ok) setLogStatus(logStatusReply.value);
    if (ipcReply?.ok) setIpcStats(ipcReply.value);
    if (devtoolsReply?.ok) setDevtools(devtoolsReply.value);
  }, [bridge]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);

  /** 面板读数要随调用变化（spec 1.6-12）：harness 发完调用得能在界面上读到新值，所以按固定间隔重读。 */
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('log/line', (line) => {
      setPushed((count) => count + 1);
      setLines((current) => [...(current ?? []), line].slice(-LOG_LIMIT));
    });
  }, [bridge]);

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

  /** 反复启停巡检（spec 1.5-08）：结果不止「跑完了」，而是把三项漂移摊在界面上，截图本身就能当验收证据。 */
  const runCycle = (id: string) =>
    void run(t('assembly.actionCycle', { id }), () => bridge?.plugins.cycle(id, CYCLE_ROUNDS), {
      apply: setCycle,
      describe: (report) => t('assembly.cycleOk', { id: report.id, rounds: report.rounds }),
    });

  const saveConfig = async () => {
    if (!editing) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editing.text);
    } catch (error) {
      // 解析失败根本不该发进主进程：先把原因留在界面上，省得用户以为已经保存了。
      setNotice(t('assembly.jsonInvalid', { message: error instanceof Error ? error.message : String(error) }), 'seal');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setNotice(t('assembly.jsonInvalid', { message: t('assembly.jsonRootObject') }), 'seal');
      return;
    }
    await run(
      t('assembly.actionSave'),
      () => bridge?.plugins.saveConfig(editing.id, parsed as Record<string, unknown>),
      {
        describe: failedNotice,
      },
    );
  };

  /**
   * 在途那一拍的原因码：这一屏五只动作口（配置 / 停用 / 启用 / 巡检 / 保存）都走
   * `useBridgeAction`，跑着的时候再按一次会把插件树搅成半新半旧，所以整屏共用一支码。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`assembly.reason.${code}`);

  const metrics = status?.metrics;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Boxes size={16} />
            {t('assembly.heading')}
          </h2>
          <DeskButton
            action="assembly-refresh"
            variant="line"
            compact
            busy={!!busy}
            disabled={busyReason !== undefined}
            disabledReason={busyReason}
            disabledReasonLabel={reasonLabel(busyReason)}
            onClick={() => void read()}
          >
            <RefreshCw size={14} />
            {t('assembly.refresh')}
          </DeskButton>
        </div>

        {tree?.manifestError && (
          <Banner tone="seal" className="mt-3">
            {t('assembly.manifestError', { message: tree.manifestError })}
          </Banner>
        )}

        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span>
            {t('assembly.metricRegistry', { size: metrics?.registrySize ?? 0, counter: metrics?.registryCounter ?? 0 })}
          </span>
          <span>{t('assembly.metricEffects', { total: metrics?.effectTotal ?? 0 })}</span>
          <span>{t('assembly.metricResources', { num: metrics?.activeResources ?? 0 })}</span>
          <span>{t('assembly.metricGuarded', { names: (status?.guarded ?? []).join(', ') })}</span>
        </p>

        {/* 自测通道读数（spec 1.6-01 / 1.6-06 / 1.6-12）：harness 用 data-stat 锚点读它，
            因此这里刻意不用 data-row-id——那个选择器必须只命中插件行。 */}
        <div className="mt-2 rounded-lg border border-line bg-ink-950/60 px-3 py-2">
          <p className="text-[11px] font-semibold text-slate-300">{t('assembly.channelHeading')}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500" data-stat="ipc">
            <span>
              {t('assembly.metricIpc', {
                inFlight: ipcStats?.inFlight ?? 0,
                completed: ipcStats?.completed ?? 0,
                denied: ipcStats?.denied ?? 0,
              })}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500" data-stat="devtools">
            <span>
              {devtools?.isCdpEnabled
                ? t('assembly.metricCdpOn', { port: devtools.cdpPort ?? 0 })
                : t('assembly.metricCdpOff')}
            </span>
            <span>{t('assembly.metricTargets', { num: devtools?.targetCount ?? 0 })}</span>
            <span>{devtools?.isPackaged ? t('assembly.metricPackaged') : t('assembly.metricDev')}</span>
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-slate-500" data-stat="targets">
            {(devtools?.targets ?? []).map((target) => (
              <li key={String(target.id)} data-target-id={String(target.id)}>
                {t('assembly.targetRow', {
                  id: target.id,
                  title: target.title,
                  kind: target.isMainWindow ? t('assembly.targetKindWindow') : t('assembly.targetKindView'),
                  focus: target.isFocused ? t('assembly.targetFocused') : t('assembly.targetUnfocused'),
                })}
              </li>
            ))}
          </ul>
        </div>

        {notice && (
          <Banner tone={noticeTone} markers={{ testid: 'action-notice' }} className="mt-2">
            {notice}
          </Banner>
        )}

        <ul className="mt-3 flex flex-col gap-2">
          {(tree?.nodes ?? []).map((node) => {
            const guarded = status?.guarded.includes(node.id) ?? false;
            const mounted = node.state === 'active' || node.state === 'loading' || node.state === 'unloading';
            // data-row-id / data-action 是给 harness 的机读锚点：脚本按插件 id 与动作定位，
            // 不依赖可见文案，所以切到英文界面后同一套命令仍然命中（spec 1.6-13）。
            return (
              <li key={node.id} data-row-id={node.id} className="rounded-lg border border-line bg-ink-950/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-200">{node.id}</span>
                    <Tag tone={STATE_TONE[node.state]}>{t(`state.${node.state}`)}</Tag>
                    {guarded && (
                      <span className="flex items-center gap-1 text-[11px] text-slate-500">
                        <ShieldCheck size={12} />
                        {t('assembly.guarded')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {/* 归属色按「这个动作动到谁」：整屏没有任何一步离开这台机器，所以**零朱砂**——
                        「配置」只是把当前生效值读进编辑框，一行都不写 → `line`；
                        「停用 / 启用 / 巡检」改的是本机运行期的插件树 → `amber`；
                        「保存」写运行期配置（§9：配置层从不落盘）→ 同一档 `amber`。 */}
                    <DeskButton
                      action="config"
                      variant="line"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() => void openEditor(node.id)}
                    >
                      <SlidersHorizontal size={12} />
                      {t('assembly.editConfig')}
                    </DeskButton>
                    {mounted && !guarded && (
                      <DeskButton
                        action="stop"
                        variant="amber"
                        compact
                        busy={!!busy}
                        disabled={busyReason !== undefined}
                        disabledReason={busyReason}
                        disabledReasonLabel={reasonLabel(busyReason)}
                        onClick={() =>
                          void run(t('assembly.actionStop', { id: node.id }), () => bridge?.plugins.stop(node.id))
                        }
                      >
                        <Square size={12} />
                        {t('assembly.stop')}
                      </DeskButton>
                    )}
                    {(node.state === 'disposed' || node.state === 'failed') && (
                      <DeskButton
                        action="start"
                        variant="amber"
                        compact
                        busy={!!busy}
                        disabled={busyReason !== undefined}
                        disabledReason={busyReason}
                        disabledReasonLabel={reasonLabel(busyReason)}
                        onClick={() =>
                          void run(t('assembly.actionStart', { id: node.id }), () => bridge?.plugins.start(node.id), {
                            describe: failedNotice,
                          })
                        }
                      >
                        <Play size={12} />
                        {t('assembly.start')}
                      </DeskButton>
                    )}
                    {mounted && !guarded && (
                      <DeskButton
                        action="cycle"
                        variant="amber"
                        compact
                        busy={!!busy}
                        disabled={busyReason !== undefined}
                        disabledReason={busyReason}
                        disabledReasonLabel={reasonLabel(busyReason)}
                        onClick={() => void runCycle(node.id)}
                      >
                        <Repeat size={12} />
                        {t('assembly.cycle')}
                      </DeskButton>
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
                {node.error && <p className="mt-1 break-all text-[11px] text-seal">{node.error}</p>}
              </li>
            );
          })}
          {(tree?.nodes.length ?? 0) === 0 && <li className="text-xs text-slate-400">{t('assembly.empty')}</li>}
        </ul>

        {editing && (
          // 编辑框在行之外，所以给它自己的锚点 data-editor-for 来标明归属；
          // 刻意不复用 data-row-id，否则 `dom --selector '[data-row-id]'` 会多出一行、与主进程 id 集合不再相等（spec 1.6-03 / 1.6-13）。
          <div data-editor-for={editing.id} className="mt-3 rounded-lg border border-line bg-ink-950/80 p-3">
            <p className="text-[11px] text-slate-400">
              {t('assembly.editorHeading', { id: editing.id })}
              {' · '}
              {editing.mounted ? t('assembly.editorMounted') : t('assembly.editorUnmounted')}
            </p>
            <DeskTextarea
              action="assembly-config"
              data-editor="config"
              className="mt-2 h-32 w-full px-2 py-2 font-mono"
              value={editing.text}
              onValueChange={(value) => setEditing({ ...editing, text: value })}
              spellCheck={false}
            />
            <div className="mt-2 flex items-center gap-2">
              <DeskButton
                action="save"
                variant="amber"
                compact
                busy={!!busy}
                disabled={busyReason !== undefined}
                disabledReason={busyReason}
                disabledReasonLabel={reasonLabel(busyReason)}
                onClick={() => void saveConfig()}
              >
                <Save size={12} />
                {t('assembly.saveConfig')}
              </DeskButton>
              <DeskButton action="cancel" variant="ghost" compact onClick={() => setEditing(undefined)}>
                {t('assembly.cancel')}
              </DeskButton>
            </div>
          </div>
        )}

        {cycle && (
          <Banner tone="celadon" markers={{ testid: 'cycle-report' }} className="mt-3">
            {t('assembly.cycleReport', {
              id: cycle.id,
              rounds: cycle.rounds,
              size: cycle.sizeDrift,
              effects: cycle.effectDrift,
              resources: cycle.resourceDrift,
              before: cycle.before.registrySize,
              after: cycle.after.registrySize,
            })}
          </Banner>
        )}
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <ShieldCheck size={16} />
          {t('assembly.errorHeading', { num: status?.errorCount ?? 0 })}
        </h2>
        <ul className="mt-2 flex flex-col gap-1">
          {(status?.errors ?? []).map((error, index) => (
            <li key={`${error.id}-${String(index)}`}>
              <details className="rounded-md border border-line bg-ink-950/60 px-3 py-2">
                <summary className="cursor-pointer text-[11px] text-seal">
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

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <ScrollText size={16} />
            {t('assembly.logHeading')}
          </h2>
          <DeskButton action="assembly-probe-redact" variant="line" compact onClick={() => void probeRedact()}>
            <ShieldCheck size={14} />
            {t('assembly.probeRedact')}
          </DeskButton>
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
            <li key={`${String(line.ts)}-${String(index)}`} data-log-level={line.level} className="break-all">
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
