# 计划二 · 集成浏览器自动化（plan）

> 前置：P1 的 1.1–1.10 已定义骨架（Electron 壳、cordis kernel、IPC 契约、内核视图容器 1.2-12、
> 会话分区 1.8、额度闸门 1.9、工作流主界面 1.10）。**本计划只在 P1 骨架之上加自动化能力**，
> 不重开基础设施。规范依 `AGENTS.md`（尤其 §2 复用优先、§6 方案先行、§7 可视验收）。

## 0. 证据基线（全部实测，非推断）

| 事实                                                                                                                                                                                                                            | 取证方式                                                           | 对本计划的约束                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron 44.4.5 主进程内 cordis 可运行、可驱动窗口                                                                                                                                                                              | spike `.research-repos/cordis-spike/electron-main.mjs` + `run.log` | 自动化 service 一律挂主进程，渲染层只读状态                                                                                                                                                                              |
| CDP（`--remote-debugging-port` + `/json`）能读到实时 DOM 并截图                                                                                                                                                                 | 同一 spike，读出过页面文本                                         | agent 可视自测（2.x 的 V 项）走这条路，不靠纯脚本断言                                                                                                                                                                    |
| `session.fromPartition('persist:x')` 重启后 cookie 仍在                                                                                                                                                                         | spike 实测二次启动会话保留                                         | 2.1 的持久化方案基础                                                                                                                                                                                                     |
| `browser-copilot` **PolyForm Noncommercial 1.0.0**                                                                                                                                                                              | 读其 `LICENSE` + `package.json` `[实测]`                           | 默认 **clean-room**：只取结构与协议概念。版权方（`dcc123456`，即需求方）已于 2026-09-30 口头确认可自由改授，但**书面授权文件尚未落地**，因此本仓库仍按不搬运代码执行（见 `docs/research/source-repos-analysis.md` §1.2） |
| 取证副本有两份，且**不是同一份**：tarball 解包副本 `D:\works\deep-seek-workspace\.research-repos\src\browser-copilot-main`（无 `.git`）与后续 `git clone` 副本 `D:\works\deep-seek-workspace\browser-copilot`（HEAD `984cf3d`） | `ls` + `git -C ... log -1` `[实测]`                                | 引用源仓库一律写**绝对路径 + 文件:行**，并注明取自哪一份副本；两份内容会漂移，行号不可混用                                                                                                                               |
| 三个源仓库对 `zhipin\|boss\|直聘\|猎聘\|打招呼` **零命中**                                                                                                                                                                      | `grep -r` `[实测]`                                                 | BOSS 选择器、字段顺序、话术、投递时机**全部自建**，无抽取来源                                                                                                                                                            |
| `browser-copilot` 的 server runner 用 Playwright                                                                                                                                                                                | 读其 `server/package.json` `[实测]`                                | **不采用**：与 §1.4 零前置依赖红线冲突；采用其「扩展通道 = CDP + 注入」形态                                                                                                                                              |
| 未引入 Playwright ⇒ 没有自动等待/选择器引擎                                                                                                                                                                                     | 由上条推导，2.2 需反向验证                                         | 必须自建 locator 层，否则 2.3+ 全是脆弱 sleep 循环                                                                                                                                                                       |

## 1. 技术选型与理由

