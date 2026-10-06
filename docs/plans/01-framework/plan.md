# 计划一 · 搭建主体框架 — 详细实施计划

> 上位文档：`docs/00-master-plan.md`
> 验收文档：`docs/specs/01-framework/spec.md`
> 范围：**只做骨架**，不含任何招聘业务逻辑。P2/P3/P4 的全部依赖都必须在 P1 内闭环。
> 骨架必须包含四类"以后改不动"的接线面：内置内核与会话分区（1.8）、外发额度闸门（1.9）、
> 对话式主界面（1.11）与工作流面板（1.10）的界面形态、零前置依赖的打包方式（1.7）。

---

## 0. 已完成的可行性验证（本计划的证据基线）

以下不是假设，是 2026-09-29 在本机实测通过的结果（脚本：`.research-repos/cordis-spike/`）：

| 验证项                                                          | 结果                                                                                                                                                                          | 对本计划的约束                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cordis v4 服务发布 / 跨插件 inject / effect 回收 / 依赖联动卸载 | 通过                                                                                                                                                                          | 采用 §4 插件写法为强制规范                                                                                                                                                                                                                                                                    |
| Cordis 运行于 Electron 主进程（内嵌 Node 24.21）                | 通过 `fiber.state=2 registry=1`                                                                                                                                               | 后端 = 主进程，无独立 Node 服务                                                                                                                                                                                                                                                               |
| Electron 主进程 ESM（`"type":"module"` + `.mjs`）               | 通过                                                                                                                                                                          | 全仓 ESM，不出 CJS 双轨                                                                                                                                                                                                                                                                       |
| `--remote-debugging-port=9222` + CDP `/json` + 读实时 DOM       | 通过（读到 `SPIKE-RENDER-OK`）；9222 仅为该次 spike 的实测值，正式端口按用户要求固定 **10222**（见 §8.1）                                                                     | P1.6 可视自测通道走 CDP，不需额外 HTTP 服务                                                                                                                                                                                                                                                   |
| `node:sqlite` 在宿主 Node 24 可 require                         | 通过                                                                                                                                                                          | 持久层走内置 sqlite，不引原生依赖                                                                                                                                                                                                                                                             |
| Electron 二进制下载                                             | GitHub/electronjs.org **不可达**，仅 `registry.npmmirror.com/-/binary/electron/` 可用；1.2 实测 Electron 44 **已删除 install 脚本**，改由根 `postinstall` 显式跑 `install.js` | 见 §7 环境前置 + `docs/acceptance/1.2/1.2-11-electron-binary.txt`；**2026-10-06 在有网宿主上复验通过**（纯净副本 `pnpm install` 自动就位 + 移开 `~/Library/Caches/electron` 的冷缓存那一路真的下到了 124 MB 的 arm64 zip），读数 `docs/acceptance/1.2/1.2-11-electron-binary-recheck-mac.txt` |
| 版本基线                                                        | cordis 4.0.0-rc.10 / electron 44.4.5 / node 24.18（宿主）/ esbuild 0.28.2                                                                                                     | 锁定这些为起点                                                                                                                                                                                                                                                                                |

## 1. 语言与技术选型（决策 + 理由）

| 项             | 选择                                                        | 理由 / 放弃的方案                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语言           | TypeScript 5.x，`strict: true`，全量 ESM                    | cordis 是 ESM-only 且类型驱动（declaration merging）；放弃 JS：service 名靠字符串，无类型就无边界                                                                                                                                              |
| 外壳           | Electron 44                                                 | §0 已验证；放弃 Tauri —— cordis 插件体系与 CDP 自动化无处安放                                                                                                                                                                                  |
| **自动化内核** | **Electron 自带 Chromium + `WebContentsView`**              | 用户只装一个 app，不能要求装 Chrome，也不能首启动下载浏览器。**放弃** Playwright（自带 chromium 需联网下载、体积翻倍）与 `puppeteer-core`+系统 Chrome（要求用户装 Chrome）。代价：无 Playwright 选择器引擎与自动等待 → 在 P2.2 自建 locator 层 |
| UI             | React 18 + Vite 6                                           | 硬性要求；Vite 对 ESM/HMR 最省事                                                                                                                                                                                                               |
| 登录态         | `session.fromPartition('persist:<platform>')`               | Chromium 原生 cookie/localStorage 持久化，随 userData 落盘；放弃自建 cookie 序列化（易漏 httpOnly/SameSite/过期语义）                                                                                                                          |
| 包管理         | pnpm workspace                                              | 能 enforce 包边界（跨包 import 必须显式声明依赖），配合 lint 实现分层规则                                                                                                                                                                      |
| 持久化         | `node:sqlite`（Electron 内嵌 Node 24 内置）                 | **master §1.4 第 3 条硬约束**：不得在用户机现场编译。放弃 `better-sqlite3`（需 electron-rebuild 对齐 ABI）                                                                                                                                     |
| 状态（渲染层） | zustand                                                     | 渲染层不做真相源，只缓存 service 事件流投影                                                                                                                                                                                                    |
| 校验           | zod（对齐 cordis 的 StandardSchemaV1 槽位）                 | cordis 插件 `Config` 接受 standard-schema，zod 可直接挂载                                                                                                                                                                                      |
| Lint           | eslint 9 flat + typescript-eslint（type-checked）+ prettier | 自定义规则禁止跨层 import 与直接 import cordis（§3）                                                                                                                                                                                           |
| 打包           | electron-builder                                            | 一份配置出 nsis / dmg / AppImage / deb；产物自包含                                                                                                                                                                                             |
| 提交钩子       | 自研 `.githooks/commit-msg`（纯 sh）                        | **不用 husky/commitlint**：本环境拦截 install 脚本，依赖 postinstall 的工具链不可靠（已实测）                                                                                                                                                  |
| 单测           | vitest（仅纯逻辑）                                          | 功能验收不用它，见 §6                                                                                                                                                                                                                          |

## 2. 项目结构（定稿）

```
auto-cc/
├─ docs/
│  ├─ 00-master-plan.md
│  ├─ research/                  # 源项目分析（抽取决策留痕）
│  ├─ plans/<NN>-<name>/plan.md  # 每个主体计划的实施计划
│  ├─ specs/<NN>-<name>/spec.md  # 逐项验收标准
│  └─ acceptance/<spec-id>/      # 验收证据：截图 + DOM 快照 + 日志
├─ package.json                  # root，private，"type":"module"
├─ pnpm-workspace.yaml           # 含 onlyBuiltDependencies: esbuild, electron
├─ tsconfig.base.json            # 唯一 TS 真相源，子包 extends
├─ tsconfig.json                 # 供 type-aware lint 覆盖全仓
├─ eslint.config.js  .prettierrc.json  .npmrc  .gitattributes  .githooks/
├─ cordis.yml                    # 插件装配清单（声明启用哪些插件与配置）
└─ packages/
   ├─ core/           @auto-cc/core           # cordis 复导出、Service 基类、错误、路径解析
   ├─ shared/         @auto-cc/shared         # 跨进程类型与契约、IPC 通道、service 白名单
   ├─ config/         @auto-cc/plugin-config  # L0 配置：分层合并 + schema 校验
   ├─ logger/         @auto-cc/plugin-logger  # L0 日志：环形缓冲 + 文件 + 事件外发 + 脱敏
   ├─ store/          @auto-cc/plugin-store   # L0 持久化：node:sqlite + migration
   ├─ kernel/         @auto-cc/plugin-kernel  # L0 装配：读 cordis.yml，挂载其余插件，错误隔离
   ├─ entitlement/    @auto-cc/plugin-entitlement # L0 额度闸门 + usage 账本 + 本地无限实现
   ├─ shell/          @auto-cc/plugin-shell   # L1 窗口/托盘/生命周期
   ├─ sessions/       @auto-cc/plugin-sessions # L1 persist partition 会话与登录态探测
   ├─ ipc/            @auto-cc/plugin-ipc     # L4 IPC 网关：typed RPC + 事件流
   ├─ plugin-manager/ @auto-cc/plugin-plugins  # L4 插件启停/热重载/状态树
   ├─ devtools/       @auto-cc/plugin-devtools # L4 可视自测驱动（CDP harness），dev-only
   ├─ main/           @auto-cc/main           # Electron 主进程入口（薄：只做生命周期）
   ├─ preload/        @auto-cc/preload        # contextBridge 白名单（唯一渲染层出口）
   ├─ renderer/       @auto-cc/renderer       # React 应用（首页 = 对话界面，工作流为第二视图）
   └─ testing/        @auto-cc/testing        # harness 客户端、断言、fixture 站点
```

**目录纪律**

