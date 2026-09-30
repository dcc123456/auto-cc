# 计划二 · 集成浏览器自动化（plan）

> 前置：P1 的 1.1–1.10 已定义骨架（Electron 壳、cordis kernel、IPC 契约、内核视图容器 1.2-12、
> 会话分区 1.8、额度闸门 1.9、工作流主界面 1.10）。**本计划只在 P1 骨架之上加自动化能力**，
> 不重开基础设施。规范依 `AGENTS.md`（尤其 §2 复用优先、§6 方案先行、§7 可视验收）。

## 0. 证据基线（全部实测，非推断）

| 事实                                                                                                                                                                                                                            | 取证方式                                                           | 对本计划的约束                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron 44.4.5 主进程内 cordis 可运行、可驱动窗口                                                                                                                                                                              | spike `.research-repos/cordis-spike/electron-main.mjs` + `run.log` | 自动化 service 一律挂主进程，渲染层只读状态                                                                                                                                                                                                                                                |
| CDP（`--remote-debugging-port` + `/json`）能读到实时 DOM 并截图                                                                                                                                                                 | 同一 spike，读出过页面文本                                         | agent 可视自测（2.x 的 V 项）走这条路，不靠纯脚本断言                                                                                                                                                                                                                                      |
| `session.fromPartition('persist:x')` 重启后 cookie 仍在                                                                                                                                                                         | spike 实测二次启动会话保留                                         | 2.1 的持久化方案基础                                                                                                                                                                                                                                                                       |
| `browser-copilot` **PolyForm Noncommercial 1.0.0**                                                                                                                                                                              | 读其 `LICENSE` + `package.json` `[实测]`                           | 默认 **clean-room**：只取结构与协议概念。版权方（`dcc123456`，即需求方）已于 2026-09-30 口头确认可自由改授，但**书面授权文件尚未落地**，因此本仓库仍按不搬运代码执行（见 `docs/research/source-repos-analysis.md` §1.2）                                                                   |
| 取证副本有两份，且**不是同一份**：tarball 解包副本 `D:\works\deep-seek-workspace\.research-repos\src\browser-copilot-main`（无 `.git`）与后续 `git clone` 副本 `D:\works\deep-seek-workspace\browser-copilot`（HEAD `984cf3d`） | `ls` + `git -C ... log -1` `[实测]`                                | 引用源仓库一律写**绝对路径 + 文件:行**，并注明取自哪一份副本；两份内容会漂移，行号不可混用                                                                                                                                                                                                 |
| 三个源仓库对 `zhipin\|boss\|直聘\|猎聘\|打招呼` **零命中**                                                                                                                                                                      | `grep -r` `[实测]`                                                 | BOSS 选择器、字段顺序、话术、投递时机**全部自建**，无抽取来源                                                                                                                                                                                                                              |
| `browser-copilot` 的 server runner 用 Playwright                                                                                                                                                                                | 读其 `server/package.json` `[实测]`                                | **本阶段不采用**（理由是「外部浏览器是独立 OS 窗口，不能再嵌进 app 面板被用户看到与接管」，不是「禁止第二套内核」）；采用其「扩展通道 = CDP + 注入」形态。需求方 2026-09-30 更正：app 自行内置/自动下载外部内核是**许可**方案，见 master plan §1.4，因此 §9.7 若出现补不上的缺口可以切宿主 |
| 未引入 Playwright ⇒ 没有自动等待/选择器引擎                                                                                                                                                                                     | 由上条推导，2.2 需反向验证                                         | 必须自建 locator 层，否则 2.3+ 全是脆弱 sleep 循环；§9.7 的对账就是「不切宿主到底缺了什么」的账本                                                                                                                                                                                          |

## 1. 技术选型与理由

| 项                  | 选择                                                                                                   | 理由与否决项                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 被驱动的页面宿主    | Electron 自带 Chromium，`WebContentsView` 挂载（复用 1.2-12 容器）                                     | 选它的正面理由：被驱动的窗口就在 app 面板里，可见 + 可人工接管 + 零下载。外部宿主（Playwright 自带 Chromium）**不是禁区**，代价是它是独立 OS 窗口、不再嵌在本面板里，故只在 §9.7 出现补不上的缺口时切换，且由 app 构建期内置或运行期自动下载（用户零手动，见 master plan §1.4）；仍否决 `puppeteer-core`+系统 Chrome（要求用户装 Chrome） |
| 页面操作通道        | `webContents.executeJavaScript` 注入原语 + 必要处 CDP `Input.dispatch*`（真实点击/输入法）             | 纯 JS 注入无法产生受信事件（isTrusted），点击/输入的关键动作走 CDP；否决扩展式 `chrome.debugging`（我们是 Electron，无扩展运行时）                                                                                                                                                                                                        |
| 定位策略            | 自建 **locator**：多策略候选（`data-testid` → role+文本 → 文本 → CSS → XPath）+ 评分 + 失效重定位      | 没有 Playwright 的 auto-wait，locator 必须自带「等待谓词」，否则退化成 `setTimeout` 轮询                                                                                                                                                                                                                                                  |
| 站点知识载体        | **站点知识包**（声明式：域名、路径模式、字段顺序、选择器候选、失败分支、频控参数）与适配器代码分离     | 选择器腐化最快（AGENTS.md/主计划 §2 原则 4）；数据化才能不改代码热更新                                                                                                                                                                                                                                                                    |
| 流程编排            | 自建 `workflow.runner`：线性步骤序列 + 重试 + 断点续跑 + 节点级事件（借鉴 IR→compile→repair **结构**） | 否决直接吞 `browser-copilot` 引擎（111k 行 + PolyForm）；否决外部工作流库（与 cordis effect 生命周期打架）                                                                                                                                                                                                                                |
| 登录态              | `persist:<platform>` 分区 + 失效探测（2.1 骨架已有），本计划接真实平台分区                             | 不实现自动登录/扫码绕过；失效即提示用户在场操作                                                                                                                                                                                                                                                                                           |
| 外发（打招呼/投递） | 一律先过 `entitlement.gate`（1.9）+ 频控 + human-in-the-loop 开关                                      | 主计划 §8 合规立场；风控出现即暂停                                                                                                                                                                                                                                                                                                        |

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
  **2026-09-30 更正指向**：画布已正式立项为 `docs/plans/05-chat-agent/plan.md` §5.10（含 DAG 解锁），
  不再是"泛 P5"；本片仍不做。
- **不做对话编排与规划循环**：2.8 只把浏览器能力登记成 `agent.tools` 工具并让两个界面都能看到进度；
  「自然语言→计划→选工具→执行」的 agent loop 属 P5，P2 阶段任何"在浏览器模块里判断该调哪个工具"的代码都算越界。
- 不做 MCP 对外接口（属 P5）。
- 本子计划不切换宿主：页面仍只由 Electron 自带 Chromium 驱动（不是永久禁令——外部内核可由 app 内置或自动下载，
  但只在 §9.7 出现补不上的能力缺口时才切，见 master plan §1.4 的更正）；不引入 `cheerio` 之外的第二套 DOM 解析（页面 DOM 一律在页面内取，不在 Node 侧解析 HTML 字符串）。

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

### 9.7 不引入 Playwright 的能力缺口对账（spec 2.2-09 的反向验证）

本阶段不切宿主换来的是「被驱动的窗口就在 app 面板里」（可见 + 可接管）与包体不变，
代价是 Playwright 内建的五项便利要自己补。这本账的用途不是辩护，而是**切换宿主的触发条件**：
下面任何一条一旦被判为「内置通道补不上」，就按 master plan §1.4 的口径由 app 内置或自动下载外部内核。
逐条对账，**已补齐的写对策，没补齐的显式记为缺口并挂到对应子计划**，不允许含糊成「以后再说」。

| Playwright 内建能力       | 本项目对策                                                                                                                                                             | 实测证据                                                                                                                                     | 状态                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 自动等待（actionability） | locator 层的五类等待谓词（appear / disappear / visible / clickable / textChanges），MutationObserver 主导 + `waitCheckMs` 兜底节拍，等不到抛 `WAIT_TIMEOUT` 结构化错误 | 2.2-03 单测（延迟插入仍命中）+ §7.4 的裸 sleep 扫描 + `docs/acceptance/2.2/2.2-04-*`（真页面上 5000ms 超时的结构化读数）                     | **已补齐**                   |
| iframe 自动穿透           | 注入脚本走 `mainFrame.framesInSubtree` 全帧求值，命中后按「父帧 iframe rect + 帧内 rect + 各自 scroll 偏移」折算顶层视口坐标                                           | §9.4 Q1/Q3 spike + `docs/acceptance/2.2/2.2-10-iframe.png`（帧内输入 + 帧内发送 + 服务端收件计数同时成立）                                   | **已补齐**（跨源帧同样可读） |
| 新标签 / 弹窗接管         | `setWindowOpenHandler` 一律 `deny` + 同分区挂 `WebContentsView` 子视图，`activeKernelViewUrl` 与 `kernelViewTakeoverCount` 是可见读数                                  | `docs/acceptance/2.2/2.2-11-takeover-readouts.txt`（`window.open` 与 `target=_blank` 两条入口各接管一个子视图，子视图读到 `autocc_session`） | **已补齐**                   |
| 网络空闲等待              | **缺口**：没有 `waitForLoadState('networkidle')` 的等价物。分页/列表加载只能等 DOM 谓词，站点若先渲染骨架屏再补数据，会读到半截列表                                    | —                                                                                                                                            | 记为缺口 → **2.3-06**        |
| 文件上传                  | **缺口**：`Input.dispatch*` 覆盖不了原生文件选择框，需走 CDP `Page.setFileInputFiles` + `DOM.setFileInputFiles` 通道，本计划未实现                                     | —                                                                                                                                            | 记为缺口 → **2.6-04**        |

两条缺口都不是「补不了」，而是**不属于 2.2 的边界**（2.2 只交付定位与动作原语）。
把它们写死在这里，是为了让 2.3 / 2.6 开工时不能假装这两项能力存在。

## 10. 子计划 2.3 的选型与证据（开工前定稿，实现照此执行）

### 10.1 这一条到底在做什么

2.2 交出的是「找到一个元素」，2.3 要交出的是「把一页岗位读成库里的一行」。中间差三件事：
**批量字段抽取**（一次读 N 个容器 × M 个字段，而不是 N×M 次定位）、**文本归一化**（薪资/经验/学历
是中文自然语言，不是结构数据）、**落库与幂等**（同一岗位重复抓不能长出新行）。
这三件事分属三层，混在一处就会写成「适配器里既拼选择器又算薪资又写 SQL」，所以先切开：

| 切面         | 归属                                                     | 为什么是它                                                                         |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 页面批量抽取 | `browser`：`browser.page.extract(containerSpec, fields)` | 页面 DOM 只在页面里读（§8 硬规则），而「读哪些字段」是定位声明的用法，不是平台知识 |
| 文本归一化   | `platform-boss/normalize.ts`（纯函数）                   | 「K·15薪」「万/年」「面议」是中文招聘站约定，内核不该认识（plan §3 规则 1）        |
| 落库与幂等   | `platform-boss`：`jd.store` 服务 + migration v2          | 表属于域，建表的一方自己说清（沿用 1.9 `usage.ledger` 留的迁移口子）               |
| 一轮抓取编排 | `platform-boss`：`jd.capture` 服务                       | 界面/工具需要一个可调用的动作；2.4 的节点**调它**，不再写第二个循环                |

### 10.2 一手取证（读概念与数值，不搬代码）

- 源仓库 `browser-copilot`（tarball 副本 `D:\works\deep-seek-workspace\.research-repos\src\browser-copilot-main`）
  的抓取侧同样是「声明字段 → 页面内取值 → 归一化入库」三段式；本项目**不引入它的 selector 库**，
  因为 2.2 已自建 locator，再引一套就是第二个 DOM 解析实现（§8 明令禁止）。
- 源仓库对 `zhipin|boss|直聘` **零命中**（plan §0 实测行），所以薪资/经验/学历的中文写法必须自建样本。
  本机实测样本取自 2.2 仿站卡片：`25-40K·14薪` / `30-45K` / `面议` / `1.8-2.5万·15薪` / `40-60K·16薪`
  —— 覆盖「K 区间」「万 区间」「薪 后缀」「面议」四类，正好是 spec 2.3-03 要求的那三类再加一类的组合。
- `node:sqlite` 的 UPSERT 与 `ON CONFLICT` 在 1.3 已实测可用（`docs/acceptance/1.3/1.3-06-node-sqlite-in-electron.txt`），
  2.3-04 的幂等靠**唯一索引 + `ON CONFLICT DO UPDATE`**，不靠「先查再插」——那两句之间状态会变，
  重放与并发都会长出新行。

### 10.3 归属与命名（延续 2.1/2.2 的口径，不再新开入口）

1. **抽取挂在 `browser.page`，不新建 `browser.extract` 服务**：`page` 的职责就是「在这个已打开的页面里读」，
   `navigate` / `snapshot` 已经在那儿；再开一个读页面的服务就是同一能力两个入口（AGENTS.md §2.5）。
2. **`extract` 不打分、不自愈**：按声明顺序取**第一条能匹配的候选**，命不中就把该字段记为落空。
   打分与歧义拒绝（`minScore` / `minMargin`）是 `browser.locate` 的语义，动作与外发才需要 fail-closed；
   读字段读错一条只是少一条数据，而把整轮抓取卡住是更糟的失败。这条区别必须写进注释，
   否则后来的人会「顺手」给 extract 接上阈值，一次站点改版就整轮罢工。
3. **`jd.store` 的 migration 号段取 2**（`usage_ledger` 是 1，号段规则写在 `entitlement/src/ledger.ts` 顶部注释）。
   表名 `jobs`；P4 的知识库表一律 `kb_` 前缀。这张表只放**岗位事实**
   （标题/公司/薪资/城市/经验/学历/职责/要求/发布时间/来源/抓取时间），
   「这条 JD 我投没投、聊到哪一步」属 2.5/2.6 的会话表，不放进来。
4. **spec 2.3-05 要的是「可回滚」**：现有 `Migration` 只有 `up`（`store/src/migrate.ts`）。
   补法是**扩展现有迁移执行器**——`down?: (db) => void` + `rollback(db, migrations, toVersion)`，
   不是新建第二套迁移框架。缺 `down` 的迁移在回滚时明确报错（不静默跳过），
   否则「回滚成功」是句假话。

### 10.4 参数全部进配置（`cordis.yml`），代码里不写魔法数

| 配置键             | 归属服务       | 默认 | 含义                                                             |
| ------------------ | -------------- | ---- | ---------------------------------------------------------------- |
| `maxRounds`        | `jd.capture`   | 8    | 列表滚动/翻页的最大轮数（2.3-06 的死循环上限）                   |
| `targetCount`      | `jd.capture`   | 20   | 单次运行的入库目标条数，到了就停                                 |
| `roundPauseMs`     | `jd.capture`   | 300  | 两轮抽取之间的最短间隔：给页面装载留时间，也防狂点滚动           |
| `extractRowLimit`  | `browser.page` | 12   | 单次抽取最多回传多少个容器                                       |
| `extractTextLimit` | `browser.page` | 4000 | 单个字段正文上限（字符），页面回读一律钳制（2.1 那条守卫的延续） |

详情读取**串行**（不设并发旋钮）：内嵌视图只有一块，并行读详情就是同时导航同一页面，
那是把「读到 A 的详情其实是 B」写进设计里。

### 10.5 fixture 站要补的四块（V 类条目的靶子）

当前 `fixtures/self-test-lab/boss-search.html` 是**写死 6 张卡片**的静态页，撑不起 2.3：

1. **岗位数据移到服务侧**（`scripts/fixture-server.ts` 里一份虚构清单，≥ 12 条），
   `/boss` 按 `keyword` / `city` / `experience` 查询参数现渲——2.3-01 的「按条件搜索」才有输入可言。
2. **无限滚动**：页面内脚本在滚到底时向 `/api/jobs?page=N&...` 取下一页并追加卡片，
   服务端在最后一页返回 `hasMore: false`——2.3-06 的「无新内容即停」靠这条真信号，不靠猜。
   这也是 §9.7 里「网络空闲」缺口的**对策落点**：等的是 DOM 谓词（卡片数增长），不是网络状态。
3. **详情页按 `jobId` 现渲**（职责/要求/发布时间各不相同）——2.3-02 的字段完整性才有比对对象；
   同时保留一条 `?jobId=1003&broken=1` 的**坏详情页**（缺职责/要求节点）——2.3-08 的注入点。
4. 所有数据仍标注「与任何真实公司、真实职位无关」，且测试全程不出现真实域名（AGENTS.md §7.2）。

### 10.6 界面（2.3-07）与入口

诊断视图新增「JD 抓取实验台」面板，与 2.2 的定位实验台同区：**文案全走 `jd.*` 命名空间**（zh-CN + en），
按钮只有三个——`搜索并入库` / `读库内清单` / `重新读快照`，进度行显示「第 N 轮 · 已入库 M 条」，
失败行显示「跳过 K 条：…」。面板不调选择器：它只调 `jd.capture` / `jd.store`，
于是同一个能力天然既能被工作流节点调用、也能被 agent 当工具调用（AGENTS.md §5.9）。
抓取是**只读动作**，一次运行都不该在 `usage_ledger` 留下行（2.3-11）。

### 10.7 许可状态对本子计划的影响

2.3 的抽取/归一化/落库全是本项目自定设计，**不搬运任何源仓库代码**，因此不受
「书面授权文件尚未落地」的前置阻塞（那道闸门管的是 2.5 的话术文本与 2.6 的站点知识搬运）。
中文薪资写法来自本项目仿站样本，不是从 `browser-copilot` 抄来。

### 10.8 明确不做（2.3 阶段）

- 不做多平台抓取（只 BOSS 一个适配器）；不做真实平台自动化验证（2.3-10 保持 `[!]` 待用户在场）。
- 不做工作流节点化（2.4）：本轮循环写成 `jd.capture` 的一个方法，2.4 的节点**调它**，不复制循环。
- 不做关键词匹配、岗位打分、去重语义判断（那是 P4 知识库与 P5 推荐的事）；幂等键就按 spec 字面：`来源 URL + 标题`。
- 不做 LLM 补全缺失字段（AGENTS.md §8 事实锁定：抓不到就是抓不到，不许编）。

## 11. 子计划 2.4 的选型与证据（开工前定稿，实现照此执行）

### 11.1 这一条到底在做什么

1.10 交出的是「六个写死步骤按迁移表依次推进的空转流水线」，2.4 要交出的是「一个能声明、能失败、
能重启续跑、能留证据的执行器」。中间差四件事，而且每件都有人做过错的样子：

| 缺的东西                   | 为什么不能用 1.10 的现成物顶                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| 计划与运行态的**数据形态** | `WorkflowRunView.steps` 来自常量 `WORKFLOW_STEP_IDS`，不是来自声明；「计划」根本还不存在这个概念 |
| **重试**（次数 + 退避）    | 1.10 只有「失败后人工 `retryStep`」，没有「自己先试两次」这一层                                  |
| **断点续跑**               | 状态只在内存（1.10 的刻意为之，见 `packages/workflow/src/index.ts` 头注释），进程没了就全丢      |
| **失败证据**               | 只有一个 `error: string`；页面上当时长什么样、截图在哪，无处可查                                 |

切面与归属（先切开再写，否则会写成「runner 里既拼 SQL 又截图又调适配器」）：

| 切面                     | 归属                                                                 | 为什么是它                                                                                                             |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 计划/节点/运行态**类型** | `packages/core`（`WorkflowRunView` 现在就在那儿）                    | 渲染层要画它、IPC 要校验它、workflow 要执行它；放 workflow 包会让 L4 界面反向依赖 L2（plan §3 依赖方向）               |
| 节点循环与重试           | `packages/workflow`：`nodes.ts` + `retry.ts`                         | `machine.ts` 是全应用唯一状态机，2.4 只把「常量六步」换成「计划里的 N 个节点」，**不再开第二台状态机**                 |
| 运行态持久化             | `packages/workflow`：`run-store.ts` + migration **v4**               | 沿用 1.3 的 `store`；表属于域（`usage_ledger`=1、`chat_session`=2、`jobs`=3，workflow 取 4）                           |
| 失败证据里的**截图**     | `packages/browser`：`browser.page.screenshot()`（挂在现有 `page`）   | 截图是「页面读数」的一种，与 `snapshot`/`extract` 同族；新建 `browser.evidence` 就是同一能力两个入口（AGENTS.md §2.5） |
| 节点事件                 | 复用 1.10 的 `workflow/progress` 频道（payload 加 `phase`/`nodeId`） | 见 11.3 第 1 条：两个界面已经订了这一条，分叉成两个事件名会让它们各订阅一半                                            |

### 11.2 一手取证（读概念与数值，不搬代码）

副本 = `D:\works\deep-seek-workspace\browser-copilot`（git clone，HEAD `984cf3d`；行号只对该副本有效）。
它的引擎是**节点图解释器**，我们的对照物是同一层的抽象，所以逐条记「采纳/否决」：