| 项                  | 选择                                                                                                   | 理由与否决项                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 被驱动的页面宿主    | Electron 自带 Chromium，`WebContentsView` 挂载（复用 1.2-12 容器）                                     | 否决 Playwright/Puppeteer 自带浏览器（首启动联网下载 + 体积翻倍 + 违反「只装一个 app」）；否决 `puppeteer-core`+系统 Chrome（要求用户装 Chrome） |
| 页面操作通道        | `webContents.executeJavaScript` 注入原语 + 必要处 CDP `Input.dispatch*`（真实点击/输入法）             | 纯 JS 注入无法产生受信事件（isTrusted），点击/输入的关键动作走 CDP；否决扩展式 `chrome.debugging`（我们是 Electron，无扩展运行时）               |
| 定位策略            | 自建 **locator**：多策略候选（`data-testid` → role+文本 → 文本 → CSS → XPath）+ 评分 + 失效重定位      | 没有 Playwright 的 auto-wait，locator 必须自带「等待谓词」，否则退化成 `setTimeout` 轮询                                                         |
| 站点知识载体        | **站点知识包**（声明式：域名、路径模式、字段顺序、选择器候选、失败分支、频控参数）与适配器代码分离     | 选择器腐化最快（AGENTS.md/主计划 §2 原则 4）；数据化才能不改代码热更新                                                                           |
| 流程编排            | 自建 `workflow.runner`：线性步骤序列 + 重试 + 断点续跑 + 节点级事件（借鉴 IR→compile→repair **结构**） | 否决直接吞 `browser-copilot` 引擎（111k 行 + PolyForm）；否决外部工作流库（与 cordis effect 生命周期打架）                                       |
| 登录态              | `persist:<platform>` 分区 + 失效探测（2.1 骨架已有），本计划接真实平台分区                             | 不实现自动登录/扫码绕过；失效即提示用户在场操作                                                                                                  |
| 外发（打招呼/投递） | 一律先过 `entitlement.gate`（1.9）+ 频控 + human-in-the-loop 开关                                      | 主计划 §8 合规立场；风控出现即暂停                                                                                                               |

## 2. 本计划新增的包与 service

```
packages/
  browser/        @auto-cc/browser      # 内核会话宿主、locator 层、注入原语、CDP 输入
  platform-boss/  @auto-cc/platform-boss # BOSS 适配器 + 站点知识包（数据）
  workflow/       @auto-cc/workflow     # workflow.runner：节点模型、执行、重试、断点、事件
```

对外的 cordis service（命名遵循 `域.能力`）：

| service             | 归属包        | 职责（只列对外方法签名意图，不含实现）                                                              |
| ------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `browser.page`      | browser       | `navigate(url)` / `snapshot()` —— 只在「会话已打开」的那块视图上做页面原语，不拥有分区              |
| `browser.act`       | browser       | `click(locator)` / `type(locator, text)` / `select(locator, value)` / `waitFor(predicate)`          |
| `browser.locate`    | browser       | `find(spec, opts)` → 候选评分结果；`refind(lastKnown)` → 自愈重定位                                 |
| `platform.registry` | browser(契约) | `list()` / `get(platform)` → `PlatformAdapter`                                                      |
| `platform.boss`     | platform-boss | `search(criteria)` / `detail(id)` / `chat(id, text)` / `sendResume(id)` / `readReplies(id)`         |
| `jd.store`          | platform-boss | JD 实体读写（表结构在 1.3 store 之上建 migration）                                                  |
| `workflow.runner`   | workflow      | `run(plan, ctx)` / `pause(runId)` / `resume(runId)` / `stepState(runId)`，节点事件走 `cordis:event` |

**2.1 实施时定下的两处命名/归属决策（写在这里，后续子计划不得各走一套）**：

1. 原表第一行写的是 `browser.session`（`open/close/navigate/snapshot/partitionOf`）。
   **`open` / `close` / `partitionOf` 三项不进 browser 包**：P1 的 1.8 已经把「挂载视图 + 分区 +
   登录态判定」收在 `sessions.open` / `sessions.close` / `partitionFor` 上，再开一个 `browser.session`
   就是同一能力两个入口（AGENTS.md §2.5 明令禁止）。所以 `browser` 包只拿 `navigate` / `snapshot`，
   service id 叫 `browser.page`；spec 2.1-01 字面上的 `browser.session.open('boss')` 按
   `sessions.open('boss')` 打分，判据（在主窗口内挂载、不新开窗口）不变。
   归属因此是三方而不是两方：`shell` 拥有视图（借出 `kernelContents()` / `mountKernelSite()`）、
   `sessions` 拥有分区与登录态、`browser` 只拥有页面。
