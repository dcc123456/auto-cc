# auto-cc 主体计划（Master Plan）

> 版本：v1.0　状态：**已定稿，作为后续所有子计划的基线**
> 本文档是唯一的顶层计划。每个主体计划（P1~P4）的详细实施计划与验收 spec 分别位于
> `docs/plans/<id>/plan.md` 与 `docs/specs/<id>/spec.md`。

---

## 1. 项目定位

### 1.1 形态

auto-cc 是一个**桌面端 Application**，不是网页、不是 CLI、不是浏览器扩展宿主。

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| 运行时外壳 | Electron | 必须在用户本机持有 Chromium 渲染层与 Node 主进程；见 §6 选型 |
| 平台 | Windows / macOS / Linux **三端都要出安装包** | 硬性需求 |
| 后端 | Node.js 主进程，内嵌 **Cordis** 插件框架 | 硬性需求（功能以插件挂载） |
| 前端 | React 渲染进程 | 硬性需求 |
| 分发 | electron-builder 产出 `nsis`/`dmg`/`AppImage`+`deb` | 见 §6.5 |

### 1.2 产品目标

为中国求职者提供一个**自动化求职助理**，把「找工作」从重复劳动变成一条可托管的流水线：

```
   ①搜索 JD        ②读 JD + 建档      ③生成话术         ④打招呼/沟通        ⑤按 JD 优化简历      ⑥择机投递
  BOSS/猎聘/拉勾  →  结构化 JD 库   →  开场白/追问/回绝  →  自动发送+回复监听  →  命中缺口的简历内容  →  自动发简历
```

**闭环判据**：一条 JD 从被发现到简历送达，用户不需要手动操作浏览器；用户只做两件事 ——
设定画像与筛选条件（前置）、审批高风险动作（可选的 human-in-the-loop 开关）。

### 1.3 明确的非目标（防止范围漂移）

- 不做 SaaS / 多用户服务端；单机单用户，数据全在本地。
- 不做「代刷简历」「批量海投绕过平台风控」的对抗能力；反检测不是设计目标（见 §8）。
- 不自建浏览器内核；不自研 PDF 排版引擎；不训练模型 —— 三源项目的能力**按功能内核抽取复用**。
- 不做移动端。

---

## 2. 三大成熟功能源项目的分析结论

用户明确：**这三个项目不适合直接嵌入**，需要判断后按需抽取。分析结论如下（详细逐仓库分析见
`docs/research/source-repos-analysis.md`）。

| 源项目 | 原形态 | 可抽取的「功能内核」 | 必须丢弃的宿主耦合 |
| --- | --- | --- | --- |
| `browser-copilot` | 浏览器扩展（WXT/Manifest V3）+ 配套 server | ①工作流引擎（步骤序列 + 断点续跑）②DOM 定位与语义选择策略 ③站点适配器（招聘站）④抓取的 JD 数据结构 | popup/options/background 生命周期、扩展消息通道、MV3 service worker 约束、扩展打包链 |
| `canva-pdf` | 独立 Web 应用 | ①简历模板模型（区块 + 数据绑定）②PDF 渲染与导出管线 ③版面度量（分页/字号/边距） | 其前端路由与状态管理、画布编辑器的独立宿主、其构建配置 |
| `ai-resume` | 独立应用 | ①简历 → 个人知识库的抽取建模 ②检索（JD 查询 → 个人经历命中）③缺口识别与内容生成提示词 | 其 Web 宿主、其独立的存储层与鉴权 |

**抽取原则（对全部三个项目生效）**：

1. 只搬**纯逻辑与数据契约**，不搬宿主。凡是 import 了原项目 UI 框架、扩展 API、或原项目配置的，重写而非移植。
2. 搬过来的代码必须落进一个 Cordis 插件边界内，通过 Service 对外暴露，不得跨插件直接 import 内部文件。
3. 保留来源可追溯性：每个抽取模块在文件头注明源项目 + 源路径，便于后续 diff 上游。
4. 站点选择器（招聘平台 DOM）**不硬编码进逻辑**，集中在 `platforms/boss` 这类适配器包里，因为它是腐化最快的部分。

