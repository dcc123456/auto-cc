/**
 * `browser.act` 服务（spec 2.2-03 / 2.2-10 / 2.2-12 / 2.2-13）：把「一次页面动作」做完。
 *
 * 顺序是写死的：**先等到可点，再定位，再动手**。反过来（先点再等）在真实站点上就是
 * 「点了个空」——页面把按钮往下推 20px，坐标已经作废，所以几何稳定也必须算等待条件。
 *
 * 两条通道如实报告（spec 2.2-12）：
 * - `cdp`：`webContents.debugger` 派发真实输入事件，页面读到的 `isTrusted` 为 true；
 * - `dom`：帧内脚本直接操作元素，`isTrusted` 为 false。退回这条只在「attach 不上」或
 *   「iframe 偏移认不出」时发生，且**永远不猜坐标**——猜出来的点位置会把动作打到别人身上。
 * `<select>` 的原生下拉没有可信输入可模拟（要点开系统弹层），所以它固定走 DOM 通道。
 *
 * `upload` 是个例外：`input.files` 是只读的，脚本伪造不出一个真文件，所以这条路径**没有 DOM 兜底**，
 * CDP 走不通就直接结构化失败（spec 2.6-04）。它也不看坐标——隐藏的上传控件照样能注，
 * 于是等待用 `appear`、并且不受 iframe 偏移折算成败的影响。
 */
import { AppError, asApp, Service, agentTool, registerAgentTools, toolResult, type Context } from '@auto-cc/core';
import type {
  ActResultView,
  HitAddress,
  LocateResultView,
  LocatedView,
  LocateSpec,
  WaitPredicate,
} from '@auto-cc/shared';
import type { WebContents } from 'electron';
import { basename, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  evaluateInFrames,
  findFrameByUrl,
  readingsFromFrames,
  requireKernelContents,
  type KernelHost,
} from './frame-channel.js';
import { dispatchClick, dispatchType, dispatchUpload, viewportPointOf } from './input-channel.js';
import {
  DEFAULT_SCRIPT_LIMITS,
  buildClickArmScript,
  buildClickReceiptReadScript,
  buildDomActionScript,
  buildNodeHandleScript,
  buildUploadReadbackFunction,
  buildValueReadScript,
  buildWaitScript,
  toClickReceiptReading,
  toDomActionReading,
  toWaitReading,
} from './locator-script.js';
import { locateSpecSchema } from './platform-contract.js';
import { assertSpecValid } from './locator-spec.js';
import type { BrowserLocateService } from './locate-service.js';
import type { BrowserPageService } from './index.js';

