/**
 * 对话侧的接管横幅（spec 5.5-01）：页面现在在谁手里、因何接管、已经接管多久，以及那两只按钮。
 *
 * 判据里那句「界面明确显示已人工接管」要的是**一眼读得出**，所以这一条不属任何一条消息、属于此刻这块页面。
 * 三类读数（人按的 / 风控 / 登录失效）共用同一份 `browser.takeover.held()`，这里只是画它，不解释、不推导（AGENTS.md §2.5）。
 *
 * 2026-10-19 设计稿 v2 那一版把它**压成一行**（用户裁定：「接管横幅压成一行」）：原先两态各占一条 36px 的带、
 * 未接管那一态还把「点了接管，后面的动作就停」整句摊在明面上，流上方因此多出两条常驻横带。
 * 现在只留「此刻在谁手里」那一行读数与那颗键，两句解释性长文改挂在按钮的气泡（`tip`）上——悬停仍然读得到，
 * 而这一条自己不该吃掉消息流的空间。
 *
 * 恢复之后「那就接着跑」不在这张横幅上：交还页面与恢复那条 run 是两次分开表态，
 * 后者在计划卡的页脚上（`AgentRunPanel`，spec 5.5-01 的第二个动作）。
 */
import { Hand, MousePointerClick } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TakeoverStateView } from '@auto-cc/shared';
import { Banner, DeskButton } from './ui/controls';
import { formatElapsed } from './format';

/**
 * 接管横幅。
 * @param state `browser.takeover.held()` 的读数；还没读回来时按「未接管」画（不猜）
 * @param elapsedMs 本轮已接管的毫秒时长，来自 `useTakeover`（它只扳重画，不另起一份账）
 * @param busy 正在执行的动作标签；非空时按钮禁用，防止连点
 * @param notice 上一次动作的提示行（失败原因留在界面上，截图才拿得到证据）
 * @param onHold 人按下「我来接管」
 * @param onRelease 人按下「交还页面」
 * @returns 一行常驻状态条：接管中是琥珀色的窄条，未接管是一行淡字加一颗接管按钮
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
      {held ? (
        // 接管中 = 这台机器在等人表态，按设计口径是琥珀那一档；通栏贴边（去掉圆角与左右边框）保持横幅的位置感。
        // 走原件的 `compact` 档而不是自配内边距：这一条要的就是"一行读数"那一档几何，语气色仍由 tone 给。
        <Banner
          tone="amber"
          size="compact"
          reason={held.reason ?? 'unknown'}
          markers={{
            testid: 'takeover-banner',
            'takeover-held': 'true',
            'takeover-reason': held.reason ?? '',
            'takeover-elapsed': formatElapsed(elapsedMs),
          }}
          className="rounded-none border-x-0 border-t-0 px-4"
          actions={
            // 「交还」那颗走条尾动作槽而不是 children：正文读数换行时同处一条 flex-wrap 行会被挤到下一行的是
            // 按钮，而这条横幅是「此刻页面在谁手里」的唯一读数，按钮必须常驻条尾。
            <DeskButton
              action="takeover-release"
              variant="amber"
              compact
              busy={busy !== undefined}
              tip={t('chat.takeover.heldHint')}
              tipPlacement="bottom"
              tipAlign="end"
              onClick={onRelease}
            >
              <MousePointerClick size={11} />
              {t('chat.takeover.release')}
            </DeskButton>
          }
        >
          <span className="font-semibold" data-takeover-heading>
            {t('chat.takeover.held')}
          </span>
          <span data-takeover-reason-label>
            {t(held.reason ? `chat.takeover.reason.${held.reason}` : 'chat.takeover.reason.unknown')}
          </span>
          <span data-takeover-duration>{t('chat.takeover.since', { duration: formatElapsed(elapsedMs) })}</span>
        </Banner>
      ) : (
        <div
          data-testid="takeover-banner"
          data-takeover-held="false"
          data-takeover-reason=""
          data-takeover-elapsed=""
          className="flex items-center gap-2 border-b border-line px-4 py-1 text-[11px] text-slate-400"
        >
          <Hand size={11} className="shrink-0" aria-hidden="true" />
          <span data-takeover-heading>{t('chat.takeover.notHeld')}</span>
          <DeskButton
            action="takeover-hold"
            compact
            className="ml-auto"
            busy={busy !== undefined}
            tip={t('chat.takeover.notHeldHint')}
            tipPlacement="bottom"
            tipAlign="end"
            onClick={onHold}
          >
            <Hand size={11} />
            {t('chat.takeover.hold')}
          </DeskButton>
        </div>
      )}
      {/* 提示行跟着横幅：按「交还」被主进程拒掉时（例如它已经不认这一轮），那句原话得留在截图里。 */}
      {notice ? (
        <p className="border-b border-line px-4 py-1.5 text-[11px] text-slate-300" data-testid="takeover-notice">
          {notice}
        </p>
      ) : null}
    </>
  );
}
