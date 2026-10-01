# 源项目抽取分析（P1-02 产出）

> 本文档是 P2/P3/P4 抽取决策的**唯一证据基线**。所有结论均来自对源码的本地实测读取，
> 不采信 README 自述之外的二手转述。标注 `[实测]` 的条目给出可复现路径。

## 0. 取证方法与环境事实

网络前提：本机 `git clone` GitHub 与 GitHub Releases 直连不可用（`Recv failure: Connection was reset`）。
改用 codeload 拉取默认分支源码 tarball 并解包，得到三份可完整读取的工作副本 `[实测]`：

| 仓库                        | 默认分支 | 本地路径（取证副本）                                                    |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `dcc123456/canva-pdf`       | `main`   | `D:\works\deep-seek-workspace\.research-repos\src\canva-pdf-main`       |
| `dcc123456/browser-copilot` | `main`   | `D:\works\deep-seek-workspace\.research-repos\src\browser-copilot-main` |
| `dcc123456/ai-resume`       | `master` | `D:\works\deep-seek-workspace\.research-repos\src\ai-resume-master`     |

**`browser-copilot` 后续多了一份副本** `[实测 2026-09-30]`：`D:\works\deep-seek-workspace\browser-copilot`
是 `git clone`（HEAD `984cf3d`，含 `.git` 与 `node_modules`），比上表的 tarball 解包副本更新。
两份内容会漂移，**下文引用的 `文件:行` 只对 git clone 那一份有效**；引用时必须写清是哪一份，
不要用一份的行号去解释另一份。

这三份副本是**只读参考**，永不作为依赖引入 auto-cc，也不参与 auto-cc 的构建。
`docs/research/` 之下不复制其源码；引用时只写路径与行号。

---

## 1. 许可证红线（先于一切设计决策）

| 仓库              | 自身代码许可                                                                                                      | 运行时依赖许可                                                                                                          | 结论：可否搬代码                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `canva-pdf`       | README §许可证 声明 **MIT**；**但仓库无 `LICENSE` 文件、`package.json` 无 `license` 字段** `[实测]`               | `pdfjs-dist` **Apache-2.0** `[实测更正 2026-10-01]`、`mupdf` **AGPL-3.0**、`pdf-lib`/`fontkit` MIT `[实测 README 致谢]` | **可搬**，但必须：①要求作者补 LICENSE 文件；②分发附完整 NOTICE |
| `browser-copilot` | **PolyForm Noncommercial 1.0.0**，`LICENSE` 文件与 `package.json` 双处明示，Copyright (c) 2026 dcc123456 `[实测]` | Playwright / tesseract.js / @xyflow/react 等                                                                            | **不可搬**（在商用前提下）。只能做**行为与架构移植**，逐行重写 |
| `ai-resume`       | README §License 声明 **MIT**；`server/package.json` 写 `ISC`；**同样无 `LICENSE` 文件** `[实测]`                  | ChromaDB、Puppeteer、mysql2、pdfkit、mammoth                                                                            | **可搬**（纯逻辑模块），但注意其依赖不要一起带进来             |

### 1.1 由许可证推导的三条硬约束

1. **P2 的全部实现必须是 clean-room**。auto-cc 有明确商用意图（§1.5 商业化预留：按投递次数付费）。
   `browser-copilot` 是 PolyForm 非商用授权，因此 auto-cc 中**不得出现该仓库的任何代码、任何字面复制的
   prompt 文本、任何复制的图标/UI 资源**。允许保留的是**概念**（snapshot→ref→act→observation 协议、
   IR→compile 单向编译、失败分类自愈的环路设计），概念不受版权保护。