export const browserActSchema = z.strictObject({
  /** 一次动作前的等待上限（毫秒）；超时即结构化失败，不静默继续（spec 2.2-04）。 */
  waitForTimeoutMs: z.number().int().min(200).max(30_000).default(5000),
  /** 「可点击」谓词要求连续几帧几何一致，避免点到正在被布局往下推的元素（spec 2.2-03）。 */
  stableCheckSamples: z.number().int().min(1).max(5).default(2),
  /** 观察器之外的兜底轮询间隔（毫秒）：样式与滚动变化不产生 mutation，只靠观察器等不到。 */
  waitCheckMs: z.number().int().min(16).max(2_000).default(100),
  /** 关掉即显式降级到 DOM 通道（结果里 `channel` 与 `trusted` 会如实变成 dom / false）。 */
  cdpInputEnabled: z.boolean().default(true),
  /** 文件注入后回读 `files[0]` 与 `change` 的上限（毫秒）；超时把当时的读数如实交出去（spec 2.6-04 / 2.7-04）。 */
  uploadReadbackMs: z.number().int().min(100).max(30_000).default(1500),
  /** 回读的轮询步长（毫秒）。`setFileInputFiles` 回包时 change 未必已派发完，只能轮（plan §13.2 第 2 条）。 */
  uploadReadbackStepMs: z.number().int().min(10).max(2_000).default(50),
  /** 点击派发后等页面回执的上限（毫秒）；页面答得上来却没回执，`status` 就给 `timeout`（裁定⑰ / plan §16.1）。 */
  clickReadbackMs: z.number().int().min(100).max(30_000).default(600),
  /** 点击回执的轮询步长（毫秒）。与 `uploadReadbackStepMs` 同形：事件派发是异步的，只能轮。 */
  clickReadbackStepMs: z.number().int().min(10).max(2_000).default(50),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserActConfig = z.output<typeof browserActSchema>;

/** 一次动作在页面里的结局：走哪条通道、事件是否受信、回读到什么值。 */
type ActionOutcome = { channel: 'cdp' | 'dom'; trusted: boolean; valueAfter: string | null };

/**
 * 漂移比对用的文本归一：把连续空白并成一个空格再去首尾。
 *
 * 页面读数在注入脚本里已经折叠过一次空白，这一句兜的是**调用方**那一侧（名字是从上一轮读数抄来的，
 * 也可能来自界面输入），两边归一到同一形状才谈得上「整串相等」。
 * @param value 任一侧的文本
 * @returns 折叠空白并修剪后的串
 */
function normalizeHitText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 待注入的本地文件读数（路径与字节数都要交给页面比对）。 */
type UploadableFile = { path: string; name: string; size: number };

/**
 * 取一条候选的跨调用身份（候选下标 + 帧内身份号）。
 * @param chosen 胜出候选
 * @returns DOM 通道找回同一节点所需的两个键
 */
function identityOf(chosen: LocatedView): { candidateIndex: number; nodeIndex: number } {
  return { candidateIndex: chosen.candidateIndex, nodeIndex: chosen.nodeIndex };
}

/**
 * 取一条候选的**跨 world** 身份（候选下标 + 命中序号）与形状基准。
 * @param chosen 胜出候选
 * @returns CDP 隔离世界里按序号找回同一节点所需的地址，以及漂移校验要用的标签名与矩形
 */
function handleAddressOf(chosen: LocatedView): {
  address: { candidateIndex: number; hitIndex: number };
  expected: { tagName: string; rect: LocatedView['rect'] };
} {
  return {
    address: { candidateIndex: chosen.candidateIndex, hitIndex: chosen.hitIndex },
    expected: { tagName: chosen.tagName, rect: chosen.rect },
  };
}

/**
 * 校验并读出待注入的文件（路径是调用方给的系统边界输入，必须自己确认它指向一个真文件）。
 * @param filePath 待注入文件的绝对路径
 * @returns 绝对路径、文件名与字节数（字节数用于回读比对）
 * @throws 非绝对路径、不存在、不是普通文件、0 字节或读不到状态时 `INVALID_ARGUMENT`
 */
function readUploadableFile(filePath: string): UploadableFile {
  // 显式标注成 never 可调用变量：TS 的控制流分析才认「这一句之后不返回」，否则下面报「size 未赋值」。
  const reject: (reason: string) => never = (reason) => {
    throw new AppError('INVALID_ARGUMENT', `待上传的文件不可用：${reason}`, 'browser.act', { filePath });
  };
  if (!isAbsolute(filePath)) reject('路径必须是绝对路径');
  let size: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) reject('它不是一个普通文件');
    size = stat.size;
  } catch (error) {
    reject(error instanceof Error ? error.message : String(error));
  }
  if (size === 0) reject('文件是 0 字节，注进去也只是一个空附件');
  return { path: filePath, name: basename(filePath), size };
}

export class BrowserActService extends Service {
  static provide = 'browser.act';
  static Config = browserActSchema;
  /** 动作必经定位：同一份打分与阈值只此一处（AGENTS.md §2.5）。 */
  /** `browser.page` 也必须声明：等不到可点时那条结构化失败要带快照，漏了就会以 TypeError 顶掉 WAIT_TIMEOUT。 */
  static inject = ['shell', 'browser.locate', 'browser.page'];

  constructor(
    ctx: Context,
    private readonly config: BrowserActConfig,
  ) {
    super(ctx, 'browser.act');
  }

