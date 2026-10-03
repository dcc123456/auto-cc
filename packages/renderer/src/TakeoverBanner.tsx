/**
 * 对话侧的接管横幅（spec 5.5-01）：页面现在在谁手里、因何接管、已经接管多久，以及那两只按钮。
 *
 * 判据里那句「界面明确显示已人工接管」要的是**一眼读得出**，所以这一条放在档位行下方、消息流之外——
 * 它不属于任何一条消息，属于此刻这块页面。三类读数（人按的 / 风控 / 登录失效）共用同一份
 * `browser.takeover.held()`，这里只是画它，不解释、不推导（AGENTS.md §2.5）。
 *
 * 恢复之后「那就接着跑」不在这张横幅上：交还页面与恢复那条 run 是两次分开表态，
 * 后者在计划卡的页脚上（`AgentRunPanel`，spec 5.5-01 的第二个动作）。
 */
import { Hand, MousePointerClick } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TakeoverStateView } from '@auto-cc/shared';
import { formatElapsed } from './format';

/**
 * 接管横幅。
 * @param state `browser.takeover.held()` 的读数；还没读回来时按「未接管」画（不猜）
 * @param elapsedMs 本轮已接管的毫秒时长，来自 `useTakeover`（它只扳重画，不另起一份账）
 * @param busy 正在执行的动作标签；非空时按钮禁用，防止连点
 * @param notice 上一次动作的提示行（失败原因留在界面上，截图才拿得到证据）
 * @param onHold 人按下「我来接管」
 * @param onRelease 人按下「交还页面」
 * @returns 一行常驻状态条：接管中是琥珀色的警示条，未接管是一行淡字加一颗接管按钮
 */
export function TakeoverBanner({
  state,
  elapsedMs,
  busy,
  notice,
  onHold,
  onRelease,
}: {
  state?: TakeoverStateView;
  elapsedMs: number;
  busy?: string;
  notice?: string;
  onHold: () => void;
  onRelease: () => void;
}) {
  const { t } = useTranslation();
  // 「在接管却读不出原因」在 5.5-a 的不变式里不出现（三个字段同生同灭，那边有用例钉着），
  // 但类型上允许 null。读到 null 时画一句「原因未知」，比把裸值甩到页面上诚实。
  const held = state?.isHeld ? state : undefined;

  return (
    <>
      <div
        data-testid="takeover-banner"
        data-takeover-held={String(held !== undefined)}
        data-takeover-reason={held?.reason ?? ''}
        data-takeover-elapsed={held ? formatElapsed(elapsedMs) : ''}
        className={`flex items-center gap-2 border-b px-4 py-2 text-[11px] ${
          held ? 'border-amber-900 bg-amber-950/40 text-amber-200' : 'border-slate-800 text-slate-500'
        }`}
      >
        <Hand size={12} />
        {held ? (
          <>
            <span className="font-semibold" data-takeover-heading>
              {t('chat.takeover.held')}
            </span>
            <span data-takeover-reason-label>
              {t(held.reason ? `chat.takeover.reason.${held.reason}` : 'chat.takeover.reason.unknown')}
            </span>
            <span data-takeover-duration>{t('chat.takeover.since', { duration: formatElapsed(elapsedMs) })}</span>
            <span className="ml-auto text-[10px] text-amber-400/70">{t('chat.takeover.heldHint')}</span>
            <button
              type="button"
              data-action="takeover-release"
              disabled={busy !== undefined}
              onClick={onRelease}
              className="flex items-center gap-1 rounded-md border border-amber-800 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
            >
              <MousePointerClick size={11} />
              {t('chat.takeover.release')}
            </button>
          </>
        ) : (
          <>
            <span>{t('chat.takeover.notHeld')}</span>
            <span className="ml-auto text-[10px] text-slate-500">{t('chat.takeover.notHeldHint')}</span>
            <button
              type="button"
              data-action="takeover-hold"
              disabled={busy !== undefined}
              onClick={onHold}
              className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Hand size={11} />
              {t('chat.takeover.hold')}
            </button>
          </>
        )}
      </div>
      {/* 提示行跟着横幅：按「交还」被主进程拒掉时（例如它已经不认这一轮），那句原话得留在截图里。 */}
      {notice ? (
        <p
          className="border-b border-slate-800 bg-slate-950/70 px-4 py-1.5 text-[11px] text-slate-300"
          data-testid="takeover-notice"
        >
          {notice}
        </p>
      ) : null}
    </>
  );
}
