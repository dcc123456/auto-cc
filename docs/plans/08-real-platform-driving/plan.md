# P8 · 真实站点驱动（Real Platform Driving）— 实施计划

> 版本：v1.0　状态：**进行中**（2026-10-08 立项）
> 立项缘由：用户点名「我需要这个项目作为企业级可用的项目，而不是 demo；要接入真实的网站、真实的搜索、真实的登陆」。
> 现场核对后的结论是：**机器早就造好了，缺的是靶子**——内核视图、CDP 可信输入、分区与真实 cookie 判活、
> 平台登记处、额度闸门、频控、风控停机、外发编排、29 张表全是真实现并有真实 IO；
> 把它锁在仿站上的只有配置与一份知识包。本计划负责兑现 `cordis.yml:143-145` 与
> `docs/00-master-plan.md:477` 都写过的那句话：「届时改这一行 startUrl 即可，代码路径不变」。

---

## 1. 目标与边界

**目标**（四件事，缺一不算收口）：

1. 用户用自己的 BOSS 账号在 app 内扫码登录后，**真实搜索**能搜到 JD 并 ≥10 条入 `jobs` 表（兑现 M3 / 重开 `2.3-10`）；
2. **真实打招呼**发得出、页面状态行回读到「已送达」字样、且每笔在 `usage_ledger` 有账（兑现 M4 / 重开 `2.5-11`）；
3. **真实投递**简历经人确认后送达并落 `delivery_records`；
4. agent 的模型腿接上已就位的 `@auto-cc/llm`，对话主界面不再回确定性模板。

**边界（明确不做，AGENTS.md §8.3 + master plan §8 原样）**：

- **不**识别、**不**破解验证码；**不**伪造 UA / 指纹；**不**建账号池、**不**建代理池；**不**从远端下拉选择器。
  `scripts/check-compliance-redlines.ts` 规则一与 `packages/testing/src/cdp.ts` 的 `localTestUrlViolation` 一字节不改。
- 撞到风控 → `browser/risk-signal` → 转人工接管并**停住**，向用户报"需要你来"。这是功能，不是缺陷，也不是待补的洞。
- **不**新建包（标定证据属于 L2 `browser` 的"读页面"能力；只有 8.8 猎聘才需要第二个平台包）。
- **不**新增 SQLite 迁移：8.0 的证据是 `docs/acceptance/` 下的文本，选择器是 `boss.json` 里的数据。
  顺带一条更正——`docs/00-master-plan.md` §5 的 7.2 那行已把**迁移 31/32 预留给了提供商池**，
  所以 P8 若将来确实要存证据入库，取号必须从 33 起，且先 `SELECT max(version) FROM schema_migrations` 复核台账（§9 实测 5.3-a）。
- **不**在本计划里做多平台、云同步、多 Profile；第一批只有 BOSS 直聘一家（2026-10-08 用户裁定）。
- 自动化测试面**继续 loopback-only**：`*.test.ts` / `packages/testing/**` / `scripts/**` 一律只打 10233 仿站。
  真实站点的验收行一律标 `V-人工`，现场读数不到就留 `[!]`，禁止用推测写 `[x]`（§7.4）。
- 合规事实（一句话，不写免责长文）：驱动的是**用户本人的账号、本人授权的动作**，站点侧自动化风险由用户在
  `automation:boss` 签字那一刻承担；程序侧不做任何规避，只做频控、日上限、风控停机与人工确认。

## 2. 缺口清单（立项依据，全部为 2026-10-08 现读）

| #   | 事实（demo 的成因，逐条可核）                                                                                                       | 出处                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| G1  | 知识包 `startUrl=http://127.0.0.1:10233/boss`，选择器全是仿站的 `data-testid`，真实条目挂【未实测】                                 | `packages/platform-boss/src/knowledge/boss.json:4,111,116,222,235`             |
| G2  | 三个平台的 startUrl 全指向 fixture                                                                                                  | `cordis.yml:150-158`                                                           |
| G3  | 导航许可按 startUrl 的 origin 取白名单 ⇒ 真域名被**配置**拒绝（不是被代码拒绝）                                                     | `packages/browser/src/navigate-policy.ts:21-41`                                |
| G4  | **一条测试把 demo 钉死了**：断言发布包 origin 必须是 127.0.0.1:10233，且包内不许出现 `zhipin\|liepin\|\.com`                        | `packages/platform-boss/src/index.test.ts:65-70`                               |
| G5  | 登录态只认单枚 cookie 名 `autocc_session`；2026-10-08 真实站上取到的基线是 `__a/__c/__g` + 三枚统计 cookie，`auth` 直接回 `expired` | `packages/sessions/src/probe.ts:26-33` + `docs/acceptance/08-.../8.0-01-*.txt` |
| G6  | 内置计划写死仿站岗位 id 1001/1002 与公司"星桥科技"；`demo.flaky` 打的是仿站计数器 URL                                               | `packages/workflow/src/plan.ts:158-296`、`executors.ts:41-100`                 |
| G7  | agent 聊天与计划起草是本地确定性模板，`@auto-cc/llm`（19 家 provider / 钥匙串 / 热重配）已写好却没接进 loop                         | `packages/agent/src/loop/model.ts:100-146`、`session.ts:996`                   |
| G8  | 额度闸门实现是真的、出厂是放行：`mode:'unlimited'`（代码默认 `search 40 / greet 20 / deliver 10`）                                  | `cordis.yml:67`、`packages/entitlement/src/gate.ts`                            |
| G9  | `resume.customize` 节点是显式占位；`outbound` 样例服务默认打仿站端点                                                                | `deliver.ts:71-90`、`outbound/src/index.ts:32`                                 |
| G10 | `liepin` 只是枚举参数，没有包、没有登记                                                                                             | `packages/core/src/operators.ts:285,300,316`                                   |