  /**
   * 点击声明指向的元素（裁定⑰：`done` 从此要求页面自己回执）。
   * @param spec 定位声明
   * @param target 「点第 N 个命中」的寻址键（spec 8.4-04）；省略就点打分胜出的那一个。
   *        给定时**不再要求过最低可用分**（同一批命中的分数本来就彼此接近，虚拟列表里第 3 行与第 4 行
   *        没有谁更"该点"），但要求 `expectText` 与现场读数一致——对不上就拒点，因为序号会随重排漂到邻居身上
   * @returns 动作结局；`channel` 与 `trusted` 说明事件是怎么产生的；`status` 为 `timeout` 表示
   *          「派发没报错但页面答『没收到』」——窗口不在前台时 CDP 的鼠标事件会被合成器丢掉；
   *          页面答不上来（节点换掉、脚本不通）仍给 `done`，这条判据不外扩成假阴性
   * @throws 等不到可点 `WAIT_TIMEOUT`、定位未过线 `LOCATE_FAILED`、动作被页面拒绝 `ACT_FAILED`（三者都带 spec 与快照引用）；
   *         给了 `target` 而那一格已不在、或文本与 `expectText` 不符时同样是 `LOCATE_FAILED`（带现场读数，
   *         因为「排到别人身上」必须让调用方看得见，不能默默点中隔壁那家公司）
   */
  click = async (spec: LocateSpec, target?: HitAddress): Promise<ActResultView> =>
    this.perform('click', spec, undefined, target);

  /**
   * 往声明指向的输入控件里写文本（中文与 emoji 原样送入，spec 2.2-13）。
   * @param spec 定位声明
   * @param text 待输入文本，可含中文、emoji 与空白
   * @returns 动作结局，`valueAfter` 是页面里回读到的当前值（不是发出去的那个串）
   * @throws 与 `click` 同一组结构化错误
   */
  type = async (spec: LocateSpec, text: string): Promise<ActResultView> => this.perform('type', spec, text);

  /**
   * 选中下拉里的一个值。
   * @param spec 定位声明（指向 `select` 元素）
   * @param value 目标选项值
   * @returns 动作结局；`channel` 恒为 `dom`（原生弹层没有可信输入可模拟，如实标注而不是假装受信）
   * @throws 与 `click` 同一组结构化错误
   */
  select = async (spec: LocateSpec, value: string): Promise<ActResultView> => this.perform('select', spec, value);