- `main/` 必须是薄壳：Electron 生命周期 + 创建 Context + `ctx.plugin(Kernel)`，**不写业务**。
- 一个插件一个包。`packages/<plugin>/src/index.ts` 导出默认插件对象，内部文件放 `src/internal/`。
- `shared/` 只放类型与 schema，禁止放实现，避免变成万能依赖袋。
- P2/P3/P4 的新插件（`plugin-browser`、`plugin-jd`、`plugin-workflow`、`plugin-resume-pdf`、
  `plugin-resume-kb`…）加入 `packages/`，不改骨架。
- **`plugin-sessions` 与 `plugin-entitlement` 属于 P1**：它们分别是登录态持久化与未来计费闸门的
  唯一接入点，必须早于任何外发代码存在。

## 3. 分层与依赖规则

```
L0 kernel      config / logger / store / entitlement / kernel    无 inject
L1 shell       window / tray / sessions（内置内核会话分区）        inject: L0
L2 domain      jd-store, resume-kb, copywriting                 inject: L0 (+ L1)
L3 pipeline    workflow.runner（串联 L2 的业务主线）              inject: L1+L2
L4 surface     ipc-gateway, plugin-manager, devtools            inject: L0~L3
```

四条可机检的硬规则：

1. 只允许上层 inject 下层；同层禁止互相 inject（避免环）；跨层禁止跳级访问内部实现。
2. 任何 `packages/*` 不得 `import ... from 'cordis'`，只能从 `@auto-cc/core` 取。
3. 跨包 import 其他包的 `src/internal/**` → lint error（已在 1.1 实测生效）。
4. **任何产生外发动作的 service 调用必须先过 `entitlement.gate`**。
   P1 用「gate 缺席即报错」的骨架测试固化，P2 起对真实 send/deliver 做调用点审计。

## 4. Cordis 插件规范（由 §0 实测形态固化）

```ts
// packages/sessions/src/index.ts（示意）
import { Service, definePlugin } from '@auto-cc/core';

class SessionService extends Service {
  static provide = 'sessions';
  partition(platform: string) {
    return `persist:${platform}`;
  }
}

export default definePlugin({
  name: 'sessions',
  inject: ['config', 'logger'],
  provide: 'sessions',
  Config: SessionsConfigSchema, // zod → standard-schema
  apply(ctx, config) {
    new SessionService(ctx);
    ctx.effect(() => () => closeAllPartitions()); // 资源只走 effect
  },
});
```

- 命名：service 名 `域.能力`（`config`、`logger`、`store.db`、`sessions`、`entitlement.gate`、`jd.store`）；
  事件名落地为 `域/动作`（`log/line`、`plugin/error`、`session/expired`、`shell/view-error`）——
  1.4 定下划线改斜杠，因为事件名要和 IPC 通道、`RENDERER_EVENTS` 白名单字面量一一对应，
  而点号已经留给「服务.方法」的调用名（`shell.getStatus`），两种点号会混在一张名单里。
- 资源（浏览器会话、DB 句柄、定时器、子进程）**只能**在 `ctx.effect` 里分配。
- 插件不得抛裸错到主进程；`kernel` 统一捕获并置 fiber 为 FAILED（P1.5）。
- 已知坑：cordis 的 `FiberState` 是 ambient const enum，`verbatimModuleSyntax` 下不可复导出（TS2748），
  已在 core 用 `fiberState(state)` 映射为字符串联合类型，插件层禁止直接依赖该枚举。

## 5. 进程与通信契约

```
Renderer (React)  ──contextBridge──►  Preload  ──ipcRenderer.invoke──►  Main
   纯展示/交互        白名单方法        固定两个通道                 cordis ctx
```

- 只有两个 IPC 通道：`cordis:call`（`{ path, args }` → 结果）与 `cordis:event`（主→渲染事件流）。
  新增通道需改 spec，不允许插件私自 `ipcMain.handle`。
- `path` 必须是 `service.method`，且 service 在 `@auto-cc/shared` 的**导出白名单**里声明过；
  未声明一律拒绝（防渲染层拿到任意主进程能力）。
- preload 由 `plugin-ipc` 生成类型，渲染层调用是类型安全的（`call('jd.store.search', [...])`）。
- 安全底线：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，
  `webSecurity` 不得关闭，`will-navigate` / `setWindowOpenHandler` 默认拒绝。
- **例外**：内嵌的招聘站内核视图（`WebContentsView`）是独立宿主，不走上述 IPC 通道；
  app 只通过注入脚本与主进程 service 通信，且该视图**不加载本地 app 代码**。

## 6. 测试与验收策略（用户硬性要求：agent 能自己看页面直接测）

**双轨**，且以第一条为准：

1. **Agent 可视化自测（主）** —— `plugin-devtools` 在 dev 模式开启 CDP；
   `@auto-cc/testing` 提供 harness 客户端，支持：列 targets、导航、截图、读 DOM 快照、
   真实点击/输入、执行 JS 断言、读主进程日志与 fiber 树。
   我按 spec 场景**亲自操作 app 并基于看到的界面**判定通过/失败，证据（截图 + DOM + 日志）
   存入 `docs/acceptance/<spec-id>/`。
2. **脚本单测（辅）** —— 仅覆盖纯逻辑：schema 校验、路径解析、migration、选择器解析。
   任何功能**不得**只靠脚本绿灯就宣称完成。

测试环境限制（写进验收，不粉饰）：本机为 Windows，且 GitHub 不可达 →
macOS/Linux 的**运行期**验证无法在本机完成。这类条目一律标 `BLOCKED` 并写清缺什么，
不得降级为「配置正确即 PASS」。登录态验收用**本地 fixture 站点**，不碰真实招聘平台。

## 7. 环境前置

> 工程与代码规范（提交、注释、命名、复用、Tailwind/lucide/i18n、收尾自检）以仓库根 **`AGENTS.md`** 为唯一权威，
> 本节只列 P1 的**环境**前置项。

- [x] `.npmrc` 配 `electron_mirror` / `electron_builder_binaries_mirror` 指向 npmmirror。
- [x] `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 放行 `esbuild` 及其平台包（`electron` 一项为防御性保留，实测空转）。
- [x] 根 `package.json` 的 `postinstall` 显式调用 `packages/main/node_modules/electron/install.js`，补上 Electron 44 删掉的自动下载。
- [x] 提交钩子不依赖 postinstall（自研 sh 脚本 + `git config core.hooksPath`）。
- [x] 探测 `node:sqlite` 在 **Electron 44 主进程内**是否可用（宿主 Node 24 已确认可用，Electron 待测）→ 1.3-06。
      实测可用：Electron 44.4.5 主进程 `require('node:sqlite')` 直开 `DatabaseSync`，sqlite 3.53.4、WAL 生效，
      无原生编译（见 `docs/acceptance/1.3/1.3-06-node-sqlite-in-electron.txt`）。
- [ ] 探测 electron-builder 在本机能否产出 AppImage/deb（需 fpm）→ 决定 1.7-08 是否 BLOCKED。

## 8. 子计划顺序与产出（一次一个，逐个验收）

| #    | 子计划                 | 产出                                                                                                                     | 依赖       |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1.1  | 工程基线               | root 配置、workspace、tsconfig、eslint/prettier、`.npmrc`、提交规范、`packages/core`+`shared`                            | —          |
| 1.2  | Electron 壳            | main/preload/renderer 三通，React 页面在窗口内可见，安全策略生效                                                         | 1.1        |
| 1.3  | L0 内核插件            | `plugin-config` / `plugin-logger` / `plugin-store` / `plugin-kernel` + `cordis.yml` 装配                                 | 1.1        |
| 1.4  | IPC 网关               | `plugin-ipc` + 白名单 + 类型化 client；React 调 service 并订阅事件流                                                     | 1.2 + 1.3  |
| 1.5  | 插件运行时管理         | `plugin-plugins` 启停/热重载/状态树/错误隔离 + 调试面板页                                                                | 1.4        |
| 1.6  | 可视自测通道           | `plugin-devtools` + `@auto-cc/testing` harness；agent 完成「开页面→截图→点击→断言」闭环                                  | 1.5        |
| 1.7  | 零依赖三端打包         | electron-builder 配置、图标、安装冒烟脚本；**产物自包含、零首启动下载**                                                  | 1.6        |
| 1.8  | 内置内核会话骨架       | `plugin-sessions`：persist partition 抽象、登录态跨重启保持、失效探测事件                                                | 1.3 + 1.4  |
| 1.9  | 外发额度骨架           | `plugin-entitlement`：`gate.check()` + `usage.ledger` 落库 + 本地无限实现 + 可切断额度                                   | 1.3 + 1.4  |
| 1.10 | 工作流面板（第二视图） | renderer 工作流视图（空 runner 占位 + 步骤槽位 + 进度区），与对话共用同一 runner                                         | 1.4        |
| 1.11 | 对话式主界面骨架       | renderer 首页 = chat（消息流 + 输入区 + 工具卡片占位 + 自治档位指示 + 会话持久化）+ `agent.tools` 空注册表与调用协议定型 | 1.4 + 1.10 |

**P1 完成定义**：`docs/specs/01-framework/spec.md` 中每条标准为 PASS 或有明确理由的 BLOCKED
（不得静默跳过），且 M1 / M2 / M2b 三个里程碑由 agent 可视化验证达成。

### 8.1 子计划 1.6 的落地方案（可视化自测通道）

**目标**：agent 在不引第三方测试框架的前提下跑通「列 target → 看界面 → 点击/输入 → 断言 → 截图归档」，
并且这条通道本身逐项可验收（用户硬性要求：能自己看到页面并直接测，而不是只跑脚本）。

**分工边界**：

- **端口**：CDP 由 `scripts/dev.ts` 拉起 Electron 时注入 `--remote-debugging-port=10222`，
  主进程/preload/渲染层源码里不出现这个开关——所以「打包版不开 CDP」是结构性的，不是运行期判断。
- **harness**（`@auto-cc/testing`）：只用 Node 内置 `fetch` + `WebSocket`，不引 puppeteer/playwright。
  命令补齐为 `targets / wait / click / type / text / dom / eval / assert / shot / navigate / diff / archive`。
- **devtools**（新增 `@auto-cc/plugin-devtools`，L1）：主进程侧对照组读数。`devtools.status()` 回
  `{ isPackaged, isCdpEnabled, cdpPort, targetCount, targets[] }`，targets 取自 `webContents.getAllWebContents()`。
  它存在的意义是与 CDP `/json/list` **交叉核对**：两边数量与 URL 一致，才说明「agent 看到的」等于
  「主进程真实有的」（1.6-06）。只读，不做任何导航或注入。

**关键决策（含 1.5 遗留的收口）**：

1. **像素 diff 放 Node 侧**：Chromium `Page.captureScreenshot` 的输出固定是 8bit RGBA、非隔行 PNG，
   用 `node:zlib.inflateSync` + 五种 filter 反变换即可解出像素，不需要解码依赖（引第三方包会污染
   1.7 的零依赖产物审计）。差异以「不同像素数 / 占比 / 包围盒」三项报告，包围盒能指出差异区域。
2. **内核视图是独立 target，驱动它不需要新的 IPC 面**：harness 直接对那个 target 发 `Page.navigate`
   （1.6-09）。被测页面是仓库内 `fixtures/` 静态页，以 `file://` 加载——**不访问真实招聘平台**
   （`AGENTS.md` §7.2），P2 复用同一批页面做选择器与登录态实验。