2. **`browser.page` 的两个系统边界守卫**（不是防御性编程，是真实入口）：
   `navigate` 只允许落在**已登记平台 startUrl 的 origin** 上（`NAVIGATE_URL_REJECTED`），
   `snapshot` 对页面回读的一切值做钳制（长度截断、非字符串归空、未知 readyState 归 `complete`）——
   外部页面的读数不可信，直接进界面文案会把面板变成页面想说什么都行。

**验收前置（2.1 踩过，写死）**：`pnpm dev` **不**拉起 fixture 服务。任何 2.x 的 V 类条目开工前，
先确认 `127.0.0.1:10233` 上站着的是**当前**这份 `scripts/fixture-server.ts`
（`curl http://127.0.0.1:10233/boss` 返 200 而不是 404），否则内核视图会渲染成一个真实的
「not found」，拍出来的证据是假的。2.1 第一次开视图就撞上了上一轮会话遗留的旧服务。

**复用优先的具体体现**（AGENTS.md §2.1，写代码前先核对）：配置读取用 1.3 的 `config`，日志用 `logger`，
持久化用 `store`，外发计量用 `entitlement`，错误用 `core` 的 `AppErrorPayload`，
渲染层通道用 1.4 的 IPC 契约 —— **本计划内不得新建这五类基础设施**。

## 3. 分层与边界（四条硬规则在本计划的落地形）

1. `browser` 不得 import `platform-boss`（内核不认识 BOSS）；平台知识只能经 `platform.registry` 注册进来。
2. `workflow` 不得 import 任何平台包；它只调用 `PlatformAdapter` 接口。
3. `platform-boss` 不得直接碰 `webContents`；一切页面动作经 `browser.act` / `browser.locate`。
4. 任何外发（`chat` / `sendResume`）在**适配器内部**调 `entitlement.gate.check()`，且在 UI 上受 human-in-the-loop 开关控制；
   绕过 gate 的调用必须有测试使其失败（沿用 1.9-05）。

## 4. locator 层设计（本计划的技术核心，必须先立住）

自建 locator 是为替换 Playwright 的两件事：**自动等待**与**选择器引擎**。设计要点：

1. **LocateSpec（声明）**：一组候选策略 + 语义描述（"JD 卡片的薪资字段"）+ 期望基数（single/many）。
2. **评分**：对每个候选命中的元素打分（稳定性来源 > 语义匹配 > 路径深度 > 兄弟歧义度），返回 top-N。
3. **等待谓词**：`waitFor` 是「出现/消失/可见/可点击/文本变化」的组合，用 `MutationObserver` + rAF 实现，
   **禁止裸 `sleep`**；超时抛结构化错误（附最后一次 DOM 快照引用，供失败快照用）。
4. **自愈重定位**：节点失败时，用记录的元素指纹（tag + 属性集 + 周围文本锚点）在同页重找；
   重定位成功要落事件，供「选择器腐化」统计（2.7 的输出）。
5. **反向验证**（AGENTS.md §6.5）：2.2 必须有一条验收专门回答
   「不用 Playwright 之后，是否有 Playwright 独有能力补不上」。答案落在实测：
   能补上（等待/定位/iframe/新标签接管/网络等待各有对策）或明确记录缺口。

## 5. 工作流模型（2.4）

```ts
// 概念视图，实际类型在 packages/workflow
WorkflowPlan = { id, nodes: Node[], edges: order }        // 线性为主，允许条件跳转
Node        = { id, kind, target?, params, retry, onFail, evidence[] }
RunState    = { runId, nodeIndex, status, lastError, snapshotRef }
```

- **节点级可观测**：每个节点起止、耗时、结果摘要、失败快照（DOM 片段 + 截图路径）都发事件；
  1.10 工作流面板与 1.11 对话界面（工具卡片）订阅同一批事件渲染进度（2.8）。
- **断点续跑**：`RunState` 落 SQLite，进程重启后可从失败节点续；已完成节点不重放（幂等键 = `runId+nodeId+targetId`）。
- **人工接管点**：节点属性 `requiresHuman`（如登录失效、验证码、投递确认）→ 面板出现接管按钮，
  agent 自动化在此停住，等用户在场操作（§8 合规立场）。