  /**
   * 把一个本地文件注入声明指向的 `input[type=file]`（spec 2.6-04）。
   *
   * 与 `click` 同骨架（先等、再定位、后动手），但三处刻意不同：
   * 等待用 `appear`（站点的上传控件普遍 `display:none`，「可点」永远等不到）；
   * 不动坐标（隐藏的控件照样能注，也就免疫 iframe 偏移折算的成败）；
   * **没有 DOM 兜底**（`input.files` 只读，脚本伪造不出真文件），CDP 走不通就是失败。
   * 注入后必须回读页面自己的读数比对文件名与字节数——「命令没报错」不等于「附件进了控件」。
   * @param spec 定位声明（隐藏控件要带 `requireActionable: false`，否则定位阶段就被 fail-closed 打掉）
   * @param filePath 待注入文件的绝对路径
   * @returns 动作结局；`channel` 恒为 `cdp`，`trusted` 取自页面对那一次 `change` 的回答，
   *          `valueAfter` 是页面回读到的文件名（不是请求路径的文件名）
   * @throws 文件不可用 `INVALID_ARGUMENT`；等不到控件 `WAIT_TIMEOUT`；定位未过线 `LOCATE_FAILED`；
   *         注入链任一步失败、页面没收到 `change`、或回读与请求不符 `ACT_FAILED`（带 spec、路径与快照）
   */
  upload = async (spec: LocateSpec, filePath: string): Promise<ActResultView> => {
    const contents = requireKernelContents(this.host, 'browser.act');
    const startedAt = Date.now();
    const file = readUploadableFile(filePath);
    if (!(await this.waitSatisfied(spec, 'appear'))) {
      throw await this.waitTimeout(spec, 'appear', Date.now() - startedAt, contents);
    }
    const result = await this.locate.find(spec);
    if (!result.chosen) {
      throw new AppError('LOCATE_FAILED', `定位未过线，上传没有执行：${result.reason}`, 'browser.act', {
        spec,
        status: result.status,
        snapshotRef: result.snapshotRef,
        snapshot: result.snapshot,
      });
    }
    if (!this.config.cdpInputEnabled) {
      throw await this.uploadFailed('CDP 通道已关闭，而文件注入没有 DOM 兜底', spec, file, contents);
    }
    const { address, expected } = handleAddressOf(result.chosen);
    const injection = await dispatchUpload(
      contents,
      result.chosen.frameUrl,
      buildNodeHandleScript(spec.candidates, address, expected, DEFAULT_SCRIPT_LIMITS),
      file.path,
      buildUploadReadbackFunction(this.config.uploadReadbackMs, this.config.uploadReadbackStepMs),
    );
    if (!injection.ok) throw await this.uploadFailed(injection.error, spec, file, contents);
    const reading = injection.reading;
    if (reading.changeCount === 0) {
      throw await this.uploadFailed('注入后页面没有收到 change，站点不会有机会登记这个附件', spec, file, contents);
    }
    if (reading.fileName !== file.name || reading.fileSize !== file.size) {
      throw await this.uploadFailed(
        `页面回读的附件与请求不符（页面：${reading.fileName || '空'} / ${String(reading.fileSize)} 字节；请求：${file.name} / ${String(file.size)} 字节）`,
        spec,
        file,
        contents,
      );
    }
    return {
      action: 'upload',
      status: 'done',
      waitedMs: Date.now() - startedAt,
      channel: 'cdp',
      trusted: reading.isTrusted,
      located: result.chosen,
      valueAfter: reading.fileName,
      predicate: null,
    };
  };

  /**
   * 只等不动手（spec 2.2-03 的五类谓词）。
   * @param predicate 谓词声明；`spec` 是要等的元素
   * @returns `status` 为 `done` 表示等到、`timeout` 表示没等到——超时在这条路径上是结局，不是异常
   * @throws 没有已挂载会话 `NO_KERNEL_SESSION`；所有帧读取失败 `PAGE_SCRIPT_FAILED`
   */
  waitFor = async (predicate: WaitPredicate): Promise<ActResultView> => {
    assertSpecValid(predicate.spec, 'browser.act');
    const startedAt = Date.now();
    const satisfied = await this.waitSatisfied(predicate.spec, predicate.kind);
    return {
      action: 'wait',
      status: satisfied ? 'done' : 'timeout',
      waitedMs: Date.now() - startedAt,
      // 等待不产生任何页面事件：读数只来自脚本观察，所以 trusted 恒为 false，不冒充 CDP。
      channel: 'dom',
      trusted: false,
      located: null,
      valueAfter: null,
      predicate: { kind: predicate.kind, satisfied },
    };
  };