---

## 3. Cordis 集成基线（已实测）

Cordis = `cordis@4.0.0-rc.10`（`cordiverse/cordis`，"Meta-Framework for Modern Applications"）。
以下语义已在 `.research-repos/cordis-spike/spi.mjs` 实测通过，**不是文档转述**：

```js
class JobService extends Service { static provide = 'jobs'; list() { ... } }

const kernel = (ctx) => { new JobService(ctx); };   // ctx.jobs 立即可见
kernel.provide = 'jobs';

const consumer = (ctx) => { ctx.jobs.list(); ctx.effect(() => () => cleanup()); };
consumer.inject = ['jobs'];
```

已验证的框架行为（构成后续架构的硬约束）：

- **A. 服务发布**：`new XxxService(ctx)` 即以 `static provide` 的名字挂到 `ctx`，作用域为当前 fiber。
- **B. 显式依赖**：插件用 `inject: ['name']` 声明依赖，未声明的 service 取不到（隔离是默认的，不是共享全局的）。
- **C. 资源回收**：`ctx.effect(() => () => teardown)` 随 fiber 卸载自动逆序执行 —— 浏览器实例、DB 连接、定时器都走这条路径，禁止手写 cleanup 钩子。
- **D. 依赖联动**：提供方被 dispose 时，依赖方自动卸载（实测 `f2.state` 回到 PENDING），service 恢复后自动重建 —— 这是**热插拔/热重载**的基础，P1 必须把它做成可运维能力（改插件不重启 app）。
- **E. 可观测**：`ctx.registry.size`、`fiber.state`、`ctx.logger` 提供运行时自省能力，P1 的调试面板据此实现。
- **F. API 不稳定**：官方 README 明示 API 未稳定。因此**所有插件只依赖本项目 `packages/core` 复导出的 cordis 类型**，升级 cordis 只改一处。

### 3.1 插件分层规范

```
L0 kernel      配置/存储/日志/事件总线            无 inject
L1 platform    浏览器驱动、站点适配器              inject: kernel
L2 domain      jd-store, resume-kb, copywriting   inject: kernel (+ platform 或彼此)
L3 pipeline    job-pipeline（串联 2 的业务流）     inject: L1+L2
L4 surface     ipc-gateway, devtools              inject: L2/L3
```

规则：只允许下层被上层 inject；同层禁止互相 inject（避免环）；跨层禁止跳级访问内部实现。

---

## 4. 主体计划拆分

四大主体计划。**执行顺序为串行**，因为 P2/P3/P4 都依赖 P1 提供的插件骨架与 IPC 契约，
P4 的产出是 P2 中「按 JD 优化简历」步骤的内容来源。

```
P1 搭建主体框架 ─┬─> P2 集成浏览器自动化 ──> P5(后续) 端到端流水线与打包发布
                 ├─> P3 PDF 编辑 / 简历生成
                 └─> P4 简历 → 个人知识库
                      （P3、P4 可在 P1 完成后并行；P2 与 P4 会合于 P5）
```

> **执行纪律（用户明确要求）**：一次只推进一个计划。当前计划未通过其 spec 的逐项验收之前，
> 不得开始下一个计划。禁止把 P1~P4 混在一次改动里实现。

### P1 · 搭建主体框架

目标：跑起来一个三端可安装、功能以 cordis 插件挂载、React 界面可见、且 **agent 能自己开页面看并直接操作测试** 的骨架。

