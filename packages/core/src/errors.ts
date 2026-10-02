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
  // 话术生成（spec 2.5-10）：将要发往页面的文本命中禁发规则（手机号/身份证/验证码类）或超长。
  // 与 `OUTBOUND_FAILED` 分开，是因为前者根本不该产生网络请求，界面上也不该给"重试"按钮。
  | 'OUTBOUND_FORBIDDEN_CONTENT'
  // 打招呼编排（spec 2.5-02 / 13）。三个码各对应一种「发不出去」，界面处置不同，所以不合并：
  // 渠道缺失=装配没装平台包（改清单），重复发送=幂等键已落账（别再点），未送达=页面回读没确认（可重试）。
  // 后两者都**不落账**，所以额度不会被一次没发生的发送吃掉。
  | 'OUTBOUND_CHANNEL_MISSING'
  | 'OUTBOUND_ALREADY_SENT'
  | 'OUTBOUND_NOT_DELIVERED'
  // 首次启用自动化的风险确认（spec 2.7-06）：这个平台还没有一份签字记录。
  // 与 `QUOTA_EXCEEDED` 分开，是因为额度到量是「今天别再发了」，而这一条是「你还没承认风险」——
  // 前者等一天自己就好，后者必须由用户点一次确认，界面给的按钮完全不同。
  | 'CONSENT_REQUIRED'
  // 简历投递（spec 2.6-01 / 07）。三个码的处置互不相同，所以不合并：
  // 目标已下架=这一步别再尝试（节点 `retryTimes: 0`），审批被拒或超时=人没点头所以什么都没发生，
  // 审批单查无=界面按下的是一张陈旧卡片（服务被重建过），三者都不落账、都不扣额度。
  | 'DELIVER_TARGET_OFFLINE'
  | 'OUTBOUND_APPROVAL_DENIED'
  | 'APPROVAL_NOT_FOUND'
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
  // 简历导出（spec 3.3-11）：文档缺失 / 非法、内核打印失败（字体缺失、printToPDF 抛错）、落盘不可写
  // 都归这一个码——三者在界面上的处置相同（一句可读中文提示 + 可重试），所以不拆成三个码让界面重复劳动。
  | 'RESUME_EXPORT_FAILED'
  // 简历导入（spec 4.1-06）：路径非法 / 文件读不出 / 格式不认识 / PDF·DOCX 结构损坏
  // 都归这一个码——它们在界面上的处置相同（一句可读中文 + 让人换个文件），拆成六个码只会让界面写六遍分支；
  // 具体子原因在 `details.code` 里（`SourceFailureCode`），技术原文在 `message` 尾部，不进界面。
  | 'RESUME_IMPORT_FAILED'
  // 知识库实体（spec 4.2-01 / 4.2-02）。两个码的处置不同所以不合并：
  // 前者是「还没有可派生的简历」（引导用户先导入），后者是「界面按下的卡片已经过期」（重读列表即可）。
  | 'KB_SOURCE_MISSING'
  | 'KB_ENTITY_NOT_FOUND'
  // 派生实体的删除入口不在知识库（spec 4.2-04 的级联策略）：它在简历工作副本里，删完同步即可。
  // 单独一个码是因为界面的处置不同——这一条要给「去简历里删」的跳转，而不是给一句删除失败的提示。
  | 'KB_ENTITY_DERIVED'
  // 缺口报告（spec 4.4-03）：库里没有可比的实体。与 `KB_SOURCE_MISSING` 分开，因为处置不同——
  // 前者是「这份简历还没入库」（去导入并派生），后者是「知识库服务整个没装配」，
  // 用户自己修不了后者，界面只能给一句"功能不可用"而不是引导。
  | 'KB_LIBRARY_MISSING'
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