  /**
   * 动作的公共骨架：等待 → 定位 → 折算坐标 → 下发 → 回读。
   * @param action 动作类型
   * @param spec 定位声明
   * @param payload 输入文本或选项值（点击为 undefined）
   * @param target 索引寻址（只有 `click` 会传）：按「候选下标 + 命中序号」取那一格，绕开打分胜出者
   * @returns 界面与适配器共用的动作读数
   */
  private async perform(
    action: 'click' | 'type' | 'select',
    spec: LocateSpec,
    payload?: string,
    target?: HitAddress,
  ): Promise<ActResultView> {
    // 声明本身合不合法必须排在碰会话与闸门之前：非法形状若在页内脚本里读到零条候选，
    // 五秒后会以 WAIT_TIMEOUT 报出，把调用方引向「页面不可点」这个错方向（plan §16.3）。
    assertSpecValid(spec, 'browser.act');
    const contents = requireKernelContents(this.host, 'browser.act');
    const startedAt = Date.now();
    if (!(await this.waitSatisfied(spec, 'clickable'))) {
      throw await this.waitTimeout(spec, 'clickable', Date.now() - startedAt, contents);
    }
    const result = await this.locate.find(spec);
    const chosen = target ? this.hitAt(result, target, spec) : result.chosen;
    if (!chosen) {
      throw new AppError('LOCATE_FAILED', `定位未过线，动作没有执行：${result.reason}`, 'browser.act', {
        spec,
        status: result.status,
        snapshotRef: result.snapshotRef,
        snapshot: result.snapshot,
      });
    }
    const point = await this.viewportPoint(contents, chosen);
    // 回执必须挂在派发**之前**：事后装的监听看不见已经发生的事件（裁定⑰ / plan §16.1）。
    const armed = action === 'click' ? await this.armClickReceipt(spec, chosen) : null;
    const outcome = await this.dispatch(action, spec, chosen, payload, point, contents);
    let status: ActResultView['status'] = 'done';
    if (armed && !(await this.clickConfirmed(armed.url, chosen))) {
      status = 'timeout';
      this.ctx.logger.warn(
        `点击「${spec.description}」派发完但页面没有回执（事件被丢弃或落到了别处），本次动作按超时报告而不是已完成`,
      );
    }
    return {
      action,
      status,
      waitedMs: Date.now() - startedAt,
      channel: outcome.channel,
      trusted: outcome.trusted,
      located: chosen,
      valueAfter: outcome.valueAfter,
      predicate: null,
    };
  }

  /**
   * 从一次定位的 `ranked` 里按地址取出要点的那一格（spec 8.4-04）。
   * @param result 刚跑完的那次定位结局（`ranked` 已按服务配置 `candidateLimit` 截断）
   * @param target 调用方给的地址：候选下标 + 命中序号，可带期望文本
   * @param spec 定位声明（随错误交回调用方，让界面能看到是哪一条声明）
   * @returns 地址指向的那一格读数
   * @throws 地址越界或文本对不上时 `LOCATE_FAILED`（两种都是「两次读数之间页面重排了」，
   *          宁可不点也不把动作落到隔壁那一家身上）
   */
  private hitAt(result: LocateResultView, target: HitAddress, spec: LocateSpec): LocatedView {
    const hit = result.ranked.find(
      (entry) => entry.candidateIndex === target.candidateIndex && entry.hitIndex === target.hitIndex,
    );
    if (!hit) {
      throw new AppError(
        'LOCATE_FAILED',
        `寻址的那一格命中已不在读回的 ${String(result.ranked.length)} 条里（候选 ${String(target.candidateIndex)} / 序号 ${String(target.hitIndex)}），需要重新定位`,
        'browser.act',
        {
          spec,
          address: target,
          rankedCount: result.ranked.length,
          status: result.status,
          snapshotRef: result.snapshotRef,
        },
      );
    }
    // 漂移比对只比**整串相等**：页面读数被截断时期望文本若更长就对不上，那条动作于是被拒——
    // 拒错的代价是「这一发没发出去」，猜错的代价是「发给了另一家公司」，两个方向不对称。
    if (target.expectText !== undefined && normalizeHitText(hit.text) !== normalizeHitText(target.expectText)) {
      throw new AppError(
        'LOCATE_FAILED',
        `页面在两次读数之间重排了：第 ${String(target.hitIndex)} 格现在是「${hit.text}」，不是要动的「${target.expectText}」，这一格不点`,
        'browser.act',
        {
          spec,
          address: target,
          observedText: hit.text,
          status: result.status,
          snapshotRef: result.snapshotRef,
          snapshot: result.snapshot,
        },
      );
    }
    return hit;
  }