## 3. 选型与证据（AGENTS.md §6.1 / §6.2）

### 3.1 真实 DOM 证据怎么来：在场取证，不用任何第三方录制器

- **候选**：① 用户在 app 内登录后，由本机 CDP harness **attach 到视图自己的 target** 现读 DOM；
  ② Playwright `codegen` / `selector-generator`；③ 第三方选择器库或公开资料推测；④ 在 app 内长一个"标定录制"服务。
- **否决 ②**：它是第二套浏览器宿主，AGENTS.md §2.7 硬禁，且驱动方式与生产的 `webContents.debugger` 不同轨——用它录出来的证据不能证明生产路径能通。
- **否决 ③**：`docs/plans/02-browser-automation/plan.md:1036` 明令禁止发布未实测的选择器；2026-10-08 用户亦当场否决这一条。
- **采纳 ①，并把 ④ 收为其后续形态**：取证先用现成通道（①）跑，代价最小且当场可验；
  录制能力（④）扩在 `browser.locate` 的候选口径之上，属 8.1 之后的可选项，不在本片预先建。
- **实测结论（2026-10-08，本机 macOS，spike 代码不进仓库）**：
  运行期把 `sessions.platforms` 里 `boss` 的 `startUrl` 改成 `https://www.zhipin.com/`
  （经 `plugins.saveConfig('sessions', {platforms})`，配置只写内存、重启即失，见 §9 实测 5.3-b）→
  `sessions.open('boss')` → `harness targets` 出现
  `BOSS直聘-找工作BOSS直接谈！ https://www.zhipin.com/shanghai/?seoRefer=index` 一条真实 target。
  **三条被这条 spike 直接证实的判定**：真站点装载不需要改一行代码（G2/G3 是配置事实）；
  Electron 原生 UA 未被首页拒绝（不伪造 UA 这条守得住，若后续深层页面拒绝则**报冲突而非改 UA**）；
  视图自己的 target 可按 url 子串 attach（§9 的 2.1-12 补片"shot 截不到内嵌视图"只限截图，DOM 读取不受影响）。

### 3.2 登录态判定：只看 cookie，零出网

判定继续不发站点请求（§8.3 决策 4，`probe.ts` 文件头那条纪律原样保留）。扩展成多信号：
`authCookieNames[]`（any-of）、`guestCookieNames[]`（只有游客 cookie ⇒ expired）、`authMinPresence`，
并新增 `unknown` 这一诚实态——**没标定过的平台不许谎报 active**。参数取值全部来自 8.0 的在场读数（只记 cookie **名**，值永不离开 electron 边界，§8.5）。

**已落地（8.2-01～04）三条超出原文的实测**：① `unknown` 的下游不需要新分支——所有消费方本来就写
`=== 'active'`，而它**不发** `session/expired`（`index.ts:259` 的判据是 `=== 'expired'`），于是"不敢说"
既拦得住动作、也不会长出假的重新登录卡片；② 判活枚数**按 cookie 名去重**再计数，因为同一枚票据会同时挂在
`.zhipin.com` 与 `www.zhipin.com` 上，数行数会让 `authMinPresence: 2` 被一个名字凑满；
③ 退役 `sessionCookieName` 与"cordis.yml 不改也能挂"不可调和（`z.strictObject` 拒未知键），
spec 8.2-03 已按实测收窄，不是让步。

### 3.3 真模型：接现有网关，不新建客户端

`packages/llm` 已有 19 家 provider 预设、钥匙串、热重配与连通性自检（P7 7.1 已收口，7.2 在途）。
新增的只是 `LoopModel` 端口的第二个实现，只调 `llm.chat.complete()`——`check-llm-single-entry.ts` 仍在 lint 链里守着这一条。

## 4. 裁定记录（2026-10-08，用户当场表态）

| #   | 裁定                                                                                     | 影响                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | 第一批只做 BOSS 直聘一家打通全链路；猎聘另立切片                                         | 8.8 才需要第二个平台包                                                                                                                                                                                                                                                         |
| ②   | 真实 DOM 由用户在场录制，公开资料/经验推测这条**否决**                                   | 8.0 是全计划唯一必须用户在场的切片，且排在最前                                                                                                                                                                                                                                 |
| ③   | 真模型接进 agent，作为"真实可用"的前置条件                                               | 8.6 开工前须先收口在途的 7.2（`presets.ts`/`settings.ts` 地基）                                                                                                                                                                                                                |
| ④   | 冻结在途 UI 打磨（P6 6.2-18、P7 7.2 的继续设计），pivot 到真实站点                       | 工作区在途改动单独门禁后按 pathspec 提交，不再加新格子                                                                                                                                                                                                                         |
| ⑤   | 定位最低可用分**按通道分档**：无副作用的读取/抓取通道降档，外发通道保持 70 fail-closed   | 8.1 的入口条件；证据 8.0-03 第六节与 8.0-06 第六节（css 35 分被拒、`d-c` 被 `looksGenerated` 封顶 10）                                                                                                                                                                         |
| ⑥   | 允许打开既有会话取消息区证据，接受"该会话置为已读、招聘方可见"的副作用                   | 8.0-05 由此收口；已读是不可隐藏的事实，所以先要人点头再动手                                                                                                                                                                                                                    |
| ⑦   | 允许真实外发**一次**，但必须走 `entitlement.gate` 记账且停在人工确认那一步               | 8.4/8.5 的验收凭据是页面自己的 `[送达]`/`[已读]` 回执，不看 `act.click` 返回值                                                                                                                                                                                                 |
| ⑲   | 会话目标**另立一只字段** `conversationTarget`，不占用 `jobId`（缺口三裁法一）            | 8.4-C：扩 `PlatformAdapter.chat/readReplies`、`GreetRequestView`、`GreetChannel.send` 的入参形状，给 `conversation_messages` 加一列并**取迁移 33**（§9 实测 5.3-a：改老迁移的 up 不会重跑）；幂等与额度在会话类动作上按 `conversationTarget ?? jobId` 记，岗位语义仍归 `jobId` |
| ⑳   | `browser.locate.candidateLimit` **本轮就抬**到 20（缺口二的读数上限，schema 上限即此值） | `cordis.yml:213`；原值 5 与真会话面的现读行数撞成同一个数，第 6 位往后的联系人既读不回也点不到且不报错                                                                                                                                                                         |