| 主题       | 该仓库的做法（概念，已核对到行）                                                                                                                                                                                                                                                                                                                                         | 我们的取舍                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 解释器形态 | `runWorkflow`/`runCore`（`src/background/workflow-engine/engine.ts:394`）按边推进，执行函数挂在 `EXECUTORS` 注册表上、以 `data.blockId` 分派（`engine.ts:290-294`、`executors.ts:3170-3223`）                                                                                                                                                                            | **采纳注册表分派**：节点 `kind` → 执行函数，`workflow` 包不认识 BOSS（plan §3 规则 2）；否决它的图/画布坐标字段                                                                                 |
| 节点声明   | `WorkflowNode{id,label,position,data}` + `WorkflowEdge{source,target,sourceHandle}`（`src/lib/workflow/types.ts:53-68`）                                                                                                                                                                                                                                                 | 只取 `id`/`kind`/`params`；`position` 是画布遗留（P5 再说），`label` 属界面不属计划                                                                                                             |
| 参数与变量 | `ParamDefinition{name,type,required,default}`（`types.ts:29-39`）+ `{{var}}` 插值写进 `ctx.variables`（`engine.ts:302-308`）                                                                                                                                                                                                                                             | **不采纳**：建模板引擎就是第二个字符串基础设施，且 P2 的参数来自声明与上一步结构化输出（见 11.8）                                                                                               |
| 重试       | `onError{toDo:'retry'\|'fallback'\|'error'\|'continue', retryTimes, retryInterval}`，`maxAttempts = 1 + retryTimes`（`engine.ts:706-709`）；默认间隔**固定 1000ms、无退避无抖动**（`engine.ts:795`）；界面上 <60 当秒（`engine.ts:273`）                                                                                                                                 | **采纳 `1 + retryTimes` 口径**；**否决固定间隔**——站点抖动期固定 1s 重放等于自我 DoS，改指数退避 + 上限 + 抖动（数值进配置，见 11.4）；不采纳「<60 当秒」的单位歧义，配置一律毫秒               |
| 重放前置   | 每次重试前把变量深快照还原（`engine.ts:719-729`）                                                                                                                                                                                                                                                                                                                        | 无自由变量池 ⇒ 不需要；但**采纳它的动机**：重放必须在干净上下文里跑，所以节点执行不读上一次的可变残留                                                                                           |
| 全局护栏   | `MAX_STEPS = 2000`（`engine.ts:222`）、`MAX_WHILE_ITERATIONS = 1000`（`engine.ts:225`）                                                                                                                                                                                                                                                                                  | 线性计划没有 while，取等价物 `maxNodesPerRun`（防计划写错把主进程钉死，2.4-03 的兜底）                                                                                                          |
| 失败分类   | 可重试类 `PAGE_NOT_READY/FRAME_NOT_READY/NETWORK_ERROR/WAIT_CONDITION_UNMET` vs 必须人工类 `AUTH_REQUIRED/CAPTCHA_REQUIRED`（`repair/failure-analyzer.ts:50-58`）                                                                                                                                                                                                        | **采纳二分**：分类是「重试次数」的上游判断；`CAPTCHA_REQUIRED` 一律转 `requiresHuman` 接管点，绝不重试（AGENTS.md §8 第 3 条）                                                                  |
| 运行态落盘 | **完全没有 SQLite**：在跑的任务表在内存（`running-tasks.ts:10-15`），跑完写 `chrome.storage`（`running-tasks.ts:117`）                                                                                                                                                                                                                                                   | **否决**：扩展环境只能用它那套存储。我们的等价物是 `workflow_runs` + `workflow_nodes` 两张表                                                                                                    |
| 断点       | 检查点是 JSON 文件 `checkpoints/checkpoint-<runId>.json`，字段 `runId/workflowId/stepIndex/nodeId/status/variables/pageState/phase/workflowFingerprint/snapshotAvailable/at`（`src/lib/workflow/checkpoints.ts:30-58`）；保留 50 个/run、20 个 run（`background/checkpoint-store.ts:21-24`）；续跑靠**倒序扫**最近可用检查点 `resumePointOf`（`checkpoints.ts:212-258`） | **采纳三件事**：`stepIndex/nodeId/status/at` 的字段形状、保留上限进配置、启动时扫库找断点。**否决文件形态**：JSON 文件与库表两份真相正是 1.10 当年避开的问题，断点就写进 `workflow_runs` 行本身 |
| 跨计划串档 | 用 FNV-1a 给计划图算**指纹**，指纹不符拒绝续跑（`checkpoints.ts:162-189`）                                                                                                                                                                                                                                                                                               | **采纳**：`planFingerprint` 存进 `workflow_runs`，续跑时计划改过就明确报「这不是同一个计划」，而不是从第 5 个节点瞎续                                                                           |
| 幂等       | 按块分类判危险性 `idempotencyOf(...) === 'unsafe'`（提交/登录/付款/发送，`lib/workflow/reliability.ts:323-331`）+ 四阶段检查点 `nodeStarted/sideEffectStarted/sideEffectObserved/nodeCommitted`（`engine.ts:680-681`、`checkpoints.ts:24-28`）；终态已满足就跳过（`engine.ts:687-700`）；「启动了但没观察到副作用」时**拒绝盲目重放**（`checkpoints.ts:244-247`）        | **采纳危险性分类 + 拒绝盲重放**（这是 2.4-06 的真正内容，不是「跑两次看看」）；四阶段压缩成两列：`side_effect` 记「已开始」，唯一索引记「已做过」，见 11.3 第 5 条                              |
| 证据       | `ExecutionEvidence{url,selector,locator,readback,variables,stepTail}`，掩码 + 上限 300/800 字符、10 行（`lib/workflow/execution-evidence.ts:17-58`）；`FailureSnapshot` 由 trace + 最新检查点拼出但**只在内存**（`auto-repair/failure-snapshot.ts:81-125`）                                                                                                              | **采纳字段集与上限口径**（上限进配置，见 11.4）；**内存态正是它的洞**——重启即丢，我们的 `evidence_ref` 指向 userData 下的文件并把路径落表                                                       |
| 暂停/续跑  | `AbortController` 取消（`running-tasks.ts:74`）+ `resumeFrom`（`run-workflow.ts:155`）                                                                                                                                                                                                                                                                                   | 已经在用同一个手法（1.10 的 `controller`），2.4 只把「安全点」从步骤边界改成节点边界                                                                                                            |
| 事件面     | `EmitKind = 'tool'\|'status'\|'result'\|'error'\|'info'`（`engine.ts:38`），两个界面经同一个 `onStep` 订阅（`running-tasks.ts:59`）；统计雏形 `takeover-stats.ts:97,205`（successRate、durationMs）                                                                                                                                                                      | **采纳「一份事件流喂两个界面」**——这就是 AGENTS.md §5.9 的形态；统计不另建表，由 `workflow_nodes` 聚合（2.4-10）                                                                                |

### 11.3 归属与命名（延续 2.1/2.2/2.3 的口径）

1. **spec 2.4-02 字面的 `node.started/finished/failed` 落在 `workflow/progress` 的 `phase` 字段上**
   （取值恰为 `started`/`finished`/`failed`，外加 `retrying`），不新造事件名。理由：1.10 的工作流面板
   与 1.11 的工具卡片已经订阅这一条频道，再开一条就会有两个界面各拿一半（AGENTS.md §2.5）。
2. **`machine.ts` 仍是唯一状态机**：run 的状态集合不变（`idle/running/paused/failed/done`）。
   `WorkflowRunView.steps` 改为**由计划的节点数组生成**，节点 id 就是 step id——所以 1.10 的界面
   一行不改就能画 N 个节点，这是「换实现不动界面」的兑现点。
3. **service id 保持 `workflow.runner`**，方法面在现有 `current/start/pause/resume/retryStep` 上扩两个：
   `nodes()` 读当前计划的节点声明（面板与工具卡片用它列节点），`resumeRun(runId)` 从库里续上一次的 run
   （`resume()` 是本次运行内的续跑，两者语义不同，注释里必须写清，否则后来的人会当成一个）。
4. **两张表**：`workflow_runs`（`run_id`/`plan_id`/`plan_fingerprint`/`status`/`node_index`/`started_at`/`finished_at`/`last_error`）
   与 `workflow_nodes`（`run_id`/`node_index`/`node_id`/`status`/`attempts`/`started_at`/`finished_at`/`duration_ms`/
   `idempotency_key`/`side_effect`/`evidence_ref`/`error`）。2.4-10 的耗时与成功率**由这张表聚合**，不建第三张统计表。
   两版一起进 migration v4，`down` 各自 `DROP TABLE`（2.3 已把 `down` 补进迁移执行器）。
5. **幂等键 `runId+nodeId+targetId` 做成 `workflow_nodes.idempotency_key` 上的唯一索引**：
   危险性节点（`unsafe`）执行前先 `INSERT ... ON CONFLICT DO NOTHING`，插入 0 行即「这个目标已经做过」→ 直接跳过（2.4-06）。
   与 2.3-04 同一手法，且比它多一层：**已开始但没观察到完成**（`side_effect='started'`）时拒绝自动重放，
   转成接管点报给用户——源仓库 `checkpoints.ts:244-247` 那条「拒绝盲重放」是我们照抄的判据，不是可选优化。
6. **启动时把 `status='running'` 的孤儿 run 判成 `interrupted`**（进程被 kill 后库里必然留着 running 行）：
   界面据此才能显示「上次中断在第 i 个节点」，2.4-05 的续跑也才有起点。不清孤儿行的话，
   「重启后能看到上次卡在哪」这条永远做不到。

### 11.4 参数全部进配置（`cordis.yml`），代码里不写魔法数

| 配置键              | 归属              | 默认         | 含义 / 出处                                                                     |
| ------------------- | ----------------- | ------------ | ------------------------------------------------------------------------------- |
| `retryTimes`        | `workflow.runner` | 2            | 失败后的额外尝试次数；`maxAttempts = 1 + retryTimes`（源仓库口径，2.4-03）      |
| `retryBackoffMs`    | `workflow.runner` | 500          | 指数退避基数：第 k 次重试前等 `backoff × 2^(k-1)`（否决源仓库的固定 1000ms）    |
| `retryBackoffCapMs` | `workflow.runner` | 5000         | 退避上限，防止长计划卡在一条指数尾巴上                                          |
| `maxNodesPerRun`    | `workflow.runner` | 200          | 单次 run 的节点上限（对应源仓库 `MAX_STEPS` 的角色，防死循环）                  |
| `evidenceDomChars`  | `workflow.runner` | 800          | DOM 片段上限（源仓库 `ExecutionEvidence` 的上限口径）                           |
| `evidenceTextChars` | `workflow.runner` | 300          | 单字段文本上限，超出截断并标注                                                  |
| `evidenceDir`       | `workflow.runner` | `evidence`   | userData 下的证据子目录；文件名 = `<runId>-<nodeId>`，**路径落表**（2.4-04）    |
| `retentionRuns`     | `workflow.runner` | 20           | 旧 run 的保留个数，超出清 `workflow_*` 行（源仓库 checkpoint 保留上限的等价物） |
| `planId`            | `workflow.runner` | `boss-basic` | P2 只有一条线性主线；计划内容在代码里声明，`planId` 只是它的名字与指纹来源      |

`browser.page.screenshot()` 的归属参数（同一服务已有 `extractRowLimit`/`extractTextLimit` 那一组）：
截图不做裁剪、不落库，只回传 `{ width, height, filePath }`；写盘目录由 `workflow.runner` 给（谁产生证据谁管生命周期）。

### 11.5 fixture 靶子与界面（V 类条目的判据落点）

- **3 节点线性计划**（`boss-basic`）：`jd-capture`（调 `jd.capture`，只读）→ `jd-list`（调 `jd.store.list`）→
  `flaky`（fixture 侧计数节点：前两次必失败、第三次成功，`/api/fail-counter` 提供计数）——2.4-02/03 的靶子。
- 诊断视图新增「工作流执行器」区（与定位实验台、JD 实验台同区，**文案全走 `workflow.*` 命名空间**，zh-CN + en）：
  按钮 `跑一遍` / `暂停` / `从失败节点续跑`；进度行 `第 i/N 个节点 · 已重试 k 次`；失败行 `证据：<相对路径>`。
  面板不自己写循环，只调 `workflow.runner` 的方法（AGENTS.md §5.9）。—— 2.4-02/04/07 的截图靶子。
- **2.4-05 断点续跑**只能真 kill：dev 实例由外部脚本 kill（harness 没有 kill 能力），重启 `pnpm dev` 后
  截图必须同时显示「从库里读回的 run」「停在第 i 个节点」「第 1 个节点没有重放行」。
  kill/重启的过程与读数写进 `docs/acceptance/2.4/`，不接受只用单测冒充。
- **2.4-08 mock 适配器**：单测注入假 `PlatformAdapter`，整条链跑通且**完全不碰 `browser`**——
  这条同时反向验证 plan §3 规则 2（workflow 不认识平台包）不是空话。
- **2.4-09 卸载清理**：`plugins.stop('workflow')` 后断言在途节点让出、退避定时器清空、无残留句柄
  （沿用 1.10 那条 `ctx.effect(() => () => controller?.abort())` 的写法，退避定时器必须进同一个 effect）。

### 11.6 本机实测前置（AGENTS.md §6.2，**已跑完**，写调用代码之前）