  /**
   * 在派发之前把一次点击的回执挂到胜出节点上（plan §16.1 第一段）。
   * @param spec 定位声明（找回节点要用）
   * @param chosen 胜出候选
   * @returns 挂表成功时的基准（当时的文档地址）；节点已不在、脚本不通时返回 null 表示「页面答不上来」
   */
  private async armClickReceipt(spec: LocateSpec, chosen: LocatedView): Promise<{ url: string } | null> {
    try {
      const raw = (await this.frameOf(chosen).executeJavaScript(
        buildClickArmScript(spec.candidates, identityOf(chosen), DEFAULT_SCRIPT_LIMITS),
        true,
      )) as Record<string, unknown>;
      return raw && raw.ok === true ? { url: typeof raw.url === 'string' ? raw.url : '' } : null;
    } catch {
      // 挂不上不是动作失败：这条判据只在页面能回答时才是决定性的，不能反过来把动作链路打断。
      return null;
    }
  }

  /**
   * 有界轮询页面对这一次点击的回执（plan §16.1 第三段）。
   * @param armedUrl 挂表那一刻的文档地址；与当前地址不同即「这次点击把页面导航走了」
   * @param chosen 胜出候选（回执要在同一帧里读）
   * @returns 页面确认收到过为 true；**探针始终答不上来也算 true**，只有页面明确答「没收到」才是 false
   */
  private async clickConfirmed(armedUrl: string, chosen: LocatedView): Promise<boolean> {
    const deadline = Date.now() + this.config.clickReadbackMs;
    let isProbeAnswering = false;
    for (;;) {
      let reading = { available: false, received: false, url: '' };
      try {
        reading = toClickReceiptReading(
          await this.frameOf(chosen).executeJavaScript(buildClickReceiptReadScript(armedUrl), true),
        );
      } catch {
        // 帧正在跳转：这一轮读不到，下一轮再看。
      }
      if (reading.received) return true;
      isProbeAnswering = isProbeAnswering || reading.available;
      if (Date.now() >= deadline) return !isProbeAnswering;
      await new Promise((resolve) => setTimeout(resolve, this.config.clickReadbackStepMs));
    }
  }

  /**
   * 在整棵帧树里跑等待脚本，任一帧满足即算满足。
   * @param spec 被等待元素的声明
   * @param kind 谓词类型
   * @returns 是否满足（聊天框在子帧里满足就够了，spec 2.2-10）
   */
  private async waitSatisfied(spec: LocateSpec, kind: WaitPredicate['kind']): Promise<boolean> {
    const contents = requireKernelContents(this.host, 'browser.act');
    const source = buildWaitScript(
      kind,
      spec.candidates,
      this.config.waitForTimeoutMs,
      this.config.waitCheckMs,
      DEFAULT_SCRIPT_LIMITS,
      this.config.stableCheckSamples,
    );
    const readings = readingsFromFrames(await evaluateInFrames(contents, source, true), (raw) => [toWaitReading(raw)]);
    return readings.some((reading) => reading.satisfied);
  }

  /**
   * 把帧内矩形折算成视图坐标。
   * @param contents 内核视图句柄
   * @param chosen 胜出候选
   * @returns 视图坐标点，以及「每一层 iframe 是否都认出来了」
   */
  private async viewportPoint(
    contents: WebContents,
    chosen: LocatedView,
  ): Promise<{ point: { x: number; y: number }; resolved: boolean }> {
    const frame = findFrameByUrl(contents, chosen.frameUrl);
    if (!frame) {
      // 页面已经跳转：宁可不点，也不按过期坐标点一下别的东西。
      return { point: { x: 0, y: 0 }, resolved: false };
    }
    return viewportPointOf(frame, chosen.rect);
  }

