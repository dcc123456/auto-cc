# 计划一 · 搭建主体框架 — 详细实施计划

> 上位文档：`docs/00-master-plan.md`
> 验收文档：`docs/specs/01-framework/spec.md`
> 范围：**只做骨架**，不含任何招聘业务逻辑。P2/P3/P4 的全部依赖都必须在 P1 内闭环。
> 骨架必须包含四类"以后改不动"的接线面：内置内核与会话分区（1.8）、外发额度闸门（1.9）、
> 工作流优先的界面形态（1.10）、零前置依赖的打包方式（1.7）。

---

## 0. 已完成的可行性验证（本计划的证据基线）

以下不是假设，是 2026-09-29 在本机实测通过的结果（脚本：`.research-repos/cordis-spike/`）：

| 验证项                                                          | 结果                                                                                                              | 对本计划的约束                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Cordis v4 服务发布 / 跨插件 inject / effect 回收 / 依赖联动卸载 | 通过                                                                                                              | 采用 §4 插件写法为强制规范                  |
| Cordis 运行于 Electron 主进程（内嵌 Node 24.21）                | 通过 `fiber.state=2 registry=1`                                                                                   | 后端 = 主进程，无独立 Node 服务             |
| Electron 主进程 ESM（`"type":"module"` + `.mjs`）               | 通过                                                                                                              | 全仓 ESM，不出 CJS 双轨                     |
| `--remote-debugging-port=9222` + CDP `/json` + 读实时 DOM       | 通过（读到 `SPIKE-RENDER-OK`）                                                                                    | P1.6 可视自测通道走 CDP，不需额外 HTTP 服务 |
| `node:sqlite` 在宿主 Node 24 可 require                         | 通过                                                                                                              | 持久层走内置 sqlite，不引原生依赖           |
| Electron 二进制下载                                             | GitHub/electronjs.org **不可达**，仅 `registry.npmmirror.com/-/binary/electron/` 可用；postinstall 被拦截需手动跑 | 见 §7 环境前置                              |
| 版本基线                                                        | cordis 4.0.0-rc.10 / electron 44.4.5 / node 24.18（宿主）/ esbuild 0.28.2                                         | 锁定这些为起点                              |

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
   ├─ renderer/       @auto-cc/renderer       # React 应用（首页 = 工作流面板）
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
  事件名 `域.动作`（`plugin.state.changed`、`log.entry`、`session.auth.expired`）。
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
- [x] `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 显式放行 `esbuild` / `electron`。
- [x] 提交钩子不依赖 postinstall（自研 sh 脚本 + `git config core.hooksPath`）。
- [ ] 探测 `node:sqlite` 在 **Electron 44 主进程内**是否可用（宿主 Node 24 已确认可用，Electron 待测）→ 1.3-06。
- [ ] 探测 electron-builder 在本机能否产出 AppImage/deb（需 fpm）→ 决定 1.7-08 是否 BLOCKED。

## 8. 子计划顺序与产出（一次一个，逐个验收）

| #    | 子计划           | 产出                                                                                          | 依赖      |
| ---- | ---------------- | --------------------------------------------------------------------------------------------- | --------- |
| 1.1  | 工程基线         | root 配置、workspace、tsconfig、eslint/prettier、`.npmrc`、提交规范、`packages/core`+`shared` | —         |
| 1.2  | Electron 壳      | main/preload/renderer 三通，React 页面在窗口内可见，安全策略生效                              | 1.1       |
| 1.3  | L0 内核插件      | `plugin-config` / `plugin-logger` / `plugin-store` / `plugin-kernel` + `cordis.yml` 装配      | 1.1       |
| 1.4  | IPC 网关         | `plugin-ipc` + 白名单 + 类型化 client；React 调 service 并订阅事件流                          | 1.2 + 1.3 |
| 1.5  | 插件运行时管理   | `plugin-plugins` 启停/热重载/状态树/错误隔离 + 调试面板页                                     | 1.4       |
| 1.6  | 可视自测通道     | `plugin-devtools` + `@auto-cc/testing` harness；agent 完成「开页面→截图→点击→断言」闭环       | 1.5       |
| 1.7  | 零依赖三端打包   | electron-builder 配置、图标、安装冒烟脚本；**产物自包含、零首启动下载**                       | 1.6       |
| 1.8  | 内置内核会话骨架 | `plugin-sessions`：persist partition 抽象、登录态跨重启保持、失效探测事件                     | 1.3 + 1.4 |
| 1.9  | 外发额度骨架     | `plugin-entitlement`：`gate.check()` + `usage.ledger` 落库 + 本地无限实现 + 可切断额度        | 1.3 + 1.4 |
| 1.10 | 工作流优先界面   | renderer 首页 = workflow 面板（空 runner 占位 + 步骤槽位 + 进度区），确立为第一入口           | 1.4       |

**P1 完成定义**：`docs/specs/01-framework/spec.md` 中每条标准为 PASS 或有明确理由的 BLOCKED
（不得静默跳过），且 M1 / M2 / M2b 三个里程碑由 agent 可视化验证达成。

## 9. P1 明确不做

- 不接招聘平台、不写 JD 模型、不做 PDF、不做知识库 —— 提前做这些会让骨架被业务细节绑架。
  （1.8 用**本地 fixture 站点**验证登录态，不碰真实平台。）
- 不做 SaaS、登录、支付；只做 1.9 的 gate/ledger 接线面。
- 不做自动更新（updater 属 P5）。
- i18n 只做**基建**（1.2：Provider + `zh-CN`/`en` 两份本地 JSON + 裸文案 lint 规则），不做多语言运营与翻译校对。
- 不做多窗口/多标签架构（托盘 + 单主窗口 + 一个内嵌内核视图足够）。
- `main/` 里不留任何 `ipcMain.handle` 散落注册 —— 全走 `plugin-ipc`。
- 不引入 Playwright / Puppeteer / 任何自带浏览器下载链。