spike 落在仓库外 `.research-repos\workflow-spike\`（AGENTS.md §6.4，代码不进主干）。两组问题：

| 问题                         | 实测结论（Electron 44.4.5 / Windows / DSF 1.5）                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 主进程能不能截视图的图    | **能**：`view.webContents.capturePage()` → 24–36ms、1350×1050、13505 字节 PNG、`isEmpty:false`。截图通道今天不存在（全仓 `capturePage` 零命中），2.4-04 要新加的就是这一个方法                                                                                             |
| Q1b 截窗口自身的 webContents | **空**：同一时刻 `win.webContents.capturePage()` 返回 0ms / 0×0 / `isEmpty:true` / 0 字节。⇒ 证据必须截**内核视图**那块 `WebContents`，不是窗口                                                                                                                            |
| Q2 最小化时截图              | 窗口最小化（页面 `visibilityState==='hidden'`）时截图**仍成功**，字节与可见时一致                                                                                                                                                                                          |
| Q2b 隐藏态截的是不是新帧     | **是新帧**：隐藏态改 DOM 后再截，字节数变 12665、哈希变，说明产出的是变化后的帧。⇒ 2.3 发现的「隐藏窗口连 scroll 事件都不发」卡的是**事件投递**，不是绘制；截图这条证据通道不受影响                                                                                        |
| Q3 从未 `show()` 的窗口      | 截得到：18ms / 579×356 / 2376 字节 / 非空 ⇒ 后台视图可作证据来源                                                                                                                                                                                                           |
| Q4 WAL 跨真 kill             | 用 **Electron 自带 node**（`ELECTRON_RUN_AS_NODE=1`，node 24.21.0 / sqlite 3.53.4）连写 2262 行并逐行记账，然后在**未提交事务中途 `SIGKILL`**：新进程打开同一库读回 **2262 行**（零丢失）、`integrity_check = ok`、未提交的幽灵行 **0**、4.12MB 的 `-wal` 由该进程自动恢复 |

由这两组结论直接定下实现形态：**截图走 `WebContents.capturePage()` 并截内核视图那块 `webContents`（隐藏态可用，不需要窗口可见）**；
**`RunState` 与节点行就写 SQLite（WAL 的崩溃恢复成立）**，「已完成节点不重放」靠库里的行而不是靠内存运气。

spike 过程里撞到的一个环境坑，记在这里省后来人的时间：
**把 `.mjs` 文件直接当参数交给 `electron.exe` 会走 `default_app`**，而它在「加载应用包」期间不发出 `ready`，
于是模块顶层的 `await app.whenReady()` 永不 resolve（第一次 spike 就这么静默卡死 30 秒，且没有产任何子进程）。
入口必须是 CJS：`app.whenReady().then(() => import('./spike.mjs'))`。

### 11.7 许可状态对本子计划的影响

2.4 的节点模型 / 重试 / 断点 / 证据全是本项目自定设计，§11.2 只取**概念与数值**并标了行号供审计，
**不搬运任何源仓库代码**，因此不受「书面授权文件尚未落地」的前置阻塞（那道闸门管的是 2.5 的话术文本与 2.6 的站点知识搬运）。

### 11.8 明确不做（2.4 阶段）

- 不做分支、并行、条件跳转与可视化画布编辑（P5）：计划是线性的，`edges` 只允许「下一个节点」这一种。
  **2026-09-30 更正**：线性只是 2.4 的实现范围，不是产品决策。画布与 DAG 已在 P5 §5.10 立项，
  届时 `workflowPlanSchema` 与 `runner.advance()` 都要改（按出边推进、`node_index` 换成 `(run_id,node_id)`
  定位），**2.4-05 断点续跑与 2.4-06 幂等不重放必须在 DAG 下重新验收**（见 spec 5.10-13），
  本片结论不得被当成永久结论沿用。
- 不做 cron / 无人值守定时跑（P5）。
- 不做 agent 规划循环：2.8 才把节点登记成 `agent.tools` 工具，本阶段任何「在 runner 里判断该调哪个节点」都算越界。
- 不做 `{{var}}` 模板插值与自由变量池（源仓库形态）：节点参数来自计划声明 + 上一步的结构化输出，
  真要跨节点传值时在 2.5 定形状，现在不建第二套字符串基础设施。
- 不做节点级 LLM 自动修复（`auto-repair` 属 P5）；失败只有三种下场：自动重试、转人工接管、判失败。
- 不做截图的图像分析 / OCR（AGENTS.md §8：不做识别与规避）；截图只作为**给人看的证据**存文件。

---

## 12. 子计划 2.5 的选型与证据（开工前定稿，实现照此执行）

### 12.0 先补一个计划缺口：LLM 客户端至今没有归属

2.5-01 的判据是「LLM 不可用时回落模板且不静默失败」，但仓库里**一个 LLM 客户端都没有**：
`grep -rn "llm|openai|apiKey"` 在 `cordis.yml` 与 `packages/config` 零命中，
`packages/agent/src/session.ts:383` 明确写着助手回复由**本地确定性模板**生成（P1 的骨架，不接模型）。
而 AGENTS.md §2.7 禁的是"**第二套** LLM 客户端"——这句话隐含"第一套得有唯一归属"。

若不先定归属，后果是可预见的：2.5 为了生成话术顺手发一个 `fetch`，P4 生成简历再发一个，
P5 的 agent 规划再发一个，届时谁都不是那"一套"。所以本子计划**顺带立第一个**：

- 新增基建包 `packages/llm`，与 `store` / `logger` / `config` 同级（L1），provider 名 `llm.chat`。
  建包理由（AGENTS.md §4.3 要求记录）：它是**跨域基建**而非业务域——P2 话术、P4 简历内容、
  P5 agent 规划三方都要用，放进 `outbound` 会让"外发域"变成模型的隐性宿主，放 `core` 会让 L0 长出网络出口。
- 边界写死：只做「一次 chat completion 请求 + 超时 + 结构化失败」，**不含** prompt 业务、不含落库、
  不含编排重试（重试属调用方）。零新依赖：`fetch` 打 OpenAI 兼容端点，不引 SDK。
- 无 key / 未配置 = 明确的"不可用"状态，返回结构化失败并让调用方走模板回落；
  **禁止**默认连公网（AGENTS.md §8.6：key 走系统安全存储或已在 `.gitignore` 的配置文件）。
- 唯一性由机检守：除 `packages/llm` 外，任何包出现模型端点 URL 或 chat completion 请求即 lint 失败（spec 2.5-12）。

### 12.1 这一条到底在做什么

把 2.2 预留但故意没实现的三个适配器方法补上其中两个 ——
`packages/platform-boss/src/adapter.ts:38` 的 `UnimplementedMethod = 'chat' | 'sendResume' | 'readReplies'`
（`chat` 与 `readReplies` 归 2.5，`sendResume` 归 2.6）。2.5 的全部动作是：**生成开场白 → 过闸门 →
打进去 → 记账 → 听回复**，一个都不许旁路。外发必经 `entitlement.gate.perform()`
（`packages/entitlement/src/gate.ts:74`，判定/执行/落账三步在同一方法里），
界面复用 1.9 的样例入口，不新开第二条发送路径。

### 12.2 一手取证（读概念与数值，不搬代码）

参考实现 `browser-copilot`（其编辑器/引擎的上游语义来自 AGPL 的 Automa）在打招呼这件事上**基本是空的**。
下面每条都带路径行号，"反面基线"指的是：auto-cc 必须自己补齐，不能假装参考项目已经有了。

| 取证对象                         | 取到的事实（一手，路径:行号）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 结论                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 打招呼有无专用算子               | `src/lib/workflow/blocks/catalog.ts` 全部 60 个 block（`:93` trigger … `:1715` parameter-prompt）**没有 greet/message/outreach/contact**；`executors.ts:3200-3266` 注册表同样没有，外发只能靠 `forms` + `event-click` + `delay` 手拼                                                                                                                                                                                                                                                                   | **反面基线**：auto-cc 把打招呼做成**一等能力**（平台适配器的 `chat` 方法 + `greet` 节点 kind），而不是让用户在画布上拼三个通用块                                                                             |
| 文案从哪来                       | `executors.ts:2948-2949` `interpolate(raw, ctx.variables, ctx.refData)`：模板=用户手填串 + `{{var}}`（语法 `src/lib/workflow/interpolate.ts:4-5`），LLM 结果经 `{{lastAIResponse}}` 注入同一插槽（`executors.ts:2044`）                                                                                                                                                                                                                                                                                | **否决**它的插槽语法（2.4 已定"不建第二套字符串基础设施"，plan §11.8）。话术生成走**结构化输入 → 显式模板函数**，参数是 JD 字段而不是任意路径字符串                                                          |
| 空引用怎么办                     | `executors.ts:2956-2965`：占位符解析为空时**抛错拒填**，绝不写入空白或残留 `{{token}}`                                                                                                                                                                                                                                                                                                                                                                                                                 | **采纳机制**：生成出的文案若缺关键字段（岗位名/公司名）就拒发并报错，不把"前端工程师"发成空串                                                                                                                |
| 频控与节流                       | `catalog.ts:505-508` `delay` 默认 `time: 500`；`executors.ts:1625-1633` 是**固定值 sleep**，无 min/max、无 jitter。全库 `Math.random()` 只用于生成 ID 与 LLM 重试退避（`src/lib/llm.ts:385-388` full jitter）——**动作节奏零随机化**                                                                                                                                                                                                                                                                    | **反面基线** → `outbound.throttle` 用 [min,max] 区间随机，spec 2.5-05 以方差判据钉住                                                                                                                         |
| 每日上限                         | 全库无 `maxPerDay` / `dailyLimit` / 外发配额；命中的是截图配额（`src/background/capture.ts:31`）与自建 HTTP 的 per-IP 限流（`server/src/http-api.ts:174-176`），都与外发无关。时间窗最粗只到"星期几 + 时分"（`src/lib/schedule.ts:18-19`、`src/background/workflow-triggers.ts:311-318`），无夜间不发                                                                                                                                                                                                  | **反面基线**，且**不新建配额系统**：日上限直接复用已有的 `entitlement.gate`（`gate.ts:22-24` `mode:'daily'` + `dailyLimit`），本仓已实现且带 `countToday`（`ledger.ts:159-161`）                             |
| 人类化行为                       | 打字整段插入 + 固定 30/30/60/60/60/100/250ms（`src/inpage/kernel.ts:1181-1193`）；CDP 逐字符循环内**零间隔**（`src/background/cdp-typing.ts:196-205`）；点击坐标恒为元素几何中心、pointerId 固定 1、按下与抬起无 hold 时长（`kernel.ts:841-863`、`cdp-shadow.ts:439-466`）                                                                                                                                                                                                                             | **反面基线**：节奏抖动属 2.7 护栏，2.5 只做**发送间隔**随机；坐标与 hold 的抖动要改 `browser.act` 的输入通道，另计 2.7 条目，不在这里偷偷扩面                                                                |
| 上游对照（此条来自 Automa 语义） | Automa 有逐字符 `typeDelay`（`automa/src/content/blocksHandler/handlerForms.js:55-61`、`src/background/index.js:119`）但**均匀无随机**；BC 保留了 `forms.delay` 字段（`catalog.ts:680,700` 默认 0）而执行器从不读取它                                                                                                                                                                                                                                                                                  | 移植丢功能是真实风险 → 2.5 的参数必须有消费点测试（配置改了行为不变=缺陷）                                                                                                                                   |
| 回复监听                         | `src/background/workflow-triggers.ts:482-546`：页内 `MutationObserver`（`:523`）+ **burst 去抖 500ms**（`:487-508`），含"元素未渲染先监视 documentElement 再挂接"的占位 observer（`:537-546`），触发后只重跑工作流。**没有消息落库**：存储键只有 `settings/skills/agents/profiles/passwords/history/conversations`（`src/lib/storage.ts:55-62`），而 `conversations` 是侧栏 LLM 对话（`src/lib/types.ts:304-305` `role` 取 `user`/`assistant`/`tool`），无会话 id / 方向 / 对方时间戳 / 已回复位       | **采纳形态不采纳宿主**：变化驱动 + 去抖是对的，但真实平台上的页内 observer 会踩 §7.2（自动化测试不得访问真实平台）→ 2.5 用**对 fixture 端点轮询 + 去抖合并**实现，`readReplies` 的形状为"取增量"而非"取全量" |
| LLM 失败降级                     | `executors.ts:2025-2029` 无 key 抛"未配置模型"、`:2048-2053` 失败置空后抛出、`ai-agent-executor.ts:288-296` 空回复抛错；注释理由：下游不得基于空变量行动                                                                                                                                                                                                                                                                                                                                               | **采纳立场**：但**判据不同**——2.5-01 要求可见的模板回落。所以"抛错"用在模型调用层，"回落"用在话术生成层并**在界面播报回落**，两层分开，既不静默也不炸流程                                                    |
| 内容安全                         | 仅有格式清洗 `sanitizeModelAnswer`（`src/lib/model-output.ts:188-190`，剥思考标签与代码围栏），**无事实校验、无敏感字段过滤**；唯一相关模块 `src/lib/workflow/secret-guard.ts` 方向相反——防密钥被写进工作流图：只覆盖 `forms`（`:33`）、只认 `type === 'password'`（`:36`）、子串替换下限 8 字符（`:47`），手机号/验证码/身份证**不在其列**                                                                                                                                                            | **反面基线** → 2.5-10 的发送前黑名单校验必须自建，且作用在**将要离开 app 的文本**上（系统边界，AGENTS.md §2.6）                                                                                              |
| 幂等与重复发送                   | 外发**无去重键、无已发送集合、无时间窗**。现存两处去重都与外发无关：恢复动作 `requestId:ACTION`（`src/background/index.ts:2293-2299`、键组成见 `:2615`）与飞书事件 id（`src/background/feishu-bot.ts:472-482`）。`loop-data` 声明了 Automa 语义的 `resumeLastWorkflow: false`（`catalog.ts:1000`）但引擎从未实现 → 跨次运行进度不持久化。风险实例：`engine.ts:834-840` 的 AI 接管会在节点失败时"重做该节点的目的"并继续，对发送类步骤等于**盲目重发**（默认关：`storage.ts:101 takeoverOnRun: false`） | **反面基线**，且我们已有更好的东西：2.4 的幂等键（`runId`+`nodeId`+`targetId`）+ 跨进程拒绝自动重放。**不另建已发送集合**，重复发送防护 = 幂等键 + `usage_ledger` 按 target 计数（spec 2.5-13）              |
| 风控与验证码                     | **存在主动识别链**：`src/background/agent.ts:598-600` 的 `recognize_image` 工具明确用于"读图内文本（如 CAPTCHA）"，实现是本地 Tesseract.js（`lang` 取 `settings.ocrLanguage`（`:2963` 默认 `eng`）、`MAX_OCR_ATTEMPTS = 3` `:2973`，每次重取新验证码图、置信度 `>= 75` 或两遍一致即接受 `:3037`、择优权重 `:3031`、失败回落视觉模型 `:3054-3149`），并提示模型"fill the CAPTCHA field"。**没有"检测到风控即暂停并通知用户"的路径**（`notification`块`executors.ts:1773-1779` 只是通用系统通知）        | **整条否决**（AGENTS.md §8.3：不绕过平台风控）。2.5 只做"检测到风控/验证码即停 + 通知用户"，spec 2.5-15 留反向验证条目，确认不引入 OCR 没有造成主线能力缺口                                                  |

### 12.3 归属与命名（延续 2.1–2.4 的口径，不再新开入口）

| 能力                            | 落在哪                                                                                               | 为什么不是别处                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 模型调用                        | 新包 `packages/llm`，provider `llm.chat`                                                             | 见 12.0：跨域基建，进 `outbound` 会让外发域隐性持有模型出口，进 `core` 会让 L0 长出网络能力  |
| 打招呼（发消息到会话）          | `packages/platform-boss` 适配器的 `chat` 方法（`adapter.ts:38` 已预留，`DELIVERED_BY.chat = '2.5'`） | 这是平台差异所在（选择器、发送按钮、成功判据），进 `outbound` 会让通用外发层认识 BOSS 的 DOM |
| 读回复                          | 同上，`readReplies` 方法（同一预留位）                                                               | 同上                                                                                         |
| 话术生成                        | `packages/outbound`，provider `outbound.script`                                                      | 内容与平台无关：输入 JD 字段 + 证据，输出一段文案，不含选择器                                |
| 发送编排（闸门→节流→发送→记账） | `packages/outbound`，在既有 `outbound.sample` 旁边扩 `outbound.greet`                                | §2.3 要求扩现有入口；`outbound.sample` 证明的"必经闸门"结构正是这里要复用的                  |
| 频控间隔                        | `packages/outbound` 的 `outbound.throttle`                                                           | 间隔是外发的性质不是平台的性质；BOSS 与猎聘要用同一份节奏策略                                |
| 会话与回复落库                  | `packages/outbound`，表 `conversation_messages`                                                      | JD 归 `jd.store`（平台抓取域），"与某人说过什么"是外发域的账                                 |
| 日上限                          | **不新建**：`entitlement.gate` 的 `mode:'daily' + dailyLimit`（`gate.ts:22-24`）                     | 已有实现 + `countToday`（`ledger.ts:159-161`）。新造配额表就是 §2.7 禁止的第二套状态存储     |
| 已回复标记（2.5-08）            | 列表查询里 join `conversation_messages` 导出，**不写回 JD 行**                                       | 两处都能用=两处会不一致（§2.5）；`conversation_messages` 是唯一真相                          |
| 生成来源（2.5-09）              | 写进 `usage_ledger` 已有的 `source` / `remote_ref` 两列                                              | 加列=迁移；这两列的语义正是"这条账由什么产生 / 对端引用是什么"                               |

### 12.4 参数全部进配置（`cordis.yml`），代码里不写魔法数

| 键                                | 归属                | 默认           | 判据                                                                      |
| --------------------------------- | ------------------- | -------------- | ------------------------------------------------------------------------- |
| `scriptVersion`                   | `outbound.script`   | `v1`           | 2.5-09 的来源标识；改模板必须同时改它，否则复盘时无法区分                 |
| `minGapMs` / `maxGapMs`           | `outbound.throttle` | 45000 / 150000 | 2.5-04 的随机区间与 2.5-05 的方差判据（区间过窄方差测试会假绿）           |
| `dailyLimit`（动作 `greet`）      | `entitlement.gate`  | 现默认 5       | 2.5-02 切成 0 演示拒绝；2.5-04 的第 N+1 次被拦                            |
| `baseUrl` / `model` / `timeoutMs` | `llm.chat`          | 空 / 空 / 8000 | 无 `baseUrl` 或无 key = 不可用，直接走回落路径，**不发网络请求**          |
| `pollIntervalMs`                  | `outbound.thread`   | 3000           | 2.5-07 的取增量节奏；测试用短值，默认值不为测试而设                       |
| `forbiddenPatterns`               | `outbound.script`   | 内置三条       | 2.5-10 黑名单：11 位手机号、18 位身份证、"验证码/密码"后跟 6 位以上数字串 |

### 12.5 fixture 站需要补的两块（V 类条目的靶子）

已有靶子够用：`fixtures/self-test-lab/chat-lab.html` 的同源 iframe（`/chat/frame`）里有
`[data-testid="chat-input"]` textarea、`[data-testid="chat-send"]` 按钮、`[data-testid="chat-log"]`
回显列表，且帧内发送把 `action:'greet'` + `targetId:'fixture-job-1001'` POST 到 `/api/outbound`
（`scripts/fixture-server.ts:382-420`）——2.5-06 的"中文进框再发出去"当场就能拍。

需要补两块：

1. **注入回复**：`POST /api/reply`（body: `targetId`, `text`, 可选 `ts`）写入服务端会话队列，
   `GET /api/threads?targetId=` 按时间返回该目标的消息列表（含 `direction:'in'|'out'`）。
   这是 2.5-07 的唯一靶子——没有它，"回复监听"只能靠 app 自述。
2. **多条待打招呼目标**：`/chat` 页面按 `?targetId=` 切换会话对象，让 2.5-08 能拍出"有的已回复、有的未回复"。

### 12.6 本机实测前置（AGENTS.md §6.2，写调用代码**之前**跑完）

与 §11.6 不同，这一节**只跑完了 S3**（2.5-a 的前置），S1/S2 仍是硬前置：
实现 `chat` / `readReplies` 插槽（2.5-d）之前必须补齐，补不齐就不得写对应的调用代码。

| #   | 待实测                                                                      | 为什么要实测（而不是照博客写）                                                                                                               | 判据                                                                                   |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| S1  | CDP 受信任输入把含**中文 + emoji**的整段文本落进**同源 iframe** 的 textarea | 2.5-06 的验收就是它；参考项目在这一点上有过丢功能的先例（Automa 的 `forms.delay` 到 BC 就不生效），且帧内坐标换算 + IME 是两步都可能崩的地方 | harness 实测：帧内 `[data-testid="chat-input"]` 回读值与发出文本逐字符相等，无多余字符 |
| S2  | 主进程 `fetch` 轮询 fixture 新端点的取增量语义（带游标、去抖合并）          | 决定 `readReplies` 的形状是"取 >cursor 的增量"还是"取全量再 diff"；写错就得再造第二份会话状态                                                | 连跑两轮：注入 2 条 → 读到 2 条 → 再轮询不重复入库                                     |
| S3  | 无 key/无 `baseUrl` 时 `llm.chat` 的路径                                    | 2.5-01 要求"回落且不静默失败"，而回落只有在**确定不会发网络请求**时才是可测的                                                                | **已实测通过**，结论见 §12.6.1                                                         |

#### 12.6.1 S3 实测结论（2.5-a，2026-09-30）

1. **未配置即零网络**：`baseUrl` / `model` / 环境变量 key 任一缺失时，`complete()` 在 `fetch` **之前**
   抛 `AppError('LLM_UNAVAILABLE', …, details.missing)`；测试用 `globalThis.fetch` 存根计数，断言调用次数为 0
   （`packages/llm/src/llm.test.ts`「未配置时一次请求都不发」）。这条把 2.5-01 的"回落"从碰运气变成可测。
2. **契约以真实请求取证**，不采信文档转述：`POST <baseUrl>/chat/completions`、`Authorization: Bearer <key>`、
   体 `{model, messages, max_tokens, temperature, stream:false}`、响应读 `choices[].message.content` 与
   `usage.prompt_tokens/completion_tokens`。
3. **实测推翻一处普遍写法**：无 key 打到真实 OpenAI 兼容端点时，401 的响应体是 **plain text 而不是 JSON**
   （`platform.openai.com` 在本机直连不通，改用可连通的兼容端点做的未鉴权探针）。
   因此错误解析必须先试 `error.message`、失败即退回原文并截断，不能 `JSON.parse` 一把梭。
4. **页面侧已看到**：诊断视图插件树出现 `llm` 行（已就绪 · 配置项 6 个 · effect 1 项），
   主进程日志区实时推送 `[llm-chat-service] 模型出口未就绪：缺 baseUrl / model / apiKey（调用方将走模板回落）`，
   证据图 `docs/acceptance/2.5/2.5-12-llm-row-1.png` / `2.5-12-llm-log-2.png`。
   注意这里只证明了"挂载 + 如实播报未就绪"，真正的**话术模板回落**要等 2.5-b 的 `outbound.script`。

#### 12.6.2 S1 / S2 实测结论（2.5-d，2026-09-30）

两条都在真实 Electron 页面（CDP 10222）+ 本地 fixture（127.0.0.1:10233）上跑完，不是读文档得出的。

1. **S1 不再重跑**：它问的"中文 + emoji 能不能落进同源 iframe 的 textarea"，
   已由已验收的 2.2-10（帧内元素可定位与操作）与 2.2-13（中文/emoji 走 `Input.insertText` 不乱码）覆盖，
   证据图在 `docs/acceptance/2.2/`。本轮只补了一次读数确认：`harness type --value '你好，BOSS！😊'` 打进
   `/chat/frame` 后，页面内回读码点为 `4f60 597d ff0c 42 4f 53 53 ff01 1f60a`、长度 9 —— 无乱码、无多余字符，
   且 harness 的命令行参数（argv → CDP）不引入编码损伤。
2. **UTF-8 的唯一坑在客户端，不在服务端**：先用 `curl -d` 注入回复时，落库文本变成 `fffd` 串
   （Git Bash 按控制台代码页 GBK 编码请求体）；改用 Node `fetch` 发同一段中文 + emoji 后逐码点相等。
   因此 2.5-06 的"不乱码"判据必须由**页面内码点比较**说了算，终端回显的乱码不能当证据 —— 它测的是自己的控制台。
3. **S2 的结论与 §12.6 表里写的不一样，需要更正设计**：fixture 侧确实支持游标
   （注入 1 条 → `after=0` 读到 1 条、游标 2；再注入 2 条 → `after=2` 只回这 2 条、游标 4；不注入 → 回 0 条），
   但**真实平台不会给游标**。于是 `readReplies` 的形状不能是"取 >cursor 的增量"，只能是
   **全量读页面上可见的消息项 + 按页面自带稳定 id 去重落库**；游标降级成本地台账的最大值（少写几次插入），
   而不是正确性的依据。页面稳定 id 的来源：fixture 每条 `li` 带 `data-message-id`（真实平台是 DOM 里的
   消息序号/`data-id` 类属性，2.6 校准知识包时替换）。
4. **帧内轮询渲染已验证**：页面从 0 条起 → 注入 1 条 → 帧内多出且只多出 1 个 `li[data-message-id]`
   → 再等一个轮询周期仍只有 1 个。即"重复轮询不画重复节点"这条在 fixture 页成立，
   app 侧去重因此有可对照的现场。
5. **harness 的两条新雷（写进 1.6 的口径里，别再踩）**：
   ① `eval` 是页面**顶层**求值，脚本里的 `const` 会留在执行上下文里，第二次跑同一个文件就报
   `Identifier 'x' has already been declared` —— 探针脚本一律用 IIFE 包裹后 `return`。
   ② 不带 `--url` 的页面命令会连到 `candidates[0]`，而内嵌内核视图（0×0、`visibilityState:'hidden'`）
   常常排在第一位：`click` 会对它的坐标派发真实鼠标事件而**什么都不发生**（本例：状态行停在"待发送"、
   `/api/outbox` 计数不动）。定位到"点了没反应"时，先读 `window.innerWidth` 与 `document.visibilityState`，
   再决定是不是换 target。这条与 §12.9.2 的"隐藏视图的行点不到"是同一个坑的两个尺度。

### 12.7 许可状态对本子计划的影响

授权文件仍未落地（P1-02 记录的豁免承诺还没变成仓库内文件），而这次**它真的管得住我们**：
12.2 表里否决的插槽语法、`interpolate`、`sanitizeModelAnswer`、`secret-guard` 都是 BC/Automa 的实现物，
我们只引用了它们的**路径与结论**；话术模板与 prompt 文本必须**自写中文**，
不得从参考项目搬一句。本节采纳的三条（空引用拒填、失败即抛、观察去抖形态）是机制不是表达，
不触发搬运闸门。若实现中途发现"搬一句更快"，停下来，不动它。

### 12.8 明确不做（2.5 阶段）

- 不做验证码/风控识别与绕过（12.2 已列它的完整识别链，整条否决）；只做"检测到即暂停 + 通知用户"。
- 不做多轮自动对话与追问话术（话术生成器只产**开场白**；追问属 P5 agent 的对话循环，见主计划 §1.3）。
- 不做坐标抖动、鼠标轨迹、按下 hold 时长（属 2.7 反爬护栏，要改 `browser.act` 输入通道，不在此偷偷扩面）。
- 不做真实平台验证：2.5-11 保持 `[!]`，只在用户在场时手动做。
- 不接 P4 知识库：2.5-01 的"知识库证据"入参形状在本片定义（可为空数组），
  内容方在 P4 落，避免这里长出一个平行的小知识库。
- 不做发送排队/离线待发：额度与频控到量即停并说明原因，排队是另一种产品形态。

### 12.9 界面与实现顺序（一次一片，每片收口即提交）

界面沿用既成事实：打招呼是**工作流节点**（`greeting.send` kind）也是**对话/面板可点动作**，
同一个 `outbound.greet` 入口（AGENTS.md §5.9 禁止两处各长一套）。JD 列表加一列"已回复"，
文案走 `greet.*` i18n 命名空间，zh-CN 与 en 齐备才有 lint 通过。

| 片    | 内容                                                                                        | 判据                                           |
| ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 2.5-a | `packages/llm` + `llm.chat`（不可用即结构化失败，零新依赖）                                 | S3 实测通过 + 2.5-12 的"唯一入口"lint 规则生效 |
| 2.5-b | `outbound.script`：模板生成 + 回落播报 + 黑名单 + `source` 记版本                           | 2.5-01（U 半边）/2.5-09/2.5-10                 |
| 2.5-c | `outbound.throttle`：区间随机（配置进 `cordis.yml`）                                        | 2.5-04（U 半边）/2.5-05 方差                   |
| 2.5-d | 适配器 `chat` + `readReplies` + `conversation_messages` 表 + fixture 两块新靶子             | S1/S2 实测通过 + 2.5-06/07                     |
| 2.5-e | `outbound.greet` 编排：`gate.perform` → throttle → adapter → 记账；`greeting.send` 节点登记 | 2.5-02/03/13                                   |
| 2.5-f | 界面（已回复标记与优先级排序）+ 逐项 V 类可视验收 + spec 收口                               | 2.5-01(V)/02(V)/06/08 + 2.5-11 保持 `[!]`      |

#### 12.9.1 2.5-b 收口记录（`outbound.script`，2026-09-30）

实现落在**已有的 `packages/outbound`** 里加第二个 provider（`outbound-script`），没有新建平行包。
三条判据的实际结果与计划表略有出入，按实测写：

1. **2.5-01 打勾，且两半都过了**（计划原本只要求 U 半边）。行的验证操作写的是"无 key → 界面提示回落
   （截图）+ 生成内容含岗位关键词"，这两条现在都有：诊断面板日志播报
   `话术生成就绪：版本 v1 · 上限 200 字 · 模型 不可用（走模板回落）`
   （`docs/acceptance/2.5/2.5-01-script-logline-2.png`、`2.5-01-script-row-1.png`），
   关键词断言在 `script.test.ts`。2.5-f 要做的**不是**这条，而是把文案摆进对话/工作流界面。
2. **2.5-09 保持 `[ ]`**：`ScriptDraftView` 已经带 `scriptVersion` + `jdId`（单测覆盖），
   但这条判据是"查库断言字段非空"，落库动作在 2.5-e 写 `usage_ledger.source` 时才存在。
3. **2.5-10 保持 `[ ]`**：黑名单是**唯一出口** `assertSendable`（模型产出与模板产出两条路都过，
   命中即 `OUTBOUND_FORBIDDEN_CONTENT` 而不是重试），但这条说的是"不发送到页面"——
   当前还没有任何发送路径可验。2.5-e 必须补一条"绕过 `assertSendable` 直接发即测试失败"再打勾。

顺带记一个**会被误读成泄漏的读数**：面板"巡检"按钮是 `CYCLE_ROUNDS = 20` 轮启停，
第一轮报 `漂移 尺寸 0 / effect 1 / 句柄 0`，看着像 `outbound-script` 漏了一个 effect。
逐插件比对后它的 effect 数仍是 1（`registry 26→26`），**再跑一轮报 `effect 0`** ——
那 +1 是 `plugins/src/index.ts` cycle 注释里说的 settle 窗口没吃掉的瞬时值。
判据：一次漂移不结论，连跑两轮看是否增长。

#### 12.9.2 2.5-c 收口记录（`outbound.throttle`，2026-09-30）

实现落在 `packages/outbound/src/throttle.ts`（同包第三个 provider，不新建包，见 §12.3），
`registry.ts` 里 id 为 `outbound-throttle`，`cordis.yml` 显式写 `minGapMs: 45000 / maxGapMs: 150000`。

- **它只做一件事**：回答「下一次外发之前隔多久」。计时（`sleep`）由调用方用 `@auto-cc/core` 的现成实现做，
  日上限归 `entitlement.gate`（`mode:'daily'`）——两处都不在本服务里再造一份，
  否则就是 §2.7 禁的第二套状态存储。因此本服务是纯抽样函数，能在单测里被穷举而不拖慢测试。
- **2.5-05 打勾，但实际断言与 spec 原句不同，所以按实测口径改写了 spec**：原句写「方差 > 阈值」，
  实现里断的是「10 次抽样全部落在闭区间内 + 极差 > 区间长度 30% + 互异值 ≥8」。
  方差对样本量敏感（10 个样本的方差估计本身就抖），极差与互异数在同样样本量下更稳定，
  且 30% 阈值对应的失败概率约 1e-4（推导写在测试注释里），不会变成 flaky。
- **2.5-04 保持 `[ ]`**：它的 U 半边（间隔落在配置区间内、随机化）已随 2.5-05 一起验掉，
  但 C 半边「日上限到量即停、实测第 N+1 次被拦」需要真实外发路径，那是 2.5-e `outbound.greet` 的判据。
- 页面证据 `docs/acceptance/2.5/2.5-05-throttle-1.png`（插件行：`无依赖 · 配置项 minGapMs, maxGapMs · effect 1 项`）
  与 `2.5-05-throttle-2.png`（巡检报告 `registry 27→27 · 漂移 尺寸 0 / effect 0 / 句柄 0` +
  日志 `外发节流就绪：间隔在 45.0s – 150.0s 之间随机（非固定节奏）`）。
- **§12.9.1 的漂移判据在本片原样复现**：首轮巡检报 `effect 1`，第二轮报 `effect 0`，
  期间每一轮卸载都是「回收 1 项 effect，剩余 0 项」。这不是节流服务的问题，
  是 `plugins.cycle` 的 `SETTLE_MS` 窗口量到了尚未落定的计数——所以「看第二轮、不看第一轮」从经验升级为固定动作。
- **配置区间是活的**：装配面板里把 `outbound-throttle` 的配置改成 `{"minGapMs":5000,"maxGapMs":9000}` 并保存，
  点一次「巡检」后日志播报变成 `间隔在 5.0s – 9.0s 之间随机（非固定节奏）`（证据 `2.5-05-throttle-live-config.png`），
  **app 没有重启**，而 `cordis.yml` 在磁盘上仍是 45000/150000——`kernel.applyConfig` 只写运行期补丁层（1.5 已定），
  所以这条演示不会污染入库文件。节流服务的 `options` 是构造期快照，因此改配置要经一次重挂载才生效，
  这也是 `2.5-e` 的打招呼编排不能"改了立刻变慢/变快"的原因（届时要么显式重挂载，要么把区间读成 getter）。
- 截图过程中确认的一条 harness 事实：`cdp.ts` 的 `scrollTo` 注释所说「写 DOM `scrollTop` 只改 DOM、合成器画面不动」
  只对**页面滚动**成立；日志框自己是 `max-h-64 overflow-y-auto`，对它写 `ul.scrollTop = ul.scrollHeight` 是会重绘的。
  所以拍最新日志的固定动作是：先 `eval` 滚内部框，再 `shot --reveal 'li[data-log-level]:last-child'`
  （reveal 这时只需要把框带进视口，否则它会以「已滚到边界但目标仍不在视口内」拒绝拍错的东西）。

### 12.10 2.5-d 的落点设计（写代码前定稿）

**这一片只做「页面 ↔ 会话表」这条通道**：适配器把 `chat` / `readReplies` 两个插槽实现成真实页面动作，
`conversation_messages` 表把读到的消息落进库。额度闸门、频控、账本仍留给 2.5-e ——
适配器**一次 `entitlement.gate` 都不进**（AGENTS.md §7.3 的必经口在编排层，1.9-06 的 grep 才有对象可查）。

1. **归属：`conversation_messages` 放 `packages/platform-boss`，不放 `outbound`**。
   理由不是"顺手"，是依赖方向：`outbound` 的现有依赖里没有 `browser`，让它去调
   `platform.registry.readReplies()` 就要新开一条 `outbound → browser` 的横向边（AGENTS.md §4.1 禁止）。
   而 `platform-boss` 已经有这条边并且是同一个形态的先例——通用的 `jobs` 表就住在它里面（`jd-store.ts`）。
   本轮沿这条先例走，等第二个平台真的落地时再讨论抽包，不提前抽（§2.7）。
2. **`chat()` 的「sent」必须由页面回读说了算**，不是「点完了就算发出去」：
   输入回读相等（`act.type` 的 `valueAfter`）→ 状态行文本变化（`act.waitFor` 的 `textChanges`）→
   文本里含知识包声明的成功样式。任一环不成立就返回 `sent:false` + 原因，绝不返回 true。
   `textChanges` 要在点击**之前**起好（基线在脚本启动时取），点击与等待并发进行；
   这是现有原语里唯一不需要再造一套轮询的做法（§2.2）。
3. **`readReplies()` 只读页面，不读服务端的会话 API**：真实平台上 app 唯一能观察到的面就是 DOM，
   所以读的是 `messageItem` 声明的那批节点，`from`（对方/自己）由页面上的方向标记判定。
   游标不是页面给的（§12.6.2 第 3 条），去重靠页面自带的稳定 id → `conversation_messages` 的唯一索引。
4. **需要给 `extract` 补一个能力**：字段现在只在容器**子树**里找（`extract-script.ts:124` 走
   `scope.querySelectorAll`），而一条消息的 id / 方向 / 正文都挂在容器本身。
   补法是给 `ExtractFieldSpec` 加 `scope?: 'subtree' | 'self'`（默认 `subtree`，现有调用点一行都不用改），
   `self` 就读容器自身。这是扩展现有模块的接口，不是新造第二条读页面的路（§2.3）。
5. **页面结构事实全进知识包的新 `chat` 段**：`entryPath` / `input` / `sendButton` / `statusLine` /
   `sentPattern` / `messageItem` / `messageIdAttribute` / `directionAttribute` / `inboundValue`。
   `adapter.ts` 里出现一条属性名字符串就会被 `scripts/check-knowledge-pack.ts` 的选择器扫描拦下，
   所以这些只能来自 `pack.chat`。`knowledgePackSchema` 是 `z.strictObject`，多写的键会被拒 ——
   这一条正好保证「加了段就必须加校验」。

### 12.11 2.5-d 收口记录（页面 ↔ 会话表这条通道，2026-09-30）

**落点与 12.10 的设计一致，逐条对上了**：`ExtractFieldSpec.scope?: 'subtree' | 'self'`（默认 `subtree`，
老调用点零改动）、知识包新增 `chat` 段、`conversation_messages` 住在 `packages/platform-boss`
（迁移段 5，唯一索引 `(platform, job_id, dedupe_key)`），适配器没有进 `entitlement.gate`。

**2.5-06「输入中文不乱码、发送后页面出现该消息」是看到页面了的**，不是单测推的：
`browser.act.type` 走 CDP 受信通道（`channel:'cdp'` / `trusted:true`），92 个字符的中文+emoji 文案
回读 `valueExact:true`、`valueLength` 与 `expectedLength` 逐字符相等（含「」与 🙂）；
`browser.act.click` 之后**同源 iframe 内**的状态行真的翻成「第 2 条已送达服务端」，
父页的 postMessage 读数与独立出口 `/api/outbox` 的计数一起动。证据：
`docs/acceptance/2.5/2.5-06-typed-1.png`、`2.5-06-sent-2.png`、
`2.5-06-typed-readout-3.txt`、`2.5-06-send-readout-4.txt`、`2.5-06-frame-readout-5.txt`。

**2.5-07「回复监听入库、带时间戳」同样有页面证据**：向 fixture 注入一条对方回复后，
它先出现在帧内时间线（`2.5-07-reply-on-page-1.png`，`data-direction="inbound"`），
再由 `conversation.store.syncFrom` 落库——`read 2 / inserted 2 / duplicate 0`，
二次同步 `inserted 0 / duplicate 2`（去重键在唯一索引里，不在内存集合里，对应 §2.5-13 的方向），
行带 `read_at` 与 `external_id`，且按 jobId 分线程（`statusBefore.jobs:1` → `statusAfter.jobs:2`，
`newestJobId` 从 `1001` 变 `2002`）。证据：`2.5-07-frame-readout-2.txt`、`2.5-07-sync-readout-3.txt`。

**一条诚实的边界**：适配器层面的 `sent:true` 判定只有单测覆盖，没有页面验收截图——
因为 `platform.boss.chat` 刻意**不在**渲染层白名单里（外发必须经 2.5-e 的额度闸门）。
页面这条路上能看到的是「输入回读一致 + 状态行变化 + 出箱计数」，
`sent` 的三环节判定逻辑本身在 `adapter.test.ts` 里断言。这不是回避，是把 §7.3 的必经口留在正确的位置。

**本轮踩到并记下来的三条环境事实**（都是实测，不是推断）：

1. 装机版 app（userData 在 `%APPDATA%\auto-cc`）在跑时，`pnpm dev` 会因单实例锁**静默退出 0**、
   CDP 端口根本不监听。不要用杀用户进程来解决——`AUTO_CC_USER_DATA_DIR="$PWD/tmp/dev-userdata-25d" pnpm dev`
   换一份 userData 即可（`scripts/dev.ts` 已支持）。
2. fixture 服务是长驻进程，而 `/chat/frame` 的 HTML **内联在 `scripts/fixture-server.ts` 里**，
   父页 `chat-lab.html` 却是每次请求读磁盘——改了帧内模板不重启 `pnpm fixture`，
   会得到「半新半旧」的页面，表现为帧绑定到写死的 `fixture-job-1001` 而不是请求参数 `1001`。
3. CDP `Input.insertText` 是**在光标处插入**，不清空原有内容。所以"无多余字符"这类断言
   必须每轮先 `browser.page.navigate` 重置页面再输入，否则上一次留下的字会拼进回读值里。

**顺带修掉的一处读数说谎**：帧内「已注入 N 条」原来显示的是**这一批增量**的条数，
把线程里的消息数说小了。`/api/threads` 增加 `total`（该线程总条数），标签改「线程内 N 条」，
截图里的数字才与库里行数对得上。

**留给 2.5-08 / 2.5-e 的前置**（本轮不夹带，见 §1.4）：入库正文带着 fixture 的「我：/对方：」前缀，
因为方向标记和正文在同一个文本节点里、用 `scope:'self'` 一次读全。
要干净，得同时动 fixture 模板、知识包 `chat` 段声明和适配器解析三处——放到 2.5-08 做已回复标记时一并处理。

### 12.12 2.5-e 的落点设计（写代码前定稿）

这一片把 §12.3 表里「发送编排（闸门→节流→发送→记账）」那一行落地成 `outbound.greet`，
并一次补齐 2.5-02/03/04/09/10/13 的 C 半边。

1. **依赖方向这条必须先解决，否则第一行代码就是错的**。
   `outbound.greet` 要调平台适配器，而适配器在 `platform.registry` 后面（`packages/browser`）；
   让 outbound 去 import `@auto-cc/plugin-browser` 就新开一条 L2→L2 横向边（§4.1），
   正是 §12.10 第 1 条用来否决「会话表放 outbound」的同一个理由。
   本仓对这个问题**已有解法**：`workflow.executors` 的契约面住在 `@auto-cc/core`
   （`WorkflowExecutorRegistry` + `executorRegistryOf(ctx)`），能力包只 import core 就能往 L3 的登记处挂东西，
   `core/src/index.ts:78-86` 的注释把理由写得很清楚。
   所以打招呼渠道照同一个形状办：core 里声明 `GreetChannel` / `GreetChannelRegistry`，
   登记处由 `outbound.greet` 自己实现，`platform-boss` 在 init 里 `register('boss', …)`。
   **否决的替代方案**：(a) 编排放 platform-boss —— 那是把平台无关的计量逻辑复制给第二个平台做准备（§2.2）；
   (b) outbound 直接依赖 browser —— 打破 §4.1；(c) 把 `PlatformAdapter` 整份契约搬进 core ——
   core 是 L0，不该认识「岗位」「会话页」这些领域概念，只搬打招呼需要的那一个方法。
2. **账本同时是「幂等表」和「节流用的钟」，不新增任何状态存储**（§2.7 第二套状态存储禁令）。
   2.5-13 要的「同 run 同 target 不重发」= `usage_ledger` 上按 `(action, target_id, workflow_run_id)` 数一行；
   2.5-04 要的「连续间隔」= 拿 `MAX(ts) WHERE action='greet'` 与 `throttle.nextGapMs()` 比，不足就 `sleep` 差值。
   两条都是给 `UsageLedgerService` **加只读查询**（`countFor` / `latestActionTs`），
   不建表、不加列、不在内存里留「已发送集合」——spec 2.5-13 的 grep 判据要的是「代码里没有那个集合」，
   不是「没有查询」。
3. **`sent:false` 不能落账**：适配器返回 false 时编排层在 `gate.perform` 的 task 里抛
   `OUTBOUND_NOT_DELIVERED`，于是闸门那侧「只有 task 成功才记账」（`gate.ts:66-68`）自动成立——
   页面上没发出去的东西不算用户额度。同理黑名单在校验阶段就拒，连 task 都不进。
4. **2.5-09 的来源写进已有两列**（§12.3 最后一行）：`source` 记 `${scriptVersion}:${jdId}`。
   `gate.perform` 现在是 `record({action, ...context})`，所以给 `ActionContext` 补一个可选 `source`
   就能透传到 `LedgerDraft`（那两列早就在表里，spec 1.9-08 预留的），不改建表、不加迁移。
5. **`greeting.send` 由 `outbound.greet` 自己登记**，和 `jd.capture` 同一个手法
   （init 里 `executorRegistryOf(ctx)?.register(...)` + `ctx.effect` 注销）。
   这样「界面点一次发送」和「工作流跑一次发送」是同一个入口（§5.9 禁止两处各长一套），
   区别只在 `workflowRunId` 有没有值。
6. **注册表用「最后写入者说话」**：插件能被单独重启（1.5），第二次 `register('boss')` 必须覆盖而不是报错，
   否则重启后的平台包永远拿不回自己的渠道——这条抄 `WorkflowExecutorRegistry` 的既定决策。
7. **配置**：`outbound.greet` 自己只有 `enabledAction`（默认 `greet`）这种真开关；
   区间、日上限、黑名单、模板版本继续留在各自服务里（§12.4），本编排一层不复制参数。
8. **V 半边不在这一片**：2.5-02 的「界面显示拒绝原因」要有 UI 才算，那是 2.5-f 的活；
   这一片交的是「拒绝发生在发送之前 + 不落账 + 对端计数不动」这条能从 IPC 层看到页面的部分。

### 12.13 2.5-e 收口记录（发送编排这条通道，2026-09-30）

实现与 §12.12 有四处不同，前两处是**设计被实测推翻**，不是执行偏差。

1. **第 1、6 条的「`outbound.greet` 自己存一张渠道表、平台包 init 时推进来」作废，改成现问现取的拉模型。**
   起因是第一次活体跑就撞上：页面 `plugins.saveConfig('entitlement', …)` 之后，
   打招呼从此一律 `OUTBOUND_CHANNEL_MISSING { registered: [] }`，直到重启才恢复。
   根因不在配置，而在装配生命周期——**上游任一插件改配置会连带重建它的下游**，
   `outbound.greet` 的 `[Service.init]` 重跑、构造器里的 `Map` 被换成空表，
   而 `platform-boss` 的 init 不会因此再跑一遍，所以没人往表里补登记。
   现在的形状：core 声明 `GreetChannelSource`（`greetChannel(platform)` / `greetablePlatforms()`），
   由 `platform.registry` 实现——适配器是唯一事实来源，`chat` 能力就是渠道，
   编排层每次外发按名字现问，**不持有任何平台状态**。
   这条同时修掉一处骗人的读数：就绪日志从前读自己那张表，改配置后就在装配面板上播报
   「已登记渠道（暂无）」；现在每次挂载都重新问登记处，`2.5-02-pull-model-readout.txt`
   里那七行「当前可打招呼平台 boss」就是重建前后各读一遍的结果，
   紧接着的第二条外发成功并落账（`2.5-03-ledger-rows.txt`）。
   推论留给后面所有切片：**任何"由别的包在 init 时推给我"的注册表都有这个坑**，
   要推就得同时能重放，否则一律改成拉。
2. **`GreetChannel.send` 丢掉了适配器返回的 `ledgerKey`。** 计量凭证由 `entitlement.gate` 落账时生成，
   适配器不参与算数；留着它只会让人以为外发侧要自己配对账（`platform-registry.test.ts` 有一条
   断言投影出的渠道只回 `{sent, reason}`）。
3. **第 7 条的 `enabledAction` 没做**：动作名 `greet` 与额度键、账本 `action`、幂等键是同一个字符串，
   做成可配置等于允许三者不一致——那是给自己造对不上账的机会。`outbound.greet` 的配置因此是空 schema。
4. **`cordis.yml` 里 `workflow-executors` 挪到 `outbound-greet` 之前**，否则节点执行器登记不上
   （`greeting.send` 会在跑工作流时报未登记 kind）。另外两处小改动：`OutboundGreetService.executeNode`
   得是 public（测试要直接打节点路径），`assertNotYielded` 从 runner 提到 core（greet 与 runner 共用，
   §2.2 第二次出现就抽）。

实测口径记录：2.5-02 原文写「把额度切成 0 次」，但 `gateSchema` 的 `dailyLimit.min(1)` 让 0 在界面上不可达，
等价做法是切成 2 次、打到第 3 次（`2.5-02-gate-rejected.txt`）。频控那条把区间收成 30s 单点才好断言，
实测 `waitedMs=19496`（第一条发送自身耗掉约 10s）、账本 ts 差恰好 30000。

本机关验时踩到的环境事实（已同步进 AGENTS.md §9）：热改配置会重建下游并重跑 `[Service.init]`；
页面操作前必须先 `sessions.open`；harness 的 eval 不支持顶层 await；选应用页要显式 `--url 5173`；
`shot --reveal` 只查顶层文档，iframe 里的内容得在帧内 `scrollIntoView`。

### 12.14 2.5-f 的落点设计（写代码前定稿）

这一片交 2.5-08 / 2.5-14（join 半边）/ 2.5-02 的 V 半边，并把 §12.11 欠的「我：/对方：」前缀一次还清。
四处落点都在写代码前定死，避免边写边改判据。

1. **打招呼按钮长在 JD 列表行上，不长在 chat 里**。`outbound.greet.perform` 已在渲染层白名单里
   （`bridge.ts:127`），界面入口只是**多一个调用方**，不新增 IPC 口、不新增 service（§2.3）。
   为什么选 JD 列表而不是对话气泡：2.5-08 的判据是「已回复的 JD 在界面标记」，标记和动作必须在同一行，
   用户看到的是一列「这个目标回复了没有 / 还没打招呼的下一个发它」；而 chat 入口要的是
   agent 工具面（同一入口、不同触发者），那是 2.8「双入口接通」的活，本轮往 chat 里塞第二个按钮
   就是提前长出两套入口代码（§5.9 禁止的正是这个）。
   **界面一行都不自己判断**：回执只转述 `GreetReceiptView`（waitedMs / source / origin / ledgerId），
   拒绝只转述 `bridgeError.code + message`——`entitlement.gate` 在被拒时不落日志（`gate.ts:74-92` 只在放行侧 log），
   所以 2.5-02 的「界面显示原因」只能靠 `QUOTA_EXCEEDED` 的 error payload 上屏，这也就顺手补了 §12.13
   留的「闸门拒绝不可见」那条尾巴。

2. **「已回复」由查询导出，不写回 `jobs`**（2.5-14 的原句）。具体形状是给 `jd.store.list` 的 SQL
   挂一个**分组派生表左连**，而不是直接 join 明细：
   `LEFT JOIN (SELECT platform, job_id, COUNT(*) AS inbound FROM conversation_messages
WHERE direction = 'recruiter' GROUP BY platform, job_id) reply ON reply.platform = jobs.platform
AND reply.job_id = jobs.job_id`。
   两个细节不能省：
   - **库里方向存的是 `'recruiter'` / `'self'`**，不是页面上的 `inbound`——页面属性值由知识包
     `chat.inboundValue` 声明，适配器 `readReplies` 已经把它翻译过一次（`adapter.ts:414`），
     查询侧再认 `inbound` 就会永远数到 0。
   - **必须走派生表**：`jobs` 的唯一键是 `(source_url, title)`，`(platform, job_id)` 不唯一，
     直接 join 明细会让一条 JD 长出 N 行、列表行数与 `total` 当场对不上。
     `JobRowView` 因此加 `replied: boolean` + `inboundCount: number`（不叫 `hasReply`，名字要对上 spec 的「已回复」）。
     排序改成 **已回复优先，其余仍按 `captured_at DESC, id DESC`**——这一条同时兑现 2.5-08 后半句
     「后续步骤优先这些目标」（投递在 2.6，本轮先把「谁该先做」这件事在列表顺序上说清楚）。
     `jd-store.test.ts:268` 那条倒序断言不受影响（两行都未回复），新增一例钉住「旧但已回复」在「新而未回复」之前。

3. **前缀三处一起动**（fixture 模板、知识包、适配器），少动一处就是半新半旧的页面（§12.11 环境事实 2）：
   - `scripts/fixture-server.ts:446` 不再把方向拼进正文，改为渲染一个 `<span data-message-body>` 只装正文，
     视觉上的「对方：」由独立的标记节点给；
   - `boss.json` 的 `chat` 段新增 `messageBody` 定位符（`schemaVersion` 不动，`knowledgePackSchema` 是
     strictObject，多写键会被拒 ⇒ 加了字段就必须加校验）；
   - `adapter.ts` 读正文改成按 `messageBody` 在容器**子树**里取（默认 `scope:'subtree'`），
     id / direction 仍从容器自身读。
     连带要改的测试：`adapter.test.ts:374-392`、`conversation-store.test.ts:80/97/135`、
     `test-doubles.ts:487` 的默认行 `'对方：方便聊聊吗'`。
     **不写迁移去改历史正文**：dev 库里那几行带前缀的文本是 2.5-d 期间从旧模板读来的页面事实，
     删它要在应用代码里写死前缀，那正是 §12.10 说过的「把站点知识写进适配器」。验收以重新同步的新行为准。
     去重键不受影响：fixture 每条消息带 `data-message-id`，`dedupeKeyOf` 走 `id:<externalId>` 分支，
     只有「页面不给 id」的站点才会因正文变短而换掉 `t:sha1(...)` 键——这一点写进测试注释，别让它变成惊喜。

4. **新增文案全走 `jd.*` 命名空间并补齐 en**：打招呼按钮、已回复标记、回执行、拒绝原因提示。
   `scripts/check-renderer-conventions.ts`（已挂在 `pnpm lint` 末道）会做两语言包键对齐与插值参数校验，
   所以这里没有「先写中文回头补」的余地（§5.5/5.6）。

### 12.15 2.5-f 收口记录（界面打招呼入口与已回复标记这条通道，2026-09-30）

实现与 §12.14 没有偏差，四条落点原样落地：入口挂在 JD 行上（`[data-action="greet-<jobId>"]`）、
「已回复」由分组派生表左连导出、前缀三处一起改、新文案全在 `jd.*`。**未新增 service、未加迁移、
未动 `schemaVersion`**——`boss.json` 多出的 `messageBody` 定位符由 `knowledgePackSchema` 的
`strictObject` 同步补了校验，所以「加了字段就必须加校验」这条没有留死角。

页面实测拿到的三条读数（都是活体窗口，不是单测）：

1. **2.5-02 V 半边**：先在 unlimited 下点 #1 行的打招呼 → 回执块上屏
   （`账本行 #1 · 频控等待 0 毫秒 · 来源 v1:1（模板回落）· 页面回读：状态行回读到成功样式「已送达服务端」`，
   `2.5-02-greet-receipt.png`）；再在装配面板把 entitlement 现改成 `daily/1`（不重启）→ 点 #3 行 →
   界面红块 `QUOTA_EXCEEDED：动作 greet 今日 1 次额度已用完`（`2.5-02-quota-rejected.png`）。
   同一时刻 fixture `/api/outbox` 仍是 2 条、`usage.ledger.summary` 的 total 仍是 1：
   **被拒的那条既没出门也没落账**，这正是 §7.3「外发必经闸门」在界面上的可见面。验完把配置改回
   unlimited（`remaining` 回到 `null` 即为已恢复），不留一个明天让人困惑的日限额。
