/**
 * `log` 服务（spec 1.3-04 / 1.3-05 / 1.3-11）。
 *
 * 命名说明：cordis 自身占用 `ctx.logger`（内置 LoggerService），所以本服务注册名是
 * `log`，`ctx.logger` 与 `ctx.log` 不冲突。插件照常直接调用 `ctx.logger.info(...)`，
 * 本服务只在**出口**接管：级别过滤 → 脱敏 → 环形缓冲 + 落盘 + 事件外发。
 * 出口式接管意味着「绕过本服务打日志」也一样会被脱敏，这比约定更重要。
 */
import {
  asApp,
  Logger,
  redactText,
  redactValue,
  Service,
  type Context,
  type Exporter,
  type LoggerMessage,
  type LoggerType,
} from '@auto-cc/core';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { z } from 'zod';
import { RingBuffer } from './ring.js';

export interface LogLine {
  ts: number;
  level: LoggerType;
  name: string;
  text: string;
}

/** 与 cordis 的 LoggerLevel 对齐（error 0 / warn 1 / info 2 / debug 3）。 */
const LEVEL: Record<LoggerType, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export const logSchema = z.strictObject({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  buffer: z.number().int().positive().max(50000).default(500),
  file: z.string().min(1).default('auto-cc.log'),
  dir: z.string().min(1).optional(),
  redact: z.boolean().default(true),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type LogConfig = z.infer<typeof logSchema>;

/** Error 不是普通对象，cordis 默认的 `JSON.stringify` 会把它压成 `{}`，这里显式展开。 */
function stringify(value: unknown): string {
  if (value instanceof Error)
    return redactText(`${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class LogService extends Service {
  static provide = 'log';
  static Config = logSchema;
  static inject = ['config'];
  /** 允许注入配置的环境变量（spec 1.3-02 第 3 层的真实用例）。 */
  static envMap = { level: 'AUTOCC_LOG_LEVEL', buffer: 'AUTOCC_LOG_BUFFER' };

  /** cordis 把 `static Config` 校验后的配置作为构造器第二个实参传入，类型也从这里推导出调用点。 */
  private readonly options: LogConfig;
  private readonly ring: RingBuffer<LogLine>;
  private sink: WriteStream | undefined;
  private logFile: string | undefined;

  constructor(ctx: Context, options: LogConfig) {
    super(ctx, 'log');
    this.options = options;
    this.ring = new RingBuffer(options.buffer);
  }

  /** 落盘路径，供界面日志页与 1.6 自测通道展示（spec 1.3-05）。 */
  get filePath(): string | undefined {
    return this.logFile;
  }

  get level(): LoggerType {
    return this.options.level;
  }

  /** 取最近 N 条已脱敏日志（spec 1.3-04 的内存缓冲出口）。 */
  tail(limit = 100): LogLine[] {
    return this.ring.toArray().slice(-Math.max(0, limit));
  }

  /** IPC 网关入口（spec 1.4-07）：日志出口状态，界面用它显示落盘路径与生效级别。 */
  status = (): { file: string | undefined; level: string } => ({ file: this.logFile, level: this.options.level });

  [Service.init](): void {
    const dir = this.options.dir ?? asApp(this.ctx).config.paths().logDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, this.options.file);
    this.logFile = file;
    const sink = createWriteStream(file, { flags: 'a' });
    this.sink = sink;
    // 卸载（依赖失效、restart、退出）时收尾写流：与 store 的连接回收同一套 effect 语义。
    this.ctx.effect(
      () => () => {
        sink.end();
        this.sink = undefined;
      },
      'log.sink',
    );

    // cordis 内置环形缓冲按同一容量收敛，避免原始（未脱敏）消息在内存里留太久。
    this.ctx.logger.bufferSize = this.options.buffer;

    const exporter: Exporter = {
      colors: false,
      levels: { default: LEVEL[this.options.level] },
      formatters: {
        o: (value) => stringify(this.options.redact ? redactValue(value) : value),
        O: (value) => stringify(this.options.redact ? redactValue(value) : value),
      },
      export: (message: LoggerMessage) => this.write(message),
    };
    this.host = exporter;
    const off = this.ctx.logger.exporter(exporter);
    // exporter 注册在根 fiber 上，插件卸载不会自动摘除；包进自己的 effect 才能保证回收。
    this.ctx.effect(
      () => async () => {
        await off();
      },
      'log.exporter',
    );

    this.ctx.logger.info(
      `日志落盘：${file}（级别 ${this.options.level}，缓冲 ${this.options.buffer} 条，脱敏 ${this.options.redact}）`,
    );
  }

  /** 复用注册给 cordis 的那个 exporter，格式化和脱敏规则就只有一份。 */
  private host: Exporter | undefined;

  /** 单条消息出口：格式化 → 脱敏 → 缓冲 + 落盘 + 事件（1.4 之后由 IPC 网关订阅）。 */
  private write(message: LoggerMessage): void {
    try {
      const host = this.host ?? { colors: false, export: () => {} };
      let text = Logger.format(host, message);
      if (this.options.redact) text = redactText(text);
      const line: LogLine = { ts: message.ts, level: message.type, name: message.name, text };
      this.ring.push(line);
      this.sink?.write(`${new Date(line.ts).toISOString()} ${line.level.toUpperCase()} [${line.name}] ${line.text}\n`);
      this.ctx.emit('log/line', line);
    } catch (error) {
      // 出口本身绝不能再抛：否则一条坏日志会把调用方整个流程带崩。
      console.error('[log] 写出失败：', error);
    }
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    log: LogService;
  }
}