| 子计划 | 内容 | 产出 |
| --- | --- | --- |
| 1.1 | 仓库与工程基线：pnpm workspace、TS 配置、ESLint/Prettier、提交规范、目录结构定稿 | 可 `pnpm i && pnpm dev` 的空壳 |
| 1.2 | Electron 壳：主/渲染/preload 三进程、安全策略（contextIsolation/sandbox）、单实例、窗口与托盘 | 能打开 React 页面 |
| 1.3 | Cordis kernel 插件：配置层、日志层、持久化层（SQLite + migration）、`cordis.yml` 装配 | service 可 inject |
| 1.4 | IPC 网关插件：service 方法暴露给渲染层的契约层（typed RPC + 事件流） | React 能调 service 并订阅事件 |
| 1.5 | 插件运行时管理：热挂载/卸载/启停、状态面板（registry/fiber state）、错误不崩主进程 | 调试面板可见插件树 |
| 1.6 | 可视自动化测试通道：CDP 驱动的 dev harness，agent 可截图/读 DOM/点击/执行断言 | `pnpm harness` 可用 |
| 1.7 | 三端打包：electron-builder 配 nsis / dmg / AppImage+deb，签名与安装冒烟脚本 | 三端产物 |

### P2 · 集成浏览器自动化

抽取 `browser-copilot` 的工作流引擎与站点适配器，运行于主进程持有的浏览器会话。

| 子计划 | 内容 |
| --- | --- |
| 2.1 | 浏览器会话服务：启动/复用 Chromium、用户 profile 持久化、登录态保持与失效检测 |
| 2.2 | 站点适配器 SPI：`PlatformAdapter` 接口（search/detail/chat/send-resume）+ BOSS 直聘实现 |
| 2.3 | JD 抓取与结构化：搜索条件 → 列表 → 详情 → 规范化 JD 实体入库 |
| 2.4 | 工作流引擎移植：步骤序列、重试、断点续跑、失败快照 |
| 2.5 | 打招呼与对话：话术注入、发送、回复监听、频控与人类化节流 |
| 2.6 | 简历投递动作 + 人工审批开关（human-in-the-loop） |
| 2.7 | 反爬与合规护栏：随机化、日上限、检测到风控即暂停并通知（**不是绕过风控**） |

### P3 · PDF 编辑 / 简历生成

抽取 `canva-pdf` 的模板模型与渲染管线。

| 子计划 | 内容 |
| --- | --- |
| 3.1 | 简历文档模型（JSON Schema：区块/条目/度量）与校验 |
| 3.2 | 模板系统：模板定义、数据绑定、多模板切换 |
| 3.3 | 渲染管线：React 预览 → 分页/度量 → PDF 导出（中文字体子集化，跨平台字体回退） |
| 3.4 | 版面编辑器：拖拽区块、字号边距调节、实时预览 |
| 3.5 | 版本与快照：每次投递所用简历可追溯、可 diff |

### P4 · 通过简历构建个人知识库

抽取 `ai-resume` 的知识建模与检索。

| 子计划 | 内容 |
| --- | --- |
| 4.1 | 简历导入与解析（PDF/DOCX/Markdown → 结构化经历实体） |
| 4.2 | 个人知识库建模：经历/项目/技能/成果四类实体 + 关系 |
| 4.3 | 本地检索：embedding 存储（sqlite-vec 或等价）、混合检索（向量 + 关键词） |
| 4.4 | JD → 能力要求拆解，与知识库做缺口比对 |
| 4.5 | 定向内容生成：按 JD 重排/改写简历内容，标注不可编造项 |
| 4.6 | 话术生成器：开场白/追问/拒绝应对，绑定 JD + 知识库证据 |

### P5 · 端到端流水线与发布（P1~P4 之后规划）

串联 ①→⑥ 全链路、调度器（定时任务）、指标看板、正式发布与升级通道。

---

## 5. 里程碑与门禁

| 里程碑 | 判据 | 门禁 |
| --- | --- | --- |
| M1 | 三端安装包可安装可启动，空 React 界面可见 | P1 spec 全绿 |
| M2 | agent 能自主打开 app、截图、点击、断言并复述结果 | 1.6 spec 全绿 |
| M3 | 在真实 BOSS 账号上搜到 ≥10 条 JD 入库 | 2.3 spec 全绿 |
| M4 | 自动打招呼并有回复监听记录 | 2.5 spec 全绿 |
| M5 | 由知识库产出一份针对指定 JD 的定制简历 PDF | 4.5 + 3.3 全绿 |
| M6 | 择机自动投递，全过程可在界面回看 | P5 |

---

## 6. 技术选型与理由