2. **2.5-08**：同步前 5 行全「还没有人回复」（`2.5-08-baseline-unreplied.png`），
   `conversation.store.syncFrom` 后 #2「对方已回 1 条」、#1「对方已回 2 条」置顶，
   其余三行沉后（`2.5-08-replied-first.png`）。
3. **2.5-14 + 前缀**：`2.5-14-joined-readout.txt` 里 1002 线程内 2 条只计 1 → 自己发的行不进计数；
   二次同步 `duplicate 2` → 去重判据在唯一索引里。三条存储正文 `带方向前缀: false`，
   帧内 `[data-message-marker]`（「对方：」/「我：」）与 `[data-testid=chat-log-body]`（纯正文）
   拆分断言见 `2.5-14-frame-dom-assert.txt`。**「投递优先」只兑现到列表取序这一层**，
   2.6 的投递节点必须消费同一份顺序、不得自己再排一次——spec 里把这句话写进 2.5-08 的验证操作列，
   不让它变成一个已经打勾的错觉。

本轮新增的环境事实（后面所有 V 类验收都会再撞上，记在这里）：

- **闸门动作名是 `greet`，不是 `outbound.greet`**。`check()` 对未知动作不报错，只会永远返回
  「一次都没用过」，所以判断「daily 配置是否真的生效」要看 `remaining` 从 `null` 变成数字，
  而不是看 `allowed`。传错键的 `check` 会给出 `allowed:true, remaining:1` 这种看着像通过、
  实则什么都没测到的读数。