  /**
   * 下发一次动作，必要时退回 DOM 通道。
   * @param action 动作类型
   * @param spec 定位声明
   * @param chosen 胜出候选
   * @param payload 输入文本或选项值
   * @param point 视图坐标与折算结论
   * @param contents 内核视图句柄
   * @returns 通道、是否受信、页面回读到的值
   */
  private async dispatch(
    action: 'click' | 'type' | 'select',
    spec: LocateSpec,
    chosen: LocatedView,
    payload: string | undefined,
    point: { point: { x: number; y: number }; resolved: boolean },
    contents: WebContents,
  ): Promise<ActionOutcome> {
    const useCdp = this.config.cdpInputEnabled && action !== 'select' && point.resolved;
    if (useCdp) {
      const sent =
        action === 'click'
          ? await dispatchClick(contents, point.point)
          : await dispatchType(contents, point.point, payload ?? '');
      if (sent) {
        return {
          channel: 'cdp',
          trusted: true,
          // 输入类动作一律回读页面里的真值：发出去的串不等于页面收到了什么（spec 2.2-13）。
          valueAfter: action === 'click' ? null : await this.readValue(spec, chosen),
        };
      }
      this.ctx.logger.warn(`CDP 输入通道不可用，本次 ${action} 退回 DOM 通道（事件不受信）`);
    }
    const reading = await this.domAction(action, spec, chosen, payload);
    if (!reading.ok) {
      throw new AppError('ACT_FAILED', `页面动作失败：${reading.error}`, 'browser.act', {
        spec,
        action,
        snapshotRef: `${contents.getURL()}@${String(Date.now())}`,
      });
    }
    return { channel: 'dom', trusted: false, valueAfter: action === 'click' ? null : reading.valueAfter };
  }

  /**
   * 走帧内脚本执行动作（`isTrusted:false`，只作为显式降级）。
   * @param action 动作类型
   * @param spec 定位声明
   * @param chosen 胜出候选
   * @param payload 输入文本或选项值
   * @returns 页面里的动作读数
   */
  private async domAction(
    action: 'click' | 'type' | 'select',
    spec: LocateSpec,
    chosen: LocatedView,
    payload?: string,
  ): Promise<{ ok: boolean; valueAfter: string; error: string }> {
    const source = buildDomActionScript(action, spec.candidates, identityOf(chosen), payload, DEFAULT_SCRIPT_LIMITS);
    return toDomActionReading(await this.frameOf(chosen).executeJavaScript(source, true));
  }

  /**
   * 回读目标控件的当前值。
   * @param spec 定位声明
   * @param chosen 胜出候选
   * @returns 页面里的值；节点已经不在就当空串（不让一次回读把整次动作打崩）
   */
  private async readValue(spec: LocateSpec, chosen: LocatedView): Promise<string> {
    const source = buildValueReadScript(spec.candidates, identityOf(chosen), DEFAULT_SCRIPT_LIMITS);
    return toDomActionReading(await this.frameOf(chosen).executeJavaScript(source, true)).valueAfter;
  }

  /**
   * 读数所在的那一帧（跳转后按地址找不回时退回主帧，让脚本报「节点不在了」而不是静默成功）。
   * @param chosen 胜出候选
   * @returns 可直接求值的帧对象
   */
  private frameOf(chosen: LocatedView) {
    const contents = requireKernelContents(this.host, 'browser.act');
    return findFrameByUrl(contents, chosen.frameUrl) ?? contents.mainFrame;
  }

  /**
   * 拼等不到的结构化失败（spec 2.2-04 要的是「有现场可看」，不是只有一句超时）。
   * @param spec 动作声明
   * @param kind 等待用的谓词（错误文案要说清「等的是什么」，上传等的是 appear 而不是可点）
   * @param waitedMs 实际等了多久（毫秒）
   * @param contents 内核视图句柄，用于拼快照引用
   * @returns 带 spec、快照引用与最后一次 DOM 快照的结构化错误
   */
  private async waitTimeout(
    spec: LocateSpec,
    kind: WaitPredicate['kind'],
    waitedMs: number,
    contents: WebContents,
  ): Promise<AppError> {
    const at = Date.now();
    return new AppError(
      'WAIT_TIMEOUT',
      `等待「${kind}」超时（${String(this.config.waitForTimeoutMs)}ms 内未满足）`,
      'browser.act',
      {
        spec,
        waitedMs,
        snapshotRef: `${contents.getURL()}@${String(at)}`,
        snapshot: await this.page.snapshot().catch(() => null),
      },
    );
  }