3. **面板加机读锚点**（1.5 遗留第 3 条）：插件行 `data-row-id="<插件 id>"`、按钮
   `data-action="config|stop|start|cycle"`（配置编辑器再补 `save|cancel` 与 `data-editor="config"`），
   脚本不再靠可见文案定位；文案继续走 i18n，两者解耦。`data-row-id` 只出现在插件行上，
   网关与 CDP 读数用 `data-stat` 锚点，这样 `dom --selector '[data-row-id]'` 恰好等于插件 id 集合。
4. **网关指标进界面**（1.5 遗留第 2 条）：`ipc.stats`（在途 / 已完成 / 拒绝）登记进白名单并在面板顶部展示，
   harness 的「调用成功率」以它为数据源。`devtools.status()` 的 target 里带 `isFocused`，
   点击之后焦点是否真落到该目标上就有主进程侧的证据（`isVisible()` 在 Electron 44 的 `WebContents`
   类型上不存在，所以取焦点而不是取可见性）。
5. **dev 重启竞态**（1.5 固化事实第 8 条）：`scripts/dev.ts` 的重启拆成 `scheduleRestart()`（防抖）+
   `runRestart()`（等旧进程真正 `exit` 再拉起，带兜底超时），退出等待期间又来一轮构建则排队补一次，
   否则新旧进程同时 bind 10222，`pnpm dev` 整个会话被带走。
6. **证据归档**（1.6-11）：`shot --out` 只写临时目录；`archive --id <spec-id> --in <files…>` 才搬进
   `docs/acceptance/1.6/` 并把文件名规范成 `<spec-id>-<slug>.png`。这与 `AGENTS.md` §7.5 的机检钩子同向：
   过程图不入库，入库的必须是命名合规的验收证据。

**验收期追加的决策**（1.6 逐项跑下来才暴露，原方案里没有）：

7. **`eval`/`assert` 支持 `--expr-file`**：Windows 上 pnpm 经 `.cmd` 转发实参会在换行处截断，
   多行断言脚本根本传不进去。成段 JS 从文件读，是这条通道在 Windows 上可用的前提。
8. **截图前 `Page.bringToFront` + dev 关掉遮挡计算**：Chrome 判定窗口被覆盖后停止产帧，
   `Page.captureScreenshot` 会无限等。「agent 自己看页面」不能要求人把窗口腾到前台。
9. **面板定时重读（`READ_INTERVAL_MS = 2000`）**：1.6-12 要的是「读数随调用变化」，只读一次就冻结。
   代价是 `completed` 被自家轮询刷高，所以精确断言只落在 `denied` 上（详见 spec §1.6 事实第 8 条）。
10. **白名单拒绝计数收敛到 `Gateway.deny()`**：入站检查是唯一计数点，catch 分支不再按错误码补数，
    否则 `ipc.probeReject` 一次越权会让面板 +2。
11. **`tmp/` 与 `docs/acceptance/` 退出 lint / prettier 管辖**：前者是过程脚本（不入库），
    后者是 harness 输出的字节副本，重排等于篡改证据。

**验收结论**：1.6-01 … 1.6-14 全部通过，逐项证据在 `docs/acceptance/1.6/`；1.6-08 的安装包复验、
以及打包态截图是否同样需要遮挡开关，移交 1.7。

### 8.2 子计划 1.7 的落地方案（零依赖三端打包 + CSP）

**目标**：一条 `pnpm dist:<os>` 出可安装产物，用户只装这一个 app 就能跑通骨架 —— 不装 Node、不装 Chrome、
首启动不下载任何东西；同时把 1.2 起刻意推迟的 CSP 在**打包态**补上。

**落地形态**：

- `scripts/build.ts`：esbuild 产 `main.cjs` / `preload.cjs`（与 dev 同一套 bundle 选项，去掉 watch 与 sourcemap）
  - `vite build` 产渲染层，然后组装 staging 目录 `build/app/`：`package.json`(`main: main.cjs`) +
    两份 cjs + `renderer/`。
- `electron-builder.yml`（仓库根）：`directories.app = build/app`、`directories.output = dist`，
  win = nsis、mac = dmg+zip（arm64/x64）、linux = AppImage + deb；`extraResources` 把 `cordis.yml`
  与 `resources/icon.png` 落到 `resources/` 根。

**关键决策**：

1. **产物从 staging 目录构建，不直接吃 workspace**：esbuild 的 `external` 只留 `electron`，cordis 与全部
   `@auto-cc/*` 已内联进 `main.cjs`，所以 `build/app/` 里天然没有 `node_modules`。这比「让 electron-builder
   去遍历 pnpm 符号链接再过滤」可靠得多 —— 1.7-12 的零依赖是**结构事实**，不是事后清理。
2. **打包态资源路径只在两处收口**：主进程清单根 = `process.resourcesPath`（`manifestRoot()` 已实现）；
   壳层的渲染层入口与图标改判 `app.isPackaged`，分别是 asar 内的 `__dirname/renderer/index.html` 与
   `process.resourcesPath/icon.png`。dev 分支保持原样，避免打包逻辑污染开发态。
3. **CSP 只写进构建产物**：dev 里 vite 注入内联 preamble 并开 HMR，此时加 CSP 只会逼出一份专为 dev 放宽的规则
   （spec §1.2 事实第 5 条）。所以 CSP 由 `scripts/build.ts` 在 vite 产出之后改写 `renderer/index.html`
   插入 `<meta http-equiv="Content-Security-Policy">`；内容按「先最严、违规再定位」的顺序取，
   `script-src 'self'`、不含 `unsafe-eval`，`connect-src 'self'`（骨架阶段渲染层不发网络请求）。
   打包版必须截图证明界面照常渲染 —— CSP 让 app 白屏也算不合格。
4. **不引入签名链**：本机无证书，骨架阶段也不该把 Apple 公证 / EV 证书塞进来。nsis 走未签名产物，
   exe 的图标与版本元数据由 electron-builder 的 resedit 路径写入（不下载 winCodeSign）；
   签名与公证归 P5 发布计划。