- **`shot --reveal` 对比视口还高的元素会直接拒绝截图**（`cdp.ts:286` 只接受「完整可见」或
  「上下都溢出」两种落位，长面板两头都不沾）。要拍长面板里的一块，reveal 那一块本身
  （`[data-testid=jd-rows]`、`[data-testid=jd-error]`），别 reveal 整个面板。
- **reveal 之后布局还会变**：错误块/回执块出现会把内容顶下去，第一张图常常把目标切在上边缘外。
  读数稳定后再拍一次，别拿第一张当证据。
- **同源 iframe 的帧内 DOM 从父 target 就能读**（`iframe.contentDocument`），不需要额外的 target
  或帧定位能力；父页面自身 `querySelectorAll('[data-testid=chat-log-item]')` 是空数组，
  拿它当「页面没消息」的证据会读出一个假失败。
- **fixture 的线程与收件箱都在内存里**，重启即清空；而 Git Bash 里 `curl -d '中文'` 发出去的是
  非 UTF-8 字节，会把整条线程污染成乱码（`/api/reply` 当场回显乱码）。验收脚本一律
  `--data-binary @file` + `charset=utf-8` 头，中文正文先落文件。
- 复用检查（§2.4/2.5）：本轮没有新写判定逻辑上界面——徽标只转述 `JobRowView.replied/inboundCount`，
  回执只转述 `GreetReceiptView`，拒绝只转述 `bridgeError.code + message`；排序只在 SQL 里做一次。

## 13. 子计划 2.6 的选型与证据（开工前定稿，实现照此执行）

### 13.1 这一条到底在做什么

投递 = 把一份简历文件交到「已经聊上」的目标手里，并且在按下发送之前插一道人。
五件事：上传通道（2.6-04）、投递动作过闸门与落账（2.6-02/03）、人工审批与「仅辅助」档位
（2.6-01/06）、投递前二次校验目标仍在招（2.6-07）、所用简历版本可追溯（2.6-05）。

### 13.2 前置取证：文件上传通道（本机实测 2026-09-30，AGENTS.md §6.2）

**这一节的存在理由**：spec 2.6-04 的原文写着「Electron 侧 `startUpload` 而非 DOM 伪造」，
而这条 API 根本不存在。如果不先做取证，实现会在一个假名字上打转。

1. **`startUpload` 是不存在的 API**（本项目的第三次同类事故，见 §9 已记两次）。
   在装机版本 `electron@44.4.5` 的 `electron.d.ts` 全文里做大小写不敏感检索，
   `startUpload` / `FileChooser` / `fileChooser` 事件 / `setFilePaths` / `setFileInputFiles`
   **一个都没有**。真实存在的相关表面只有三处：
   `WebContents.debugger`（`electron.d.ts:18833`）、`Debugger.attach/sendCommand`
   （`:7646` / `:7670`）、`WebContents.startDrag(item)`（`:18765`，那是把文件**拖出**给系统，
   方向相反，不是上传通道）。
   其中关键的一条约束：`sendCommand(method: string, commandParams?: any, sessionId?: string)`
   —— **method 是自由字符串，没有任何命令名联合类型**，编译器不会替我们挡下拼错的 CDP 命令，
   所以命令名与参数形状必须由单测钉住（复用 `input-channel` 现有的假 session 断言形状）。
2. **`DOM.setFileInputFiles` 在这个 Electron 构建里实测可用，而且是真上传**。
   靶页（一次性，写在 `tmp/`，不进仓库）的 `<input id="resume" type="file">` 上走
   `DOM.getDocument → DOM.querySelector → DOM.describeNode`（取 `backendNodeId`）
   `→ DOM.setFileInputFiles{files:[绝对路径], backendNodeId}`，之后页面回读：
   `文件数 1`、`名字 26-spike-resume.pdf`、`字节 226`、`类型 application/pdf`，
   并且**`change` 事件真的触发了**（页面自己的回显段落变成「已选择：26-spike-resume.pdf（226 字节，
   类型 application/pdf）」）。`change` 触发是这条取路的命门：真实站点的校验/预览/进度全挂在
   `change`/`input` 上，只塞 `files` 不发事件就是「DOM 伪造」，会在下游静默失败。
3. **Playwright 式的「点按钮弹系统框再交文件」这条路径本轮没有结论**，不当设计依据。
   `Page.setInterceptFileChooserDialog{enabled:true}` 本身返回成功（`{}`），但随后的
   `Input.dispatchMouseEvent` 三连**一个页面事件都没落下来**（在 input 上挂的
   click/mousedown/mouseup 计数器读回 `[]`），所以 `Page.fileChooserOpened` 从未推过来。
   排查中先撞到一个真坑：**`Input.dispatchMouseEvent` 的 `buttons` 是 int32 位掩码**，
   传 `'left'` 会被 Chromium 以 `Invalid parameters ... int32 value expected` 拒掉，
   而远程 CDP 客户端不会把这条错误报到控制台，只表现为「点击静默不发生」
   （我们自己的 `input-channel.ts:60-80` 一直传数字，所以这坑只坑了 spike）。
   改成 `buttons: 1` 后点击仍不落页，最可能的解释是**当时那个 `WebContentsView` 不可见/被遮挡**
   （远程输入对不可见视图不做命中测试），而不是命令不支持。
   留到实现期在「内核视图确实可见」的前提下重测；主路径按第 2 条定——
   真实站点即便把 input 藏起来只留一个开框按钮，第 2 条照样能塞，因为它不需要点击。

推论（写进实现约束）：上传原语走**已有的 `contents.debugger` 通道**（`input-channel.ts:103`
是全仓唯一的 `debugger.attach`），不引入第二个 CDP 客户端、不引入 Playwright；
节点引用（`backendNodeId`）的解析与「定位层用 JS 选节点、上传用 CDP 选节点」两套寻址怎么对齐，
是 §13.3 必须先定的一件事——定不齐就会出现「定位到 A、文件塞进 B」。

### 13.3 落点设计（定稿，2026-09-30；四项逐个定，实现照此执行）

**1）归属与命名：`packages/outbound` 加 `deliver.ts`，服务名 `outbound.deliver`，闸门键 `deliver`，节点 kind `resume.deliver`。**

- 不新建包：投递与打招呼是同一件事的上下游（先聊上，再递简历），要复用的东西已经在同包里——
  `outbound.script.assertSendable`（黑名单唯一出口）、`outbound.throttle.nextGapMs`（节奏）、
  `entitlement.gate` + `usage.ledger`（判定与落账）。另起一个包就是把这四项依赖再声明一遍（AGENTS.md §2.3）。
- 闸门键沿用 `gate.ts` 注释里已经写好的 `deliver`，与账本 `action`、幂等键同一个字符串——
  §12.13 第 3 条定下的口径（三者不许拆开）不在这里动摇。
- 适配器契约把 `sendResume(jobId)` 扩成 `sendResume(jobId, attachment)`，
  `ResumeAttachment = { path, fileName, sizeBytes, sha256 }`。为什么传结构而不是只传路径：
  渠道要在回执里说清「塞进去的就是这几个字节」，只给路径就得让回读侧再算一次 hash——
  同一份算术做两处（§2.2）。`adapter.ts:69` 那个 `UnimplementedMethod = 'sendResume'`
  （`sendResume: '2.6'`）在本片删掉，这是它第一次有真实现。
- 知识包加**可选段** `deliver`（与 `chat` 同形，缺段即结构化失败，不拿猜的选择器打真实站点）：
  `uploadInput / sendButton / statusLine / sentPattern / offlinePattern`。
  `uploadInput` 直指 `<input type=file>` 的定位名——站点通常把它藏在一个「发送简历」按钮背后，
  但注入不需要点击（§13.2 第 3 条），所以「定位到那个隐藏的 input」就是最短路径。

**2）审批状态机放在 `outbound.deliver`，界面只是它的一个投影加一个 resolve 入口。**

- 为什么不放界面那一侧：投递有两个入口（工作流节点、界面单发）。把「等人」做在界面里，
  两个入口就各长一套「谁在等确认」，而第二个入口必然漏（§2.5）。
- 形状：`pendingApprovals: Map<approvalId, { platform, jobId, fileName, sizeBytes, sha256, requestedAt, settle, timer }>`，
  三个方法：`request()`（内部，等待方）、`resolveApproval(id, approved)`（界面上那两个按钮打到这里）、
  `pending()`（界面重渲染时现读「当前在等什么」，不靠订阅补齐状态，因此刷新/重开面板不会丢卡片）。
- 事件加一条 `outbound/approval-requested`，进 `RENDERER_EVENTS` 与 `RendererEventSignatures`
  （那条「新增事件名必须补载荷类型」的保险丝会替我们盯住）。载荷是结构化数据
  （approvalId + 目标 + 文件三要素），句子由渲染层按 i18n 组——与 2.1-08 定下的口径同一条。
- **超时按拒绝**，`approveTimeoutMs` 默认 120000。「没人表态」永远不等于「同意」。
  这条同时是热改配置重建的兜底：服务被重建后 Map 是空的，老那次 `await` 等不到 settle，
  由超时判死；而新实例查不到这个 id 返回 `APPROVAL_NOT_FOUND` 结构化失败，不是静默通过。
  §12.13 的教训在这里第二次生效，改写成一句话：**内存里悬着的等待必须自带到期出口**，否则重建即悬挂。
- 为什么不复用 runner 的 `requiresHuman` 接管点：接管是在 executor **抛错之后**才记的
  （`workflow/index.ts:579`），「这一步要不要问人」和「这一步失败了」走同一个入口，
  于是区分不了「还没问」与「问了且被拒」；而拒绝之后界面上只剩「重试这一步」一个按钮，
  语义正好反了。接管点留给它本来的用途（验证码/风控，2.7-01）。
  代价是投递等待期这一步在面板里是 `running` 而不是「待接管」，确认信息改由确认卡片承载——
  这条取舍写进 spec 2.6-01 的验证操作列，不留「看起来本该用接管」的悬念。
- 让出：等待挂在节点的 `invocation.signal` 上（复用 `sleep(ms, signal)` + `assertNotYielded`），
  暂停能立刻打断等待，且不发送、不落账——与 greet 的让出语义逐字一致。

**3）`stage / commit` 两段切，档位直接取现成的 `AutonomyLevel`。**

- `stage(request)`：校验文件（存在、pdf、大小上限）、算 sha256、查目标 JD 行、现问渠道、
  带文案时过黑名单 → 产出 `StagedDelivery`。**不发、不落账、不进闸门**。
- `commit(staged)`：才走 greet 那条顺序——额度先查后等 → 频控（以账本最近一条 `deliver` 为钟）→
  审批（按档位）→ 渠道发送 → 页面回读 → `gate.perform('deliver', …)`。
- 不新造枚举：`AutonomyLevel`（core `events.ts:390`，`suggest | semi | auto`）就是 master plan §1.7
  第 3 条定的那三态，2.6 是**第一次让它产生行为差异**的一片（1.11-07 当时明确只存档位）。映射：
  `suggest` = 只 stage（2.6-06 仅辅助）；`semi` = stage + 确认后 commit（2.6-01 的默认，档位默认值就是它）；
  `auto` = 免审批直接 commit，频控与额度照旧。
- 当前档位的**唯一来源是 `outbound.deliver` 的配置**（装配面板可热改，正是已经有把握演示的那条路）。
  不读 `chat.session` 的 `autonomy` 列：那是 L3 对话层的状态，L2 领域反过头问 L3 就是 §4.1 禁的方向；
  等 2.8 把投递做成 agent 工具时由**调用侧把档位当参数传进来**，方向自然顺。这条现在不做，见 §13.5。
- 2.6-05 的可追溯：`usage_ledger.source` 写 `resume:<sha256 前 12 位>@<文件名>`，
  不加列、不加迁移（复用 2.5-09 已经钉过的那一列）。
- 2.6-03 的「结果状态」按 §13.4 第 2 条更正后的口径落，账本维持「成功才有行」。

**4）CDP 节点引用与 locator 寻址对齐：一条链，两边都不各自选节点。**

第二轮 spike（`tmp/26-spike-handle2.mjs`，靶页由脚本自带的临时 http 服务提供，同源，不进仓库）实测：

- `DOM.setFileInputFiles{files, selector}` **这条取路不存在**——回包原文
  `Either nodeId, backendNodeId or objectId must be specified`，`selector` 被当未知参数忽略。
  若照 CDP 文档转述去写它，就是一次标准的 §6.2 事故。
- `DOM.requestNode{objectId}` 在**没有先 `DOM.getDocument`** 时回 `{nodeId: 0}`：不报错，
  但那个 0 是无效引用；补一次 `getDocument` 之后同一调用回 `{nodeId: 11}`。
  「静默给你一个 0」这种形状绝不能进我们的代码路径——它就是「看着成功、实则什么都没发生」。
- `DOM.querySelector` 在这份构建里只回 `{nodeId}`，**不带 `backendNodeId`**，
  所以 `setFileInputFiles{backendNodeId}` 也不通（除非再多一次 `DOM.describeNode`）。
- 可用的最短链：`Runtime.evaluate{expression, returnByValue:false}` 的 `objectId`
  → `DOM.setFileInputFiles{files, objectId}`。主帧实测文件只落在 `#first`
  （另两处仍是「未触发」），`change` 触发，名字与字节都对。
- 子帧：`Page.getFrameTree` 按 URL 取 frameId → `Page.createIsolatedWorld{frameId}` →
  在该 `executionContextId` 里 evaluate → 同一个 objectId 直接注入成功。
  子帧回读 `change#1 文件名=26-spike-resume.pdf 字节=226 / data-which=in-frame`，
  主帧两处仍「未触发」：**跨帧不串味**；而隔离世界拿到的就是页面上那个真节点
  （主帧注册的 `change` 监听器被触发了）。

据此定下 `browser.act.upload(spec, filePath)`，形状与 `click` 逐字对齐：先 `waitSatisfied('clickable')`、
再 `browser.locate.find(spec)` 得到 `chosen{candidateIndex, nodeIndex, frameUrl}`，
**「哪个节点」只由 locator 这一处决定**；CDP 侧不做第二次选择——在 `chosen.frameUrl` 对应的帧上下文里
跑**同一份候选打分脚本**，但返回**节点本身**（`returnByValue:false`）而不是 JSON 读数，
于是打分的胜出者与注入用的 objectId 是同一个节点。新增的是 `locator-script.ts` 里一个
`buildNodeHandleScript(candidates, identity)`，与既有 `buildDomActionScript` 共用打分与身份逻辑。
取到 objectId 后注入，**随后必须回读校验**：在同一上下文读 `files[0].name` 与 `size` 跟请求的文件比对，
不符即 `ACT_FAILED`（带 spec 与快照引用）。这条回读既是「定位到 A、文件塞进 B」的机器防线，
也正好是 2.6-04 的 V 证据本身。
命令名与参数形状由单测钉死（`sendCommand(method: string, …)` 没有联合类型，编译器不挡），
复用 `input-channel.ts:141` 已有的 `sendCommands(contents, CdpCommand[])` 接缝与它的假 session 断法。
**四条被实测否决的路都不进代码**：`requestNode` / `nodeId` / `backendNodeId` / `selector`，
每条上面都有一句理由。OOPIF（跨进程子帧）不在本片——`sendCommand` 有 `sessionId` 位，
真要接是加一个参数的事，而 fixture 与 BOSS 的会话页都在同进程（记进 §13.5）。

### 13.4 随本片更正的四条 spec 文案（条目 ID 不变，文案改了要留原因）

1. **2.6-04**：原文的 `startUpload` 是不存在的 API（§13.2 第 1 条）。改成实测那条——
   `DOM.setFileInputFiles{files, objectId}`、`change` 真触发、注入后回读文件名与字节与请求一致，
   并把这条回读升级成验收动作的一部分（不接受「调用没报错」当证据）。
2. **2.6-03**：原文「投递成功/失败均落 `usage.ledger` 且带结果状态」与本项目既有不变量冲突——
   `gate.perform` 只在 task 成功后落账（`gate.ts` 注释 + 2.5-03 已测「失败一律不落账」），
   而 `countToday()` 数的就是行数，失败也落行会把额度算错（超限拒的是不存在的用量）。
   改成：成功落 `usage_ledger` 一行（`action=deliver`、`source` 带简历 hash）；
   失败**不落账**，结果状态在 `workflow_nodes` 行（`error` / `attempts`）与日志里可查，额度不扣。
3. **2.6-07**：`jobs` 表没有任何在招状态列（`jd-store.ts:45-63`），「二次校验」只能现问页面——
   知识包 `deliver.offlinePattern` 一份数据 + 一次重读，而不是给 JD 行加一列再往里写。
   「跳过」落为「这一步不再尝试、不发送、不落账」：节点 `retryTimes: 0` + 结构化失败
   `DELIVER_TARGET_OFFLINE`。runner 里由 executor 驱动的 `step-skipped` 目前只服务断点续跑
   （`workflow/index.ts:476`），那种「按条件跳过」的图语义属于 5.10 画布切片，不在本片造。
4. **2.6-05**：原文「记录简历快照 id + 内容 hash」里的前半个凭据现在不存在——P3（简历 PDF 生成）
   还没做，库里没有简历快照表，为它建表就是为一个占位符加迁移。改成本片能真做到的那半条：
   `source` 记 `resume:<sha256 前 12 位>@<文件名>`，快照 id 等 P3 建表后补进同一个字符串，
   3.7 的 diff 拿 hash 就能对上。

### 13.5 本片不做 / 明确欠着的

- **fixture 侧要新增两样**：一个上传靶页（带隐藏 input 与 `change` 回显，作为 2.6-04 的截图对象），
  一个收得到文件的接收端。现有 `readJson` 只吃 JSON 且有 64KB 上限（`fixture-server.ts:553`），
  multipart 要新写 body 解析——所以用 **base64-in-JSON** 提交，把解析成本留在主线之外。