## 6. 测试策略（本计划最容易自欺的部分，写死）

| 层级                | 手段                                                                                                                            | 覆盖子计划                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 纯逻辑单测（U）     | vitest：locator 评分、IR 编译、重试判定、频控计算、JD 归一化                                                                    | 2.2 / 2.3 / 2.4 / 2.5             |
| fixture 站点（V/C） | **本地 HTTP 服务托管的仿站**（搜索页/详情页/聊天页/投递弹窗，DOM 结构刻意模仿但不含真实平台代码），驱动真实 Electron 窗口操作它 | 2.1 / 2.2 / 2.3 / 2.5 / 2.6 / 2.8 |
| CDP harness（V）    | agent 打开 app → 截图 → 读 DOM 断言 → 点击 → 再断言，逐步留证                                                                   | 所有 V 项                         |
| 真实平台            | **只在用户在场时手动验证**，不进自动化；每次真实验证的结果以 `docs(acceptance)` 记录                                            | 2.3-真实、2.6-真实                |

**禁止**：自动化测试里出现 `zhipin.com` 等真实域名（AGENTS.md §7.2，1.6 落 URL allowlist）。
fixture 站的选择器与站点知识包分开存放，改仿站不影响适配器接口。

## 7. 子计划分解与顺序（一次只推进一个）

| #   | 子计划                                                                                                | 完成判据（详见 spec）                                | 依赖                               |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| 2.1 | 内核会话服务与登录态接管：`browser.session` 在真实窗口里打开/导航/快照，分区持久化跨重启，失效探测    | spec 2.1 全绿（含「重启后 fixture 站仍显示已登录」） | 1.2 / 1.8                          |
| 2.2 | locator 层 + `PlatformAdapter` SPI                                                                    | spec 2.2 全绿（含反向验证条目）                      | 2.1                                |
| 2.3 | JD 抓取与结构化入库：搜索条件 → 列表 → 详情 → 规范化 JD 实体                                          | spec 2.3 全绿（fixture 站 ≥10 条入库）               | 2.2                                |
| 2.4 | `workflow.runner`：节点模型、重试、断点续跑、失败快照、节点事件                                       | spec 2.4 全绿                                        | 2.2                                |
| 2.5 | 打招呼与对话：话术注入、发送、回复监听、频控与人类化节流                                              | spec 2.5 全绿（fixture 站，且 ledger 有账）          | 2.3 / 2.4 / 1.9                    |
| 2.6 | 简历投递动作 + human-in-the-loop + gate 计量                                                          | spec 2.6 全绿                                        | 2.5 / P3.3（需有可投递的简历产物） |
| 2.7 | 反爬与合规护栏：随机化、日上限、风控检测即暂停通知                                                    | spec 2.7 全绿                                        | 2.5                                |
| 2.8 | 双入口接通：浏览器能力登记为 `agent.tools` 工具、工作流面板与对话界面同步显示进度、可中断可接管可续跑 | spec 2.8 全绿（截图为证）                            | 1.10 / 1.11 / 2.4                  |

> **对 P3 的依赖是软的**：2.6 需要「有一份可投递的简历 PDF」，P1/P2 阶段用固定占位 PDF 顶替，
> 不等 P3。这样 2.1–2.5 不被 P3 阻塞。

## 8. 明确不做（P2 阶段）

- 不做多平台并行（先做 BOSS 一个适配器；`platform.registry` 留位但不写第二家）。
- 不做自动登录、扫码辅助、验证码识别、指纹伪装、多账号池（主计划 §8 一律拒绝）。
- 不做无人值守定时跑（croner 类调度属 P5）。
- 不做录制→工作流的可视化编辑器（`@xyflow` 画布属 P5；2.8 只做进度面板）。
- **不做对话编排与规划循环**：2.8 只把浏览器能力登记成 `agent.tools` 工具并让两个界面都能看到进度；
  「自然语言→计划→选工具→执行」的 agent loop 属 P5，P2 阶段任何"在浏览器模块里判断该调哪个工具"的代码都算越界。