5. **安装包冒烟仍用 harness，但 CDP 开关由操作方在命令行外部追加**：1.6-08 保证的是「app 自己不注入开关」，
   不是「这台机器上的 Chromium 不能被别人加开关」。验收时给安装后的 exe 传 `--remote-debugging-port=10222`，
   此时 `devtools.status().isCdpEnabled` 仍为 false —— 两个事实同时成立，正是那条结构性保证最直接的证据。
6. **零首启动下载用 netlog 判，而不是「看起来没下载」**：安装后的 app 带 `--log-net-log=<file>` 启动，
   解析 JSON 断言不存在对外的 http(s) 请求事件。这条同时也是 1.6 移交的打包态 CDP 复验入口。
7. **干净环境用「剥离 PATH」启动做代理证明**：本机是唯一可用的 Windows，拿不到未装 Node 的干净机器。
   改以只保留系统目录的 `PATH` 启动安装包并截图出界面，证明运行时不需要外部 node / 系统 Chrome；
   mac 与 linux 的真实干净机验收按 §7 规则标 BLOCKED 并写清缺什么，不降级为「配置正确即 PASS」。
8. **镜像目录名是错的，已修**：`.npmrc` 里 `electron_builder_binaries_mirror` 原指向
   `registry.npmmirror.com/-/binary/electron-builder/`（实测 404），npmmirror 的实际目录是
   `electron-builder-binaries/`。同时确认本机 **GitHub HTTPS 仍不可达**（`000`），但 **SSH 推送可用** ——
   这个区分要记下，否则下次会把「能 push」误读成「能下载 release 资产」。
9. **两个镜像是两个开关，不能只配一个**（1.7 实测）：`electron_builder_binaries_mirror` 只管 builder
   自己的工具链（nsis / icons / appimage / fpm），**electron 发行包**走 `electronDownload.mirror`。
   `--linux` 首次构建实测 `ETIMEDOUT 20.205.243.166:443`（GitHub release 资产），在
   `electron-builder.yml` 里补 `electronDownload.mirror = registry.npmmirror.com/-/binary/electron/`
   （校验和从同目录 `SHASUMS256.txt` 取）之后 `linux-unpacked` 真实产出。
   顺带两个坑：`electronVersion` 必须显式声明（staging 里没有 electron，自动发现不到，
   `scripts/build.ts` 的 `assertElectronVersion()` 因此宁可构建失败也不静默换内核）；
   `electronDist` 是**顶层**选项、不能按平台分段，本想用它复用本地已装好的 electron 二进制，
   结果会同时污染 win/mac/linux 三条链路，遂放弃、改用镜像下载。