- **简历文件从哪来**：P3（简历 PDF 生成与编辑）还没做，本片接收的是「请求里带的路径 /
  配置里的默认路径」。`resume:<hash>` 这个 source 形状就是将来与简历快照表对上的钩子，
  现在不建表。
- **档位与 `chat.session` 的接线**：见 §13.3 第 3 条末，留给 2.8 的 agent 工具入口。
- **OOPIF 子帧上传**：`sessionId` 参数留白，等真实站点证明需要再接。
- 界面确认卡片要新文案，全部进 `deliver.*` 命名空间并一次补齐 zh-CN / en（AGENTS.md §5.5/5.6）。

### 13.6 2.6-a 收口记录（文件注入这条原语，2026-09-30）

与 §13.3 第 4 条有四处偏差，都是「照原文写下去就会失败」那类，逐条记清楚：

1. **等待判据是 `appear`，不是 `clickable`**。原文照 `click` 抄了 `waitSatisfied('clickable')`，
   而隐藏的 `input[type=file]`（`display:none`，站点把入口做在按钮背后）永远读不到盒模型，
   那条等待在真实站点上只会等满超时。上传不经坐标，几何稳定对它没有意义，
   所以 `appear` 就是它的全部前置——这也是为什么 `upload` 不能沿用 `perform` 那条等待路径。
2. **跨世界寻址用 `hitIndex`，不用 `nodeIndex`**。`nodeIndex` 是脚本注册表
   （隔离世界 `globalThis` 上的 WeakMap 计数器）在**某一个 JS world 内部**发的号，
   而注入必须在 `Page.createIsolatedWorld` 新建的上下文里跑：新世界重新扫一遍就重新编一次号，
   同一个节点在两边的号可以不同（前面有条候选先消耗过号即是）。`hitIndex`（同一条候选过滤祖先之后
   的第几个命中，文档序）与世界无关，所以取节点引用的脚本按它取。
   单测里那条跨世界用例就是这个失败模式的靶子：同一份声明在旧世界按 `nodeIndex` 找回、
   在新世界编号已变，而按 `hitIndex` 找回的是同一个节点。
3. **新增 `LocateSpec.requireActionable`（缺省 true）**。隐藏 input 在打分层要吃
   `NOT_VISIBLE 30` 与 `OBSTRUCTED 20`（`enabled` 读不到时再多扣 `NOT_ENABLED`），
   testId 的 100 分会掉到 `minScore 70` 以下判 `below-score`——「定位到那个隐藏的框」
   在本片第一个真实场景里就必然失败。豁免只免掉「可被指点」三条判据，策略权重、包含匹配折价、
   生成串封顶照旧；注入类声明必须在知识包里显式写 `requireActionable: false`（进 2.6-b 的 `boss.json`）。
   落地方式是**给既有的 `scoreReading` / `toRankedCandidates` 加一个参数**，不是再写一套打分器（§2.3/2.5）。
4. **回读绑在同一个 objectId 上，`change` / `isTrusted` 由页面自己答**。`input.files` 只读，
   主进程伪造不出真附件，所以「有没有真的收到」只能问页面：取节点引用的脚本顺手在隔离世界装一个
   `change` 探针（WeakMap 以节点为键，键名常量 `UPLOAD_PROBE_KEY = '__autoCcUploadProbe'`），
   记 `changeCount` 与 `event.isTrusted`，每次取句柄都清零；回读用 `Runtime.callFunctionOn`
   而不是再 evaluate 一次，于是 `this` **就是**注入的那个节点，不存在「回读到另一个同名 input」的空间。
   附带一条实测事实：`callFunctionOn{returnByValue:true}` 的值在 `result.value` 里，
   把整个回包喂给读数钳制函数会得到 `changeCount:0` 这种「什么都没发生」——
   这个形状是照代码读出来的，不是文档转述（§6.2），`toCallFunctionValue` 就是为它加的。

一条**已经知道 weaker 的防线，写在这里免得将来误当成强防线**：取节点时复核的是
「`tagOf === 'input'` + `type === 'file'` + tagName 与 rect 四项等值」，但隐藏控件的 rect 全是 0，
等值比对退化成恒真，实际挡漂移的只有「序号 + 是不是 file input」两道。真站点的隐藏框是否会让序号漂到
邻居身上，只有 2.6-c 的 fixture 靶页与 2.6-d 的真人验证能答，届时如实记。

另两条按原计划落地但值得点名：**上传没有 DOM 兜底**（`cdpInputEnabled:false` 即 `ACT_FAILED`，
不像点击那样降级成 `trusted:false` 的脚本点击——降级在这条路上等于宣称附件进去了而并没有）；
**四条被否决的 CDP 取路不进代码**，且有断言钉着：注入链的命令序列逐条比对
（`Page.enable → Runtime.enable → DOM.enable → Page.getFrameTree → Page.createIsolatedWorld →
Runtime.evaluate → DOM.setFileInputFiles → Runtime.callFunctionOn`），
再把 `selector` / `nodeId` / `requestNode` 三个字面在序列化后的命令表里查一遍，出现即失败。

三条机器防线合起来回答的是同一个问题：不接受「调用没报错」当成功——节点按序号找回并复核形状、
注入与回读共用一个 objectId、`changeCount === 0` 或文件名/字节数与请求不符即 `ACT_FAILED`
（带 spec、`filePath` 与页面快照）。

证据现状：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 全绿（`pnpm test` 退出码 0），
`packages/browser` 12 个测试文件 181 条全过；本轮相关的四份是 `act-service.test.ts` 22、
`locator-script.test.ts` 37、`input-channel.test.ts` 22、`locator-spec.test.ts` 19。
**2.6-04 的 V 半边不打勾**——截图对象是 fixture 的上传靶页，它排在 2.6-c（§13.5 第一条），
所以这一片只有逻辑层证据，spec 里 2.6-04 保持 `[ ]`，不因单测全绿写成 `[x]`。

### 13.7 2.6-b 收口记录（`outbound.deliver` 编排 + 适配器 `sendResume`，2026-09-30）

四处与 §13.3 的偏差，都属于「照原文写下去就会失败或写歪」那一类，逐条记清楚：

1. **`stage` 不查目标 JD 行**。§13.3 第 3 条把「查目标 JD 行」列进了准备步骤，用途是替确认卡片
   凑出「递给谁」那句话。落地的口径改成：`title` / `company` 由调用方（界面或节点参数）带进来，
   缺省就是空串。两条理由：`jd.store` 的读取面只有 `list(limit)` / `count` / `status`，
   没有按 jobId 取一行的方法；而补这个方法并把 `outbound.deliver` 接到 JD 存储上，
   就是 §4.1 明令禁止的同级横向引用（L2 领域包互不 import，平台知识只经 `platform.registry` 那条 SPI 进来）。
   为卡片上两句文案开这条口子不值——界面入口本来就知道用户点的是哪张 JD 卡。
2. **没有随信正文，所以不挂 `outbound.script`**。§13.3 第 3 条那句「带文案时过黑名单」管的是随信文案，
   而 2.6 的条目里没有一处要求投递带文案（黑名单在 2.5 管的是话术）。本片只递那份 PDF，
   因此 `static inject` 里没有 `outbound.script`；将来做「随信一句话」时把它加回来，
   那道唯一出口（`assertSendable`）已经在那儿了，不必现在为它留一个空依赖。
3. **下架二次校验落在适配器的第一道闸，spec 2.6-07 原文的「渠道没被调」按字面不成立**。
   「现在还收不收」只有页面能回答，而读页面本身就是渠道在做的事：`sendResume` 的顺序是
   （按知识包必要时导航到上传页）→ 读一次状态行 → 命中 `offlinePattern` 即抛 `DELIVER_TARGET_OFFLINE`，
   之后才碰文件。所以断言的口径改成「**在架闸门之后零外发动作**」：假页面上 upload 调用数 0、
   click 调用数 0，读数只有那一发（`page.kinds === ['deliver-status']`），账本不增。
   spec 那条文案随本片更正，条目 ID 不动（先例见 §13.4）。
4. **审批状态机从 2.6-c 提前到本片**。它是 `commit` 序列里的一环（额度 → 频控 → 审批 → 发送 → 回读 → 落账），
   留在下一片，这一片就演示不出 2.6-01 / 06 的档位差异；而把「等人」做成后补的插件，
   等于允许中间那段时间里两个入口一个等、一个不等——正是 §13.3 第 2 条要避免的形状。
   2.6-c 剩下的仍是界面那半：`outbound/approval-requested` 事件、桥接与 IPC 白名单、确认卡片与待发送态。

另两条按原计划落地但值得点名：**`stage` 是同步的**（读文件与算 hash 都是同步 API，`commit` 才异步），
原先照 §13.3 的措辞写成 `async` 被 eslint 的 `require-await` 拦下——这一段没有一处 await，
返回一个 Promise 只会让调用方误以为它能 await 出什么；**档位 `suggest` 跑工作流节点时是抛错**而不是
「成功但什么都没做」：`executeNode` 检查 `receipt.committed`，否则以 `OUTBOUND_APPROVAL_DENIED`
上浮，因为记成完成会让断点续跑认为这一步已经过了，那正是 2.6-06 最坏的一种误读。

三份测试面（逻辑层证据）：`adapter.test.ts` 新增投递 describe 9 条（四段判据各一支、缺 `deliver` 段
fail-closed、空 jobId、定位失败原样透传）；`platform-contract.test.ts` 新增投递页知识 4 条
（隐藏的上传控件带着 `requireActionable: false` 一起过校验、声明了 `sendResume` 却没有 `deliver` 段、
`deliver` 引用不存在的定位名时逐条点名、缺 `offlinePattern` 直接非法）；`deliver.test.ts` 新文件 21 条
（三档行为各一支、确认卡片不含路径、拒绝 / 超时 / 单一 settle / 未知 id / 等待中让出 / 服务重建六种定局
都不发不落账、账本行与 `source` 形状、额度**先查后等**（用实测墙钟差小于频控间隔断言）、
频控以账本最近一条 `deliver` 为钟、幂等换进程重挂同一份库照样成立、渠道在 stage 与 commit 各现问一次、
文件校验五支、节点路径三支）。

证据现状：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 全绿（`pnpm test` 退出码 0），
`packages/outbound` 5 个测试文件 53 条、`packages/platform-boss` 6 个 114 条、`packages/browser` 12 个 186 条全过。

**运行时装配半边（真实 app 的「诊断」视图，CDP 10222 + harness，截图 `tmp/26b-assembly-deliver.png`）**：
装配面板上 `outbound-deliver` 一行是「已就绪」，读数 `依赖 entitlement, outbound-throttle, platform-registry ·
配置项 autonomy, approveTimeoutMs, maxResumeBytes · effect 3 项`，位置正好在 `outbound-greet` 与 `platform-boss`
之间（清单顺序即挂载顺序）；主进程日志同刻三行连起来是本次要看的因果链——

```
00:46:15 INFO [outbound-deliver-service] 投递编排就绪：额度键 deliver · 档位 semi · 确认超时 120000ms
           · 当前可投递平台 （平台层尚未登记带 sendResume 的适配器） · 节点执行器已登记 resume.deliver
00:46:15 INFO [kernel-service] 插件 outbound-deliver → active
00:46:15 INFO [platform-registry-service] 平台适配器已登记：boss（能力 search / detail / chat / sendResume / readReplies）
```

「就绪时还没有渠道、渠道在之后才登记」正是 §12.13 那条拉模型要在真实进程里成立的样子（单测里对应
「挂载时登记表为空不影响后来」那一条）。这条只是**装配证据**，不是 2.6-01 的 V 半边——那要的是确认卡片上屏。

**2.6-01 / 02 / 06 / 07 的 V 半边不打勾**——确认卡片、待发送态与 fixture 上传靶页排在 2.6-c，
spec 相应条目保持 `[ ]`，逻辑半边已覆盖，不因单测全绿写成 `[x]`。

### 13.8 2.6-c 收口记录（审批状态机上屏 + fixture 靶页 + 逐项验收，2026-10-01）

**这一片交出的东西**（三处提交，各做一件事，按 §1.4 分开）：`ec9fb78` 把 `outbound/approval-requested`
事件、`deliver.pending` / `deliver.resolveApproval` 两个桥接方法并进白名单并画出确认卡片；
`670b285` 给 fixture 加 `/deliver` 靶页（`display:none` 的上传控件 + 服务端按原始字节算 sha256 的
`POST /api/deliver-upload`）；`67d858c` 补 `boss-deliver` 内置计划，让投递节点有一条能落到库里读数的入口。
等待状态机本身留在 `outbound.deliver`（§13.3 第 2 条的理由不变：投递有两个入口，做在界面侧必然漏一套）。

**逐条打到的证据**（`docs/acceptance/2.6/`，每条一个 `.txt` 读数 + 对应截图）：
`2.6-01` 卡片上屏 / reload 后重建 / 点确认才发送 / 到点即拒四张；`2.6-02` 到量即拒；
`2.6-03` 节点行 `failed · attempts=1 · error`；`2.6-04` 靶页与 `files[0]` 机读同源、整串 sha256 与 app 侧相等；
`2.6-06` 待发送态且账本零增；`2.6-07` 下架目标零上传零点击；`2.6-08` 用量面板与闸门同一份计数。
全程只打 `127.0.0.1:10233`（`platform.registry` 的 `startUrl` 就指着它），每一次外发都经 `gate.perform`。

**与计划的偏离，逐条写明**：

1. **计划里不带简历路径**：`BOSS_DELIVER_PLAN` 的两个节点只给 `platform` / `job`，`file` 参数缺席——
   把 `D:/…/tmp/26c-resume.pdf` 这种机器绝对路径写进仓库里的计划，等于让每次 clone 都要先改计划。
   路径改从 `outbound.deliver` 的 `resumeFile` 取（`plugins.saveConfig` 热改，测试期用 `tmp/` 下 193 字节的占位 PDF）。
   计划是纯数据、参数只允许标量这条约束因此没有松动（plan §11.8）。
2. **额度演示用的是 `dailyLimit=2` 而不是原文的 1**：跑第 3 次投递时账本里已经有两行 deliver，
   「切到 1 就必然立刻拒」这条性质没变，只是被拒的是第 3 发而不是第 2 发；`gate.check` 的读数
   （`remaining:0` + 可读原因）与截图都按实际数字归档，spec 那条的验证操作在 `2.6-02-*.txt` 里更正过。
3. **频控是演示期配置而不是代码**：`outbound-throttle` 的 `minGapMs` / `maxGapMs` 临时热改成 0，
   否则七次外发要挂十几分钟；默认 45–150s 那套随机间隔一行没动，`2.6-*` 的截图里也没有拿 0 间隔冒充真实节奏。
4. **「等待中暂停可打断」这一小半没在窗口里重放**：第二次点 `run-once` 时 runner 没有起新 run
   （上一发 `boss-deliver` 的 run 还停在 `failed` 且库里可续），于是拿不到「审批等待中按暂停」的画面。
   这条语义只由 `deliver.test.ts:352` / `:625`（abort → `WORKFLOW_STEP_FAILED`，不发送不落账、卡片收掉）
   与 2.4-07 已验过的让出路径支撑，spec 2.6-01 因此带一条明示的 weaker 半条，不打成无损的 `[x]`。
5. **`2.6-04` 没消掉 §13.6 记下的 weaker 防线**：靶页的上传控件与真实站点一样是 `display:none`，
   rect 全 0 使注入后的形状复核退化，这一条只能靠「服务端独立算出的整串 sha256 与 app 侧一致」对账；
   真站点上的最终判定仍欠真人验证（§7.2 不许自动化打真实平台）。

**驱动真实窗口时撞到的四条操作事实**（下次跑 V 类条目直接照做，别再试错）：

- 面板所在的 tab 是 `hidden` 时，里面按钮的 `getBoundingClientRect()` 全是 0，而 harness 的 `click`
  是按中心点派发原生鼠标事件的——落在 `(0,0)` 上，点不到。所以**先点「诊断」tab 再操作 job-lab**，
  并用 `harness dom --attrs` 读一次 rect 确认它真的有尺寸。第一次 `deliver-1001` 点击失败就是这条。
- 渲染层有 CSP（1.7 的产物），页面里 `fetch('http://127.0.0.1:10233/…')` 直接 `Failed to fetch`。
  fixture 侧的读数（`/api/deliveries`）从 shell 取，页面侧的读数用 `--url 10233` 连内核视图那个 target。
- 桥接的键是「域名 + 点号余段」：`b.outbound['deliver.pending']`、`b.jd['store.list']`、
  `b.usage['ledger.summary']`，不存在 `b.outbound.deliver.pending()` 这种三层形状；写错就 `is not a function`。
- `plugins.readConfig` 复读得到的是**校验后**的值：喂 `mode:'limited'` 这种非法枚举时写入被 `static Config`
  挡回、读数仍是 `unlimited`，这本身就是闸门配置面的证据，别把它当成「保存失败」去排查。

## 14. 子计划 2.7 的选型与证据（开工前定稿，实现照此执行）

### 14.1 这一条到底在做什么

七条验收里**没有一条是"让自动化更强"**，全部是给自动化装刹车与行车记录仪：
撞见风控就停（2.7-01）、根本不装绕过件（2.7-02）、三个动作各有日上限（2.7-03）、
节奏参数不许散在代码里（2.7-04）、做过什么能回看（2.7-05）、首次启用要先签字（2.7-06）、
落盘的个人信息要糊掉（2.7-07）。所以这一片的判据是**反向的**：
验收通过的标志是"某件事没有发生"（没发出去、没绕过、没落明文），
这决定了它的实现重心在**观测点 + 结构化失败 + 机检扫描**，而不在新能力。

### 14.2 前置取证（本机现状勘察 2026-10-01 + `electron.d.ts` 实测，AGENTS.md §6.2）

**A. 现状：风控检测今天是零。** 全仓 `packages/**` 检索 `captcha|验证码|风控|403|429|checkpoint`，
运行期命中为零：`platform-contract.ts:291` 只是 `OutboundResult.reason` 的自由文本注释；
`sessions/probe.ts:6` 是"探测不发请求"的策略注释；`platform-registry.test.ts:107,219` 与
`agent.test.ts:123,127` 都是**测试假件**在扮演验证码。唯一的"验证码→停"路径是
`plan.ts:37` 声明的 `requiresHuman` 节点，而它只在**节点已经失败之后**才生效
（`workflow/index.ts:578-585`）。也就是说：页面真的跳出验证码时，app 现在会把它当成
一次普通失败去重试，或者当成空结果继续往下走——这正是 2.7-01 要堵的洞。

**B. 现状：HTTP 状态码在装载路径上被丢掉。** `browser.page.settleLoad`（`index.ts:269-283`）
只把 `did-fail-load` / `did-finish-load` 收敛成 `'loaded' | 'failed' | 'timeout'` 三个字符串，
而 403/429 是**成功装载**（`did-finish-load`），连失败码都不带。
`readSnapshot`（`index.ts:241-259`）里有 `url/title/bodyText`——页面文本拿得到，状态码拿不到。

**C. `electron.d.ts`（装机版 44.4.5）实测的三条取路，逐条比对后选第二条**：

| 取路                                                     | 事实（行号对 `node_modules/.pnpm/electron@44.4.5/.../electron.d.ts` 有效）                                                                                                                                                                                                                         | 取舍                                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDP `Network.enable` + `Network.responseReceived`        | `input-channel.ts:110-121` 是全仓唯一的 `debugger.attach`，`:152-156` 只做**请求/应答一次性** `sendCommand`；全仓**没有任何 `debugger.on('message')` 监听**，`Page.enable`/`Runtime.enable` 之外没启用过别的域                                                                                     | **否决**：要先把事件路由这层从零搭起来（谁订阅、如何按 sessionId 分发、视图销毁后怎么退订），为一个读数引入常驻事件通道，代价与 §2.6 的简洁要求不成比例；且 method 名是自由字符串（§13.2 第 1 条的同一个坑），拼错静默 |
| `session.webRequest.onResponseStarted(filter, listener)` | `:19757/:19763` 签名里 listener 是 `(details) => void`——**没有 callback**，纯观测；`OnResponseStartedListenerDetails`（`:23118-23150`）带 `statusCode`、`statusLine`、`resourceType`、`url`、`webContentsId`、`frame`；`WebRequestFilter`（`:19778-19799`）`types:['mainFrame']` + `urls:string[]` | **采纳**：只读、拿得到状态码、不会卡住请求，过滤到主框架后每次导航一条，事件量可控。观测点挂在**已存在**的会话与视图边界上，不需要新的 CDP 通道                                                                        |
| `session.webRequest.onHeadersReceived(..., callback)`    | `:19744/:19751` 是**改写型**钩子，details 同样带 `statusCode:23114` 与 `resourceType:23110`，但必须调用 `callback(HeadersReceivedResponse)`；不调用则该请求挂住                                                                                                                                    | **否决**：一个"看一眼"的需求却要求我们交出响应控制权，写错就是整页卡死，比状态码丢掉的故障更难查                                                                                                                       |

**D. 现状：额度只有"一个数管三个动作"，且抓取完全不进闸门。**
`gateSchema`（`entitlement/gate.ts:20-25`）是 `{ mode: unlimited|daily, dailyLimit: 1..1000 默认 5 }`，
`countToday(action)`（`ledger.ts:160-165`）按动作分计数器但共用同一个上限——
2.7-03 要的"各自独立"今天只做到了一半（计数独立、额度不独立）。
`jd-capture.ts:11-12` 明写"全程只读：一行 `entitlement.gate` 都不进（AGENTS.md §7.3 管的是外发）"，
并被 spec 2.3-11 验收过——**与 2.7-03 正面冲突**，处置见 §14.4 第 1 条。

**E. 现状：`pacing` 是一套没人读的第二额度系统。**
`platform-contract.ts:162-169` 定义了 `pacing: { minActionGapMs 默认 3000, maxDailyActions 默认 20 }`，
`boss.json:244-247` 给了 `5000 / 20`。全仓检索 `.pacing` 的运行期消费者：**零**
（只有 `platform-boss/src/index.test.ts:55` 断言它 > 0）。它和 `entitlement.gate` 的日上限、
`outbound.throttle` 的随机间隔是同一件事的第二份声明——按 §2「禁止第二套同类基础设施」必须处理，见 §14.4 第 2 条。