- 不做 MCP 对外接口（属 P5）。
- 不引入 Playwright / Puppeteer / 任何自带浏览器下载链；不引入 `cheerio` 之外的第二套 DOM 解析（页面 DOM 一律在页面内取，不在 Node 侧解析 HTML 字符串）。

## 9. 子计划 2.2 的选型与证据（开工前定稿，实现照此执行）

### 9.1 一手取证（读源仓库**概念与数值**，不搬代码）

副本 A = `D:\works\deep-seek-workspace\.research-repos\src\browser-copilot-main`（tarball 解包，无 `.git`）。
以下结论取自**同仓库的 git clone 副本** `D:\works\deep-seek-workspace\browser-copilot`（HEAD `984cf3d`），行号只对该副本有效 `[实测]`：

| 主题     | 该仓库的做法（概念，已核对到行）                                                                                                                                                                                                                                                                                | 我们的取舍                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 策略生成 | 每元素生成多候选：6 种 testid 属性 / 稳定 `id` / `name`+tag / role+可读名 / 精确可见文本 / CSS 路径；可读名级联 `aria-labelledby → aria-label → label → placeholder → title → alt → submit value → 自身文本`（`src/inpage/kernel.ts:211-218,599-615,156-207`）                                                  | **采纳级联顺序**（这是 W3C accname 的工程化近似，不是它的私有发明）；候选策略类型化进 `LocateSpec`                                                                           |
| 评分     | 权重表 testid 100 / role+name 95 / id 90 / label 88 / name 85 / 稳定 data-* 75 / 精确文本 70 / CSS 35 / XPath 25 / 纯位置 10；生成串与带 `nth` 的候选硬顶到 10；歧义判定要 **minScore 70 且与次优 margin ≥ 12**，否则 **fail closed**（`src/lib/workflow/locator-score.ts:30-53,99-154,228-254`）               | **采纳「阈值 + margin + fail closed」三件套**，数值进配置不进代码（spec 2.7-04 禁魔法数）                                                                                    |
| 指纹     | `tagName/role/accessibleName/normalizedText/stableAttributes/ancestorRoles/nearbyTexts`（`element-fingerprint.ts:52-64`）；**没有相似度重匹配算法**——自愈靠候选回退链 + 语义优先 resolver，多义时拒绝猜测                                                                                                       | 采纳字段集；`refind` 我们做成「指纹重找 + 唯一命中才认」，同样不猜（spec 2.2-05）                                                                                            |
| 等待     | **纯轮询**：动作前置门 1200ms 上限 / 120ms 轮询，检查 exist+visible+enabled+未被遮挡 + 两帧 bbox 稳定；可见性用 computed style + 零矩形 + `aria-hidden`；遮挡用 `elementFromPoint`（`src/background/driver.ts:307-351`、`kernel.ts:75-119,1252-1288,1667-1691`）                                                | **不照抄**：spec 2.2-03 明确要求 `MutationObserver` 且禁裸 sleep。采纳它的**判据集合**（可见/可点/未被遮挡/稳定），把触发器换成观察器                                        |
| iframe   | 用 `chrome.debugging` 注入 `allFrames:true` 再按 `found*4+ok*2+topFrame*1` 给各 frame 的应答排序（`driver.ts:461-541`）；闭合 shadow 走 CDP                                                                                                                                                                     | 采纳**多 frame 应答排序**这个形态；通道换成 Electron 的 `WebFrameMain.executeJavaScript`（`electron.d.ts:19232`）+ `framesInSubtree`（同 `:19302`）                          |
| 新标签   | **不存在自动接管**：只有录制态 `tabs.onCreated` 记账，运行态钉住 scope tab（`record-controller.ts:186-251`、`driver.ts:116-147`）                                                                                                                                                                               | 无处可抄，自己实现（spec 2.2-11）：`setWindowOpenHandler` deny + 同分区挂子视图                                                                                              |
| 输入     | 默认**非受信合成**：原生 prototype setter 写 `.value` + 派发 input/change；仅在回读校验失败时才升级到 CDP `Input.insertText`（明确说是为 IME/非 ASCII），逐字符 `dispatchKeyEvent` 兜底（`kernel.ts:864-885`、`driver.ts:551-567`、`src/background/cdp-typing.ts:50-58,178-208,269-279`）；**无随机化打字节奏** | 反着来：点击与输入**默认走 CDP 受通道**（spec 2.2-12 要 `isTrusted=true`），`.value` 直塞只作为不可 attach 时的显式降级且必须在结果里标注；人类化节奏是 2.5 的事，本层不提供 |

