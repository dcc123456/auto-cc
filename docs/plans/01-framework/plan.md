# 计划一 · 搭建主体框架 — 详细实施计划

> 上位文档：`docs/00-master-plan.md`
> 验收文档：`docs/specs/01-framework/spec.md`
> 范围：**只做骨架**，不含任何招聘业务逻辑。P2/P3/P4 的全部依赖都必须在 P1 内闭环。

---

## 0. 已完成的可行性验证（本计划的证据基线）

以下不是假设，是 2026-09-29 在本机实测通过的结果（脚本：`.research-repos/cordis-spike/`）：

| 验证项 | 结果 | 对本计划的约束 |
| --- | --- | --- |
| Cordis v4 服务发布 / 跨插件 inject / effect 回收 / 依赖联动卸载 | 通过 | 采用 §4 插件写法为强制规范 |
| Cordis 运行于 Electron 主进程（内嵌 Node 24.21） | 通过 `fiber.state=2 registry=1` | 后端 = 主进程，无独立 Node 服务 |
| Electron 主进程 ESM（`"type":"module"` + `.mjs`） | 通过 | 全仓 ESM，不出 CJS 双轨 |
| `--remote-debugging-port=9222` + CDP `/json` + 读实时 DOM | 通过（读到 `SPIKE-RENDER-OK`） | P1.6 可视自测通道走 CDP，不需额外 HTTP 服务 |
| Electron 二进制下载 | GitHub/electronjs.org **不可达**，仅 `registry.npmmirror.com/-/binary/electron/` 可用；postinstall 被拦截需手动跑 | 见 §7 环境前置，写进 `.npmrc` |
| 版本基线 | cordis 4.0.0-rc.10 / electron 44.4.5 / node 24.18（宿主）/ esbuild 0.28.2 | 锁定这些为起点 |

## 1. 语言与技术选型（决策 + 理由）

| 项 | 选择 | 理由 / 放弃的方案 |
| --- | --- | --- |
| 语言 | TypeScript 5.x，`strict: true`，全量 ESM | cordis 是 ESM-only 且类型驱动（declaration merging）；放弃 JS：service 名靠字符串，无类型就无边界 |
| 外壳 | Electron 44 | §0 已验证；放弃 Tauri —— cordis 插件体系与 CDP 自动化无处安放 |
| UI | React 18 + Vite 6 | 硬性要求；Vite 对 ESM/HMR 最省事 |
| 包管理 | pnpm workspace | 能 enforce 包边界（跨包 import 必须显式声明依赖），配合 lint 实现分层规则 |
| 持久化 | `node:sqlite`（优先）→ 不可用则 `better-sqlite3` | **native 编译是环境风险**：postinstall 被拦截。P1.3 先探测 `node:sqlite`，Electron 44 内嵌 Node 24 应自带。放弃独立 DB 进程 |
| 状态（渲染层） | zustand | 渲染层不做真相源，只缓存 service 事件流投影 |
| 校验 | zod（对齐 cordis 的 StandardSchemaV1 槽位） | cordis 插件 `Config` 接受 standard-schema，zod 可直接挂载 |
| Lint | eslint 9 flat config + typescript-eslint（type-checked）+ prettier | 加自定义 rule 禁止跨层 import（§4.3） |
| 打包 | electron-builder | 一份配置出 nsis / dmg / AppImage / deb |
| 单测 | vitest（仅纯逻辑） | 功能验收不用它，见 §6 |

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
├─ pnpm-workspace.yaml
├─ tsconfig.base.json            # 唯一 TS 真相源，子包 extends
├─ eslint.config.js  .prettierrc  .npmrc
├─ cordis.yml                    # 插件装配清单（声明启用哪些插件与配置）
└─ packages/
   ├─ core/          @auto-cc/core          # cordis 复导出、Service 基类、类型、错误、事件表
   ├─ config/        @auto-cc/plugin-config  # L0 配置：分层合并 + schema 校验
   ├─ logger/        @auto-cc/plugin-logger  # L0 日志：环形缓冲 + 文件 + 事件外发
   ├─ store/         @auto-cc/plugin-store   # L0 持久化：sqlite + migration
   ├─ kernel/        @auto-cc/plugin-kernel  # L0 装配：读 cordis.yml，挂载其余插件
   ├─ ipc/           @auto-cc/plugin-ipc     # L4 IPC 网关：typed RPC + 事件流
   ├─ plugin-manager/@auto-cc/plugin-plugins # L4 插件启停/热重载/状态树
   ├─ devtools/      @auto-cc/plugin-devtools# L4 可视自测驱动（CDP harness）
   ├─ main/          @auto-cc/main           # Electron 主进程入口（薄：只做生命周期）
   ├─ preload/       @auto-cc/preload        # contextBridge 白名单（唯一渲染层出口）
   ├─ renderer/      @auto-cc/renderer       # React 应用
   ├─ shared/        @auto-cc/shared         # 跨进程类型与契约（无业务逻辑）
   └─ testing/       @auto-cc/testing        # 测试工具：harness 客户端、断言、fixture