## 5. 里程碑与切片

| 片  | 内容                                                                                                                                                                                                                     | 需要用户在场     | 门禁                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | -------------------- |
| 8.0 | 在场取证：真 BOSS 的列表/详情/会话/上传/风控五屏 DOM 证据 + 登录前后 cookie 名差集，一次录全，产物是 `docs/acceptance/08-*/8.0-*-readings.txt`                                                                           | **要**           | V-人工               |
| 8.1 | 知识包契约扩展（`origins` / 每条候选带 `evidence` 或显式 `unverified` / 包级 `packStatus`）+ `navigate-policy` 许可来源改口径 + 发布真实包与 `boss-fixture.json` 拆分 + 倒置 G4                                          | 不要             | U+C                  |
| 8.2 | `judgeAuth` 多信号与 `unknown` 诚实态，`sessions.platforms[]` schema 扩展，`sessionCookieName` 退役                                                                                                                      | 不要             | U                    |
| 8.3 | 真实搜索 + 抓取 ≥10 条入 `jobs`（字段完整率如实播报）                                                                                                                                                                    | 要               | V-人工               |
| 8.4 | 真实打招呼：外发通道遇 `unverified` 定位即 `LOCATOR_UNVERIFIED` 失败；1 条真实送达且账本有行                                                                                                                             | 要               | V-人工               |
| 8.5 | 真实投递：`input[type=file]`（预期 `requireActionable:false`）+ 人确认 + 落 `delivery_records`                                                                                                                           | 要               | V-人工               |
| 8.6 | `loop/model-gateway.ts` 接 `llm.chat`，`agent-loop` 配置键 `model:'stub'\|'gateway'`（默认 `stub`）；聊天模板腿接同一网关；LLM 输出按不可信输入过 `knownToolIds` 与工具 `strictObject`                                   | 不要             | U+V+V-人工（连通性） |
| 8.7 | `entitlement.mode` 由 `unlimited` 收 `daily`；`demo.*` 改名 `fixture.*`；`outbound` 样例端点默认 null；`resume.customize` 变实或按 §2.4 删除                                                                             | 不要             | U+C                  |
| 8.8 | 内嵌视图几何换边（2026-10-08 用户点名"网页显示不全 / 要自适应、滚动、全屏"）：渲染层 `ResizeObserver` 量槽位 → `shell.setKernelViewBounds` → `slot-bounds.ts` 纯函数钳制；工具行（收窄/加宽/展开）摆在视图盖不住的那一行 | 要（真站点读数） | U+V+V-人工           |
| 8.9 | 猎聘第二家：验证 8.1 的抽象是否真的通用（新平台包 + 在场取证，另立切片）                                                                                                                                                 |

**顺序理由**：在场窗口是唯一稀缺资源。8.1–8.5 的代码全部依赖 8.0 的证据；8.0 录完，后面都能在用户不在场时推进。
**仿站与 `scripts/fixture-server.ts` 全部保留**——它们是 2.4-05/06 崩溃续跑与 400+ 条已验收行的自动化面，不是 demo 残留；
要退的是"生产配置只肯指向仿站"这件事，不是测试面。`workflow/src/plan.ts` 的仿站计划同样留着当自动化面，
真实工作流一律走 `workflow_plans` / 画布存的计划，**不往 `plan.ts` 硬码真站点**。

**8.8 的形状为什么是"渲染层量、主进程铺"**（2026-10-08 用户在场报"网页显示不全 / 要自适应、滚动、全屏"）：

- **候选一是主进程自己按窗口尺寸铺**（现状：固定 38%、`y:0` 起满高）。否决——它不知道界面布局：右栏多宽、有没有展开、
  头部与状态条各占多少都不在它视野里，所以永远盖掉那两行，且加一档宽度就得回主进程改代码（P6 记的 6.2-04 / 6.4-04 正是这条）。
- **候选二是把站点视图嵌进渲染层 DOM**（`<webview>` 之类）。否决——那是第二套浏览器宿主（AGENTS.md §2.7 硬禁），
  且本项目的动作层走 `webContents.debugger` 下发可信事件，换宿主等于把 2.1/2.2 整条链路重做。
- **候选三是引入 Portal/浮层组件库来摆工具行**。否决——工具行只要落在上报矩形**之外**就天然可点（原生视图造成的是命中测试遮挡，
  不是 z 序竞争），为这一条加依赖不值当（§2.6 不为假想需求做抽象）。
- 落点选择：钳制与兜底写成 `packages/shell/src/slot-bounds.ts` 的**纯函数**（不 import electron），
  于是负腿（非有限、非正、无交集）在单测里就能判，不必在活体上制造非法几何；滚动一律交还给页面自己
  （视图尺寸 = 站点视口尺寸，`ResizeObserver` 只负责让这条等式在改窗口/换档/展开时重新成立）。
- 几何偏好只落渲染层 localStorage（`auto-cc.kernel-slot-width`），**不新建迁移**：`plugins.saveConfig` 那条路重启即失，
  而为一只宽度档开表不值当（与 `MetricsPanel` 的区间档同一条裁定）。展开态不落盘是刻意的——
  开机就把主区整块盖住、而"收起"那颗在画面边上，不像宽度那样能一眼看出自己改过它。

