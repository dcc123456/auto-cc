/**
 * `browser.locate` 服务（spec 2.2-01 / 2.2-02 / 2.2-04 / 2.2-05）：
 * 把「一份定位声明」变成「一条带理由的胜出候选」，达不到阈值就**拒绝猜测**。
 *
 * 这个服务只做三件事：把候选喂给页面脚本回读、把回读交给 `locator-spec` 的纯判定、
 * 把结局拼成界面与 `browser.act` 都能直接用的形状。**所有打分规则都不在这里**（它们在
 * `locator-spec.ts`，可以不开窗口单测），所以想改判定口径不会碰到 Electron 代码。
 *
 * 与 `browser.page` 的分工：页面服务只读「整页长什么样」，这里读「我要的那个东西在哪」。
 * 两者共用 `frame-channel`（同一块视图、同一条多帧求值通道），不存在第二套取句柄逻辑。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { ElementFingerprint, LocateResultView, LocateSpec, LocateStatusView, LocatedView } from '@auto-cc/shared';
import { z } from 'zod';
import { evaluateInFrames, readingsFromFrames, requireKernelContents, type KernelHost } from './frame-channel.js';
import {
  DEFAULT_SCRIPT_LIMITS,
  buildFingerprintScanScript,
  buildLocateScript,
  toLocatedReadings,
  type ScriptLimits,
} from './locator-script.js';
import {
  decideLocate,
  rankScored,
  scoreByFingerprint,
  toRankedCandidates,
  validateSpec,
  type LocateDecision,
} from './locator-spec.js';
import type { BrowserPageService } from './index.js';

/** `status()` 里 retained 的失败摘要条数：够解释「刚才为什么不确定」，又不会变成运行日志。 */
const RECENT_FAILURE_LIMIT = 8;