2. **AGPL 依赖必须显式记账**。`mupdf` 是 AGPL-3.0。作为未修改库消费不传染源代码，
   但**分发即触发 NOTICE 义务**，且若我们对 WASM 产物做任何修改则传染。P3 必须先做「依赖许可清单」验收项。
   **实测更正（2026-10-01，写本节时它是二手转述）**：`pdfjs-dist` **不是** AGPL-3.0——
   本行原先的「AGPL-3.0」来自 `canva-pdf` README 的致谢段，而拉取发布产物（6.3.289 与 2.16.105 两个时点）
   内的 `LICENSE` 文件读到的都是 **Apache-2.0**。结论：P4 4.1 抽 PDF 文本可以消费 `pdfjs-dist` 而**不触发 AGPL NOTICE**；
   `mupdf` 仍按 AGPL 记账。证据与推导写在 `docs/plans/04-resume-kb/plan.md` §1.1。
3. **MIT 声明缺 LICENSE 文件 = 授权不完整**。`canva-pdf` 与 `ai-resume` 都只在 README 里写了许可，
   仓库里无 LICENSE 文件、`canva-pdf` 的 package.json 还缺 `license` 字段。在把它们当作抽取来源之前，
   需要补齐（或从作者取得书面授权）。

### 1.2 许可豁免记录（原「待用户确认的唯一阻塞项」，已确认）

三个仓库的版权方都是 `dcc123456`。**2026-09-30 由版权方本人（即本项目的需求方）在对话中确认：
三个仓库均为其本人所有，可自由改授。** 因此：

- `browser-copilot` 的 PolyForm Noncommercial 1.0.0 约束由版权方自行豁免，**P2 允许直接移植其算法代码、
  prompt 文本与站点知识**，不再强制 clean-room。
- `canva-pdf` / `ai-resume` 的 MIT 声明同样成立，可搬代码。

**仍然有效的三条限制，不因豁免而消失**：

1. **AGPL-3.0 依赖是第三方的，版权方无权豁免**：`pdfjs-dist`、`mupdf` 的 NOTICE 与「修改即传染」义务照旧，
   P3 的依赖许可清单验收项不降级。
2. **豁免需要落成文件**，不能只存在于聊天记录里。落地方式二选一，P2 开工前完成其一：
   ① 在三个源仓库各补一个 `LICENSE` 文件（`canva-pdf` / `ai-resume` 目前只在 README 里写了许可）；
   ② 由版权方在 auto-cc 仓库内提交一份书面授权说明（谁、哪个仓库、豁免到什么程度、日期）。
   在此之前，本仓库**仍按不搬运代码执行**——移植动作以该文件的存在为前置条件。
3. 若源仓库中还有第三方贡献者的提交，其 portions 不在豁免范围内，需单独核对。

本套文档此前按**保守假设（不可搬代码）**编写；上面第 2 条把「已确认可搬」与「实际开始搬」分开，
避免用一句口头确认替代许可记账。各 plan 的「移植方式」列在授权文件落地后改为「直接移植」。

---

## 2. 逐仓库能力内核

### 2.1 `canva-pdf`（内部名 `minipdf`）— 保真 PDF 编辑器

**定位**：纯浏览器本地 PDF 编辑器，~12.9k 行非测试 TS。Vite + React 19 + Tailwind + zustand + immer + TipTap。

**三引擎路由**（其最有价值的架构，`src/core/engine/router.ts`）：
按优先级 MuPDF（字节级真删字）→ PDFium（对象级删除+重画）→ pdf-lib（白底 overlay 兜底）降级。
`mupdf` npm 包最初是 Node 原生绑定、不能进浏览器 bundle，故最终走 MuPDF.js WASM `[实测 README 决策日志 1]`。

**可抽取内核**（低耦合、纯 TS/异步）：