**8.4 的形状为什么是"按公司名选中既有会话"，以及它带的三个缺口**（2026-10-08 用户选定路线 A：这一发打给**既有联系人**，
不打「立即沟通」那条新发起沟通——后者的面板形状 8.0-05 是故意没按的，取证欠着）：

- 现场读数（attach 在停着 `/web/geek/chat` 的内核视图上，只读不导航；这一页是**用户自己在界面上点进消息**留下的，
  我经产品口那两次尝试都没成——探针把 `jd.store.list` 的返回体键写成 `rows`，实际是 `jobs`，
  于是 `conversation.store.syncFrom(null,'boss')` 回 `INVALID_ARGUMENT`。这是探针缺陷，不是产品缺陷，
  但它顺带证实了一件事：**产品自己这边的每一条会话入口都按 jobId 寻址**，没有"按联系人"的那一只）：
  会话行 `ul[role="group"] > li[role="listitem"]` **hits=5**，行上**没有任何可用主键**（只有 Vue 的 `data-v-*` 空值散列，
  8.0-05 那条「`d-c` 不是会话身份」的负结论在第二批行上再次成立）；行内唯一能把人和岗位对上的是**公司名那一行文本**
  （上海肯德基有限公司 / 紫川软件 / 上海坤亿 / 巨闲网络 / 子雄科技）。未选中会话时 `div#chat-input` 挂载数 **0**、消息区是
  `.chat-no-data` 空态 ⇒ 输入框与发送键**只在选中会话之后存在**，所以"选哪一行"这一步不是可选项，是打招呼的前置。
- 缺口一：**适配器今天没有"选中会话"这一步，而缺它不止卡住外发，还让读取会串号**。
  `chat(jobId, text)` 只按 `chat.entryPath` 拼地址就打字（仿站的 URL 带 jobId，所以那边一直成立）；
  `readReplies(jobId)`（`adapter.ts:537`）同理——它 navigate 之后直接抽 `messageItem`，**抽的是"当时屏幕上选中的那一条"**，
  再把每一行盖上调用方给的 jobId 入库。真包 `boss.json` 的 `chat` 段没有 `targetParam`（真站点不给可直接拼的会话地址），
  于是 `pageUrlFor` 只能回到 `/web/geek/chat`：人在界面上选了谁，就读到谁、并记成调用方要的那个 jobId。
  本轮因为没有任何会话被选中（`chat-no-data` 空态）而没读到东西，**这条串号路径没有被触发，但它存在**。
  ⇒ 这一片要把"选中哪一行"补成 `chat` 与 `readReplies` **共同的前置**，判不出目标就 fail-loud，
  而不是照当前选中项打字或入库。
- 缺口二：**动作层只能"按 spec 点胜出的那一个"，不能点"第 N 个命中"**。已有的先例是
  `browser.act.upload` 走 `{candidateIndex, hitIndex}` 索引寻址（`LocatedView.hitIndex` 的注释就写明它是跨 world 唯一可用的寻址键），
  所以这一片的落点是**扩这个既有形状**（给 `click` 加同一个 `target` 对，§2.3 扩接口而非另立入口），
  而不是再造一条"按文本点"的平行通道。**明确否决**两种省事写法：① 运行时把公司名拼成 CSS（`:has-text` / `[textContent=…]`）
  ——那等于运行时生成选择器，违反 §8 红线与"选择器只出自包"；② 用 `extract` 的 `containerIndex` 当动作寻址键
  ——它是跨帧重编的全局序号，与 locate 的 `hitIndex`（候选×帧内序号）不同源，混用会在有 iframe 的站点上点错行。
- 缺口三：**`GreetRequestView.jobId` 在真 BOSS 的会话面上没有对应物**。这一片先把两处代码事实钉住：`jobId` 不只是
  参数名，它就是幂等键与额度目标本身（`packages/outbound/src/greet.ts:194` 的 `ledger.countFor(GREET_ACTION, jobId, runId)`
  与 `:240` 的 `gate.enforce(..., { targetId: jobId })`），适配器侧 `ledgerKey` 恒为 null（`adapter.ts:436`）。
  库里现读 **24 行**、`jobId` 全部是 `/job_detail/<hash>.html` 的 basename（带 `.html`，`bareHash=0 / other=24`），
  而联系人行不给 hash；两者只在"公司名"这一格可能相交——**但本轮现场这一格也不相交**：会话面 5 家公司
  （上海肯德基有限公司 / 紫川软件 / 上海坤亿 / 巨闲网络 / 子雄科技）与库里 23 个去重公司名**零重合**
  （库里是本轮新搜的前端岗，联系人是 9 月手动投过的那批）。⇒ 路线 A 的目标只能**从会话面取**，
  `jobId` 就不能从库里取。这一格必须在动手前定，候选是 `boss-chat:<公司名>`（一家公司多个会话会互相挡住，
  是**保守方向的错**，可接受并可后改），否决是拿 `d-c` 或 Vue 散列（现场已证不是身份，用它＝串号发给错的人，
  是不可接受的错）。同一只键还管着会话表本身（`conversation_messages` 的唯一索引是
  `(platform, job_id, dedupe_key)`，`conversation-store.ts:56`），所以这一格定下来是**三处共用**的定下来，
  不是只在打招呼这一处。这一条按 §6 的口径先提出冲突，不自行打破 `2.5-e` 的 jobId 语义继续写。
