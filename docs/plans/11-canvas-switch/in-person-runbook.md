# 11 片 B 案 · 一次在场采集 runbook

> 目的：把 11-03/04/05/06/07/09 与 10.3 三条、9.2-05/06 的 V 类读数排成一次在场。
> 原则：只在一只 dev 实例（CDP 10222、window 5173）上跑；不访问真实招聘平台，除非该项明确写明
> 「真实 BOSS 手验」且皇上在场逐项确认；任何一项遇验证码/风控立即暂停，不识别、不跳过。
> 脚本位置：`tmp/11b/in-person/`（未跟踪的临时探针，不进主干）。

## 0. 到场前提（皇上只需做三件事）

1. 把那只 dev 实例的窗口**放到前台、别被其他窗口遮挡**（CDP 输入在 hidden 时不落页）。
2. 第 2、7 项需要**已登录的 BOSS 会话**（登录态窗口）；其余各项不需要登录。
3. 第 1 项需要**手拖一次窗口边缘**改到指定宽度（macOS 无既有原生 resize 通道，本片不自造 test-only 接口）。

兵部侧准备：`pnpm harness targets --port 10222` 确认 5173 target 在；`node tmp/11b/in-person/state.mjs` 先取基线。

## 1. 11-05 真实窗口 resize（宽 ≥1409 / 窄 1000）

- **皇上做**：把窗口拖到宽 ≥1409（内容区 ≥1225）停下，喊一声；再拖到宽 1000 停下，喊一声。
- **兵部跑**：每档 `node tmp/11b/in-person/state.mjs`，并补一条窗口读数：
  `pnpm harness eval --url 5173 --expr "({innerWidth,innerHeight,dpr:devicePixelRatio,outerWidth,outerHeight,screenX,screenY})"`。
- **取**：window bounds（outer/ inner、屏幕坐标）、view bounds、zoomFactor、DPR、header/footer 坐标。
- **判据**：视图矩形 = 左轨右缘 → 窗口右缘、header 下沿 → footer 上沿（±1px）；无空白、无错位、不盖 chrome；
  宽档右栏 ≈796（zoom≈0.650），窄档右栏 ≈614（zoom≈0.502）。
- **禁止**：`Emulation.setDeviceMetricsOverride` 的读数不算本条证据。
- **不过时**：记 `[!]` 并写真因（哪一档、差多少 px），不改判据。

## 2. 11-04 登录态两档 zoom + 命中负对照（与 11-05 同批）

- **皇上做**：确认 BOSS 已登录、窗口在前台；兵部展开网页窗口后，皇上用真实鼠标点一下站点里一个安全控件
  （如搜索框，不触发投递），确认能点中。
- **兵部跑**：`node tmp/11b/in-person/act.mjs kernel-canvas-toggle`（展开）→ `state.mjs`；
  再按 11-05 收两档；命中负对照用 CDP 真点站点 target 的安全控件并读页面回执。
- **取**：`zoomReading`（三位小数显示）、全精度 `zoom`、`zoomSource=platform`、`activePlatform`、
  站点页 `innerWidth/scrollWidth/clientWidth/scrollHeight`。
- **判据**：窄 614/1224=0.501634、宽 796/1224=0.650327（全精度判定，显示三位）；
  `scrollWidth ≤ clientWidth`、页面可自主滚动；zoom≠1 时真实鼠标仍点中站点控件（以页面回执为准，不看 act 返回值）。
- **失败即降级**：命中负对照不过 → 按 plan §4.3 降级为「分栏态无缩放 + 宽窗」，把缺口如实写回 spec，不静默。

## 3. 11-03 把手 30% / 70% 端点