**F. 现状：脱敏只做了日志这一半。** `log/redact.ts` 有 phone/id-card/email/secret 四类掩码，
`LogService` 在出口处 `redactText`（`logger/src/index.ts:131-153`，`redact` 默认 true）；
但工作流失败证据 `workflow/index.ts:698-732` 写盘时把 `page.bodyText`（`evidenceTextChars` 默认 300 字）**原文**落进
userData 下的 JSON，一行 redact 都没过。截图侧：`browser.page.screenshot`（`index.ts:191-217`）只回字节，
落盘只发生在 `writeScreenshot`（`:758-771`），像素层面今天没有任何脱敏。

**G. 现状：没有"首次启用"这道签字，也没有能存住这件事的地方。**
`onboarding|consent|firstRun|协议` 全仓零命中。持久层只有 `store.db`（`packages/store`，
迁移号已被占到 5：ledger/chat/jobs/workflow/conversation），而**插件配置活不过重启**——
`plugins.saveConfig` 只写 `kernel.runtimePatches`（`kernel/src/index.ts:137,375,440`，全仓无 `writeFileSync`），
所以"用户确认过"这件事不能存进配置。渲染层也没有通用弹窗组件，最接近的形状是
`JobLabPanel.tsx:74-119,247-258` 的确认卡片（现读 `pending()` + 事件驱动刷新 + 两个按钮各带 busy 态）。

**H. 本机 spike 已跑完（2026-10-01，`tmp/spike-27c/main.cjs` + 一次性本地 HTTP，Electron 44.4.5 真实二进制）**：
spike-1 用 `session.fromPartition('persist:spike-27c')` 上挂
`webRequest.onResponseStarted({urls:['http://127.0.0.1:10299/*'], types:['mainFrame']}, listener)`，
依次导航 `/ok`、`/forbidden`、`/too-many`：三条**都**推来 `statusCode` 200/403/429、`statusLine`、
`resourceType:'mainFrame'`、`webContentsId`。把 `types` 去掉再导航一张带 XHR + iframe 的页面，
`resourceType` 变成 `mainFrame`/`xhr`/`subFrame` 三条——**所以 `types:['mainFrame']` 是必需的**，
否则每次页面内请求都进来一条噪声。另一条同样重要的实测：
**同一个 session 的同一个 webRequest 事件只有一个 handler**——第二次注册直接把第一个**覆盖**掉
（前一个数组此后不再增长，计数停在 0），所以 `browser.risk` 是这个槽位的**独占者**，
装配时必须幂等、卸载时必须摘除，别指望"再多挂一个监听器"这条路存在。
还有一个对产品语义有用的读数：403/429 的主框架导航照样触发 `did-finish-load`（不是 `did-fail-load`），
**风控页的正文是读得到的**，所以知识包 `riskPattern` 那条文本信号不是纸面能力。
spike-2 断言生命周期：listener 装在会话上，把装着它的那张窗口 `destroy()` 掉之后，
**它不会残留成坏状态、也不会消失**——同分区新建的窗口继续被记到（计数 3 → 4，`webContentsId` 从 1 变 2），
说明归属判定只能靠 `details.webContentsId` 去会话的视图表里反查平台；
摘除用 `onResponseStarted(filter, null)`，不抛错且此后新导航零记录（增长 0）；
摘完再重挂照样生效（重挂后 `/forbidden` 立刻记到 403）。顺带一条环境事实：
Windows 上最后一个窗口关掉会直接结束进程，spike 必须挂 `window-all-closed` 空处理器才跑得完后半段
（真实 app 有主窗口，不受影响，但脚本型验证会踩）。
C 表第二行的取舍据此**定稿为第二条取路**：只读、拿得到状态码、事件量按导航计、且不需要新的 CDP 通道。
spike-3（截图遮罩：只加 overlay 元素、不改文本内容，截完移除，回读 `document` 确认页面自述文本没被我们改坏）
**当时未跑**，它服务的是 2.7-d 的 2.7-07，不属本片；现已在 2.7-d 跑完，实测读数与它划出的能力边界见 §14.10 第 ⑥ 条。

### 14.3 落点设计（定稿 2026-10-01，实现照此执行）

**1）检测归 `browser.risk`，暂停归 `workflow.runner`，中间只有一个事件（2.7-01）。**

- 新增服务 `packages/browser/src/risk-service.ts`，provide `browser.risk`，注入 `platform.registry` + `sessions`。
  理由与边界：观测点在**页面装载**这一层（C 表第二行），而分区/视图生命周期在 `sessions`/`shell`，
  判定标准（哪些字样算风控）在知识包里——三样凑齐的最小落点就在 browser 域，
  放进 `outbound` 会让打招呼与投递各自盯一遍页面（两个入口必然漏一套，同 §13.3 第 2 条的理由）；
  放进 `runner` 会让 L3 反过来教 L2 怎么读页面。不新建包。
- 两个信号源，一个出口：`onResponseStarted` 的主框架 `statusCode ∈ riskStatusCodes` → 一类；
  知识包新增**可选** `risk` 段（`riskPattern`：状态行/标题/正文任一命中即算）→ 另一类。
  `risk` 段用可选而不是必填，因为 2.6 的 `deliver` 段必填换来的那条纪律在这里不适用：
  没有风控字样的平台照样要能跑，缺段只是"这一类信号不检"，不是能力缺失。
- 命中即 `ctx.emit('browser/risk-signal', {platform, kind, detail, url, at})` 并进 `RENDERER_EVENTS`
  与 `RendererEventSignatures`（那条保险丝会盯住），载荷是结构化数据、句子由渲染层按 i18n 组——2.1-08 口径。
- 暂停走**已有的那条一模一样的路**：runner 订阅 `session/expired` 后 `stop(takeover)`
  （`workflow/index.ts:392-399`），这里加一个同形状的 `browser/risk-signal` 订阅 →
  `stop({reason:'risk-control', subject:platform, stepId:当前步, at})`。
  `WorkflowTakeoverReason`（`core/events.ts:89`）加 `'risk-control'` 一个值，
  `zh-CN/en` 两份语言包各加一条 `workflow.takeoverBody.risk-control`。
  面板横幅、重试按钮、i18n 命名全部复用 `WorkflowPanel.tsx:118-137` 现有形状，界面侧零新组件。
- "立即"的含义钉死为三件事：run 状态转 `paused`（不再起下一步）、当前节点收到的 `signal` 被 abort
  （因此 greet/deliver 的 `assertNotYielded` 会在下一个检查点抛，不发送、不落账——与 2.4-07/2.6 已验语义逐字一致）、
  界面拿到横幅。**不做**：不重试、不降级、不"等一会儿再看一眼"，任何一条都是绕过风控。

**2）红线只用心智 + 机检守，不做成运行期开关（2.7-02）。**

- 新增 `scripts/check-compliance-redlines.ts`，形态照抄 `check-llm-single-entry.ts`（一条规则一个脚本，root `pnpm lint` 串上），
  扫 `packages/*/src/**` 生产代码（测试与 harness 另列 allowlist）：
  UA/请求头伪装（`overrideUserAgent|appendUserAgent|userAgent:` 赋值、`webRequest.onBeforeSendHeaders`）、
  指纹与自动化痕迹（`navigator.webdriver`、`addInteractiveScripts`、`addScriptToEvaluateOnNewDocument`、
  对 `navigator.plugins|languages|platform` 赋值）、验证码识别外部服务（`2captcha|anticaptcha|capmonster|scratch` 域名）、
  多账号池（`partitionFor(` 的调用点唯一且入参是平台名，分区名不许带序号）。
- 扫描器是**防漂移**，不是防有意为之：真要接码或伪装，人一定写得出来，所以同一条验收的另一半是 §8 那条禁令的
  持续存在（spec 2.7-02 要求 plan §8 记录，见 §14.5）。
- 现状有利：E3 勘察确认今天**一处都没有**（`userAgent`/`appendUserAgent`/`addInteractiveScripts`/
  `evaluateOnNewDocument`/`extraHeaders` 全零命中），所以这条规则落地即绿，不需要"先豁免再收敛"的过渡名单。
  唯一需要写明的是 `browser.act` 的 DOM 兜底路径会**诚实报告 `trusted:false`**（`act-service.ts:351-361`），
  这是取证不是伪装，扫描器不得把它算作命中。

**3）日上限改成三键，抓取纳入同一个闸门（2.7-03）。**

- `gateSchema` 改为 `{ mode, dailyLimits: { search, greet, deliver } }`（各自 `.int().min(1).max(1000)`，
  默认给保守值并在 cordis.yml 里显式写一遍——照 throttle 那次的既有做法，为的是装配面板能现场改宽改窄），
  **删掉** `dailyLimit` 而不是留着当兜底（§2.6 不做兼容垫片）。`check()` 的取数从 `dailyLimit` 换成
  `dailyLimits[action]`，未知动作名仍然结构化失败而不是"当作 0"或"当作无限"。
- `jd.capture.run` 用 `gate.perform('search', {targetId: keyword, source})` 包住一次抓取 run：
  成功才落账（闸门语义一行没改），超限抛 `QUOTA_EXCEEDED`，节点侧表现为一次可回看的失败而非静默少抓。
  这条与 spec 2.3-11 的原文冲突，处置写在 §14.4 第 1 条，不允许悄悄改。
- 三个计数器**互不占用**由 `countToday(action)` 天然保证（`ledger.ts:160-165` 已按 action 过滤），
  所以本片只动配置形状与消费点，账本表结构、迁移号、日界（本地自然日 `setHours(0,0,0,0)`）一律不碰。

**4）节奏参数归位 + 一条扫描规则（2.7-04）。**

- 把 `browser.act.upload` 的读回等待从 `locator-script.ts:669` 的默认实参（`timeoutMs=1500, stepMs=50`）
  改成由 `browser.act` 的配置传入（`act-service.ts:192` 现在是不带实参调用）。
  `nodeScanCap:4000`、`extract-script.ts:82` 的 `200` 是**注入脚本内部的上限护栏**，
  属于"页面内跑的那段 JS 的自保护"，配置化它没有意义（注入脚本拿不到主进程配置），
  处置是集中到一个 `packages/browser/src/inpage-limits.ts` 常量模块 + 扫描器把它列进 allowlist，
  而不是散在两个脚本文件里各写一遍。
- `jd-capture` 的轮间停顿 `roundPauseMs` 保留（它已是配置项），但**改走 `outbound.throttle` 的随机间隔**：
  固定 300ms 的轮询节奏就是 `throttle.ts:7` 自己注释的"机器行为"。为此 `throttleSchema` 扩成
  `{ minGapMs, maxGapMs, scrollGapMs }`（新增滚动节奏一档），消费点从 greet/deliver 两处变三处，
  不新增第二个节流服务。
- 扫描规则并进同一个脚本的第二条（`check-compliance-redlines.ts` 里两条规则、两段输出）：
  `packages/{browser,outbound,platform-boss,workflow}/src/**` 生产代码里，
  出现在 `sleep(`/`setTimeout(`/`setInterval(` 实参位置的数字字面量，除显式 allowlist（如 `SETTLE_MS`、`SCROLL_*` 这类非节奏用途）外一律失败。
  这条规则的判据是"数值得从配置来"，不是"不许有数字"。

**5）审计视图是两份既有事实的并置，不是第三套存储（2.7-05）。**

- 事实源已经齐了：成功侧 `usage_ledger`（时间/动作/目标/来源，`LedgerRowView` 已在 `bridge.ts:265-277`），
  结果与失败侧 `workflow_nodes`（`status/attempts/error/evidence`，2.4 落库、2.6 已验收过读数）。
  所以 2.7-05 要做的只是**一个界面**：新增 `packages/renderer/src/AuditSection.tsx`，
  并进现有 `UsagePanel`（同页不同段，不新开视图），上半段列账本行（含新的 `search` 行），
  下半段列最近若干 run 的节点行 + 结果；两个读数都走已在白名单里的 `usage['ledger.summary']` 与
  `workflow['runner.nodes']`，**不加新表、不加新 service、不加新白名单键**。
- 「结果」这一列的诚实口径：账本行存在 = 该次动作成功（1.9 决策 1：失败不记账，写了就是假用量）；
  节点行的 `status` 给出 success/failed/待接管。两处并置时不伪造统一时间线，
  每条都注明它来自哪份事实——这样 2.7-05 的"回看"不会变成"看起来什么都有其实只有一半"。
- 抓取动作进入账本后，`byAction` 那一列第一次有三个值，`UsagePanel` 现在**没渲染 `byAction`**
  （只渲染 byDay/recent），本片顺手补上，因为它正是"三个动作各自独立"的可见证据。

**6）首次签字存进 sqlite，释放路径硬拦（2.7-06）。**

- 新增迁移 v6 表 `automation_consents(scope TEXT PRIMARY KEY, acknowledged_at INTEGER NOT NULL)`，
  scope 取值 `automation:<platform>`。放 `packages/sessions`（它已经是"平台级、跨重启的状态"这件事的唯一归属：
  分区、登录态快照、平台清单都在这），注入 `store`；服务面 `sessions.consentStatus(platform)` /
  `sessions.grantConsent(platform)`，两个都进白名单（后者只接受平台名，不接受任意 key，避免变成万能 KV 写入口）。
- 拦截点两处，缺一处都算假护栏：
  ① 界面：点「开始工作流 / 打招呼 / 投递 / 抓取」前读 `consentStatus`，未签则先弹确认（复用 G 条那个卡片形状，
  新 i18n 命名空间 `consent.*`），确认后才发原动作；
  ② **释放路径**：`outbound.greet`/`outbound.deliver` 的 commit 段与 `jd.capture.run` 在过闸门**之前**
  调用 `ensureConsent(platform)`，未签即结构化失败 `CONSENT_REQUIRED`。
  只做 ① 的话，工作流节点与 agent 工具这两条入口会静默绕过——这正是 §13.3 第 2 条踩过的那类漏。
- "出现一次"的判据是 per-platform 的 scope 已存在，不是前端记过一次弹窗；重启、reload、换面板都不该再弹（V 类要验的就是这条）。

**7）脱敏补齐：文本落盘过 `redactText`，截图加遮罩（2.7-07）。**

- 文本侧一行改动：`workflow/index.ts` 的 `writeEvidence` 在写 `page.bodyText`/`url`/`error.details` 之前过
  `redactText`（`log/redact.ts` 已是唯一实现，直接复用，不再写第二份正则——§2.1）。
- 截图侧做**遮罩而不是改内容**：`browser.page.screenshot` 前注入一段页面脚本，
  按 `redact.ts` 同一批正则找到命中的文本节点、在其 `getClientRects()` 上盖绝对定位实心块、
  截完立即移除。为什么不是"把文本换成 `***`"：那会改站点 DOM，站点自己的校验/预览可能因此改变行为，
  我们在做的事就说不清了。像素遮罩的边界也要写进 spec：它盖得住手机号/邮箱/身份证这类**页面上以文本出现的**信息，
  盖不住图片里的、PDF 预览里的——这条不许在验收时被说成"截图全脱敏"。
- 遮罩默认开启，开关放 `browser.page` 配置（`maskSensitiveInShots`，默认 true），
  关掉它只应该发生在调试现场，装配面板上那行配置就是这条默认的证据。

### 14.4 与已验收条目的冲突，逐条写明处置

1. **spec 2.3-11「抓取全程只读，一行 `entitlement.gate` 都不进」被 2.7-03 更正。**
   2.3-11 的原意是"抓取不消耗外发额度"，这条意思保留（`search` 与 `greet`/`deliver` 各数各的，
   抓 20 次不会吃掉打招呼的额度）；被更正的是"完全不进闸门"——把每日抓取量纳进同一个闸门是唯一
   合规的落点，另建一套抓取计数会同时违反 §2 与 2.6-08 已经验收过的"无第二套计数"。
   验收时 2.3-11 的旧读数不改写，spec 里补一条更正说明指向 2.7-03。
2. **知识包 `pacing` 段删除**（`platform-contract.ts:162-169` + `boss.json:244-247` +
   `platform-boss/index.test.ts:55` 那条断言）。运行期零消费者（E 条实测）= §2.4 的死代码；
   而它声明的两件事已经分别由 `entitlement.gate`（额度）与 `outbound.throttle`（节奏）在做，
   留着就是第二套同类基础设施的**声明**。2.2 当年验收的是"pacing 作为数据存在"，
   这一条随本片的更正一并回写进 spec，不假装它从来没写过。
3. **`gateSchema.dailyLimit` 消失**，1.9（spec 1.9-0x）与 2.6-02 的验收读数里凡出现 `dailyLimit` 的
   配置文件与测试都要跟着改；这是配置形状变化，不是额度语义变化，账本表与"成功才落账"一条不动。
4. **`outbound.sample` 那个"界面传任意 action 字符串"的口子要收窄**（`outbound/src/index.ts:59-64`
   把渲染层给的字符串原样送进 `gate.perform`）。改成三键枚举：日上限变成按动作取值之后，
   任意字符串意味着任意人可以从渲染层**发明新的免限额度动作名**，把 `dailyLimits` 绕成摆设。

### 14.5 明确不做（2.7 阶段）

- 不做任何验证码/风控的**识别与规避**：不接码、不破解、不重试撞开、不替换 UA、不改指纹、不分摊多账号
  （§8 第 2 条禁令在本片落成机检扫描器 2.7-02；这是它第一次有工具兜着，不再只是文档里一行字）。
- 不做站点级风控知识库的**众包/在线更新**：风控字样只能来自仓库里的知识包 JSON（2.2-08 那条纪律），
  本片不引入任何"从远端拉选择器"的通道。
- 不做 IP 代理池、不做请求签名算法还原、不做对站点私有接口的直连（这三条比 UA 伪装更越界，
  且都不属于"用户在自己电脑上用自己的账号操作"这件事）。
- 不做审计日志的导出/上报（本地回看即 2.7-05 的全部要求；任何把求职数据送出本机的通道属 P5 之后另立子计划）。
- 不做 ToS 文本的法律审校：弹窗里的文案是风险提示 + 用户自担声明，不是合同条款；
  真要正式协议文本必须来自法务（源仓库许可状态至今未确认，见项目记忆与 §12.7 同类口径）。
- 不接管 macOS/Linux 的运行期验证（AGENTS.md §9：本机 Windows，相关项一律 `[!]`）。

### 14.6 拆分与顺序（一片一次提交，一片一收口）

| 片    | 内容                                                                                                                  | 覆盖条目                       |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 2.7-a | 红线扫描脚本（两条规则）+ `pacing` 段删除 + 注入脚本常量归位 + 节奏参数配置化                                         | 2.7-02、2.7-04                 |
| 2.7-b | `dailyLimits` 三键 + 抓取入闸门 + `outbound.sample` 动作名收窄 + 单测与配置更正                                       | 2.7-03（含 §14.4 第 1/3/4 条） |
| 2.7-c | `browser.risk` 服务 + 知识包 `risk` 段 + `browser/risk-signal` 事件 + runner 订阅转暂停 + fixture 风控靶页 + 截图验收 | 2.7-01                         |
| 2.7-d | 证据文本脱敏 + 截图遮罩（spike-3 之后）+ 断言落盘内容已掩码                                                           | 2.7-07                         |
| 2.7-e | `automation_consents` 迁移 + `sessions.consent*` + 界面确认卡片 + 释放路径硬拦 + 审计视图段落                         | 2.7-06、2.7-05                 |

顺序的理由：a/b 是纯静态与配置面，失败不影响运行期；c 是唯一需要新观测通道的（先跑 spike-1/2）；
d 的截图遮罩依赖 spike-3；e 排最后是它要同时改界面与两处释放路径，牵面最广，且它的审计视图
需要 b 落地的 `search` 账本行才有东西可看。

### 14.7 2.7-a 收口记录（红线扫描 + 节奏归位这条机检面，2026-10-01）

**做了什么**：新增 `scripts/check-compliance-redlines.ts`（两条规则、并进 `pnpm lint` 末道）；
知识包 `pacing` 段连同 `platform-contract.ts` 的 schema 一起删除；`outbound.throttle` 从一档区间变两档
（`scrollMinGapMs/scrollMaxGapMs`）；`jd.capture` 的轮间停顿改为向节奏服务要（`PagePacer` 声明在
`core/events.ts`、`pagePacerOf()` 取用）；`browser.act` 新增 `uploadReadbackMs/uploadReadbackStepMs`
两个配置项，注入脚本的默认实参消失；`extract-script.ts` 的 `200` 收成 `XPATH_SCAN_CAP`。
界面那行同步更正为「轮间停顿随机（由 outbound.throttle 给）」，`CaptureStatusView` 去掉 `roundPauseMs`。

**验收读数**：2.7-02、2.7-04 转 `[x]`，证据 `docs/acceptance/2.7/2.7-02-redline-scan.txt`（绿/红/回绿三段
逐字输出 + 装配面读数）与 `2.7-04-pacing-config.png`（诊断视图截图）。真实 app 里 29 个插件节点全 active、
`notActive` 为空——`jd-capture` 新加的 `outbound.throttle` 依赖在真实装配里成立（缺依赖时 cordis 会把插件
停在 pending，而不是报错，所以这条读数是必需的，不能只靠单测）。

**与 §14.3 / §14.4 的四条偏差，逐条写明**：

1. **`throttleSchema` 新增的是区间而不是单点**（§14.3 第 4 条写的是 `{scrollGapMs}`）。
   单点就是固定节奏，与 2.5-05 已经验收过的「非等间隔」判据自相矛盾；两组区间共用同一条 `drawInclusive()`，
   没有第二套抽样实现（§2.5）。
2. **`roundPauseMs` 彻底删除，没有按 §14.4 第 2 条的"保留但改走 throttle"处理**。
   留这个名字就是留一份「抓取侧自己也有间隔」的声明（§2.5 一个入口），而界面上把它报成定值在随机化之后
   是假读数。配套：`jd-capture.test.ts` 用 `toEqual`（不是 `toMatchObject`）锁 `status()` 形状，
   再加一条 `jdCaptureSchema.safeParse({roundPauseMs:300}).success === false`，
   使"偷偷加回固定间隔"直接让测试变红。