- 活体前置（用户在场才有解）：视图 `clientWidth` 现读 **455px**（收窄档），而发送键实测长在 x≈1112 ⇒
  **窗口拉到 ≥1410 并带到前台**是 8.4-01 的硬前置（AGENTS.md §9 的 2.1-12：hidden 窗口里 CDP 输入不落页，
  `act.click` 会回成功而页面根本没收到）。plan §7 第 5 条那条"注入通道能不能落到 contenteditable"
  也只能在这一轮现场验（代码侧两条分支都在：`locator-script.ts:554` 的 DOM 兜底 + CDP `Input.insertText`）。
  **落地记录（2026-10-08，8.4-A / 8.4-B）**：
  - **缺口二已拿掉**（8.4-A）：`browser.act.click` 加第二个实参 `target?: HitAddress`
    （`{candidateIndex, hitIndex, expectText?}`，与 `upload` 既有的索引寻址同一个形状，§2.3 扩接口）。
    地址不在读回的 `ranked` 里、或 `expectText` 与页面此刻那一格的文本折叠空白后不等，都以 `LOCATE_FAILED`
    停下且**一条输入事件都不下发**（拒错的代价是"这一发没发出去"，猜错的代价是"发给了另一家公司"）。
    不传 target 时行为与改动前逐字一致，`agent.tools` 那条登记没动。
  - **缺口一的知识包那一半已到货**（8.4-B）：包契约的 `chat` 段新增 `conversationRow` / `conversationRowLabel`
    两只定位名，配齐才合法、只声明一只报错、**既没有 `targetParam` 又没有选行也报错**（三种形状各有用例）；
    真包 `boss.json` 按证据 8.4-04 登记了 `chatConversationRow`（hits=5）与 `chatConversationLabel`
    （`.name-box > span:nth-child(2)`，hits=5，`effect:'read'`），仿站包靠既有的 `targetParam` 过同一条规则。
  - **缺口一还差适配器那一半**（`selectConversation` 是 `chat` 与 `readReplies` 的共同前置）：
    缺口三已随**裁定⑲** 定下（另立 `conversationTarget`，不占 `jobId`），落点见下面那条 8.4-C 的链。
    同一处还带着一条读数上限：`browser.locate.candidateLimit` 当时取 5，正好等于会话面的现读行数
    ⇒ 超过 5 家联系人时寻址够不着（解除条件见证据 8.4-04 第三节；**已由裁定⑳ 抬到 20**）。
  - **8.4-C 的落点链（裁定⑲/⑳ 之后现读的形状，动代码前照这一串改，别在别处另立形状）**：
    ① `packages/core/src/events.ts:546` 的 `GreetChannelSource.send(targetId, text)` 加第三个入参
    `conversationTarget?: string`；② `packages/browser/src/platform-contract.ts:634/648` 的
    `PlatformAdapter.chat/readReplies` 同一形状（会话面用它选行，岗位面继续用 `jobId` 拼地址）；
    ③ `packages/browser/src/platform-registry.ts:97` 的窄投影把这一位透下去（`ledgerKey` 丢弃的那条注释不动）；
    ④ `packages/platform-boss/src/adapter.ts` 新增 `selectConversation(conversationTarget)`：
    按 `chat.conversationRow` 等列表、按 `chat.conversationRowLabel` 读回 `ranked` 找文本相符的那一格，
    再用 8.4-A 的 `click(spec, {candidateIndex, hitIndex, expectText})` 点它，**文本对不上或找不到就
    `CONVERSATION_TARGET_NOT_FOUND` 停下**（不点、不读，也不许退化成"读当前选中的那条"）；
    `chat` 与 `readReplies` 都以它为前置；⑤ `packages/outbound/src/greet.ts:172` 的请求解构加
    `conversationTarget`，幂等键与额度目标（`:194` 的 `countFor` 与 `:240` 的 `enforce`）改用
    `conversationTarget ?? jobId`——**这是裁定⑲ 的唯一语义变更点**，包里有 `targetParam` 的站点走不到这一格；
    ⑥ `packages/platform-boss/src/conversation-store.ts` 加迁移 **33**（新列 `conversation_target` +
    唯一索引换成 `(platform, job_id, conversation_target, dedupe_key)`；§9 实测 5.3-a：改老迁移的 up 不会重跑，
    且本仓没有一处 `PRAGMA foreign_keys = ON`，重建索引要显式在同一条事务里做）；
    ⑦ `packages/shared/src/bridge.ts:773` 的 `GreetRequestView` 与外发工具的 `input` schema 同步补这一位。
    仿站侧**不改行为**：`boss-fixture.json` 有 `targetParam`，`conversationTarget` 一路都是 undefined。
  - **8.4-C 落地记录（2026-10-08，七条链全部到货；`[ ]` 只剩活体那一半）**：
    落点链上的形状按原文逐条改完，另外三条现场发现要记下来：
    ① **取号 33 之后 `store.version` 的水位就从 26 抬到 33**（`refreshVersion` 写的是「已应用的最大号」），
    于是`conversation.status().schemaVersion` 与 5.8-05 那条「四条计数 SQL 逐字对源码」的机检一起被推着改——
    这两处都是**故意用源码文本作判据**的（`metrics-scale.test.ts:266`），加列时必须同步它，否则红的是判据而不是产品。
    ② **33 的 `down` 必须先删带会话坐标的行**：旧索引 `(platform, job_id, dedupe_key)` 装不下它们
    （按会话落库的行岗位格都是空串、去重键同形），留着再重建旧索引会当场以 `UNIQUE constraint failed` 崩
    （本轮补片实测）。回滚本来就是「退回这支功能之前的状态」，号段 5 的 `down` 直接 `DROP TABLE` 是同一条语义。
    那条「老库只跑到 26 时把 33 升上来」的用例（内存库逐个跑 `up`）就是为这一条建的，否则它只在装机用户的库上炸。
    ③ **`up`/`down` 不必自己写事务**：`runMigrations`/`rollbackMigrations` 已经把每支迁移整段包在
    `BEGIN`/`COMMIT` 里（`packages/store/src/migrate.ts:100` 与 `:147`），落点链 ⑥ 那句"显式在同一条事务里做"
    由装配层兑现，迁移体内再写 `BEGIN` 反而会以「事务已在进行中」失败。
    同一处还加了一条比原文更硬的判据：`selectConversation` 在**标签定位有多条候选**时以 `LOCATE_SPEC_INVALID`
    停下（不点）——抽取行的 `containerIndex` 是跨候选全局重排出来的，多候选时它不等于任何一条的命中序号，
    按它点会点到别的候选身上，而这一格错的代价是"把话发给另一家公司"。仿站包没声明这一双定位，
    所以按会话坐标寻址在仿站上如实报 `KNOWLEDGE_PACK_INVALID`（`conversationTarget` 一路 undefined 的那条不变）。