```

**目录纪律**

- `main/` 必须是薄壳：Electron 生命周期 + 创建 Context + `ctx.plugin(Kernel)`，**不写业务**。
- 一个插件一个包。`packages/<plugin>/src/index.ts` 导出默认插件对象，内部文件放 `src/internal/`。
- `shared/` 只放类型与 schema，禁止放实现，避免变成万能依赖袋。
- P2/P3/P4 的新插件（`plugin-browser`、`plugin-jd`、`plugin-resume-pdf`、`plugin-resume-kb`…）
  加入 `packages/`，不改骨架。

## 3. 分层与依赖规则

沿用 master plan §3.1 的 L0~L4。三条可机检的硬规则：

1. 上层可 inject 下层，同层不得互相 inject，下层绝不知道上层。
2. 任何 `packages/*` 不得 `import ... from 'cordis'`，只能从 `@auto-cc/core` 取。
3. 跨包 import 其他包的 `src/internal/**` → CI 失败。

## 4. Cordis 插件规范（由 §0 实测形态固化）

```ts
// packages/jd-store/src/index.ts（示意，P2 才落地）
import { Service, definePlugin } from '@auto-cc/core';

class JdStoreService extends Service {
  static provide = 'jd.store';
  async search(q: JdQuery) { /* ... */ }
}

export default definePlugin({
  name: 'jd-store',
  inject: ['store.db', 'config'],   // 显式声明，未声明取不到
  provide: 'jd.store',              // 允许兄弟/上层 inject
  Config: JdStoreConfigSchema,      // zod → standard-schema
  apply(ctx, config) {
    const svc = new JdStoreService(ctx);
    ctx.effect(() => () => svc.close());   // 资源只走 effect
  },
});
```

- 命名：service 名 `域.能力`（`config`、`logger`、`store.db`、`browser.session`、`jd.store`）；
  事件名 `域.动作`（`plugin.state.changed`、`log.entry`）。
- 资源（浏览器实例、DB 句柄、定时器、子进程）**只能**在 `ctx.effect` 里分配。
- 插件不得抛裸错到主进程；`kernel` 统一捕获并置 fiber 为 FAILED（P1.5）。

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

## 6. 测试与验收策略（用户硬性要求：agent 能自己看页面直接测）

**双轨**，且以第一条为准：

1. **Agent 可视化自测（主）** —— `plugin-devtools` 在 dev 模式开启 CDP；
   `@auto-cc/testing` 提供 harness 客户端，支持：列 targets、导航、截图、读 DOM 快照、
   真实点击/输入、执行 JS 断言、读主进程日志与 fiber 树。
   我按 spec 场景**亲自操作 app 并基于看到的界面**判定通过/失败，证据（截图 + DOM + 日志）
   存入 `docs/acceptance/<spec-id>/`。
2. **脚本单测（辅）** —— 仅覆盖纯逻辑：schema 校验、路径解析、migration、选择器工具。
   任何功能**不得**只靠脚本绿灯就宣称完成。

## 7. 环境前置（实施前必须完成，否则卡住）

- [ ] `.npmrc` 写入 `electron_mirror=https://registry.npmmirror.com/-/binary/electron/`
      与 `enable-pre-post-scripts=true`（否则 Electron 二进制不下发，见 §0）。
- [ ] 探测 `node:sqlite` 在 Electron 44 主进程内是否可用 → 决定 P1.3 走哪个驱动。
- [ ] 探测 `better-sqlite3` 能否在本环境完成 native 编译（预编译二进制走 npm registry，需镜像）。
- [ ] 确认 Linux 打包：本机为 Windows，无 Docker/Linux → `electron-builder --linux` 的
      AppImage 可由 Node 交叉打包（`electron-builder` 支持在 Windows 产 AppImage/deb 部分目标），
      `deb` 需 fpm。**若不可达则 P1.7 降级为「三端配置齐备 + Windows 产物实测 + Linux/mac 配置审查」，
      并在 spec 中显式标记为 BLOCKED 而非 PASS。**

## 8. 子计划顺序与产出（一次一个，逐个验收）

| # | 子计划 | 产出 | 依赖 |
| --- | --- | --- | --- |
| 1.1 | 工程基线 | root 配置、workspace、tsconfig.base、eslint/prettier、`.npmrc`、提交规范、`packages/core` 复导出 | — |
| 1.2 | Electron 壳 | main/preload/renderer 三通，React 页面在窗口内可见，安全策略生效 | 1.1 |
| 1.3 | L0 内核插件 | `plugin-config` / `plugin-logger` / `plugin-store` / `plugin-kernel` + `cordis.yml` 装配 | 1.1 |
| 1.4 | IPC 网关 | `plugin-ipc` + 白名单 + 类型化 client；React 调 service 并订阅事件流 | 1.2 + 1.3 |
| 1.5 | 插件运行时管理 | `plugin-plugins` 启停/热重载/状态树/错误隔离 + 调试面板页 | 1.4 |
| 1.6 | 可视自测通道 | `plugin-devtools` + `@auto-cc/testing` harness；agent 完成「开页面→截图→点击→断言」闭环 | 1.5 |
| 1.7 | 三端打包 | electron-builder 配置、图标、安装冒烟脚本、版本号与产物命名规范 | 1.6 |

**P1 完成定义**：`docs/specs/01-framework/spec.md` 中每条标准为 PASS 或有明确理由的 BLOCKED
（不得静默跳过），且 M1/M2 两个里程碑由 agent 可视化验证达成。

## 9. P1 明确不做

- 不接招聘平台、不写 JD 模型、不做 PDF、不做知识库 —— 提前做这些会让骨架被业务细节绑架。
- 不做自动更新（updater 属 P5）。
- 不做 i18n（界面先中文）。
- 不做多窗口/多标签架构（托盘 + 单主窗口足够）。
- `main/` 里不留任何 `ipcMain.handle` 散落注册 —— 全走 `plugin-ipc`。
