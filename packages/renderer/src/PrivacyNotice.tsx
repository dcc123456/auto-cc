/**
 * 首屏隐私声明与使用条款（spec 5.9-06）。
 *
 * 为什么是"补一屏"而不是给 `ConsentCard` 加两句：2.7-e 那张卡的判据是**某个平台的自动化风险**，
 * 由"要动手了"这个事件触发、签字写进 `automation_consents` 表、作用域跟着 platform 走——它回答不了
 * "这个 app 把我的数据放在哪儿、什么时候会离开本机"。5.9-06 要的正是后者，而且要出现在**首屏**，
 * 所以这是一层独立的、第一次启动就挡在工作台前面的声明；两处共用 `Modal` 原件（同一套遮罩、Esc 层级、
 * 滚动锁、footer 装配），不共用事实（plan §7.7.1 F24）。
 *
 * 它**不占 09 稿"全 app 只允许 5 只弹窗"的那笔预算**：这一屏本来就是 `role="dialog"` + `aria-modal` 的
 * 挡路浮层，只是自己手搓了一套 `fixed inset-0 z-50`——换到原件上是把第二套基础设施删掉，不是新增第 6 只
 * 弹窗（判据同一句："不做完阅读就无法负责"）。记录见 plan §3.9。
 *
 * 确认状态落在渲染层 localStorage 而不是新开一张表：与 `auto-cc.lang`、`auto-cc.metrics.range`
 * 同一条判据（plan §7.6.2 决策十八）——它不驱动任何业务动作，主进程不需要知道它，为"看过没有"
 * 开迁移反而引入第二份事实源。代价也如实写在这：换一份 userData 就等于没看过，首屏会再出现一次，
 * 而这恰好是 5.9-06 要的"首启动"语义。
 */
import { FileText, ShieldCheck } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatClock } from './format';
import { DeskButton } from './ui/controls';
import { Modal } from './ui/overlays';

/** 确认标记键：与 `auto-cc.lang` 同一份 localStorage，前缀同为 `auto-cc.`。 */
const PRIVACY_ACK_STORAGE_KEY = 'auto-cc.privacy.acknowledged';

/**
 * 读回「首屏声明表过态没有」。
 *
 * 存的东西来自 localStorage，形状没有任何保证（用户手改、旧版本残留都算），所以只认
 * 一个能解析出正整数的形状，其余一律当「没看过」——把脏值当成已确认，等于让一次损坏的写入
 * 永久关掉合规首屏。
 * @returns 确认时刻的毫秒时间戳；没看过或读数不可信时为 null
 */
function readAcknowledgedAt(): number | null {
  const stored = localStorage.getItem(PRIVACY_ACK_STORAGE_KEY);
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const acknowledgedAt = (parsed as Record<string, unknown>).acknowledgedAt;
    if (typeof acknowledgedAt !== 'number' || !Number.isFinite(acknowledgedAt) || acknowledgedAt <= 0) {
      return null;
    }
    return acknowledgedAt;
  } catch {
    return null;
  }
}

/**
 * 这一屏的三态：首启动未表态 / 已表态收起 / 表态过又主动重开。
 *
 * 为什么不给 `visible` + `isReopened` 两个布尔：那两个布尔有第四种组合（不可见却"是重开"），
 * 而按钮文案与"要不要写确认标记"恰好都由这同一个事实决定——一个枚举把它们钉成互斥。
 */
type NoticeState = 'first-run' | 'dismissed' | 'reopened';

/**
 * 首屏声明的挂载与表态状态（`App` 里用一次：首启动自动出现，标题栏那颗按钮负责随时重开）。
 * @returns `visible` 当前是否显示这一屏；`isReopened` 这次是主动重看而不是首启动；`open` 重新打开；`close` 收起（首启动那一次会写确认标记）
 */
export function usePrivacyNotice(): {
  visible: boolean;
  isReopened: boolean;
  open: () => void;
  close: () => void;
} {
  // 「是不是首启动」只在这一次 useState 里判：localStorage 同步可读，不用等 bridge 回来再闪一帧。
  const [state, setState] = useState<NoticeState>(() => (readAcknowledgedAt() === null ? 'first-run' : 'dismissed'));

  /**
   * 收起这一屏。首启动那一次顺手把"已读"写进 localStorage——写入失败不拦住用户
   * （下一启动再问一次是可接受的代价，"点了没反应"才是真故障），所以这里不接 bridge，只用 localStorage。
   */
  const close = useCallback((): void => {
    if (state === 'first-run') {
      localStorage.setItem(PRIVACY_ACK_STORAGE_KEY, JSON.stringify({ acknowledgedAt: Date.now() }));
    }
    setState('dismissed');
  }, [state]);

  const open = useCallback((): void => setState('reopened'), []);

  return { visible: state !== 'dismissed', isReopened: state === 'reopened', open, close };
}