## 6. 与 AGENTS.md 的冲突声明（按本文件前言：先停下来提出冲突，不自行打破规则继续写）

## 6. 与 AGENTS.md 的冲突声明（按本文件前言：先停下来提出冲突，不自行打破规则继续写）

1. **§7.2 vs 真实站点验收**：规则原文是"自动化测试不得访问真实招聘平台……真实平台只在用户在场时手动验证"，
   而 `check-compliance-redlines.ts:100-112` 自己写明"刻意不扫生产代码：这个 app 的本职工作就是驱动真实招聘站"。
   因此生产配置指向真站**不违规**；真实验证一律走 `V-人工`，harness 对真实 target **只 attach 读取、不 navigate**（不 navigate 是刻意的：`navigate` 属于测试面动作）。
2. **G4 那条禁域名测试与"发布真实包"不可调和**：该测试的**目的**是"防止未取证的选择器上真实站点"，不是永远钉住仿站。
   按"规则服从意图"改写判据为「发布包的每条定位要么带 8.0 证据、要么显式 `unverified`，且 `unverified` 不许出现在外发通道」，
   同时新增仿站包用例保住原有意图（仿站那份永远 loopback）。这一条改动需要用户认可，已在 §4 裁定 ② 里隐含（禁止猜测选择器就是它的原意）。
   **8.1 落地形态（2026-10-08 收口）**：原判据整条搬进仿站包用例（`index.test.ts` 的「仿站知识包装载」组，origin 仍必须是
   `127.0.0.1:10233` 且包内不许出现真域名），上线包侧换成新判据（shipped + `origins` 覆盖自身 + 每条候选有证据或显式未取证 +
   `evidence.ref` 必须指向 `docs/acceptance/`）。顺带一条比原计划更硬的收口：装载器缺省是 `real`，
   **打仿站变成必须写出来的那一方**（`{ pack: 'fixture' }`），于是 §7.2 从一条扫描器规则变成调用点上看得见的选择。
3. **§4.3 新增文件**：8.1 只在 `packages/browser` 内加契约字段与判定，不新建包；8.9 猎聘建包时再记边界（8.8 已被内嵌视图几何换边占号，见 §5 表末行）。
4. **§9 迁移取号**：原写"本计划不取新号"，**裁定⑲ 改口**：8.4-C 要 **33**（`conversation_messages.conversation_target`
   一列 + 唯一索引换成 `(platform, job_id, conversation_target, dedupe_key)`）。这里先登记占号，避免与并行窗口撞号
   （AGENTS.md §9 的 2026-10-08 读数：最高已用到 32，30 预留未启用）。

## 7. 后续缺件（本片没拿掉的格子，登记以免被当成已解决）

1. **视图独立窗口**：8.8 把摆位的权威换到了渲染层，但没有改变"一只窗口一块槽位"这件事。
   BOSS 首页是 1224px 起铺的定宽布局，1200 宽的窗口即使展开也只有 1015px，仍差 209px（读数见
   `docs/acceptance/08-real-platform-driving/8.8-05-real-viewport.txt`）。要把这一格彻底拿掉，
   需要一只可单独最大化/全屏的窗口宿主——那会动到"视图宿主唯一"这条 §8.3 决策 1，得先立缺件再动。
2. **拖宽（连续）而非档位**：现在只有三档 + 展开。用户如果要的是"鼠标拖着走"，那要在槽位左缘加一只把手，
   并把 `WIDTH_CLASSES` 换成一个可拖出的像素值（同一份 localStorage 键）。8.8 先交付"看得见、点得动、铺得开"。
3. **元素级滚进画面**：8.0-04 实测真站点的关键控件长在**内部滚动容器**里（`div.job-detail-container` scrollHeight 1376 /
   clientHeight 446），而 `browser.page.scroll` 滚的是 window——滚到底也到不了它，`browser.act.click` 因此在
   "元素确实存在"的情况下报 `WAIT_TIMEOUT`。8.4/8.5 的外发控件同样在面板内，这一格不补就会出现"选择器没错、就是点不到"的静默失败。
4. **定位阈值与真实站点的结构性冲突（已由裁定 ⑤ 裁决：按通道分档）**：`minScore` 默认 70 是按仿站的富 `data-testid` 环境标定的；
   真 BOSS 全页没有 testid/id，可稳定过线的只有「表单 `name`」与「`role`/`text` + 稳定 accessible name」两类（8.0-03 第六节、
   8.0-06 第六节各有实测：容器候选 35 分被拒、`d-c` 属性被 `looksGenerated` 封顶 10 再叠歧义罚分至 −15，且同值出现在 4 行上、根本不是身份）。
   抓取容器与投递控件都不在这两类里 ⇒ 不在 8.1 里对「无副作用通道 / 外发通道」分档给最低可用分，真实站点一条动作都发不出去。
   **已落地（8.1-09）**：`browser.locate` 配置加 `readMinScore`（缺省 30，`cordis.yml` 显式写 70/30 两档），
   `LocateSpec.effect` 决定用哪一档——降档只降分数下限、不降歧义判据，指纹自愈永远按严档；装载期拦住"动手那四条定位声明 `effect:'read'`"。
   状态行**故意不在**那份名单里（它只被读），见 `docs/acceptance/08-real-platform-driving/8.1-09-channel-tiers-readings.txt` 第三节。