  /**
   * 拼一次文件注入的结构化失败（spec 2.6-04：不接受「命令没报错」当成功）。
   * @param reason 失败落在哪一步，或页面回读与请求不符的具体对比
   * @param spec 上传声明
   * @param file 已通过校验的待注入文件读数
   * @param contents 内核视图句柄，用于拼快照引用
   * @returns 带 spec、绝对路径、快照引用与注入后现场的结构化错误
   */
  private async uploadFailed(
    reason: string,
    spec: LocateSpec,
    file: UploadableFile,
    contents: WebContents,
  ): Promise<AppError> {
    const at = Date.now();
    this.ctx.logger.warn(`文件注入失败：${file.name}（${reason}）`);
    return new AppError('ACT_FAILED', `文件注入失败：${reason}`, 'browser.act', {
      spec,
      filePath: file.path,
      snapshotRef: `${contents.getURL()}@${String(at)}`,
      snapshot: await this.page.snapshot().catch(() => null),
    });
  }

  /** 壳层的视图宿主句柄。 */
  private get host(): KernelHost {
    return asApp(this.ctx).shell;
  }

  /** 定位服务的读取面（动作先定位再下发，判定口径不在此重复）。 */
  private get locate(): Pick<BrowserLocateService, 'find'> {
    return asApp(this.ctx)['browser.locate'];
  }

  /** 页面服务的快照面（失败现场的唯一来源）。 */
  private get page(): Pick<BrowserPageService, 'snapshot'> {
    return asApp(this.ctx)['browser.page'];
  }

  [Service.init](): void {
    // 点击与输入标 `outbound` 而不是 `local-write`：它们不发消息，但一次 `click` 就能在真实页面上
    // 按下「发送」——分界是「出了本机没有」，不是「是不是发消息」（plan §15.7 落点 4）。
    // 闸门不在这里重复：`outbound.greet` / `outbound.deliver` 内部已有 consent + 额度（落点 5）。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'browser.act.click',
        titleKey: 'agent.tool.labels.actClick',
        description: '点击定位声明指向的控件（真实页面上的外部副作用，需先经批准流）',
        input: z.strictObject({ spec: locateSpecSchema }),
        effect: 'outbound',
        requiresConfirmation: true,
        // `done` / `timeout` 由 `status` 自己说，摘要不复述成「已发送」（5.1-11 的"不掩盖失败"）。
        // 证据引用给的是**胜出的那一个元素所在的帧**：动作打在了哪一页，比入参更值得对账。
        run: async ({ spec }) => {
          const result = await this.click(spec);
          return toolResult(result, {
            summary: `点击「${spec.description}」${result.status === 'done' ? '已完成' : '页面未回执'}（事件通道 ${result.channel} · ${String(result.waitedMs)} 毫秒）`,
            evidenceRefs: result.located ? [`frame:${result.located.frameUrl}`] : [],
          });
        },
      }),
      agentTool({
        id: 'browser.act.type',
        titleKey: 'agent.tool.labels.actType',
        description: '往定位声明指向的输入控件写文本（中文与 emoji 原样送入）',
        input: z.strictObject({ spec: locateSpecSchema, text: z.string().min(1) }),
        effect: 'outbound',
        requiresConfirmation: true,
        // 摘要里只报**回读到的字符数**，不报内容本身：写进去的是求职者姓名/手机号这类个人信息（§8.5）。
        run: async ({ spec, text }) => {
          const result = await this.type(spec, text);
          return toolResult(result, {
            summary: `往「${spec.description}」送入 ${String(text.length)} 字，页面回读 ${String(result.valueAfter?.length ?? 0)} 字（${result.status === 'done' ? '已回读' : '等待超时'}）`,
            evidenceRefs: result.located ? [`frame:${result.located.frameUrl}`] : [],
          });
        },
      }),
    ]);
    this.ctx.logger.info(
      `动作服务就绪：等待上限 ${String(this.config.waitForTimeoutMs)}ms · 稳定采样 ${String(
        this.config.stableCheckSamples,
      )} 帧 · CDP 输入 ${this.config.cdpInputEnabled ? '开' : '关（退回 DOM，事件不受信）'} · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.act': BrowserActService;
  }
}