| 路径                                             | 能力                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `src/core/writer/` 全部                          | 导出管线：redact / flatten / text-overlay / textBlockEdits / textQuad / cjkFont / pages |
| `src/core/engine/{router,types,fontClassify}.ts` | 引擎无关的编辑能力路由                                                                  |
| `src/core/mupdf/loader.ts`                       | WASM 加载与私有 ArrayBuffer 副本处理                                                    |
| `src/core/pdf/{textColor,renderer}.ts`           | pdfjs 渲染 + span 颜色/字符 quad 抽取                                                   |
| `src/core/project/serialize.ts`                  | `.minipdf.json` 存档序列化                                                              |
| `src/core/templates/`                            | 内置模板，**含 `resume-modern`**                                                        |
| `scripts/experiment-subset.mjs`                  | CJK 子集化的实测脚本（200 汉字 → 201 字形，68.5KB vs 7289KB，106x）`[实测]`             |

**耦合点**：`store/*`（zustand）被 loader/router 直接 import，抽取时须改为显式注入；React 组件层、
TipTap 浮层、Tailwind 主题不抽。

**与招聘/求职的关系**：`grep zhipin|boss|直聘` 零命中 `[实测]`。它是**纯工具**，不含任何岗位逻辑。

### 2.2 `browser-copilot` — 浏览器自动化 + 工作流引擎

**定位**：Chrome MV3 侧栏 AI 助手（~111k 行）+ 独立 Node 侧 `server/browser-copilot-runner`（fastify + Playwright + ws + croner + zod + pino）。

**两条执行通道**，这是它最值得学的结构：

- 扩展通道：`src/background/driver.ts` 经 `chrome.debugging`(CDP) + 注入 `src/inpage/kernel.ts`（~2.7k 行 DOM 原语）操作**真人浏览器**；
- runner 通道：`server/src/` 用 Playwright 跑**无人值守**流程。

**算法级资产（概念可移植，代码不可搬）**：

| 主题       | 路径                                                                                        | 价值                                       |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 选择器生成 | `src/inpage/element-picker/build-selector.ts`                                               | data-testid/role/text 多策略运行时生成     |
| 定位自愈   | `src/lib/workflow/{element-fingerprint,locator-score,target-to-selector,selector-probe}.ts` | 候选定位器打分与失效重定位                 |
| 工作流 IR  | `src/lib/workflow/{ir,workflow-compiler,types}.ts`                                          | 语义 IR → 确定性编译，68 种积木 catalog    |
| 失败自愈   | `src/background/workflow-engine/{engine,executors,repair/}`                                 | 失败分类 / 根因分析 / 失败记忆             |
| agent 协议 | `src/lib/{tool-catalog,providers,system-prompt}.ts`                                         | 36 工具目录、多供应商配置表、14 条操作规约 |
| MCP 桥     | `public/mcp-server.mjs` + `src/lib/mcp-adapter.ts`                                          | 零依赖 stdio↔WS                            |

**关键负向结论**：`grep zhipin|boss|liepin|直聘|猎聘|打招呼` **零命中** `[实测]`。
仓库里**没有**任何招聘平台选择器，也**没有**打招呼话术库；站点知识被设计为外置 Skill（`skills/<slug>/SKILL.md`）
与录制工作流。唯一招聘痕迹是 `upload-file` 积木的语义短语表含「上传简历」`[实测 operator-registry.ts L133-152]`。
→ **auto-cc 的 BOSS 直聘选择器、字段顺序、话术模板必须自建**，`browser-copilot` 只提供承载它们的引擎。

### 2.3 `ai-resume` — 简历结构化 + 生成质量控制

**定位**：Express 5 + MySQL 8 + ChromaDB + Puppeteer 的简历优化 SaaS 原型（server ~2k 行），client React + shadcn。

**可抽取（MIT 声明 + 零/低依赖纯逻辑）**：