5. **会话输入框是 `contenteditable`，不是 `<input>`**：8.0-05 实测真 BOSS 的打字口是
   `div#chat-input.chat-input[contenteditable="true"]`，而 `browser.act.type` 走的是值注入 + `input` 事件那套
   （对 `contenteditable` 而言"值"是 `innerText`/子节点，不是 `.value`），发送键的 `.disabled` 也**只是类名**、不是原生属性。
   8.4 开工前必须先验这一条注入通道到底能不能落到 contenteditable 上（`Input.insertText` 派的是键盘事件，理论可落，
   但**以页面回读为凭**），不行就得加一条"按可编辑元素写"的分支——那属于 L2 `browser.act`，不是适配器。
6. **发送键在窗口不够宽时不在视图内**：8.0-05 读数里那颗按钮的矩形右缘超出 1200 宽窗口的可见区。
   8.4 的活体前置条件是**先把槽位开到展开档**（8.8 的工具行）或把窗口拉宽到 ≥1410，否则 CDP 派发的事件落不到它。
   这一格与 §9 的 2.1-12（窗口 hidden 时输入不落页）是两类不同的遮挡，都要用户在场。
7. **薪资这一列在真站点上没有"可直接取用的那一格"**（8.0-03 第五节第 1 条 + 8.0-04 第一节，两条实测合起来才看得出形状）：
   列表页 `span.job-salary` 是**私用区字形混淆**（textContent 看着是空串，逐码点是 `e03a 4b` 这类 PUA 码位，
   计算样式 `font-family: kanzhun-mix`）；形状A 面板里 `[class*="salar"]` **0 命中**（根本没有薪资节点）；
   形状B 的 `.salary` 明文但是 **hits=37**（相似职位列表也用它，主岗位那一枚长在 `div.job-banner` 里，
   而 banner 的 innerText 是「招聘中 <岗位名> 10-12K」这种**状态行与薪资同源的一句话**）。
   ⇒ 上线包因此**没有**声明详情的薪资字段：三种候选里没有一个"证据支持的单点"，硬声明一条就是假证据（裁定 ② 的同一纪律）。
   列表那一格只能如实报缺。**做字体映射表 = 反爬对抗，按 §8.3 红线不做**（这条证据里已经写死了）。
   8.3 的处置二选一，且要在那一片里裁定：① 从 `div.job-banner` 的 innerText 里**解析**出明文薪资
   （解析归 `platform-boss/normalize.ts` 那一层，是文本处理、不是选择器猜测）；② 薪资整列报缺。
   判据都是同一条：**不许把 PUA 码位当数字入库**，也不许猜一个数。
8. **详情页到底走哪种形状，8.3 现场必须先验一格**（它决定抓取代码的形状，不是实现细节）：
   卡片链接 `a.job-name` 的 href 实测是 `/job_detail/<jobId>.html`（**不带** `securityId`），
   而 8.0-04 第一节写明 `securityId` 是 416 字符的不透明串、**只能从列表/面板链接里带出来、不可自拼、不可复用**，
   带它的那条完整地址（形状B）当初是靠点面板里的「查看更多信息」`a.more-job-btn` 落地的，
   **直接导航那条不带 securityId 的地址从来没有实测过**。
   ⇒ 两条分叉：能打开 → `detailRoot` 的第二条候选（`div.job-banner`）有效，逐条导航抓详情即可；
   打不开（站点跳回/要求带票）→ 详情只能在**形状A 面板**里读（`div.job-detail-body`，点卡片换内容而 URL 不变，
   且 8.0-04 第三节明确"面板在进列表页时就已经带着第一张卡的 active 态渲染出来"），
   那时抓取要改成「读面板 → 换卡 → 再读」的节奏，而不是现在的 `navigate(detailUrl)`。
   这一格不猜：8.3 在场跑一次就有答案，读数进 `8.3-01-real-search.txt`。
   **现场答案（2026-10-08，两枚不同公司的页面）**：不带 `securityId` 的 `/job_detail/<jobId>.html`
   **打得开、是完整一页**（`readyState=complete`、正文在 DOM 里），所以抓取维持 `navigate(detailUrl)` 的节奏是对的；
   正文节点是 `div.job-sec-text`（公司介绍那枚多带 `fold-text`，必须排他），技能标签列在形状B **不存在**
   （`ul.job-label-list` 0 命中，职责与要求混排在同一块正文里）。读数与边界见 `8.3-01-real-search.txt` 第四、七节。
   发布这条定位属于下一片（取证已到货，`boss.json` 本片一字未改）。
9. **页面侧登录信号还没取，所以 `authMinPresence` 停在保守档 2**（8.2 留下的口子，不是终态）：
   8.0-02 的原话是「≥1 命中 auth 族即视为**候选** active，且必须**同时**没有页面侧未登录文案」，
   而页面侧那一半（header 是否还显示「登录/注册」）当初就写明留给 8.3-01 现场取。它没到货之前，
   把 1 写进配置等于让"候选"直接冒充"结论"，所以 `cordis.yml` 的 boss 段取 2，并把语义未核实的 `__l`
   只作为第四名分母进族（单独在场落 `below_presence / unknown`）。
   **8.3-01 的前置动作**：现场读一次页面侧信号 ⇒ 对得上就把 `authMinPresence` 放松到 1 并留一条单测钉住
   "单枚 + 页面侧已确认"的形状；对不上（登录族在场而页面说没登录）就**保持 2**，并把该平台判成 `unknown`
   而不是替站点编一个结论。顺带一条同族缺口：`unmapped ⇒ unknown` 这条不对称意味着
   **两族都标定齐全**才可能报出 `expired`，8.9 猎聘开工时必须先录游客族，否则那个平台永远只会说"判不准"。
