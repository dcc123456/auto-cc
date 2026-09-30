export type AppErrorCode =
  | 'SERVICE_NOT_FOUND'
  | 'METHOD_NOT_FOUND'
  | 'NOT_IN_ALLOWLIST'
  | 'NOT_SERIALIZABLE'
  | 'PLUGIN_FAILED'
  | 'CONFIG_INVALID'
  | 'PLATFORM_NOT_CONFIGURED'
  | 'INVALID_ARGUMENT'
  | 'QUOTA_EXCEEDED'
  | 'OUTBOUND_FAILED'
  // 工作流状态机（spec 1.10）：非法迁移（含「还没有 run」）与占位步失败注入共用两个码，
  // 界面按码决定是「提示一句状态不允许」还是「这一步标红并可重试」。
  | 'WORKFLOW_INVALID_STATE'
  | 'WORKFLOW_STEP_FAILED'
  // 内核页面（spec 2.1）：导航地址过不了许可判定，与视图里根本没有已挂载的页面。
  // 两者界面表现不同——前者是「你给的地址不让去」，后者是「先点开门」，所以不合并成一个码。
  | 'NAVIGATE_URL_REJECTED'
  | 'NO_KERNEL_SESSION'
  // 注入脚本本身在页面里抛了（页面被销毁、脚本被 CSP 拦下），与「读到了但内容为空」是两回事。
  | 'PAGE_SCRIPT_FAILED'
  // 内核视图取像素失败（spec 2.4-04 的失败截图）：`capturePage()` 抛错与回了一张空图共用一个码，
  // 因为调用方（工作流证据）对两者的处置相同——证据里记 null，而不是把整条 run 判成别的结局。
  | 'PAGE_SCREENSHOT_FAILED'
  // 定位与动作层（spec 2.2）。三个动作错误按「停在哪一步」分码，界面据此决定给不给重试按钮：
  // 声明本身不可用（改数据）、等不到可点（可重试）、未过线（要看候选）、下发被拒（可重试）。
  | 'LOCATE_SPEC_INVALID'
  | 'WAIT_TIMEOUT'
  | 'LOCATE_FAILED'
  | 'ACT_FAILED'
  // 站点知识包（spec 2.2-08）与适配器登记（spec 2.2-07）：前者是数据不合法，后者是装配缺包。
  | 'KNOWLEDGE_PACK_INVALID'
  | 'PLATFORM_NOT_REGISTERED'
  // 对话骨架（spec 1.11）：入参边界（空 / 超长）、并发（上一条还在流式）、档位枚举、注册表重复登记。
  // 界面按码决定是「把原因显示成一行提示」还是「什么都不改」。
  | 'CHAT_EMPTY_INPUT'
  | 'CHAT_INPUT_TOO_LONG'
  | 'CHAT_BUSY'
  | 'CHAT_AUTONOMY_INVALID'
  | 'TOOL_DUPLICATE'
  // 模型出口（spec 2.5-01 / 2.5-12）：两个码必须分开，因为处置不同——
  // `LLM_UNAVAILABLE` 是「根本没配」，调用方应当回落模板并在界面播报；`LLM_REQUEST_FAILED` 是「配了但这次没成」，
  // 由调用方决定是否重试。合成一个码会让界面对两者说同一句谎话。
  | 'LLM_UNAVAILABLE'
  | 'LLM_REQUEST_FAILED'
  | 'UNKNOWN';

export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
  path?: string;
  details?: unknown;
  stack?: string;
}

/**
 * Errors crossing the IPC boundary must be plain data — an Error instance does not
 * survive structuredClone with its message intact.
 */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly path?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toPayload(): AppErrorPayload {
    return { code: this.code, message: this.message, path: this.path, details: this.details, stack: this.stack };
  }

  static from(error: unknown, fallbackCode: AppErrorCode = 'UNKNOWN'): AppErrorPayload {
    if (error instanceof AppError) return error.toPayload();
    if (error instanceof Error) return { code: fallbackCode, message: error.message, stack: error.stack };
    return { code: fallbackCode, message: String(error) };
  }
}

export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as AppErrorPayload).message === 'string'
  );
}