### 9.2 归属与命名（延续 2.1 那三条，不再新开入口）

| 新增                                                     | 落在哪                                                                                            | 为什么在这                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `browser.locate`（`find` / `refind`）                    | `packages/browser`，与 `browser.page` 并列的第二个 service                                        | 定位是页面语义，不是会话语义；`refind` 要发 `locator/relocated` 事件供 2.7 统计腐化率                              |
| `browser.act`（`click` / `type` / `select` / `waitFor`） | `packages/browser`，构造时 `inject: ['browser.locate']`                                           | 动作先定位再输入，拆两个包只会把一次 DOM 往返变成两次；同包内 `locate` 是被注入方，不构成循环依赖                  |
| 页面通道（多 frame 求值 + 应答排序）                     | `packages/browser/src/frame-channel.ts`（包内共享，`page/locate/act` 三处都用）                   | 第 2.2 条：同一逻辑出现第二次就抽公共层。句柄获取与注入失败的结构化错误也只此一份                                  |
| CDP 输入通道                                             | `packages/browser/src/input-channel.ts`                                                           | 唯一 `debugger.attach` 点。视图销毁时必须 detach，否则目标留在 Electron 目标表里（2.1-11 数过这个坑）              |
| `platform.registry` + `PlatformAdapter` 契约             | `packages/browser`（契约与登记表都在内核侧）                                                      | plan §3 规则 1：`browser` 不认识 BOSS，平台知识只能被注册进来。注册动作发生在装配层，不在 browser 里 import 平台包 |
| BOSS 适配器 + 站点知识包                                 | **新建** `packages/platform-boss`（plan §2 已登记，理由：站点知识是数据资产，与内核代码分开发版） | 2.2 只交付契约 + 空壳适配器 + 知识包形态；抓取实现属 2.3                                                           |

### 9.3 参数全部进配置（`cordis.yml`），代码里不写魔法数

| 配置键（`browser.locate`） | 含义                                     | 默认值 | 由哪条 spec 决定                   |
| -------------------------- | ---------------------------------------- | ------ | ---------------------------------- |
| `minScore`                 | 候选最低可用分（低于则判「不确定命中」） | 70     | 2.2-02（评分可解释 + fail closed） |
| `minMargin`                | 与次优候选的最小分差                     | 12     | 2.2-02                             |
| `candidateLimit`           | 一次 `find` 回传的 top-N                 | 5      | 2.2-02（排序稳定可断言）           |
| `textNormalizationLimit`   | 指纹里文本/属性值的截断长度              | 80     | 2.2-05                             |

| 配置键（`browser.act`） | 含义                                              | 默认值 | 由哪条 spec 决定             |
| ----------------------- | ------------------------------------------------- | ------ | ---------------------------- |
| `waitForTimeoutMs`      | 谓词等待上限（超时即结构化失败）                  | 5000   | 2.2-03 / 2.2-04              |
| `stableCheckSamples`    | 判定「几何稳定」需要连续一致的采样帧数            | 2      | 2.2-03（可点击谓词）         |
| `typeCharDelayMs`       | CDP 逐字符键入的间隔上限（`insertText` 路径不用） | 120    | 2.2-13（不乱码优先于人类化） |
| `cdpInputEnabled`       | 是否使用 CDP 受信输入通道（关掉即显式降级）       | true   | 2.2-12                       |

### 9.4 本机实测前置（AGENTS.md §6.2，写调用代码**之前**跑完）