10. **electron-builder 的中断缓存会伪装成各种无关错误**（1.7 实测三次）：上一次构建被取消后
    `%LOCALAPPDATA%\electron-builder\Cache\` 里留下的 0 字节 / 半截目录会被直接复用，
    表现分别是 `icon-tool.js` 抛空 `RequestError`、`EINVAL`、以及 exit 134。
    排查方向不是配置也不是网络，而是 `rm -rf` 掉 `Cache/icons@1.1.0` 与 `Cache/appimage-12.0.1`
    （以及 `dist/*.tmp`），同一份配置随即 exit 0。

**验收结论**：1.7-01 … 1.7-08、1.7-11 … 1.7-14 通过在 Windows 安装后的真实 exe 上，逐项证据在
`docs/acceptance/1.7/`；1.7-09（需 macOS 主机）、1.7-10（需 Linux 侧的 fpm / mksquashfs + appimagetool）
按 §7 规则标 `[!]` 并写清缺哪个二进制，配置本身已产出 `linux-unpacked`，到对应宿主重跑即可补齐。
安装包侧复验：「app 自己不注入 CDP 开关」在打包版上成立（操作方外部追加后 `isCdpEnabled` 仍为 false）；
打包态截图沿用同一个遮挡开关即可，本轮**没有**做「不加遮挡开关」的反向对照，所以只记录了「加了就正常」。

### 8.3 子计划 1.8 的落地方案（内置内核会话与登录态持久化）

**目标**：把 1.2 起就挂在壳层里的空壳内核视图变成**真正承载站点的会话容器** —— 每个平台一份
`persist:<platform>` 分区、分区之间与 app 界面互相读不到 cookie、登录态跨重启保持、失效可探测并
在界面上说清楚，并且用户能亲眼看到自动化在做什么、随时用键盘鼠标接管。

**选型与证据**（AGENTS §6.1 / §6.2：API 形态一律以本机安装的 `.d.ts` 为准，不看博客转述）：

| 候选                                                                          | 结论     | 证据                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron 内置 `WebContentsView` + `webPreferences.partition = 'persist:<id>'` | **采用** | `packages/main/node_modules/electron/electron.d.ts:24607` `WebContentsViewConstructorOptions.webPreferences`；`:19573` `partition?: string`（注释明确：`persist:` 前缀即持久、同分区共享会话）；`:12523` `Session.fromPartition` |
| `BrowserView`                                                                 | 否决     | Electron 44 已弃用，官方指引迁到 `WebContentsView`；本仓库 1.2 起用的就是后者，换回去是倒退                                                                                                                                      |
| 给内核视图注入 `preload` 跑自动化脚本                                         | 否决     | 内核视图加载的是外部站点，注入即等于把 app 的能力交给别人的页面；自动化一律走 CDP（1.6 已建通道），主进程只提供 session                                                                                                          |
| 引入 Playwright / Puppeteer 自带内核                                          | 否决     | 直接违反「用户只装一个 app」（1.7-12 刚证明产物里没有第二内核），而 1.8 要的就是 Electron 自己的分区                                                                                                                             |
| 自己维护 cookie 存储（`tough-cookie` 一类）                                   | 否决     | 绕开 Chromium 持久化就丢掉了 localStorage / IndexedDB / service worker，真实站点根本登不进；且构成第二套状态存储（§2.7）                                                                                                         |

配套 API 同样实测过：`Session.clearStorageData({storages:['cookies']})`（`:13173` + `:20996`
`ClearStorageDataOptions`，`origin` 可按 `scheme://host:port` 收窄）、`Session.getStoragePath()`
（`:13323`，in-memory 会话返回 `null` —— 正好是「分区真的落盘了」的判据）、`Session.isPersistent()`
（`:13334`）、`Session.cookies`（`:13617`）、`WebContents.on('did-fail-load')`（`:16733`）。
`node:sqlite` / `store` 不参与登录态：cookie 归 Chromium 自己的磁盘存储。

**落地形态**：

- 新增 L2 域包 `packages/sessions`（`@auto-cc/plugin-sessions`，id `sessions`，spec.md:43 已预留）：
  只有它碰 `session`，只有它决定分区名与登录判定；`cordis.yml` 配平台清单
  （`id` / `startUrl` / `sessionCookieName`），P1 只配本地 fixture 平台。
- `packages/shell`：内核视图的**创建权仍在 shell**（它是唯一的窗口/视图宿主），新增
  `mountKernelSite(partition, url)` —— 按给定分区重建视图、把 `did-fail-load` 记进自己的状态；
  主窗口 `webPreferences` 补 `partition: 'persist:app'`。
- 新增本地 fixture HTTP 服务 `pnpm fixture`（`scripts/fixture-server.ts`，只绑 `127.0.0.1:10233`）：
  登录页（点一下写 `Max-Age` 持久 cookie）、`/api/state`（按 cookie 头判登录态）、登出路由。
  1.8-09「停掉 fixture 服务」需要先有一个可停的服务 —— 现在只有 `file://` 的 lab 页。
- 渲染层新增「会话」面板：读 `sessions.status()`、打开站点、探测、登出，并第一次订阅**领域事件**
  （`window.autoCC.on('session/expired', ...)`，失效时把「需重新登录」显示出来）。
  1.4 起 `log/line` 就已在装配面板里推送过，所以「用上 `on`」不是第一次，「订阅业务事件」才是。

**关键决策**：

1. **一个分区 = 一个视图生命周期**：`WebContentsView` 的 partition 构造后不可改，所以「切换平台」
   就是销毁旧视图、按新分区重建。不做「一个视图挂多份 session」的假象。
2. **app 界面自己也要有分区**（`persist:app`）：否则 1.8-02 的隔离只是「恰好没共享」；给了显式
   分区之后，「界面读不到站点 cookie」是结构事实，能被 `document.cookie` 直接证明。
3. **登录态落盘先不额外 flush**：`persist:` 分区由 Chromium 在正常退出时自己写盘，本计划按
   「干净退出」验收 1.8-03；只有实测复现「重启掉登录」才引入 `flushStorageData()`（§2.6）。
   **实测结论（1.8-03）**：连 `taskkill //IM electron.exe //F` 强杀都不掉登录态，
   cookie 在登出前就已落到 `Partitions/<平台>/Network/Cookies`，所以没有引入 flush。
4. **失效探测只读 cookie，不请求站点**：`session.cookies.get({name})` + `expirationDate` 判定，
   不发探测请求 —— 真实平台上一发请求就是风控流量，而骨架阶段要的是「不静默失败」。
   平台特异的选择器判定留给 P2 的站点知识包。
5. **`session/expired` 走既有事件白名单**，不新增通道：`RENDERER_EVENTS` 与 `RendererEventSignatures`
   漏一处即编译期报错（`bridge.ts:226` 的保险丝）；事件名沿用仓库的 `scope/name` 形式，
   spec 条目写的 `session.auth.expired` 落到实现是 `session/expired`（改名在 spec 里注明）。
6. **1.8-07 依赖 1.10 的工作流执行器**：P1 还没有 `workflow.runner`，「停在可恢复点」没有可停的对象。
   本轮只交付「事件 + 界面提示」这一半，另一项如实标 BLOCKED，不用假执行器凑数。
7. **脱敏只测「值不出现在日志里」**：sessions 侧日志刻意只打 cookie 名与数量；同时补
   `Set-Cookie:` 自由文本的缺口（`redact.ts` 的 `INLINE` 要求 `key=value` 形式，头块没分隔符就漏）。
8. **加载失败态由事件推，不靠快照轮询**（1.8-09 收口时补的决策）：`sessions.open` 在 `loadURL` 之后
   立刻返回，而 `did-fail-load` 晚到几十毫秒，所以动作返回时读到的快照里错误位是空的。原计划让面板
   「动作后重读一次」就够，实测不够——错误态永远慢一拍，必须再点一次刷新。改成 `shell` 在
   `did-fail-load` 里同时 `ctx.emit('shell/view-error', ...)`，走 1.4 的事件白名单出进程。
   同一轮实测还否掉了「用加载成功事件复位错误位」：Chromium 在主文档加载失败时**照样**触发
   `dom-ready` 与 `did-finish-load`，且那一刻 `getURL()` 还不是 `chrome-error://`，任何判据都会把
   刚记下的错误抹掉；所以错误位的生命周期就是「本次挂载」，`createKernelView` 开头清零。

### 8.4 子计划 1.9 的落地方案（外发额度闸门）

**目标**：把「外发必须先过闸门、过了闸门必须落账」做成 P1 的**结构事实**，而不是 P2 各自实现时的口头约定。
当前产品阶段不收费、不登录，所以默认实现就是「无限」；将来接 SaaS（P5）替换的是闸门的**实现**，
不是它的调用点——这是 `docs/00-master-plan.md` 决策 10「额度以 service 边界预埋，不以 UI 或 if 分支预埋」的落地。

**选型与证据**（§6.1；一手来源与实测为准）：

| 问题                                   | 结论                                                        | 证据 / 否决理由                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三个源仓库里有现成的额度闸门吗         | **自建**                                                    | `docs/research/source-repos-analysis.md:177`：「额度计量与付费闸门 → 自建，`entitlement.gate` + `usage.ledger`」。三个仓库都没有跨进程的服务边界，抄过来就是抄一套 if。 |
| 额度状态存哪                           | `node:sqlite`，经 `store` 服务                              | 1.3 已实测主进程内可用（`docs/acceptance/1.3/1.3-06-node-sqlite-in-electron.txt`）。内存 Map 会让「重启 app」等于免费刷额度，而「今天用了几个」必须是跨重启真相。       |
| 表结构谁建                             | 业务插件把迁移 push 进 `store.migrations` 再 `upgrade()`    | `packages/store/src/index.ts:37` 的注释就是为此留的（P1 阶段为空，1.9 由业务插件填入）。连接池仍只有一处，符合 §2.7「禁止第二个 SQLite 连接」。                         |
| 服务名要不要带点（`entitlement.gate`） | **带点**                                                    | `packages/core/src/index.ts:46` 的约定正是 `域.能力`；`packages/ipc/src/resolve.ts` 从**最长前缀**开始试，点号名在网关侧解析正确。代价见决策 4。                        |
| 一个包还是两个包                       | 两个：`entitlement`（闸门+账本）与 `outbound`（闸门消费者） | 1.9-06 要 grep「上层业务代码不含付费分支」。如果调用方就住在闸门包里，这条断言是空的——被检查的代码与被检查的机制必须是两拨（§4.3 记录的新建包理由）。                   |
| 外发打到哪                             | 本地 fixture 的新路由 `POST /api/outbound`                  | AGENTS.md §7.2：自动化测试不得访问真实招聘平台。fixture 只绑 `127.0.0.1`，收到几条就在响应里回几条，「消息真的出去了」由对端计数证明，不靠 app 自述。                   |
| 「联网校验」怎么做                     | **P1 不做**：闸门是纯本地实现                               | 1.9-09 要的是「断网不阻塞」。没有网络调用就是最强的不阻塞保证；等 P5 真接远端时再加，且失败必须降级到本地（`docs/00-master-plan.md` §1.5）。                            |

**落地形态**：

- 新增 `packages/entitlement`（`@auto-cc/plugin-entitlement`，L2 领域层），一个包两个 service：
  - `usage.ledger`（清单 id `usage`）：`inject: ['store']`；挂载时把 `usage_ledger` 迁移 push 进
    `store.migrations` 并 `upgrade()`；对外 `record()` 与 `summary()`（按天、按动作分组 + 总数）。
  - `entitlement.gate`（清单 id `entitlement`）：`inject: ['usage.ledger']`；配置
    `{ mode: 'unlimited' | 'daily', dailyLimit }`；`check(action, ctx)` 返回
    `{allowed, remaining, reason}`，`perform(action, ctx, task)` 是**唯一放行口**（先 check，不过就抛
    `QUOTA_EXCEEDED`，过后落账）。
- 新增 `packages/outbound`（`@auto-cc/plugin-outbound`，L3 流水线层的最薄一样东西）：service
  `outbound.sample`，`inject: ['entitlement.gate']`，`send({action, targetId, message})` 只经
  `gate.perform(...)` 里的那段 task 发 `fetch` 到 fixture。**没有第二个入口**，这是 1.9-05 能被演示的前提。
- `cordis.yml` 加 `usage` / `entitlement` / `outbound` 三条（排在 `store` 之后、`sessions` 之前），
  `packages/main/src/registry.ts` 与 `package.json` 同步登记（清单与注册表两处都要改，见 registry 头注）。
- `packages/shared/src/bridge.ts`：新增 `entitlement.gate.check`、`usage.ledger.summary`、
  `outbound.sample.send` 三条白名单 + 三个签名 + 三个视图类型（`GateDecisionView` / `UsageSummaryView` /
  `SendReceiptView`）；编译期保险丝 `BridgeSignaturesCovered` 会强制签名与名单同步。
- `scripts/fixture-server.ts`：新增 `POST /api/outbound`（记录进内存 outbox，回 `{ok, received}`）与
  `GET /api/outbox`（把收到的内容原样给出，作为「对端确实收到」的证据）。
- 渲染层新增「用量」面板：显示额度模式与剩余、用量分组、外发样例按钮与被拒原因。设 N=1 走
  1.5 已有的插件配置表单（`plugins.saveConfig('entitlement', …)`），不再造第二个配置编辑器（§2.2）。

**关键决策**：

1. **落账只在 task 成功之后**。被拒的动作不记账（它没消耗平台侧任何东西）；task 抛错也不记账
   （发送没发生）。P5 若要把失败也计入防滥用，改的是这一处，不是各调用点。
2. **`perform()` 是唯一的放行口**，`check()` 只用于展示剩余额度。业务若直接调 `check()` 再自己发，
   就是 1.9-05 要拦的那类绕过——所以 `outbound.sample` 里没有任何 `check()` 调用，测试也不需要。
3. **日额度按本地日零点算**，天数由 JS 算出后作为 `ts >=` 边界传参，不用 `date('now')`：SQLite 的
   日期函数按 UTC，用它做「今天」会让中国用户在早 8 点前读到「昨天」。
4. **点号服务名换来的是调用点的别扭**：`preload` 按**第一个点**切命名空间（`packages/preload/src/index.ts`），
   所以界面侧是 `bridge.entitlement['gate.check']()` / `bridge.outbound['sample.send']()`。这是网关
   最长前缀解析的对价，不为此改 preload 的切分规则——改了就会和 `service.method` 的主进程语义分叉。
5. **迁移 push 必须幂等**：`store.migrations` 是共享数组，而 `plugins.start('entitlement')` 会重新挂载
   ledger；重复 push 同一个 `version` 会让 `runMigrations` 直接抛「迁移版本重复」（`migrate.ts:38`）。
   所以 push 前按 version 查重，并把「cycle 重启三次仍能落账」写成测试（1.9-05 的姊妹项）。
6. **迁移号段在此登记**：`usage_ledger` 用 `version: 1`。P2/P3/P4 的表依次取 2、3…，谁建表谁在同一段
   落一行注释——否则两个插件各自从 1 开始，撞车发生在运行期而不是编译期，排查成本极高。
   **1.11 更正**：号段 2 已由 `chat_session` + `chat_message`（同一次迁移）占用，见 §8.6，
   因此 **P2 的第一张真表从 3 起**。
7. **P1 的传输用 `fetch`，不用内核视图**：真投递要走 `WebContentsView`（P2），但闸门与账本与传输方式无关；
   现在就接视图会把 1.9 变成 1.8 的重复验收。这条边界的代价写在这里，P2 换实现时调用点不动。

### 8.5 子计划 1.10 的落地方案（工作流面板 + `workflow.runner` 骨架）

**这一步在 P1 里的位置**：1.10 是第一个"跑起来给用户看"的能力，也是 1.11 对话界面的前置
（spec 1.11 的依赖写着 1.4 + 1.10）。它交付的是**空转的流水线骨架**：六个步骤槽位、真实推进的
状态、可中断/可续跑/可单步重试，但每一步里什么都没有。业务实现（抓 JD、生成话术、投递）
在 P2 换进来，换的时候不动状态机、不动面板、不动事件契约。

#### 选型与证据（AGENTS.md §6.1）

状态机怎么落地是这次唯一真正的新选型。三个候选：

| 候选                                                                                                           | 结论         | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **XState v5**（`xstate@5.33.2`，npm 实测最后发布 2026-09-29、`sideEffects:false`，维护活跃、纯 JS 无原生编译） | **否决**     | 它是 actor 模型：官方定位是 "creating, interpreting, and executing finite state machines"，"everything is an actor"，状态住在解释器里而不是我们手里。持久化要 `actor.getPersistedSnapshot()` 再 `createActor(logic, { snapshot })` 还原，而官方 persistence 文档自己列了三条限制——schema 演进可能出现 "incompatible state"、恢复时 "executed side effects stay dormant"、存储必须 "JSON-serializable"。本项目要的恰恰是"跨版本升级后旧的 run 还能续跑"，那正是它第一条限制点名的场景；引入它等于同一份 run 状态存两处（快照 + 我们的表）。更直接的理由：`docs/specs/02-browser-automation/spec.md` 2.4-01/06/07 已经把 `WorkflowPlan`/`Node`/`RunState` 定为**可序列化的自有数据模型**、`pause(runId)/resume` 定为接口形态，状态是数据这件事在本仓库是先于选型定下来的 |
| **复用 Cordis 自带的任务作用域**                                                                               | **实测否决** | 读 `node_modules/.pnpm/cordis@4.0.0-rc.10/.../lib/*.d.ts`：rc.10 **没有公开的 `Scope` 类**，全量 `.d.ts` 里与"取消"相关的只有 `Fiber.dispose`（`fiber.d.ts:54`）。也就是说"中断一次正在跑的任务"这个原语框架不提供，无论选哪条路都得自己实现协作式取消                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **自研线性 runner + 纯函数迁移表 + Node 内置 `AbortController`**                                               | **采纳**     | P1 的六个步骤是**线性**流水线（master plan §31 的 ①→⑥），用不到 statechart 的并行区/历史节点/守卫图；而"迁移表是纯函数 + 状态是普通对象"恰好是单测最省力的形态（1.10-03 要的就是"空 runner 走完一轮状态迁移"）。零新依赖，符合 §6.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

一手来源：XState 官方 [Actors](https://stately.ai/docs/actors)、[Persistence](https://stately.ai/docs/persistence)、
[仓库自述](https://github.com/statelyai/xstate)；Cordis 结论来自本机 `node_modules` 里的 `.d.ts`（未启动 spike）。
反向验证条目见 spec 1.10-09。

#### 关键决策

| 议题           | 决策                                                                                                                                                               | 理由                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态放哪       | **普通可序列化对象**：`{runId, status, stepIndex, steps:[{id,status,startedAt,finishedAt,durationMs,error}]}`                                                      | 界面读数、事件载荷、将来落库共用同一个形状，不需要翻译层；也是 2.4-01 已经点名的 `RunState`                                                                                                                                                |
| 迁移怎么判     | 纯函数 `next(state, event)` + 显式非法迁移表                                                                                                                       | "非法迁移被拒而不崩"是 1.10-03 的判据，纯函数最直接                                                                                                                                                                                        |
| 怎么中断       | 每个 run 一个 `AbortController`，步骤实现拿 `signal` 协作退出；`pause()` 只置标志、**等当前步让出**                                                                | 强杀一个跑在浏览器上的自动化动作会留下半提交状态；协作式退出是 §8 红线"不绕过平台风控"的前提                                                                                                                                               |
| 怎么续跑       | `resume()` 从 `stepIndex` 指向的那一步重新开始，不重置已完成步                                                                                                     | 1.10-05 的判据是"步骤号继续"，不是"从头再来"                                                                                                                                                                                               |
| 进度怎么到界面 | `ctx.emit('workflow/progress', payload)`，**必须同时**补进 `core/events.ts` 的 `Events`、`shared/bridge.ts` 的 `RENDERER_EVENTS` 与 `RendererEventSignatures` 三处 | 1.4 的网关按白名单转发事件，少一处就结构上出不了进程（1.8-06 已经踩过一次）                                                                                                                                                                |
| 步骤实现放哪   | 独立包 `@auto-cc/plugin-workflow`，六个步骤先注册为占位实现（`await sleep + 推进`）                                                                                | 面板与 runner 解耦；P2 换实现时调用点不动，符合 master plan「步骤是工作流节点/agent 工具，不另起一套」                                                                                                                                     |
| **P1 不建表**  | run 状态只驻内存 + 结构化日志，**不占用迁移号段**                                                                                                                  | 1.10-01…08 没有任何一条要求"重启后还能看到那次 run"；`usage_ledger` 占了 version 1（§8.4 决策 6），2 号留给 P2 第一张真要持久化的表。提前建表会让"内存态 vs 表态谁是真相"变成悬案                                                          |
| 视图切换       | `App.tsx` 引入**最小视图切换**：`workflow` 与 `diagnostics` 两个视图，各自保留滚动位置；诊断类面板（shell/sessions/usage/assembly）整体降级为次级入口              | 1.10-01 要"第二视图 + 一次点击可达 + 保留滚动位置"，1.10-07 要"调试面板层级低于工作流"，而今天 `App.tsx` 是四个面板堆在一个滚动区、没有任何切换机制。1.11 再把 chat 排到第一并改默认视图——**现在不留 chat 空槽**（那是 §2.4 禁止的死代码） |
| 同一个 runner  | 渲染层**不持有任何步骤状态**，只有 `workflow.runner` 的读数镜像                                                                                                    | 1.10-08 的静态判据：渲染层不得出现第二份步骤定义或第二个状态推导                                                                                                                                                                           |

#### 边界与不做

- 不做分支/并行/条件跳转（P2 的 `WorkflowPlan` 才引入），P1 的 runner 只认线性六步。
- 不做真实业务步骤、不碰网络、不碰 fixture 站点（1.10 与 1.8/1.9 不同，连样例对端都不需要）。
- 不做 run 历史列表与回放；面板只看**当前** run。
- 不做 chat 视图（1.11）。
- 连带补验 1.8-07：会话失效推送到达时，若 runner 正在跑则停在当前步 → 这条依赖的正是
  `pause()` 的协作式语义，1.10 收口时一起打勾或继续标 `[!]`。

### 8.6 子计划 1.11 的落地方案（对话式主界面骨架 + `agent.tools` 空注册表）

**这一步在 P1 里的位置**：1.11 是 P1 最后一块界面结构，也是 AGENTS.md §5.9 那条规则的落地——
首页第一入口必须是**对话**，工作流面板退居第二视图，诊断面板再低一档。它交付的是**没有智能的对话骨架**：
本地确定性假回复、空的工具注册表、真实的会话持久化。真正的 agent 推理与工具实现属 P5，
换进来时不动消息模型、不动工具协议、不动界面。

#### 选型与证据（AGENTS.md §6.1）

1.11 唯一真正的新选型是**消息与工具调用的数据模型**，以及**流式的传输形态**。
以下每条都注了一手来源；被否决的库**不装进仓库**，所以 §6.2 的「读 `.d.ts` 或跑 spike」在这里退化为
「不写调用点，因此不存在调用点漂移」——凡是我们要真的调 API 的东西（cordis / node:sqlite / zod）仍按实测。

| 候选                                                                                                        | 结论                     | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ai` + `@ai-sdk/react`（Vercel AI SDK）**：直接用它的 `UIMessage` 与 `useChat`                            | **否决引入，采纳其形状** | 官方 [UIMessage 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message) 把消息定义成**有序 parts 数组**：`TextUIPart` 判别字段是 `type:'text'`，`ToolUIPart` 带 `toolCallId`，其状态枚举是 `input-streaming / input-available / approval-requested / approval-responded / output-available / output-error`。这套形状正是 1.11-02/03/06 要的（文本与工具卡片同属一条消息、卡片有可显示的状态位），所以**照它的形状自研**。否决装包的理由是传输：`useChat` 的数据通道假定 HTTP/SSE 端点，而本项目的对端是主进程，通道只有 `cordis:call` 与事件白名单各一处；为了拍一张流式截图先架一层假 HTTP 服务，是把 P5 的成本提前付掉。本机实测：`pnpm-lock.yaml` 里 `ai` / `@ai-sdk/*` / `langchain*` / `@modelcontextprotocol/*` **一个都没有**，因此也没有版本可锁定                                                                                                                                                                                                                                                                                                            |
| **MCP 的 tool 定义**（`name`/`title`/`description`/`inputSchema`/`outputSchema`/`annotations`）作为工具协议 | **否决作为 P1 协议**     | [MCP tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 里 `inputSchema` 是 **JSON Schema**（不是 zod），而 `annotations` 只是「描述工具行为的可选属性」，规范自己写明 **clients MUST consider tool annotations to be untrusted**——即它天生不是闸门。本项目 §7.3 要的是不可越过的 `entitlement.gate`，所以副作用等级必须由**我们自己的必填字段**承载。MCP 的价值留到 P5：真接外部工具时把 `input` 转成 JSON Schema 即可，本协议不挡这条路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **纯文本消息 + 工具调用另存一条消息**（早期 chatbot 常见做法）                                              | **否决**                 | master plan §1.7 第 4 条要求「执行中每步在对话流留下可折叠的工具卡片」——卡片是**那次回复的一部分**，拆成两条消息后无法表达「同一条回复里文本-工具-文本」的顺序，1.11-06 的截图也就没有归属对象。AI SDK 用有序 parts 数组解决的正是这件事，见上第一条                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **自研 parts 判别联合 + 自研工具协议（本方案）**                                                            | **采纳**                 | 见下方「关键决策」的消息模型与工具协议两行。零新依赖（§6.3），且 `parts` 的判别式与状态命名与 AI SDK 对齐，将来若真要换成它的类型是**改名**而不是**改结构**；单测直接断言纯数据（1.11-04/05 的判据）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **档位（建议 / 半自动 / 全自动）**                                                                          | **采纳为自研三态**       | [Claude Code 权限模式](https://code.claude.com/docs/zh-CN/permission-modes) 实际有 `default / acceptEdits / plan / auto / dontAsk / bypassPermissions` 六态，用 Shift+Tab 在**界面常驻可见**地循环，并且文档明确：关键路径与需要用户交互的工具**在任何模式下都必须确认**。我们的三档是它的保守子集（`plan`→建议模式、`default`/`acceptEdits`→半自动、`bypassPermissions` 收紧成「仅白名单动作」→全自动），「档位必须能在截图里读出来」这条判据直接来自该文档。不引入它的规则引擎（allowlist 语法与 `dontAsk` 属 P5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **副作用分级 / 先批准后执行**                                                                               | **分级自研，批准有先例** | **本行在 1.11 收口前按一手来源更正过一次**（原写「`tool()` 不含任何确认语义」，是错的）：7.x 的 [AI SDK `tool()` 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool) 实有 `needsApproval?: boolean \| ((input, { toolCallId, messages, context }) => boolean \| Promise<boolean>)`，配合 `ToolUIPart` 的 `approval-requested` / `approval-responded` 两态，所以**「先批准后执行」上游有现成形态**，我们的 `requiresConfirmation` 是它的同形字段（都是布尔/谓词，不是枚举），按上第二条的对齐策略改名而不另造。仍然成立的是另一半：**上游没有任何副作用「等级」**——`needsApproval` 只回答「要不要问」，不回答「这次外发花不花钱」，而 §7.3 的 `entitlement.gate` 要的正是后者（分档才有限额可扣）。所以 `effect: 'read' \| 'local-write' \| 'outbound'` 三档是自研，最近的先例是 [MCP annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 的 `readOnlyHint` / `destructiveHint` / `idempotentHint`，但规范自己写明这些是 untrusted hints，**不能当闸门**，只能当输入。1.11-15 的反向验证按这两个字段的实际差异来判，不按「上游有没有」判 |
| **流式：逐片 `webContents.send` 事件 vs 轮询 vs MessagePort**                                               | **采纳事件推送**         | [Electron IPC 教程](https://www.electronjs.org/docs/latest/tutorial/ipc) 明确「There's no equivalent for `ipcRenderer.invoke` for main-to-renderer IPC」——主→渲染的官方形态就是单向 send；同一页还限定可序列化范围（structured clone），所以载荷只能是小 JSON。本仓库 1.4 已经把 send 收口成事件白名单（`RENDERER_EVENTS`），因此 `chat/delta` 只加一个名字。不额外做节流层：P1 的假回复分片数与间隔都是配置项，量级固定；真模型的 backpressure 属 P5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **会话持久化：主进程 sqlite 表 vs 渲染层 localStorage**                                                     | **采纳表**               | 1.11-08 的判据是"重启 app 后历史与档位仍在"，而 §2.7 禁止第二套状态存储。落库路径已有成熟范式：`store.migrations` 共享数组 + 建表方自己 push 再 `upgrade()`（`packages/entitlement/src/ledger.ts` 是本仓库第一例），号段 1 已被 `usage_ledger` 占用，本次两张表取 **2**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

一手来源：AI SDK [UIMessage 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message)、
[`tool()` 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool)；MCP [Tools 规范 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)；
Electron [IPC 教程](https://www.electronjs.org/docs/latest/tutorial/ipc)；Claude Code [选择权限模式](https://code.claude.com/docs/zh-CN/permission-modes)。
本地实测（未装包，故无 `.d.ts` 可读）：`pnpm-lock.yaml` grep `ai|@ai-sdk|langchain|@modelcontextprotocol` 全空；
`zod` 在各包固定 `^4.0.0`；`@standard-schema/spec` `^1.1.0` 已在 `plugin-config`/`plugin-kernel` 使用
（`packages/config/src/validate.ts:45` 走 `schema['~standard'].validate(value)`）——这条既有事实意味着
工具入参将来要换成任何 standard-schema 兼容的校验器都不必改消息模型。反向验证条目见新增的 spec **1.11-15**。

> **§6.2 在本节的实际兑现**：上表「副作用分级」一行初稿写的是"`tool()` 不含任何副作用等级或确认语义"，
> 收口前按 7.x 参考页逐字段复读，发现 `needsApproval` 与两态审批确实存在，已在表内更正。
> 这条转述错误没有改变任何选型（否决装包的理由一直是传输形态，见第一行），但它正是
> "文档转述不可信"要防的那类错——所以 1.11-15 的判据写成"三个字段各有承载位"，
> 而不是写成"上游没有所以只能自研"。

流式平滑的先例补记：AI SDK 在服务端侧有 `smoothStream`（把 token 流按帧合并后再下发），
与本项目"逐片 send、界面按 `messageId` 追加"是同一问题的两种解法；P1 的片数与间隔都是配置项，
量级固定，不需要这层（见上「流式」行）。未装包，故此处只留出处不引 API 形态。

#### 关键决策

| 议题                | 决策                                                                                                                                                                                            | 理由                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建包还是扩已有包  | 新建 `@auto-cc/plugin-agent`（`packages/agent`），里面两个 service：`agent.tools`（注册表与调用协议）+ `chat.session`（会话、消息、档位）                                                       | §4.3 要求只有确实跨不出才新建。对话既不是执行流水线（workflow）、也不是壳能力（shell）、更不是领域闸门（entitlement），它是**agent 的接线面**。硬塞进 workflow 会让「工作流=六步流水线」和「对话=意图入口」两件事共用一个包边界。新包的硬边界由 1.11-14 静态检查守着：`agent.*` 不得 import `platform.*` / `resume.*` / entitlement |
| 消息模型            | `{ id, sessionId, role: 'user' \| 'assistant', parts: [{ kind: 'text', text } \| { kind: 'tool', toolId, input, state, durationMs?, error? }] }`                                                | 工具卡片是**一条消息的一部分**，不是另一条消息（master plan §1.7 第 4 条：执行中每步在对话流留下可折叠的工具卡片）。P5 的 agent 一次输出「文本 + 工具调用」时不需要改表、不需要改组件                                                                                                                                               |
| 流式怎么到界面      | 新增进程内事件 `chat/delta`（`{ sessionId, messageId, text, done }`），界面按 `messageId` 追加；三处登记同 1.10 的进度事件                                                                      | 1.11-03 的判据是"字数递增可见"，整块跳出正是因为一次性推全文。载荷只带增量片段与 id，不带整份历史                                                                                                                                                                                                                                   |
| 助手回复从哪来      | 本地确定性 responder：把用户输入按固定模板回显并分片吐出，**不接 LLM、不发任何网络请求**                                                                                                        | P1 没有 LLM 客户端，也不该为了拍截图先建一个（§2.7 禁第二套的前提是别急着建第一套）。假回复的意义在于把**传输形态**定成流式，真模型接进来时换的是生成函数                                                                                                                                                                           |
| 取消语义            | 与 workflow 同一个协作式 `AbortController`；把 `sleep(ms, signal)` 从 `packages/workflow` 提到 `@auto-cc/core` 供两处复用                                                                       | §2.2：同一逻辑出现第二次必须抽公共层。聊天流是它的第二个真实使用者，不是为假想场景预留（§2.6）                                                                                                                                                                                                                                      |
| 工具协议            | `{ id, description, input: ZodType, effect: 'read' \| 'local-write' \| 'outbound', requiresConfirmation: boolean, run() }`；调用返回 `{ ok: true, value } \| { ok: false, code, message }` 联合 | master plan §1.7 第 1、2 条点名这四项（名称 / 参数 schema / 副作用等级 / 是否需要确认）。P5 只往表里 register，不改协议形状——这正是 1.11-05 要的"定型"                                                                                                                                                                              |
| 空表怎么拍工具卡片  | 界面上给一个演示入口 → `agent.tools.call('demo.echo')` → 注册表为空即 `TOOL_NOT_REGISTERED` → 卡片以失败态渲染（标题 + 入参摘要 + 状态）                                                        | 1.11-04 要**空表**、1.11-06 要**卡片可见**、1.11-09 要**调不到即报错**，三条只能同时这样满足；也是 master plan §1.7 第 8 条「失败不谎报」的最早落点                                                                                                                                                                                 |
| 档位存哪            | `chat_session.autonomy` 列（默认建议模式），`chat.session.setAutonomy` 只写这一列                                                                                                               | 1.11-07 明确 P1 只存档位不产生行为差异，所以不需要策略层；也不建第二套 settings 存储（§2.7）。档位名沿用 master plan §1.7 第 3 条：`建议模式 / 半自动 / 全自动`                                                                                                                                                                     |
| 会话持久化          | `chat_session` + `chat_message` 两张表，**同一次迁移**建出，号段取 **2**                                                                                                                        | 1.11-08 要求重启后历史与档位都还在，这是 P1 第一张真表。§8.4 决策 6 原写"2 号留给 P2 第一张表"，现由本条占用，**P2 起表号顺延为 3**（谁建表谁登记，见下）                                                                                                                                                                           |
| 两个视图共用 runner | 抽 `useWorkflowRun()`（订阅 `workflow/progress` + 挂载时 `runner.current()`），WorkflowPanel 与 ChatPanel 都读它                                                                                | 1.10-08 的后半句判据「两侧状态镜像一致」需要真的有两个消费者才算数；§2.2 同一逻辑第二次出现必须抽                                                                                                                                                                                                                                   |
| 输入区不冻结        | 运行中只禁用发送按钮、不清输入框、不卸载消息流                                                                                                                                                  | 1.11-13 要的是"能打字并能被接受"，界面冻结的根因通常是把整块区域换成 running 态分支                                                                                                                                                                                                                                                 |

#### 边界与不做

- 不接 LLM、不做意图识别、不注册任何真实工具（P5）；`agent.tools` 在 P1 是**空表**。
- 不做多会话列表 UI：P1 只有「当前会话 + 新建会话」，历史按 `sessionId` 查但不给切换面板。
- 不做消息编辑、删除、重新生成、分支对话。
- 不做执行计划确认流与副作用分级策略（master plan §1.7 第 2、4 条属 P5），P1 只把字段留在协议里。
- 回补两条 1.10 的挂起项：**1.10-01**（chat ↔ 工作流面板往返截图）与 **1.10-08**（两个视图镜像同一个 runner 实例）。

## 9. P1 明确不做

- 不接招聘平台、不写 JD 模型、不做 PDF、不做知识库 —— 提前做这些会让骨架被业务细节绑架。
  （1.8 用**本地 fixture 站点**验证登录态，不碰真实平台。）
- 不做 SaaS、登录、支付；只做 1.9 的 gate/ledger 接线面。
- 不做自动更新（updater 属 P5）。
- i18n 只做**基建**（1.2：Provider + `zh-CN`/`en` 两份本地 JSON + 裸文案 lint 规则），不做多语言运营与翻译校对。
- 不做多窗口/多标签架构（托盘 + 单主窗口 + 一个内嵌内核视图足够）。
- `main/` 里不留任何 `ipcMain.handle` 散落注册 —— 全走 `plugin-ipc`。
- 不引入 Playwright / Puppeteer / 任何自带浏览器下载链。

## 10. 裁定⑱（2026-10-06 用户表态）：右侧内嵌内核视图默认不展示，只有需要时才展示

**表态原文**：「右侧内嵌内核视图默认不展示，只有需要时才展示」。

### 10.1 这一条改的是"什么时候占着那一栏"，不是"容器还在不在"

1.2-12 的原判据（容器存在且可挂载、38% 摆位、占位页可读）**一字不动**：视图仍然在窗口创建时
就挂上去，仍然按 `KERNEL_VIEW_WIDTH_RATIO` 摆位，收回站点仍然是"重建为占位页"而不是摘掉视图
（摘了 resize 就无处摆位）。改的只有**默认可见性**那一个初值，以及"谁有权翻它"。

### 10.2 落点（三处，一次做完）

| 落点                                                            | 内容                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shell/src/index.ts`                                   | `kernelViewVisible` 初值 `true` → **`false`**；可见性判据收进 `createKernelView` 末尾一句——**装的是真实站点就展示，装的是占位页就收起**；`setKernelViewVisible`（人按的那颗）与它共用新抽的 `applyKernelViewVisible`，值真的变了才推事件 |
| `packages/core/src/events.ts` + `packages/shared/src/bridge.ts` | 新增推送 `shell/kernel-view-visible`（载荷就是那一个布尔，不另包一层），进 `RENDERER_EVENTS` 与 `RendererEventSignatures`                                                                                                                |
| `packages/renderer/src/`                                        | 新增 `useKernelViewVisible.ts`（事件当铃、状态仍取 `shell.getStatus`）；`App.tsx` 的那一栏 `<aside>` 改为**只在可见时渲染**，收起时主区拿回那 38%；`ShellPanel` 显隐按钮的兜底值跟着改成 `false`                                         |

### 10.3 为什么判据写在壳层，而不是写在每个调用方

「需要」这件事只有一个物理判据：**视图里装的是不是真实站点**（`kernelViewPartition !== ''`）。
把它写在视图的拥有者（`createKernelView`）里，`sessions.open` / `sessions.close` / 窗口销毁重建
三条路都自动对得上；写在调用方就要在每一处各补一句 `setKernelViewVisible(true)`，
那是 §2.5 禁止的"同一件事两处都能干"。人手动收起（诊断面板那颗按钮）仍然是唯一越权口子，
且只在下一次挂载站点时被推回展示。

### 10.4 与 06 稿那条"右栏一栏多用"的关系

设计稿 README 的裁定 Q1 写的是「右栏默认显示内核浏览器视图」——**本裁定把"默认"这一格翻过来了**，
Q1 剩下的部分（同一只容器、随分区换内容、形态③右栏替换）不变，6.2-04 仍是缺件。
顺带一条宽度副作用（实测的是宽度，不是岗位屏的排布）：右栏收起时主区从 560px 变 1016px（1200 宽窗口，
见验收文件①②两段读数），岗位屏那段查询容器（`@container` + `@2xl:` 断点）因此**在收起态拿到了横向骨架的宽度**，
挂载站点后又退回窄态——纵向"列表→详情→动作"读序与横向骨架的切换判据本来就是这一列自己的宽度，未改。

### 10.5 验收

`docs/acceptance/1.2/1.2-12b-kernel-view-default-hidden.txt`（三段活体读数 + 四张截图 + 四道门禁），
对应 `docs/specs/01-framework/spec.md` 的 1.2-12 追加条目。
