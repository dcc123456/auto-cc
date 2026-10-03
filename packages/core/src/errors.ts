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
  // 择机投递（spec 5.7-03）：无人值守那一路被时机规则判成「此刻不该递」。它与上面三个码都不合并——
  // 那三个是「试了没成」，这一条是「压根没试」：不落账、不进被拒流水、下一次计划点照跑。
  | 'OUTBOUND_DELIVER_DEFERRED'
  // 首次启用自动化的风险确认（spec 2.7-06）：这个平台还没有一份签字记录。
  // 与 `QUOTA_EXCEEDED` 分开，是因为额度到量是「今天别再发了」，而这一条是「你还没承认风险」——
  // 前者等一天自己就好，后者必须由用户点一次确认，界面给的按钮完全不同。
  | 'CONSENT_REQUIRED'
  // 简历投递（spec 2.6-01 / 07）。三个码的处置互不相同，所以不合并：
  // 目标已下架=这一步别再尝试（节点 `retryTimes: 0`），审批被拒或超时=人没点头所以什么都没发生，
  // 审批单查无=界面按下的是一张陈旧卡片（服务被重建过），三者都不落账、都不扣额度。
  | 'DELIVER_TARGET_OFFLINE'
  | 'OUTBOUND_APPROVAL_DENIED'
  // 待表态的单子查无此单。投递侧（2.6-c）与对话循环侧（5.3-c 的暂停单）共用这一个码而不是各造一个：
  // 界面在两边的处置一模一样——这张卡片已经过期、重读一次 `pending()` 就好，谁都不必知道它是哪一类单。
  | 'APPROVAL_NOT_FOUND'
  // 工作流状态机（spec 1.10）：非法迁移（含「还没有 run」）与占位步失败注入共用两个码，
  // 界面按码决定是「提示一句状态不允许」还是「这一步标红并可重试」。
  | 'WORKFLOW_INVALID_STATE'
  | 'WORKFLOW_STEP_FAILED'
  // 内核页面（spec 2.1）：导航地址过不了许可判定，与视图里根本没有已挂载的页面。
  // 两者界面表现不同——前者是「你给的地址不让去」，后者是「先点开门」，所以不合并成一个码。
  | 'NAVIGATE_URL_REJECTED'
  | 'NO_KERNEL_SESSION'
  // 人工接管（spec 5.5-01）：界面上那只「我来接手」收的是一句人写的理由，超长就结构化失败，
  // 不静默截断——截断等于把人写的话改成我们想听的样子，而这句话是审计里那条接管的原文。
  | 'TAKEOVER_REASON_TOO_LONG'
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
  // 会话标题（spec 5.6-07）：空与超长都在写库之前拒掉，界面各说一句不同的话——
  // 前者是「还没填」，后者是「填太多」，合并成一句会让改了半截的人以为没保存成功。
  | 'CHAT_TITLE_EMPTY'
  | 'CHAT_TITLE_TOO_LONG'
  // 会话历史导出落盘失败（spec 5.6-09）：目录不可写、磁盘满都收在这一个码上。
  // 单独一个码是因为处置只有一种——重导一次；文件没写成绝不能回一份指向不存在路径的回执。
  | 'CHAT_EXPORT_FAILED'
  // 会话改名/软删/恢复（spec 5.6-07）。两个码的处置不同所以不合并：
  // NOT_FOUND 是「这一行没有」（重读列表），NOT_DELETED 是「按下的是恢复而它根本没被删」——
  // 后者界面上该改的是按钮，不是给一句失败提示。
  | 'CHAT_SESSION_NOT_FOUND'
  | 'CHAT_SESSION_NOT_DELETED'
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
  // 定向生成的接受面（spec 4.5-11）：三个码各自对应界面的一句不同的话，所以不合并——
  // `PROPOSAL_MISSING` 是"提议态没了"（重新生成一次），`STALE_BASELINE` 是"你在生成之后自己改过简历"
  // （改的那份还在，别覆盖），`CHECK_FAILED` 是"这次选中的组合没过事实校验"（这不是重试能解决的，
  // 要人少勾几条）。合成一个"接受失败"就等于把三种不同的下一步压成一句没用的话。
  | 'KB_GENERATION_PROPOSAL_MISSING'
  | 'KB_GENERATION_STALE_BASELINE'
  | 'KB_GENERATION_CHECK_FAILED'
  // 对话循环（spec 5.2-01 / 05）。这五个码分两组：
  // 入参组（goal 空 / 超长）与界面组处置相同——把原因显示成一行提示、不改任何状态；
  // 状态组（run 查无 / 状态不对就不许确认）必须分开，因为界面给的话不同——
  // 「这张计划卡过期了」与「这条 run 查不到」是两件不同的事，合成一个码会让人误判。
  // `AGENT_LOOP_STATUS_INVALID` 单独留着：它只在写库前挡一个非法状态值，用户永远不该看见它。
  | 'AGENT_LOOP_EMPTY_GOAL'
  | 'AGENT_LOOP_GOAL_TOO_LONG'
  | 'AGENT_LOOP_RUN_NOT_FOUND'
  | 'AGENT_LOOP_NOT_PROPOSED'
  // 恢复口（spec 5.5-01 / 02）：只有「因接管而停住」的 run 能被「继续」再跑起来。
  // 与 `AGENT_LOOP_NOT_PROPOSED` 分开，是因为界面上那两只按钮属于两种态——按错了要说的是
  // 「这条 run 不是被接管按住的」（去做另一件事），而不是「这张计划卡还没确认」。
  | 'AGENT_LOOP_NOT_RESUMABLE'
  // 恢复口按下去时页面**还在接管中**（spec 5.5-01）：这不是「按错了别的路」，而是「那一双手还没离开页面」。
  // 与上面那条分开，是因为界面上的处置完全不同——这条要把「交还页面」那只按钮指给他，而不是让他去改档位。
  | 'AGENT_LOOP_TAKEOVER_HELD'
  // 恢复前的**强制重读**没做成（spec 5.5-03）：重读口不在开放面上、或它自己失败了。
  // 单独一个码而不是复用 `AGENT_LOOP_TAKEOVER_HELD`，是因为界面上的处置完全不同——那条让人「先交还页面」，
  // 这条是页面已经交回来了、缺的是「读一遍现在的页面」这道能力（装配或站点问题），run 照旧停在安全点。
  | 'AGENT_LOOP_REREAD_UNAVAILABLE'
  | 'AGENT_LOOP_STATUS_INVALID'
  // 免确认白名单（spec 5.3-06 / 07）：只在开放面上的动作才能加白。单独一个码而不是复用 `TOOL_UNAVAILABLE`
  // 那类判定读数，是因为这条走的是**写入口**——界面上的处置是「名单一行都不动 + 说明这只手不在开放面上」，
  // 而读数类的拒绝是「这一步不执行」，两件事混在一个码里会让人以为已经加白了只是这次没跑。
  | 'AGENT_POLICY_EXEMPT_UNKNOWN'
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

/**
 * 「页面现状与计划里的声明不符」这一族失败码（spec 5.5-04 的扳机）。
 *
 * 放在定义码的这一个文件里，而不是在循环里抄一份字符串：这两个码的主人是 L2 的定位与动作层
 * （`browser.locate` / `browser.act`），循环只是**读**它们来判断「这一步落空是因为页面变了」。
 * 刻意不含 `ACT_FAILED`（页面动作被拒）与 `TOOL_*`（注册表自己的拒），那些不是「找不到目标」，
 * 按 5.5-04 重规划它们就是把「重规划」用成了无条件重试。
 */
export const PAGE_DRIFT_CODES: readonly string[] = ['WAIT_TIMEOUT', 'LOCATE_FAILED'];