spike 落在仓库外 `.research-repos\locator-spike\spike.mjs`（运行：仓库内那份 electron.exe +
`--remote-debugging-port=10223`，**不占用 10222**，结论文件 `spike-run-1.log`）。四条全部实测通过：

| 问题                               | 实测结论（对 `WebContentsView` 的 webContents）                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 帧内求值                        | `mainFrame.framesInSubtree` 返回 3 个帧（顶层 + 同源 iframe + **跨源** `localhost:10298` iframe），三处 `frame.executeJavaScript()` **全部可用**——不需要 CDP isolated world，也没有 OOPIF 缺口 |
| Q2 CDP 输入是否受信                | `debugger.attach('1.3')` + `Input.dispatchMouseEvent`（mousePressed/mouseReleased）→ 页面记到 `isTrusted: true` 的 `mousedown`/`click`，坐标即派发点                                           |
| Q2b 与 harness 的远端 CDP 是否互斥 | **不互斥**：`debugger` 已 attach 时，远端 `Runtime.evaluate` 仍读到 `document.title`。（`Browser.getWindowForTarget` 依旧 `-32601`，与 2.1-10 同口径）                                         |
| Q3 iframe 内元素坐标               | CDP 要顶层视口坐标：`父帧 iframe.getBoundingClientRect() + 帧内元素 rect（+ 各自 scroll 偏移）`；按此换算后点击落在帧内（帧内读到 `isTrusted:true`，`clientY` 是帧内坐标）                     |
| Q3b 中文/emoji 输入                | `Input.insertText({text:'自动化验收🎯'})` → 输入框回显完全一致，页面收到 `inputType:'insertText'` 且 `isTrusted:true`；`dispatchKeyEvent(text:'A')` 逐字符路径同样可用                         |
| Q4 新标签接管                      | `setWindowOpenHandler` 在 target=_blank 上触发（`disposition:'foreground-tab'`），返回 `deny` 后由我们挂子视图：同分区 **cookie 直接共享**（子视图读到 `spike_session=kept`）                  |
| Q5 子视图销毁                      | `removeChildView` + `webContents.close()` 后该页面从 CDP 目标表消失（与 2.1-11 用的 `close()` 口径一致）                                                                                       |

由这几条直接定下实现形态：**帧内求值走 `WebFrameMain`，输入走 `webContents.debugger`，接管走「deny + 同分区子视图」**，
不需要引入任何第三方 CDP 客户端库。

### 9.5 fixture 站需要补的四块（V 类条目的靶子）

`scripts/fixture-server.ts` 当前有搜索页/详情页/登录/`/boss`。2.2 需要新增：

1. `/locator` —— 同一 spec 在多种 DOM 下命中不同策略的对照页（testid / role+文本 / 文本 / CSS / XPath 各一块），
   并含**延迟插入**元素（验证观察器等待）与**改版前后**两份 DOM（验证 2.2-05 自愈）；
2. `/chat` —— 聊天区放在 **同源 iframe** 里，含输入框与发送按钮，消息落 `/api/outbox`（2.2-10 / 2.2-13 的靶子）；
3. `/newtab` —— 一个 `target=_blank` 链接与一个 `window.open()` 按钮（2.2-11）；
4. `/trusted` —— 页面自己记录 `event.isTrusted`、`inputType`、回显值到 `/api/state`（2.2-12 / 2.2-13 的对端读数）。

**开工前置（同 §2 那条）**：先 `pnpm fixture`，再 `curl http://127.0.0.1:10233/locator` 返 200，才允许打 V 分。

### 9.6 许可状态对本子计划的影响

2.2 **不需要**授权文件：locator / 评分 / 指纹 / 等待 / CDP 输入全部按 §4 与 §9.2 自建，
上表只引用概念与数值（概念不受版权保护，且已标注来源行号供审计）。
授权文件真正卡住的是 2.5 的话术/prompt 文本与 2.6 的站点知识搬运——
在那两项开工前必须先落地 `docs/research/source-repos-analysis.md` §1.2 第 2 条所述的书面文件。
