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

### 3.3 真模型：接现有网关，不新建客户端

`packages/llm` 已有 19 家 provider 预设、钥匙串、热重配与连通性自检（P7 7.1 已收口，7.2 在途）。
新增的只是 `LoopModel` 端口的第二个实现，只调 `llm.chat.complete()`——`check-llm-single-entry.ts` 仍在 lint 链里守着这一条。

## 4. 裁定记录（2026-10-08，用户当场表态）

| #   | 裁定                                                               | 影响                                                            |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| ①   | 第一批只做 BOSS 直聘一家打通全链路；猎聘另立切片                   | 8.8 才需要第二个平台包                                          |
| ②   | 真实 DOM 由用户在场录制，公开资料/经验推测这条**否决**             | 8.0 是全计划唯一必须用户在场的切片，且排在最前                  |
| ③   | 真模型接进 agent，作为"真实可用"的前置条件                         | 8.6 开工前须先收口在途的 7.2（`presets.ts`/`settings.ts` 地基） |
| ④   | 冻结在途 UI 打磨（P6 6.2-18、P7 7.2 的继续设计），pivot 到真实站点 | 工作区在途改动单独门禁后按 pathspec 提交，不再加新格子          |

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

## 6. 与 AGENTS.md 的冲突声明（按本文件前言：先停下来提出冲突，不自行打破规则继续写）

1. **§7.2 vs 真实站点验收**：规则原文是"自动化测试不得访问真实招聘平台……真实平台只在用户在场时手动验证"，
   而 `check-compliance-redlines.ts:100-112` 自己写明"刻意不扫生产代码：这个 app 的本职工作就是驱动真实招聘站"。
   因此生产配置指向真站**不违规**；真实验证一律走 `V-人工`，harness 对真实 target **只 attach 读取、不 navigate**（不 navigate 是刻意的：`navigate` 属于测试面动作）。
2. **G4 那条禁域名测试与"发布真实包"不可调和**：该测试的**目的**是"防止未取证的选择器上真实站点"，不是永远钉住仿站。
   按"规则服从意图"改写判据为「发布包的每条定位要么带 8.0 证据、要么显式 `unverified`，且 `unverified` 不许出现在外发通道」，
   同时新增仿站包用例保住原有意图（仿站那份永远 loopback）。这一条改动需要用户认可，已在 §4 裁定 ② 里隐含（禁止猜测选择器就是它的原意）。
3. **§4.3 新增文件**：8.1 只在 `packages/browser` 内加契约字段与判定，不新建包；8.9 猎聘建包时再记边界（8.8 已被内嵌视图几何换边占号，见 §5 表末行）。
4. **§9 迁移取号**：本计划不取新号（31/32 已被 7.2 预留，见 §1 边界）。

## 7. 后续缺件（本片没拿掉的格子，登记以免被当成已解决）

1. **视图独立窗口**：8.8 把摆位的权威换到了渲染层，但没有改变"一只窗口一块槽位"这件事。
   BOSS 首页是 1224px 起铺的定宽布局，1200 宽的窗口即使展开也只有 1015px，仍差 209px（读数见
   `docs/acceptance/08-real-platform-driving/8.8-05-real-viewport.txt`）。要把这一格彻底拿掉，
   需要一只可单独最大化/全屏的窗口宿主——那会动到"视图宿主唯一"这条 §8.3 决策 1，得先立缺件再动。
2. **拖宽（连续）而非档位**：现在只有三档 + 展开。用户如果要的是"鼠标拖着走"，那要在槽位左缘加一只把手，
   并把 `WIDTH_CLASSES` 换成一个可拖出的像素值（同一份 localStorage 键）。8.8 先交付"看得见、点得动、铺得开"。