| 路径                                      | 能力                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `server/src/services/factCheckService.ts` | **levenshtein 归一化比对，公司/职位/时间被篡改则 RETRY_APPEND 重试一次**——防 LLM 编造经历的核心防线 |
| `server/src/keywordService.ts`            | 关键词匹配率（朴素 includes）                                                                       |
| `server/src/utils/templates/*.ts`         | 5 套简历模板，纯函数 `render(ResumeJson) => HTML`，零依赖，**可直接搬**                             |
| `server/src/prompts/resumeGenerate.ts`    | 「事实锁定 + STAR 重写 + 顺序调序」prompt 约束                                                      |
| `server/src/utils/fileParser.ts`          | PDF/Word 抽文本；<100 字符判定扫描件                                                                |
| `server/src/utils/pdfImageExtractor.ts`   | pdf-lib 解 XObject 抽图（含头像）                                                                   |
| `server/src/llm/baseProvider.ts`          | OpenAI 兼容客户端：指数退避重试 + markdown 代码块 JSON 清洗                                         |
| 表结构 `base_resume / custom_resume / jd` | 数据模型骨架                                                                                        |

**必须丢弃**：Express 路由、JWT/多用户 auth（桌面单机不需要）、`db/connection` 全局 mysql2 池、
落盘 `saveFile`、**Puppeteer 打印**（与 Electron 打包冲突，改 `webContents.printToPDF`）。

**RAG 现状的诚实评估（重要，勿高估）**：所谓「个人知识库」= 关系表 + 1 个 Chroma 集合。
`vectorService.ts` 只用 embedding 做**简历查重**（0.95 阈值）与删改同步；
embedding 走 LLM 网关 `/embeddings`，**失败时退化为 sha256 哈希伪向量（1536 维，仅演示意义）**；
**无 chunking、无检索增强生成**——生成时把 base_json 全量塞进 prompt `[实测]`。
→ P4 的检索层必须自建，`ai-resume` 能给的只有「生成质量控制」这一段。

---

## 3. 抽取决策映射表

| auto-cc 模块                  | 抽取来源（概念/代码）                                       | 移植方式             | 风险与前置                                                           |
| ----------------------------- | ----------------------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `browser.kernel`（P2.1）      | Electron `WebContentsView` + `session.fromPartition`        | **自建**，无外部代码 | 不引入第二套浏览器内核；分区持久化是 M2b 判据                        |
| `browser.locator`（P2.2）     | `browser-copilot` 的 fingerprint/locator-score **算法概念** | clean-room 重写      | PolyForm；不得复用代码与注释                                         |
| `platform.boss`（P2.2/2.3）   | **无来源——完全自建**                                        | 自建站点知识包       | 选择器/字段顺序/失败分支仓库里都不存在                               |
| `workflow.runner`（P2.4）     | IR→compile→repair **环路结构**                              | clean-room 重写      | 体量 111k 行，只取 IR+compiler+repair 三环，勿整体吞                 |
| `resume.render`（P3 生成轨）  | `ai-resume` 5 套 HTML 模板 + prompt + factCheck             | **直接搬**（MIT）    | 模板需重做样式基线；打印换 `printToPDF`                              |
| `pdf.engine`（P3 编辑轨）     | `canva-pdf` `core/writer` + `core/engine`                   | **直接搬**（MIT）    | 需 LICENSE 文件；3 个 WASM 引擎在 Electron 的加载与 CSP；AGPL NOTICE |
| `resume.kb`（P4.2/4.3）       | 表结构 + 查重思路；**检索层自建**                           | 部分搬 + 自建        | ChromaDB 是外部 docker 服务 → **违反「只装一个 app」红线，必须移除** |
| `greeting.script`（P2.5/4.6） | **无来源——完全自建**                                        | 自建话术库           | 两仓库均无话术；`ai-resume` prompt 风格可参考                        |
| `llm.provider`（跨 P2/P4）    | `ai-resume/baseProvider.ts`（重试 + JSON 清洗）             | **直接搬**（MIT）    | 供应商表自建（OpenAI 兼容即可）                                      |

---

## 4. 对既有计划的修订（本次取证直接导致的改动）