1. **Electron 而非 Tauri**：核心诉求是「驱动真实浏览器抓 JD + 复用 browser-copilot 的 DOM 逻辑」。
   Tauri 主进程是 Rust，Node 侧 cordis 插件体系与 Puppeteer/CDP 生态无处安放。Electron 让 cordis
   直接跑在主进程 Node 里，且渲染层与自动化目标同为 Chromium。代价是包体大，可接受。
2. **TypeScript（strict）+ ESM**：cordis v4 是 `"type": "module"`；全仓统一 ESM 避免双轨。
3. **pnpm workspace monorepo**：插件必须各自成包才能 enforce 分层 inject 规则（靠 lint + 显式依赖）。
4. **React 18 + Vite**：渲染层纯 UI，不做业务决策；构建快、HMR 好，利于 P1.2。
5. **electron-builder**：一套配置出 nsis / dmg / AppImage / deb，含 Linux 多格式，是三端需求的最低成本解。
6. **SQLite（better-sqlite3 / node:sqlite）+ 文件迁移**：JD、简历、知识库、投递记录全本地关系型；
   向量检索在 P4.3 决策（倾向 sqlite-vec，避免引入独立向量库进程）。
7. **zustand + typed IPC client**：渲染层轻量状态，服务端状态一律从 service 事件流派生，不做二次真相源。
8. **不引入 HTTP 服务层**：主/渲染通信用 Electron IPC（preload 白名单方法），不额外开端口，减少攻击面。
   （P1.6 的 dev harness 例外，仅 dev 模式启用。）

## 7. 项目规范（摘要，全文见 `docs/plans/1.1/spec-conventions.md`）

- 提交：Conventional Commits，`feat|fix|chore|docs|refactor|test|perf(scope): subject`；一个子计划一个原子提交串。
- 代码：ESLint（typescript-eslint type-checked）+ Prettier；TS `strict: true`，禁 `any` 外溢，禁非空断言滥用。
- 命名：cordis service 名用 `域.能力`（如 `browser.session`、`jd.store`）；插件目录 `plugin-<name>`。
- 边界：插件间只经 service 通信；`packages/*/src/internal/**` 不得被外部包 import。
- 注释：默认不写；只写「为什么」，尤其是站点选择器、频控参数、风控规避阈值的来源。
- 文档：每个子计划必须有 plan + spec + 验收记录三件套，spec 条目 ID 稳定不复用。

## 8. 合规与风险立场（前置约定，非事后补丁）

自动化操作招聘平台存在账号封禁与违反平台 ToS 的现实风险。项目立场：

- 默认开启 **人工审批**（发送打招呼/投递简历前确认），自动化频度受限；
- 提供「仅辅助」模式（只搜索/只生成内容，不自动发送），供不愿承担风险的用户；
- 不做验证码绕过、不做指纹伪装、不做多账号池 —— 这类需求一律拒绝实现；
- 所有外发动作留完整审计日志，界面可回看。

## 9. 测试策略：agent 可视化自测（用户硬性要求）

不以「测试用例脚本覆盖率」为主验收手段。定义 **Dev Harness**：

1. app 在 dev 模式下开启 `--remote-debugging-port`，由 `plugin-devtools`（P1.6）暴露控制面。
2. agent（我）通过 CDP 连接：读取实际渲染 DOM、截图、真实点击/输入、读取主进程日志与 service 状态。
3. 验收 = agent 亲自操作 app 完成 spec 场景，并**基于看到的界面**给出结论；截图与 DOM 快照作为证据归档在
   `docs/acceptance/<spec-id>/`。
4. 单元/集成测试脚本仍保留，但只用于纯逻辑（选择器解析、分页、schema 校验），不作为功能验收的唯一依据。

---

## 10. 当前进度

- [x] Cordis v4 API 实测验证（§3）
- [x] 主体计划定稿（本文档）
- [ ] 三源项目逐仓库深度分析 → `docs/research/source-repos-analysis.md`
- [ ] P1 详细计划 → `docs/plans/01-framework/plan.md`
- [ ] P1 spec → `docs/specs/01-framework/spec.md`
- [ ] P1 实施