/** `PrivacyNotice` 的输入。 */
export interface PrivacyNoticeProps {
  /** 收起这一屏（首启动时即"已读"表态，重开时只是关掉）。 */
  onClose: () => void;
  /** 已经进过一次工作台、这次是主动重看：按钮文案换成"回到工作台"，并多一行"此前已确认"的读数。 */
  isReopened: boolean;
}

/**
 * 一节声明：小标题 + 若干行正文。
 *
 * 标题与行都由调用方**翻译好**再传进来（而不是在这里拿变量当键去查）：§5.5 那条机检只认代码里
 * 写死的字符串键，键一旦变成变量就查不出拼写漂移，宁可让外层多写几行。
 * @param props.title 小节标题
 * @param props.lines 该节的正文行
 */
const Section = ({ title, lines }: { title: string; lines: readonly string[] }) => (
  <section className="mt-3">
    <h3 className="text-xs font-semibold text-slate-200">{title}</h3>
    <ul className="mt-1 flex flex-col gap-1">
      {lines.map((line, lineIndex) => (
        <li key={lineIndex} className="text-[11px] leading-relaxed text-slate-400">
          {line}
        </li>
      ))}
    </ul>
  </section>
);

/**
 * 隐私声明与使用条款首屏本体。
 * @param props 见 `PrivacyNoticeProps`
 */
export function PrivacyNotice({ onClose, isReopened }: PrivacyNoticeProps) {
  const { t } = useTranslation();

  // 列表键用下标是刻意的：这些行永远在本组件里静态存在，没有增删与排序，
  // 用文案本身当 key 反而会让翻译改动触发整节重挂。
  const dataLines = [
    t('privacy.dataLocal'),
    t('privacy.dataDir'),
    t('privacy.dataKeptAfterUninstall'),
    t('privacy.noTelemetry'),
  ];
  const networkLines = [t('privacy.netAutomation'), t('privacy.netLlm'), t('privacy.netNoBackground')];
  const resumeLines = [t('privacy.resumeNeverAuto'), t('privacy.resumeApprovalChain'), t('privacy.resumePauseAnytime')];
  const riskLines = [t('privacy.riskPlatform'), t('privacy.riskConsentCard'), t('privacy.riskNoEvasion')];
  const termsLines = [t('privacy.termsSelfUse'), t('privacy.termsNoWarranty'), t('privacy.termsUpdateChoice')];

  return (
    <Modal
      action="privacy"
      open
      width="640"
      testId="privacy-notice"
      markers={{ reopened: isReopened ? 'true' : 'false' }}
      // 重看那一次只是关掉一屏，三条退路全给；首启动那一次是"在本机写下表态"，一条都不留（09 稿⑤ 的入场判据）。
      dismissOnScrim={isReopened}
      closeLabel={t('privacy.close')}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck size={16} aria-hidden="true" className="text-jade" />
          {t('privacy.heading')}
        </span>
      }
      footer={
        <>
          {isReopened && (
            <p className="mr-auto text-[11px] text-slate-500" data-testid="privacy-already-acknowledged">
              {t('privacy.acknowledgedRow', {
                time: formatClock(readAcknowledgedAt(), t('privacy.never')),
              })}
            </p>
          )}
          <DeskButton action="privacy-acknowledge" variant={isReopened ? 'ghost' : 'amber'} onClick={onClose}>
            <ShieldCheck size={14} />
            {isReopened ? t('privacy.close') : t('privacy.acknowledge')}
          </DeskButton>
        </>
      }
    >
      <p className="text-[11px] text-slate-500">{t('privacy.intro')}</p>

      <div className="mt-3 rounded-md border border-jade/40 bg-jade-wash px-3 py-2">
        <p className="text-[11px] font-semibold text-jade">{t('privacy.keyPromise')}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{t('privacy.keyPromiseDetail')}</p>
      </div>

      <Section title={t('privacy.dataTitle')} lines={dataLines} />
      <Section title={t('privacy.netTitle')} lines={networkLines} />
      <Section title={t('privacy.resumeTitle')} lines={resumeLines} />
      <Section title={t('privacy.riskTitle')} lines={riskLines} />
      <Section title={t('privacy.termsTitle')} lines={termsLines} />

      <p className="mt-3 flex items-center gap-1 text-[11px] text-slate-500">
        <FileText size={12} />
        {t('privacy.licensesPointer')}
      </p>
    </Modal>
  );
}