3. **没有新建 `packages/browser/src/inpage-limits.ts`**（§14.3 第 4 条的处置）。
   实际剩余的两个页面内常量各只有一个消费者：`nodeScanCap` 已在 `DEFAULT_SCRIPT_LIMITS` 里，
   `XPATH_SCAN_CAP = 200` 就近声明在 `extract-script.ts`；`uploadReadback*` 搬进配置后注入脚本里
   不再有别的定值。为一条常量新建一个模块是搬家不是归位（§2.3 不新增平行文件）。
   扫描器的 allowlist 因此没有加条目：规则二只在 `sleep|setTimeout|setInterval` 的调用点命中，
   页面内的循环上限不在射程内（实测绿，且注入红探针时报的是 timer 那条）。
4. **`packages/testing/src/cdp.ts:321` 的 `setTimeout(…, 200)` 未动**。
   harness 不在规则二的五个包之内，且它是本机 CDP 客户端的重试节拍，不是站点侧看到的操作节奏（§7.2 的边界）。

**额外补的一条**：`platform-contract.test.ts` 新增「知识包里再写 `pacing` 会被 `strictObject` 当场拒收」
（§14.4 第 2 条只要求回写 spec）。锁住这个读数是为了让这次删除不可回滚——否则下一份抄来的知识包
把节奏声明带回来时，运行期只会表现为"读到了但没人用"，正是本片判死的那件事。

**收尾自检（AGENTS.md §7.4）读数**：`pnpm typecheck` 全绿；`pnpm lint` 全绿（含新扫描器：
「扫描 145 个源码文件：无 UA/指纹/打码/自定义分区痕迹，browser/outbound/platform-boss/workflow/agent 的节奏数值全部来自配置」）；
`pnpm format:check` 全绿；`pnpm test` exit 0（browser 187 / outbound 57 / platform-boss 116，其余包全 Done）。

**本片欠着的**：`PagePacer` 目前只露 `nextScrollGapMs()` 一格。滚动不是外发，不该占用外发的节流区间，
所以没有把 `nextGapMs()` 一起投影过去；将来 2.7-b 把抓取纳入 `entitlement.gate` 之后再评估要不要加第二格。

### 14.8 2.7-b 收口记录（按动作日额度 + 抓取入闸门，2026-10-01）

**做了什么**：`gateSchema` 的单值 `dailyLimit` 换成 `dailyLimits: { search, greet, deliver }`
（`z.strictObject` + 每键 `.int().min(1).max(1000)`，默认 40/20/10 并导出 `DEFAULT_DAILY_LIMITS`，
`dailyLimit` 直接删掉、不留兜底）；`check()` 先 `requireLimit(action)` 再分模式，未知动作名返回
`INVALID_ARGUMENT` 并在 message 里回显 `search / greet / deliver`；`jd.capture.run` 整轮包进
`gate.perform('search', …)` 并 `static inject` 上 `entitlement.gate`；`outbound.sample` 的 action 从
`z.string()` 收成 `z.enum(OUTBOUND_SAMPLE_ACTIONS)`；动作词表落在 `shared/src/bridge.ts`
（`QUOTA_ACTIONS` / `OUTBOUND_SAMPLE_ACTIONS`），闸门、`UsagePanel`、`outbound` 三处一起改读它；
`cordis.yml` 的 `entitlement` 段显式写三键、`jd-capture` 的 `dependsOn` 补 `entitlement`；
`CaptureRunResult.ledgerRowsBefore/After` 的口径与界面文案按 §14.4 第 1 条更正。

**验收读数**：2.7-03 转 `[x]`，证据 `docs/acceptance/2.7/2.7-03-per-action-quota.txt`（配置形状 / 单测 /
运行期读数 / 对 2.3-11 的更正四节）+ 五张真实窗口截图（用量面板三行、装配面板配置编辑器、抓取前计数、
抓满之后、被拒那一轮）。spec 侧同步改了 2.3-11 那一行与它的验收记录——按 §14.4 第 1 条"旧读数不改写"，
原始截图 `2.3-01-full-run.png` 保留当时的文案，改口只写在读数说明里。

**与 §14.3 第 3 条 / §14.4 第 4 条的偏差，逐条写明**：

1. **`outbound.sample` 收成两键而不是三键**（§14.4 第 4 条原文是"改成三键枚举"）。
   样例外发那个按钮做的事就是"从界面真的发一条出去"，`search` 不在它的能力里；让它接受 `search`
   等于开一个"记一条 `search` 账但什么都没搜"的入口——那是伪造用量，而 2.7-e 的审计视图正是靠这一列说话。
   配套读数：用量面板上 `search` 那一行没有外发按钮，只写「由抓取编排消费（面板不代发搜索）」（证据 3.1）。
   收窄没有削弱 §14.4 第 4 条要防的那件事：渲染层仍然发明不出新的动作名，`QUOTA_ACTIONS` 与
   `OUTBOUND_SAMPLE_ACTIONS` 的差集由 `bridge.ts` 一处声明，不是两处各写一遍（§2.5）。
2. **`perform('search', …)` 没带 `source`**（§14.3 第 3 条写的是 `{targetId, source}`）。
   `source` 列的既定语义是 2.5-09 的文案可追溯来源（`v1:1001`、`manual:1001`），抓取没有这条链——
   关键词已经在 `targetId` 上，再编一个字符串塞进 `source` 会让审计视图里同一列有两种含义，
   那比少一个字段贵得多。要补也是补进 `targetId` 的表述，不动 `source`。
3. **多导出了 `DEFAULT_DAILY_LIMITS` 与 `GateDailyLimits`**（plan 未要求）。
   不是为假想留的口子：带 `.default()` 的键在每个直接调用点都必须显式给出（AGENTS.md §9 的 cordis 实测），
   所以 `cordis.yml` 与 `entitlement` / `outbound` / `greet` / `deliver` / `jd-capture` 五个测试文件的构造点
   都要写全三键；用例要"只收紧 `search`、另两条保持出厂值"时必须从同一个数展开
   （`{ ...DEFAULT_DAILY_LIMITS, search: 1 }`），各自抄一遍数字就是第二套真相（§2.1）。
4. **词表放 `shared/src/bridge.ts`，不放 `plugin-entitlement`**（plan 未写落点）。
   读它的是 L3 的 `outbound`、L4 的 `UsagePanel` 和 L2 的闸门三处；若权威定义在 `entitlement` 包里，
   渲染层要拿到动作词表就得反向依赖领域包内部（§4.1 禁止），而 `bridge.ts` 已经是这个类型的唯一出处。

**三条计数互不占用为什么是免费的，也钉住**：`countToday(action, nowMs)` 早就按 action 过滤、
按本地自然日取界（`ledger.ts`），所以本片没碰账本表结构、迁移号、日界算法——
本片的全部账本侧改动只有配置形状与消费点（§14.3 第 3 条末段的原话，实测成立）。

**活体验收踩到的操作事实（写进纪律，防止下次重演）**：`pnpm dev` 的 esbuild watch 会把 workspace 包的
源码**内联**进 `main.cjs`，因此**任何主进程侧源码改动都会重启 Electron**，连带丢掉热配置、把视图复位到
chat、并关掉内核会话。第一次"输入没生效"的读数就是这么来的（`type` 之后 `after: ""`，
`eval` 查出目标元素 `rect` 全 0、`offsetParent: null`——诊断视图根本没挂载）。结论：
**V/C 类活体验收必须排在全部主进程侧改动之后**，且重启后要重新点「打开平台 fixture」再跑抓取。
另：闸门只在成功时落账，所以那次失败的抓取没有留下账本行——这条不是运气，正是 1.9 定的语义，
`entitlement.test.ts` 里锁着。

**收尾自检（AGENTS.md §7.4）读数**：`pnpm typecheck` 全绿；`pnpm lint` 全绿（含渲染层规范检查
「2 个语言包，16 个源文件」与合规扫描「145 个源码文件 0 命中」）；`pnpm format:check` 全绿；
`pnpm test` exit 0、18 个包全绿（entitlement 12 / outbound 58 / platform-boss 119 / browser 187，其余包全 Done）。

**本片欠着的**：① `PagePacer` 的第二格经评估**仍不加**——抓取纳入闸门后它要的仍然是滚动节奏，
把外发的 `nextGapMs()` 露给 L2 只会让页面动作去占外发区间（`core/events.ts:397` 那条注释就是判据）；
② 账本 `summary().byAction` 已有数据、界面仍未渲染（§14.3 第 5 条末尾说的"顺手补"），
它属于 2.7-e 的审计视图，留到那片一起做，不在这里空半截界面。

### 14.9 2.7-c 收口记录（风控信号观测 + 工作流停在接管点，2026-10-01）

**做了什么**：新增服务 `packages/browser/src/risk-service.ts`（provide `browser.risk`，注入
`shell`/`sessions`/`browser.page`/`platform.registry`，配置 `{riskStatusCodes:[403,429], pageSettleTimeoutMs:10000}`，
在 `main/registry.ts` 单独占一个清单 id `browser-risk`、`cordis.yml` 里带 dependsOn 与配置）；
`sessions` 新增同源观测口 `observeMainFrameResponses`（每分区一条 `onResponseStarted({types:['mainFrame']}, …)`，
只交出 `{platform,url,statusCode,statusLine,at}`，返回摘除函数）；知识包新增**可选** `risk` 段
（`platform-contract.ts` schema + `boss.json` 的 `riskPattern: 安全验证|访问验证|人机验证|访问受限|操作频繁`，
适配器回 `risk:{pattern}|null`，`PlatformRegistryService.riskPatternOf` 现问现取）；
`core/events.ts` 加 `RiskSignalEvent` 与 takeover 理由 `'risk-control'`，`bridge.ts` 把
`browser/risk-signal` 加进 `RENDERER_EVENTS` + `RendererEventSignatures`（那条保险丝盯着），
两份语言包各加一条 `workflow.takeoverBody.risk-control`；`workflow.runner` 加一条与
`session/expired` 同形的订阅 → `handleRiskSignal` → 既有的 `stop()`；`browser.page.settleLoad` 从私有方法
提到 `frame-channel.ts`（第二个使用者出现，§2.2 抽公共层），页面导航与风控正文判定同读一份等待逻辑；
`scripts/fixture-server.ts` 加 `/api/risk-mode`（`off|captcha|blocked`，非法值 400）作为两类判据的靶页开关。

**验收读数**：2.7-01 转 `[x]`，证据 `docs/acceptance/2.7/2.7-01-risk-signal-6.txt`（环境·靶页开关·装配读数·
日志逐字·界面 DOM·事件载荷·反向验证七节）+ 五张真实窗口截图（403 暂停面板 / 403 内嵌页 / 验证码暂停面板 /
验证码内嵌页 / 恢复正常后的列表页）。三条要点都取到运行期证据：`blocked` 下 run `b4a466ca…` 在 `jd-capture`
之前变 `paused`、`[data-testid="workflow-takeover"]` 上 `reason=risk-control`、三个节点全 `pending`；
`captcha` 下新 run `3f573127…` 约 3 秒停在同步，渲染层探针订阅拿到的载荷逐字只有五个键；
`plugins.stop('browser-risk')` 之后**同一张风控页照常跑完**（监听器零新信号），`plugins.start` 之后
新 run `79716061…` 又停在 `jd-capture` ——暂停的因果只经这一个事件，不是巧合。

**与 §14.3 第 1 条的偏差，逐条写明**：

1. **观测口做成异步，plan 未写**。运行期第一次挂载 `browser-risk` 就落在 `failed`：
   `session.fromPartition` 在 `app.whenReady()` 之前直接抛「Session can only be received when app is ready」，
   而内核装配发生在 ready 之前（`main/src/index.ts` 是 `void mount()`，只有 `shell` 自己在 launch 里等 ready）。
   改成 `[Service.init]` 里 `await app.whenReady()` 之后再逐分区挂，`browser.risk` 在 init 里 await 这个口。
   **这条是 211 条单测抓不到的**：`test-doubles.ts` 的假 `sessions` 不碰 Electron 的 ready 门，
   只有真实窗口 + `kernel.tree()` 才看得见——正好是 §7.1 要求 V 类必须"看到页面"的理由。
2. **归属靠闭包而不是 `webContentsId` 反查**（§14.2 H 的 spike-2 写的是"只能靠反查"）。
   实现是 `platforms.map(...)` 逐分区各挂一条、把平台名关进回调里，所以读数天生带正确归属，
   不需要视图表反查，也就不依赖"当前视图恰好属于这个平台"这件事。
3. **多了一道视图归属核对（`currentViewFor`），plan 未写**。观测 listener 装在**分区**上（视图销毁也还在），
   而正文只能从当前那块视图读；用户已把视图切去别的平台时，读回来的正文属于别人——拿它判风控就是
   拿别的站点的文案给这个平台定罪。所以只有 `kernelViewPartition === partitionFor(platform)` 才读正文，
   对不上就这一趟不读（状态码那条判据不受影响，它本来就带在响应里）。
4. **一趟导航只发一条信号**：状态码命中即发 `http-status` 并**不再读正文**。
   plan 只写了"两个信号源，一个出口"，没说两源可否同时命中；403 页几乎必然也带风控字样，
   两条都发会让 runner 停两次、界面说两遍同一件事，而 runner 的 `stop()` 本来就以第一条为准。
5. **"通知"落在既有横幅，界面侧零新组件**（这条是照 plan 执行，不是偏差，但要说清它做到了哪一步）：
   `browser/risk-signal` 进白名单是为了界面**能**订阅，本片没有任何常驻界面订阅它——
   用户看到的"通知"是 runner 写进 run 的接管点，由 `WorkflowPanel.tsx:118-137` 的横幅 +
   `workflow.takeoverBody.risk-control` 说出来。证据里的载荷是 harness 在渲染层临时挂探针订阅取到的。
   把它做成独立的 toast/通知中心是 P2 之后的事，本片不发明第二个界面形状。

**合规边界自查（§8.3 / §8.5）**：`onResponseStarted` 是只读 listener（没有 callback，不看也不改请求），
红线扫描器扫 147 个源码文件 0 命中；响应头一个字都不交出（可能带会话票据）；
事件 `detail` 只放判定依据（`HTTP 403` 或命中的那几个字样），不放正文节选——
`risk-service.test.ts` 用 `toEqual` 锁住载荷形状，多一个键即红。观测层不重试、不识别、不规避：
判据命中之后它做的事只有一次 `ctx.emit`。

**收尾自检（AGENTS.md §7.4）读数**：`pnpm typecheck` 全绿；`pnpm lint` 全绿（含渲染层规范检查
「2 个语言包，16 个源文件」、知识包检查「选择器只在知识包目录里」、合规扫描「147 个源码文件 0 命中」）；
`pnpm format:check` 全绿；`pnpm test` exit 0、18 个包全绿（browser 211 / workflow 83 / platform-boss 121 /
outbound 58，其余包全 Done）。验收结束靶页已 `DELETE` 归 `off`、app 回到无接管点状态、配置未改动。

**本片欠着的**：`browser/risk-signal` 目前只有 runner 一个消费者，界面的独立通知（通知中心/toast）
与"风控信号也进审计视图"这两件事都没做——它们分别属于 2.7-e 的界面与之后的通知子计划，
不在这里预先长出一半的界面。

### 14.10 2.7-d 收口记录（证据文本脱敏 + 截图遮罩，2026-10-01）

**这一片要解决的问题**：失败证据是给人翻文件看的，而它天生装着现场——页面正文里有手机号、邮箱、证件号，
`error.details` 里可能有执行器原样塞进来的对象。§8.5 说的是"截图与日志里的个人数据默认脱敏"，
默认的意思是不管调用方记不记得，落盘那一路自己会盖。

**① 权威只有一个，而且它在 L0**。脱敏原本住在 `packages/logger/src/redact.ts`（1.3 只为日志而写）。
这一片要把同一份判据用到 browser 与 workflow 上，而按 §4.1 的层序，L2/L3 不能反向依赖 logger——
于是把整个文件上收到 `packages/core/src/redact.ts` 并由 core 复导出，logger 改从 core 取。
这不是"顺手搬个文件"，是不搬就得在两个包里各养一份正则（§2.2 点名的复制）。

**② 判据从"键名形状"扩到"值形状"**。原来只认 `token=xxx`、`密码: xxx` 这类键名（`INLINE` 一条正则），
而页面正文里的手机号前面写的是"联系人手机："这种中文，键名规则一条都不认。新增 `PII_VALUE_PATTERNS`
三条**按值本身**判：身份证（17 位 + 校验位，前后用 `(?<![\dX])` / `(?![\dX])` 卡住，免得从一串更长的
数字里咬走中间 18 位）→ 手机（`1[3-9]\d{9}` 且后面不接数字，这样 `15000-25000` 这类薪资不会被吃）
→ 邮箱。顺序是硬的：长的先跑，否则身份证的前 11 位会先被当成手机号掩掉。掩码复用原有的 `maskByKind`，
于是 `138****8000` / `**********1234` / `z***@example.com.cn` 三种形状在日志、证据、截图三处是同一份。
**已知误吞**：`hotel: xxx` 这类英文键名会被键形状规则当秘密吃掉——取向是宁可误吞不可漏放，
已写进 `redact.ts` 头注释，不打算为它加白名单（加了就等于给漏放开一个入口）。

**③ 文本这一路有两个收口点，位置是算过的**。`workflow.runner` 的 `cap()` 改成**先脱敏、后截断**：
反过来的话截断点落在号码中间就留下一串"看起来不像完整号码"的原始数字，而 `evidenceTextChars` 默认 300，
真实正文一定超长，这条路径每次失败都会走。`writeEvidence` 整份过 `redactValue` 再落盘，
因为 `error.details` 是执行器原样给的（可能是页面 URL、选择器、抓到的字段值），除这里以外没有第二个
写入点，所以一处收口就够。

**④ 截图这一路是像素遮罩，不是文本改写**。`browser.page.screenshot()` 在 `capturePage` 前注入
`mask-script.ts`：按**单个文本节点**跑同一份 `PII_VALUE_PATTERNS`（注入脚本内联的是 core 导出的
`source` 字符串，不是抄一份正则），用 `document.createRange()` + `setStart/setEnd` 取每一段命中的
`getClientRects()`——`Text` 节点没有 `getClientRects`，而一次命中跨两行会给出两个 rect，两个都得盖；
零尺寸 rect（脚本或 `display:none` 里的文本）不盖。盖上的是 `position:absolute` + `z-index:2147483647`
的深色块，写在 body 末尾，**站点的文本一个字节都没被改写**。`finally` 里按 `data-auto-cc-mask`
属性清罩，所以页面上不残留任何东西。等绘制用双 `requestAnimationFrame`，并和 `maskPaintTimeoutMs`
的超时赛跑（视图隐藏时 rAF 可能根本不触发），超时值来自配置——2.7-04 说的就是这种数值不许钉在代码里。

**⑤ 失败即不出图**。所有帧都注入失败时 `screenshot()` 抛 `PAGE_SCRIPT_FAILED`，宁可不给图。
理由：交回一张"看起来已经脱敏"的原图是这一片能犯的最坏错误，而 runner 那边原本就会把它降级成
`screenshot: null`，所以抛错的代价只是证据里少一张图。开关 `maskSensitiveInShots`（默认 true）
关掉时只剩一次 `capture`，注入脚本一次都不跑——这条顺序是用共享 `calls` 数组在单测里锁住的
（`mask → capture → unmask`，且截图抛错也要走完清罩）。

**⑥ spike 与实测到的 DOM 事实**（spike-3，真实内嵌视图 + 本地 `/pii` 靶页）：`overlayCount 4`、
`pageTextUnchanged true`、`domRestored true`。靶页刻意放了三种对照——一组不该被盖的数字
（薪资 15000-25000、经验 3-5 年、编号 123456、成立于 2019、共 20 个项目）、一个把号码拆进三个文本节点的块、
一个 `<a href="tel:…">`。结果：对照数字在文本与像素两路都没被动（这是它存在的意义）；
`tel:` 链接的**可见文本**是文本节点，所以两路都盖住了；**拆进多节点的号码只有文本路盖住了**
（正文是拼接后整体过正则），像素路盖不住（单节点里只有半串数字，正则不认）。
**所以这一片不能写成"截图全脱敏"**：图片、PDF 预览、canvas 里画出来的个人信息，遮罩一律管不了。

**收尾自检（AGENTS.md §7.4）读数**：`pnpm typecheck` 全绿；`pnpm lint` 全绿（含合规扫描
「149 个源码文件 0 命中」，比上一片多 2 个文件正是新增的 `redact.ts` 与 `mask-script.ts`）；
`pnpm format:check` 全绿；`pnpm test` 全绿（core 20 / browser 223 / workflow 85 / platform-boss 121 /
outbound 58 / agent 19 / 其余包全 Done）。运行期验收在真实窗口（CDP 10222，全程本地仿站）跑通：
run `3343f1fb…` 的 `demo.flaky` 终态失败 → 证据正文三类掩码齐备、`grep -c` 原始值 = 0、
截图盖住 4 处、清罩后 `[data-auto-cc-mask]` 计数 0 且页面 DOM 里原始号码仍在。
证据归档 `docs/acceptance/2.7/2.7-07-masked-evidence-shot.png`、`2.7-07-unmasked-baseline.png`、
`2.7-07-live-readings.txt`。验收用的失败注入是把 fixture 计数器的归零打在重试窗口里做的
（`failTimes=2` 配 3 次尝试，正常路径第 3 次必然成功），验收结束计数器已归零、内核视图可见性已改回 false。

**本片欠着的**：日志这一路只做了"值形状"三类，`resume.kb`（P4）里简历正文级别的自由文本
（姓名、公司名、学校名）还没有判据——那需要真简历样本作靶，属于知识库那一片；界面侧目前没有任何
地方展示"这条证据已被脱敏"，用户看到的只是文件名，这一格与 2.7-e 的审计视图一起做。