10. **城市码表只登记了现场双证的那一枚（机制已随 8.3-05 装好，表还半空）**：`search.params.city` 要的是**城市级**码，
    而抓取路径此前把人话原样塞进 URL——站点认不出就当没写，于是"筛了上海"返回全国结果却没人报错。
    换算口 `resolveCityParam` 与契约 `search.cities` 已落地，查不到即 `INVALID_ARGUMENT`（宁停不发）。
    `boss.json` 里只有 `"上海": "101020100"` 一枚，因为它有两条独立现场证据（首页 `input.city-code` 的值 +
    整页唯一的 `/c<码>-` 锚点桶，读数见 `8.3-05-city-code-readings.txt`）；**首页的城市切换面板给不出城市级码**
    （`.dorpdown-city` 高 0、9 位码 0 枚，省级那一级是 101020000 形状、不能当城市码用），
    而首页 `data-code` 全是 6 位**职位类别码**（`100101 Java`…），照抄会得到一张每行都自洽、每行都错的表。
    ⇒ 其余城市的码只能在**搜索页的城市筛选器**上现读，那一步的前置是 8.3-01 的签字；
    在那之前界面填「杭州」就是当场报错（这是刻意选择：报错比一条会被静默忽略的地址诚实）。
11. **签字遮罩盖不住内嵌内核视图，`consent-grant` 那颗被原生视图压住一角**（8.3 开工前置检查撞上的界面缺陷，与抓取无关）：
    `WebContentsView` 是原生子视图，绘制层级在渲染层 DOM **之上**，所以面板里那张全屏 scrim 只能盖住渲染层自己的部分。
    现场几何读数（窗口 1200 宽）：`consent-card` x341 w518（右缘 859）· `consent-grant` x651 w208 y563 h30 ·
    `kernel-view-slot` x745 w455 y88 h654 ⇒ **grant 与槽位重叠 114×30 那一条**（`grantOverlapsSlot: true`），
    而遮罩承诺的"此刻只有这一张卡片可点"在重叠区根本不成立——站点页面在那里照常接得住鼠标，Tab 也能走进被盖住的格子。
    ⇒ 这片的处置是**绕开而不是修**：签字前用 `sessions.close()` 卸载视图，签完再重开（本轮就是这么走过 8.3-01 的）。
    真修要的是"把遮罩画到原生视图之上"的能力，属于渲染层那一片（6.2 的遮罩互斥族），不在 P8 里顺手改；
    同一条负腿与 **6.2-13** 记的是同一类缺口（遮罩盖不住 ≠ 背后不可达），到那一片一起裁。
12. **抽取的截断信号在适配器那一层就被丢掉了，所以 8.3-03 的"界面报被截断"现在根本无从报起**
    （8.3-01 现场证实的缺陷，2026-10-08；读数 `8.3-01-real-search.txt` 第三节）：
    `cordis.yml:198` 的 `browser.page.extractRowLimit: 12` 在 15 张卡片在场时把单轮抽取截到 12 条，
    `page.extract()` 如实带回 `truncated: true`，而 `adapter.ts` 的 `readListing` 只把 `rows` 翻译成
    `JobSummary[]`，`truncated` 与 `containers` 的差值一起被丢——抓取结局里没有任何一格说"这一轮被截断过"，
    `stoppedBy: target-count` 还会把它打扮成"够数了"（本轮界面上"目标 12 条"与截断上限 12 恰好撞成同一个数，
    这类撞数以后写判据时要避开）。
    ⇒ 8.3-03 的后半不是"界面少一句文案"，而是**信号压根没穿过适配器边界**：修法是让 `readListing`
    带回 `{ summaries, truncated }`（或直接带回 `ExtractResultView` 的那两个计数），抓取结局加一格，
    界面按 `truncated` 显式报"被截断 · 本轮读到 N 张卡"。改的是契约形状，不是加一只定时器。
    前半（无限滚动真长出下一屏）本轮也没跑到：第一轮就够 12 条，`scroll()` 一次都没执行，
    所以那一条要单独把 `targetCount` 调到超过一屏的枚数再验。
13. **界面上的「经验」那一格填了会静默失效**（与 8.3-05 修掉的 `city=上海` 同一类，8.3-01 现场撞出来的）：
    `JobLabPanel.tsx` 有 `jd-experience` 输入框并真的把它送进 `criteria.experience`，而 `boss.json` 的
    `search.params` 只登记 `keyword` / `city` ⇒ `adapter.ts:234` 按"包里没登记参数名就不进 URL"整条丢掉。
    "不替站点编一个假参数名"这条纪律本身没错（8.0-03 实测：真 BOSS 的经验筛选是页面控件，不在地址里），
    但**用户打进一格字而结果集没筛、界面上没有任何一格说这件事**，就是 8.3-05 那一类静默错。
    ⇒ 两条出路，下一片二选一并留读数：① 把经验筛选做成**页面动作**（现场取那只控件的证据，走 `browser.act`，
    属于外发档之外的读档动作）；② 界面明说"本站点的经验维不经地址筛"或干脆**拒收非空值**
    （`INVALID_ARGUMENT`，与城市码表同一口径：宁停不发）。不许第三条出路——往 `params` 里填一个没实测过的参数名。