export const browserLocateSchema = z.strictObject({
  /** 候选最低可用分；最优候选低于它一律判 `below-score`（spec 2.2-02 的 fail closed）。 */
  minScore: z.number().int().min(0).max(100).default(70),
  /** 最优与次优的最小分差；小于它判 `ambiguous`，即「两条都点得下去时宁可不动」。 */
  minMargin: z.number().int().min(0).max(100).default(12),
  /** 一次 `find` 回传的 top-N，同时也是每条候选从页面最多回读几个命中。 */
  candidateLimit: z.number().int().min(1).max(20).default(5),
  /** 指纹里文本与属性值的归一化长度上限（字符）。 */
  textNormalizationLimit: z.number().int().min(20).max(400).default(80),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserLocateConfig = z.output<typeof browserLocateSchema>;

export class BrowserLocateService extends Service {
  static provide = 'browser.locate';
  static Config = browserLocateSchema;
  /** `browser.page` 只用来在失败那一趟取回 DOM 快照（spec 2.2-04），不复制它的读取脚本。 */
  static inject = ['shell', 'browser.page'];

  private readonly recentFailures: LocateStatusView['recentFailures'] = [];

  constructor(
    ctx: Context,
    private readonly config: BrowserLocateConfig,
  ) {
    super(ctx, 'browser.locate');
  }

  /**
   * 按声明定位，必要时用上一次成功留下的指纹自愈重找。
   * @param spec 定位声明（候选按声明顺序即优先级）；不可信的界面输入，先过 `validateSpec`
   * @param lastKnown 上一次成功定位的元素指纹；省略就不触发自愈（正常路径优先）
   * @returns 结局 + 排序稳定的 top-N + 可解释理由；失败时随行一份页面快照
   * @throws 声明非法 `LOCATE_SPEC_INVALID`；没有已挂载会话 `NO_KERNEL_SESSION`；所有帧读取失败 `PAGE_SCRIPT_FAILED`
   */
  find = async (spec: LocateSpec, lastKnown?: ElementFingerprint): Promise<LocateResultView> => {
    const problems = validateSpec(spec);
    if (problems.length > 0) {
      throw new AppError('LOCATE_SPEC_INVALID', `定位声明不可用：${problems.join('；')}`, 'browser.locate', {
        problems,
        spec,
      });
    }
    const contents = requireKernelContents(this.host, 'browser.locate');
    const readings = readingsFromFrames(
      await evaluateInFrames(contents, buildLocateScript(spec.candidates, this.limits)),
      toLocatedReadings,
    );
    const ranked = toRankedCandidates(readings, spec.candidates);
    const decision = decideLocate(ranked, this.thresholds);
    if (decision.status === 'matched' || !lastKnown) {
      return this.finish(spec, ranked, decision, false, null, contents.getURL());
    }
    const healed = await this.healByFingerprint(lastKnown);
    if (healed.decision.status !== 'matched') {
      // 自愈也没过线时保留声明候选的排名：界面要看到的仍是「我声明的那几条为什么都没中」。
      return this.finish(spec, ranked, decision, false, null, contents.getURL());
    }
    // `because` 带的是**声明候选的落空原因**（改版把哪条通道打掉了），不是自愈后的得分，见事件契约。
    return this.finish(
      spec,
      healed.ranked,
      healed.decision,
      true,
      { fingerprint: lastKnown, because: decision.reason },
      contents.getURL(),
    );
  };

  /**
   * 只按指纹重找元素（spec 2.2-05 的独立入口，供改版后「先找回现场再动手」用）。
   * @param fingerprint 上一次成功定位留下的元素指纹
   * @returns 与 `find` 同形的结局；`relocated` 恒为 true 表示来源是指纹而非声明候选
   * @throws 与 `find` 同一组结构化错误
   */
  refind = async (fingerprint: ElementFingerprint): Promise<LocateResultView> => {
    const contents = requireKernelContents(this.host, 'browser.locate');
    const spec: LocateSpec = {
      description: `指纹重找 ${fingerprint.tagName || '（无标签名）'}`,
      cardinality: 'single',
      candidates: [],
    };
    const { ranked, decision } = await this.healByFingerprint(fingerprint);
    const matched = decision.status === 'matched';
    return this.finish(
      spec,
      ranked,
      decision,
      matched,
      matched ? { fingerprint, because: '指纹重找入口：未经声明候选' } : null,
      contents.getURL(),
    );
  };

  /**
   * 定位层的读数：当期阈值 + 最近几次判定摘要（界面解释「为什么这条不确定」用）。
   * @returns 不含任何页面内容，因此这条路径永远不会因为站点改版而失败
   */
  status = (): LocateStatusView => ({
    minScore: this.config.minScore,
    minMargin: this.config.minMargin,
    candidateLimit: this.config.candidateLimit,
    recentFailures: [...this.recentFailures],
  });

  /**
   * 声明候选之外的第二条来源：按标签名预筛后逐条比对指纹。
   *
   * 阈值与 `find` 用的是**同一套**（`minScore` / `minMargin`）——配置里不长出第二个旋钮，
   * 自愈过线的唯一办法是字段逐项累计上去（标签名相同只有基础分，见 `FINGERPRINT_BASE_SCORE`）。
   * @param target 上一次成功定位留下的指纹
   * @returns 判定结果；命中时 ranked 只有自愈候选
   */
  private async healByFingerprint(
    target: ElementFingerprint,
  ): Promise<{ ranked: LocatedView[]; decision: LocateDecision }> {
    const contents = requireKernelContents(this.host, 'browser.locate');
    const readings = readingsFromFrames(
      await evaluateInFrames(contents, buildFingerprintScanScript(target.tagName, this.limits)),
      toLocatedReadings,
    );
    const scored = readings.map((reading) => scoreByFingerprint(target, reading));
    const ranked = rankScored(scored).slice(0, this.config.candidateLimit);
    return { ranked, decision: decideLocate(ranked, this.thresholds) };
  }

  /**
   * 拼一次定位的结局，并把失败记进 `recentFailures`、把自愈记进事件。
   * @param spec 本次声明（原样带回，界面据此重放）
   * @param ranked 排序后的候选（已按 `candidateLimit` 截断）
   * @param decision 判定结局
   * @param relocated 是否由指纹自愈命中
   * @param healFrom 自愈的依据：上次留下的指纹 + 为什么会走自愈（声明候选的落空原因）；非自愈时为 null
   * @param pageUrl 当前页面地址，用于拼 `snapshotRef`
   * @returns 界面与 `browser.act` 共用的定位结果
   */
  private async finish(
    spec: LocateSpec,
    ranked: LocatedView[],
    decision: LocateDecision,
    relocated: boolean,
    healFrom: { fingerprint: ElementFingerprint; because: string } | null,
    pageUrl: string,
  ): Promise<LocateResultView> {
    const at = Date.now();
    const top = ranked.slice(0, this.config.candidateLimit);
    if (decision.status !== 'matched') {
      this.recentFailures.unshift({
        description: spec.description,
        status: decision.status,
        reason: decision.reason,
        at,
      });
      this.recentFailures.length = Math.min(this.recentFailures.length, RECENT_FAILURE_LIMIT);
    } else if (relocated && decision.chosen && healFrom) {
      // 自愈成功必须留痕：2.7 的「选择器腐化率」只统计这一条来源，漏发就等于宣称没有腐化。
      this.ctx.emit('locator/relocated', {
        description: spec.description,
        strategy: decision.chosen.strategy,
        score: decision.chosen.score,
        frameUrl: decision.chosen.frameUrl,
        because: healFrom.because,
        at,
      });
      this.ctx.logger.warn(`定位已由指纹自愈：${spec.description}（${healFrom.because} → ${decision.reason}）`);
    }
    const chosenUrl = decision.chosen?.frameUrl ?? pageUrl;
    return {
      status: decision.status,
      spec,
      chosen: decision.chosen,
      ranked: top,
      reason: decision.reason,
      relocated,
      snapshotRef: `${chosenUrl}@${String(at)}`,
      // 成功时不读快照：一次定位的响应体不该动辄几 KB 正文，失败才需要现场（spec 2.2-04）。
      snapshot: decision.status === 'matched' ? null : await this.page.snapshot().catch(() => null),
      at,
    };
  }

  /** 页面读数上限与取回条数上限的同源映射（配置一处，脚本与回传都跟着）。 */
  private get limits(): ScriptLimits {
    return {
      ...DEFAULT_SCRIPT_LIMITS,
      textLimit: this.config.textNormalizationLimit,
      hitsPerCandidate: this.config.candidateLimit,
    };
  }

  /** 判定阈值（来自配置，不写在代码里）。 */
  private get thresholds(): { minScore: number; minMargin: number } {
    return { minScore: this.config.minScore, minMargin: this.config.minMargin };
  }

  /** 壳层的视图宿主句柄（见 `KernelHost`：这里刻意只取两个方法）。 */
  private get host(): KernelHost {
    return asApp(this.ctx).shell;
  }

  /** 页面服务的快照面（失败现场的唯一来源，读取脚本不在这里复制第二份）。 */
  private get page(): Pick<BrowserPageService, 'snapshot'> {
    return asApp(this.ctx)['browser.page'];
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `定位服务就绪：最低可用分 ${String(this.config.minScore)} · 最小分差 ${String(this.config.minMargin)} · top-${String(
        this.config.candidateLimit,
      )}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.locate': BrowserLocateService;
  }
}