- **皇上做**：只需窗口在前台（不需要手动拖）。
- **兵部跑**：`node tmp/11b/in-person/drag.mjs 30` → `state.mjs`；`drag.mjs 70` → `state.mjs`；`drag.mjs 65` 复位。
- **取**：拖后 `panel.w / stage.w`、`bounds` 宽、`zoomReading`、`localStorage.auto-cc.kernel-canvas-right-width`。
- **判据**：两端点 bounds 与视图实宽 ±1px、bounds 与 zoom 同帧；reload 后比例仍为该值、视图复位不闪跳
  （`pnpm harness eval --url 5173 --expr "location.reload()"` 后重读）。
- **不得**：用 CSS transform 或改配置造读数。

## 4. 11-06 窄窗 1000 与 ≥1555 左栏判据 + 全屏往返

- **皇上做**：窗口拖到 1000 与 ≥1555 各停一次（可与第 1 项合并，减少反复拖）。
- **兵部跑**：每档 `state.mjs`；再 `act.mjs kernel-canvas-expand` → `state.mjs` → `act.mjs kernel-canvas-expand`（退出）。
- **取**：左栏 `scrollWidth/clientWidth`、左栏宽、右栏宽、全屏态左栏是否 0、主区矩形、往返后 bounds。
- **判据**：左栏 `scrollWidth ≤ clientWidth`；**480 仅 ≥1555 且分栏态适用**，全屏态左栏 0 不适用；
  视图隐藏时 `innerWidth ≈ 左轨 + 主区` ±1px（窄 56 / 宽 184 各一次）；全屏矩形 = 主区 ±1px、退出回分栏 ±1px。

## 5. 11-07 sidebar 回滚两路

- **兵部跑（一路）**：`node tmp/11b/in-person/mode.mjs sidebar` → `state.mjs`（应出现竖条/两键/把手、
  三档宽度可用、`kernel-slot-strip` 与 `kernel-resize-handle` 在、`kernel-canvas-stage` 不在）。
  验收后 `mode.mjs canvas` 复位。
- **二路（revert）**：在临时工作树 `git revert --no-commit c4ab178` 后跑四门禁留 EXIT，恢复现场；
  该路不改主线、不提交。
- **判据**：两路各留读数与 EXIT；回滚入口真实可达，不是死代码。

## 6. 11-09 三通道复测

- **兵部跑**：视图 target 截图（`pnpm harness shot --out tmp/11b/rev3-view.png --url 127.0.0.1:10233`，
  站点用 fixture 或当前视图 URL）、接管开关、`sessions.status()` 分区读数。
- **判据**：three 通道都活；zoom≠1 时 CDP 命中口径不坏（与第 2 项同一批）；sidebar 分支可达；退役项无回归红。

## 7. 真实 BOSS 手验：10.3 三条 + 9.2-05/06

- **前提**：皇上已登录真实 BOSS、窗口在前台；**未获皇上逐项口令不点任何外发**。
- **10.3 三条**另有前置：隔离仿站窗口 + 运行期 `llm` 指向本地 fixture 端点，两项授权仍未获准（尚书省已呈）。
  未获准则 10.3 保持 `[!]`，不拿 U 或旧样例冒充。
- **9.2-05 新会话打招呼**：真站「立即沟通」会先发默认问候 → 停在点击前，回执
  `OUTBOUND_UNTRACKED_SITE_GREETING`；须皇上逐项确认后再点。
- **9.2-06 附件投递**：真站附件菜单选择器未验 → `attachmentMenuRequired:true` 且无定位时
  `LOCATOR_UNVERIFIED`，不猜选择器；命中菜单后仍须过 gate 才发。
- **任一失败**：如实标 `[!]` 并写清停在哪一步，不以仿站读数代替真实平台。

## 8. 收口

- 每项读数落 `docs/acceptance/11-canvas-switch/`（图按 `<条目ID>-*` 命名，读数另起 `rev3-*`）。
- 未过项保持 `[!]` 与解除条件；全部满足后才宣称 11 片收口。
- 全程不碰 `cordis.yml`、不引第二套浏览器宿主、不改分区会话/CDP 10222/`data-*` 锚点。
