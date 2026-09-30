/**
 * 外发层用例的替身（`greet.test.ts` / `deliver.test.ts` 共用）。
 *
 * 只替一只手：`FakeSessionsService` 替「风险确认的签字记录」。真身在 L2 会话层且 `inject` 了
 * Electron 外壳（`shell`），在 Node 侧的用例里挂不起来；而这两份用例要验收的是
 * 「没签过字就一步都不许走」这条**判定顺序**，所以签字表必须能被用例拨到「没签」那一侧，
 * 闸门 / 账本 / 频控 / 话术一律用真实服务——把账本 mock 掉就等于没测「被拦下时没扣额度」。
 */
import { AppError, type ConsentGate, type Context, Service } from '@auto-cc/core';
import { z } from 'zod';

/** 替身的配置形状：无键，但构造器仍要接住 cordis 递来的第二个实参。 */
const fakeSessionsSchema = z.strictObject({});

/**
 * 假的 `sessions`：只回答「这个平台签过自动化风险确认吗」。
 *
 * 存在理由：`outbound.greet` / `outbound.deliver` 从 2.7-e 起把 `sessions` 列为硬依赖
 * （`consentGateOf` 读不到就抛），装配清单里没有它这两条链路整条停在 PENDING。
 * 签字表做成可增删的，用来演「第一次点确认之前，释放路径必须一步都不走」。
 */
export class FakeSessionsService extends Service implements ConsentGate {
  static provide = 'sessions';
  static Config = fakeSessionsSchema;

  /** 已签字的平台标识；真实实现把它放在 sqlite 里，这里只需要「签过 / 没签过」。 */
  private readonly granted = new Set<string>();

  /** 被问了多少次（spec 2.7-06 的读数：一次外发只该问一次，问出两次说明编排层在重复判定）。 */
  asks = 0;

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'sessions');
  }

  /**
   * 往签字表里写一个平台（真实现里这一步是用户在确认卡片上点「我承担」）。
   * @param platform 平台标识
   */
  grant(platform: string): void {
    this.granted.add(platform);
  }

  /**
   * 从签字表里抹掉一个平台（演「换一台机器 / 库还没签过」）。
   * @param platform 平台标识
   */
  revoke(platform: string): void {
    this.granted.delete(platform);
  }

  /** 契约见 `ConsentGate.hasConsent`。 */
  hasConsent = (platform: string): boolean => {
    this.asks += 1;
    return this.granted.has(platform);
  };

  /**
   * 契约见 `ConsentGate.ensureConsent`：未签即抛 `CONSENT_REQUIRED`。
   *
   * 真身还会先校验平台登记过没有（未登记抛 `PLATFORM_NOT_CONFIGURED`），这一支替身不建模：
   * 用例里的平台名都是登记过的，未登记那一条由界面侧的实测覆盖。
   */
  ensureConsent = (platform: string): void => {
    if (this.hasConsent(platform)) return;
    throw new AppError('CONSENT_REQUIRED', `平台 ${platform} 还没有一份自动化风险确认记录`, 'sessions', { platform });
  };
}