1. **P3 由单轨改双轨**：原 P3 只写了「模板 → 渲染 → PDF」。取证表明来源仓库解决的是两个不同问题——
   `ai-resume` 是**从零生成**（HTML 模板 → 打印），`canva-pdf` 是**在既有 PDF 上保真改写**（三引擎 + overlay）。
   产品链路里「根据 JD 优化简历」两者都要：默认走生成轨（可解释、可控、M5 的判据来源），
   当用户坚持保留原简历版式时走编辑轨。子计划表已按 3.1–3.7 重排。
2. **P4 检索方案改判**：ChromaDB（docker 服务）与 sha256 伪向量都不可用。改为
   **默认本地 BM25/倒排关键词检索（零原生依赖、离线可用），embedding 为可选增强**。
   理由：个人知识库规模小（数十至数百条经历、千级 chunk），JS 内存暴力余弦在毫秒级；
   引入 `sqlite-vec` 需要三端预编译原生扩展，与「用户零前置依赖 / 无 node-gyp」红线冲突。
3. **P2 的执行通道选定为「内核内 CDP/注入」，而非 runner+Playwright**：
   `browser-copilot` 的 Playwright runner 对应「服务器无人值守」形态，与我们的桌面形态不符；
   其扩展通道（CDP + 注入 kernel 操作真实页面）才是与 Electron `WebContentsView` 同构的路径。
4. **P1.7 打包新增约束**：三引擎 WASM + CJK 字体必须**随包内嵌**，且 `file://`/自定义协议 + CSP
   需要预先验证；这条已在 P1 spec 1.7 增补为验收项。
5. **新增「依赖许可清单」为发布门禁**：P5 发布前必须产出 `LICENSES.md`（含 AGPL 条目与 NOTICE），
   且每条抽取来源要能回溯到本表的某一行的某一许可判定。

---

## 5. 三仓库共同缺失（这些必须 auto-cc 自建，勿假设可抽取）

| 缺口                                 | 影响子计划 | 处置                                        |
| ------------------------------------ | ---------- | ------------------------------------------- |
| BOSS 直聘/猎聘的页面选择器与字段顺序 | 2.2 / 2.3  | 自建站点知识包，选择器多策略 + 失效重定位   |
| 打招呼与追问话术库                   | 2.5 / 4.6  | 自建，绑定 JD + 知识库证据                  |
| 「合适时机投递」的判定逻辑           | 2.6 / P5   | 自建：规则 + 信号（已回复/已交换/HR 活跃）  |
| 真正的 RAG（chunking + 混合检索）    | 4.3        | 自建，见修订 2                              |
| 登录态持久化与失效探测               | 1.8 / 2.1  | 自建，Electron session API                  |
| 额度计量与付费闸门                   | 1.9 / 2.6  | 自建，`entitlement.gate` + `usage.ledger`   |
| 工作流可视面板                       | 1.10 / 2.8 | 自建 React（`@xyflow` 概念可参考，UI 重写） |
| 三端打包与免依赖验证                 | 1.7        | electron-builder，P1 内建                   |

---

## 6. 结论（三句话）

1. **`canva-pdf` 是唯一「拿来即用」的代码级来源**（MIT 声明，需补 LICENSE 文件 + AGPL NOTICE）：
   其引擎无关的 `core/writer` 导出管线是简历保真编辑的最优解；真正的工程难点在三个 WASM 引擎的 Electron 加载。
2. **`browser-copilot` 的价值是架构与协议，不是代码**（PolyForm 非商用）：
   双通道设计、IR→compiler→repair 工作流栈、定位器评分自愈算法，是 P2 应照结构重写的蓝图；
   而它**不含任何招聘平台知识**，这一点必须写进 P2 的排期假设。
3. **`ai-resume` 给的是「生成质量控制」而非知识库**：`factCheckService` 的防篡改闭环、5 套零依赖模板、
   OpenAI 兼容 provider 基类可直接搬；其 RAG 是演示级（哈希伪向量、无检索生成），P4 必须重做。
