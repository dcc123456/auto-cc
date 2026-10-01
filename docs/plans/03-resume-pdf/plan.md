# 计划三 · PDF 编辑 / 简历生成（plan，**双轨**）

> 前置：P1 骨架（尤其 1.2 渲染层与安全策略、1.3 store、1.4 IPC、1.7 打包）。
> 与 P2/P4 的关系：本计划**不依赖 P2**，可并行；P4 的产出（定向内容）是本计划生成轨的数据来源之一，
> 但 P3 先用手工/占位内容即可验收，M5 才需要 P4.5 就位。
> 规范依 `AGENTS.md`；取证依 `docs/research/source-repos-analysis.md` §2.1 / §2.3 / §4。

## 0. 为什么是双轨（取证结论，不是拍脑袋）

两个来源解决的是**不同问题**，历史上把它们当一件事会让 P3 做错方向：

| 轨                                 | 解决的问题                                                      | 来源                                                                                             | 产物形态                    |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------- |
| **生成轨**（主线，M5 判据来源）    | 「按 JD 从零产出一份干净、可控、可复现的简历 PDF」              | `ai-resume`：5 套 HTML 模板 + prompt + factCheck（MIT 声明）                                     | 结构化 JSON → HTML → A4 PDF |
| **编辑轨**（用户坚持保留原版式时） | 「在我已有的简历 PDF 上，按 JD 改某几处文字，其余排版一点不动」 | `canva-pdf`：三引擎路由 + overlay + 字符级 quad + MuPDF 涂黑 + CJK 子集（MIT 声明，依赖含 AGPL） | 原 PDF 字节 + 保真改写      |

**默认走生成轨**。编辑轨是可选增强，排在 3.4–3.6，若工时紧张可推迟到 P5 之后，
但 3.4 的 WASM 加载可行性必须提前给结论（它决定包体与 CSP，影响 1.7）。

## 1. 技术选型与理由

| 项             | 选择                                                                           | 理由与否决                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 简历排版真相源 | **文档模型 JSON（Schema 校验）+ HTML/CSS 模板**                                | 可解释、可 diff、可被 P4 生成；否决「在 PDF 上直接编排所有版式」（成本与腐化都快）                                                            |
| PDF 生成       | Electron `webContents.printToPDF`（离屏 `WebContentsView`/隐藏窗口打印）       | **必须替换掉 `ai-resume` 的 Puppeteer**：Puppeteer 要下载 Chromium，违反主计划 §1.4 零前置依赖；Electron 自带同一内核，打印结果与预览同源     |
| 预览           | 渲染层 React 组件（同一模板渲染 HTML），所见即所得                             | 预览与导出共用模板，杜绝「预览好看、导出跑版」双真相源                                                                                        |
| 字体           | **随包内嵌**子集化 CJK 字体；打印前用 `document.fonts.ready`                   | 三端系统字体不一致（win 宋体 / mac 苹方 / linux 可能缺字）必致跑版缺字；这是三端一致性的头号风险                                              |
| 保真编辑       | 抽 `canva-pdf` 的 `core/writer` + `core/engine`，引擎路由 MuPDF→PDFium→pdf-lib | 它已实测「字符级白底 + 矢量保留 + 真涂黑」；zustand store 耦合必须改为显式入参                                                                |
| WASM 引擎      | 随包内嵌（不首启动下载），经自定义协议/`file` + CSP 白名单加载                 | `mupdf` 与 `pdfjs-dist` 为 **AGPL-3.0**：作为未修改库消费，分发须附 NOTICE；`canva-pdf` README 自述 MIT 但**无 LICENSE 文件**，抽取前须补授权 |
| 存储           | `store`（node:sqlite）存文档 JSON + 版本快照；PDF 文件落 userData 目录         | 复用 1.3，不新建存储层                                                                                                                        |

### 1.1 生成轨打印管线可行性结论（本机 Windows / Electron 44.4.5 实测）

3.3 是 M5 判据主体，落码前按 §6.2 先读 `electron.d.ts` 坐实 API，并解决「中文字体随包内嵌」这一头号跨端风险：

- **`printToPDF` 可用且够用于 A4**：`webContents.printToPDF(options: PrintToPDFOptions): Promise<Buffer>`（d.ts:18535），
  `PrintToPDFOptions` 原生含 `pageSize: 'A4'`、`margins`、`printBackground`、`preferCSSPageSize`、`scale`、`displayHeaderFooter`、`pageRanges`。
  → 模型 `DEFAULT_LAYOUT`（A4 + mm 边距）可 1:1 映射到打印选项（兑现 3.3-03「配置集中、无散落魔法数」），产物是 Buffer 直接落 userData（无需 Puppeteer，兑现 3.3-02）。
- **分层落点（AGENTS.md §4.1）**：`printToPDF` 依赖 `WebContents`，而视图/窗口归 L1 `shell`（见 `packages/shell/src/view-takeover.ts`），
  L2 `resume-doc` **禁止反向依赖 L1**。故打印执行器落在 shell/main，`resume-doc` 只交出「渲染 HTML + 打印选项 + 字体 @font-face 源」，经依赖注入被 shell 调用；`resume.export.toPdf` 的 service 门面在 resume-doc，实际 `printToPDF` 由注入的打印端口完成。
- **中文字体已选定并内嵌**：取 `Noto Sans SC`（Google，SIL OFL 1.1，允许内嵌 + 子集化）的 `chinese-simplified` + `latin` 两档字重 woff2（合计约 2.3 MB），
  落 `resources/fonts/**`，许可证全文随附 `resources/fonts/OFL.txt` 并记入 `LICENSES.md`。打印 HTML 经 `@font-face` 声明该字体，Chromium 打印时按用到的字形**自动子集内嵌**，产物字形三端一致（服务于 3.3-05/06/07）——**无需另引 fontkit 之类的子集化依赖**。
- **本机实跑已通过（spike：隐藏窗口 `loadURL(file://)` → `document.fonts.ready` → `printToPDF({preferCSSPageSize:true, printBackground:true, margins:0})`）**，对产物做字节级读数（不引第三方 PDF 解析，避开 3.4 的 AGPL/pdf-lib 依赖）：

  | 用例             | 结果                                                                                     | 对应机制腿                                                        |
  | ---------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
  | 单页简历         | `%PDF-1.4` / 1 页 / 24,916 B / `FontFile`=真 / `ToUnicode`=真 / 命中原名 `NotoSansSC`=真 | 3.3-02 无 Puppeteer、3.3-05 字体随包内嵌、3.3-07 文字可搜索非位图 |
  | 26 段长文        | `%PDF-1.4` / 2 页 / 27,049 B（页数随内容增长、未腰斩丢字）                               | 3.3-03 A4+mm 边距经 `@page` 生效、3.3-09 页数可从产物回读         |
  | 两份不同文档并发 | 各自 hash 不同（`81f636…` vs `e02ac8…`），互不串内容                                     | 3.3-12 并发导出安全                                               |

  产物体积在「单份简历 PDF」合理阈值内（3.3-06 体积腿达标；字形数精确子集比对待实现期用真实字体度量核）。

- **仍待 CDP harness + 你在场取证的纯 V 腿**：3.3-01（预览 DOM 与导出位图逐页比对）、3.3-04（连续 5 次导出无窗口闪现截图）、3.3-08（跨页条目不被腰斩的截图）、3.3-10（给定 JD 内容→PDF→截图）、3.3-11（注入失败的错误态界面截图）——这些是「看得见」的判据，须由真实渲染层 + harness 出图（§7.1），机制已在 spike 里跑通但截图腿不提前判过。

> spike 代码在 `.research-repos/print-spike/`（工作区外，§6.4 不入主干），结论进本节。落码阶段据此把「渲染 HTML + 打印选项 + 字体源 + 产物结构读数」放在 resume-doc（纯、可单测），把唯一碰 `WebContents` 的打印执行器放 shell（经注入）。

## 2. 包与 service

```
packages/
  resume-doc/   @auto-cc/resume-doc    # 文档模型 + Schema + 模板注册 + 生成轨渲染
  pdf-edit/     @auto-cc/pdf-edit      # 编辑轨：WASM 引擎装载、overlay、导出管线
```

| service           | 归属       | 职责                                                                                       |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `resume.model`    | resume-doc | `validate(json)` / `normalize(json)` / `diff(a,b)`；事实锁定字段标记不可被生成轨改写       |
| `resume.template` | resume-doc | `list()` / `get(id)` / `render(json, templateId)` → HTML                                   |
| `resume.export`   | resume-doc | `toPdf(renderTarget, options)` → 产物路径 + 内容 hash；字体就绪检查在此，失败给可读错误    |
| `resume.snapshot` | resume-doc | `save(json, meta)` / `list(resumeId)` / `restore(id)`；投递所用版本可追溯（接 2.6-05）     |
| `pdf.io`          | pdf-edit   | `open(path)` → 文档句柄；`close`；页面元信息                                               |
| `pdf.edit`        | pdf-edit   | overlay 文本块/图片/涂黑的增删改；undo/redo 经 `core` 的 effect 生命周期，不引第二套历史栈 |
| `pdf.export`      | pdf-edit   | 保真导出（flatten → textBlockEdits → redact → cjkFont 管线）；涂黑失败**必须中止**不得降级 |

**复用核对（写代码前先确认，AGENTS.md §2.1）**：配置/日志/存储/IPC/错误/额度全部走 P1 已有 service；
渲染层组件与 i18n/Tailwind/lucide 基建走 1.2；不得在 `pdf-edit` 内自建第二套字体装载器或第二套 PDF 解析。

## 3. 关键设计点

1. **文档模型**：区块（section）→ 条目（entry）→ 字段；带度量（字号、行距、边距、分栏）。
   每个条目携带 `facts` 标记（公司/职位/起止时间/数字成果）——**这些字段只允许来自 P4 知识库，生成轨不得新造**。
2. **模板 = 纯函数** `render(doc) => HTML`（沿用 `ai-resume` 的模板形态：零依赖、可单测、可 diff）。
   模板不做数据加工，只排版；数据不合法是模型的错，不是模板的错。
3. **打印路径唯一**：预览用的 DOM 与导出用的 DOM 必须是**同一份**（导出时把同一 HTML 载入隐藏视图后 `printToPDF`），
   并显式处理 `print-color-adjust`、页边距归零、A4 尺寸与 `preferCSSPageSize`。
4. **分页可控**：条目不允许跨页被腰斩（`break-inside: avoid`），区块顺序可重排；分页结果反馈进模型（`pages` 度量）供编辑器显示。
5. **编辑轨的涂黑语义**：真删除字节（MuPDF `applyRedactions`），失败即中止导出——
   绝不能出现「看起来涂掉了但文本还在」的假脱敏（这是 `canva-pdf` 已验证的行为，必须原样保住）。
6. **版本快照**：每次导出产生 `{snapshotId, docJson, templateId, fontSet, hash, createdAt}`；
   投递记录引用 `snapshotId`（2.6-05），可 diff 两份简历差异。
   - **落点（3.7-01 / 04 / 05）**：新增 `resume.snapshot` 服务（`packages/resume-doc/src/snapshot-store.ts`，迁移号段 8，表 `resume_snapshots` 一导出一次行、永不覆盖），复用 `store.db` 与 `contentHash`/`normalizeDocument`（不新建连接、不重造摘要，§2.7）。它与 `resume_docs` 分表：后者是「当前工作副本」（UPSERT 覆盖），快照是「导出瞬间的不可变事实」，读写语义相反故不合表。`resume.export.toPdf` 在页数回写后 `record(finalDoc, …)`，与那次 `resume_docs.save` 吃同一份 `finalDoc`，于是快照 hash 与导出回执 hash 同源一致；`fontSet` 取自打印门面 `resumePrint.fontSet`（`FONT_SET_ID`），字体集与产物字体同源。保留上限 `maxSnapshots`（配置项，默认 20）在每次 `record` 后按 `created_at DESC, rowid DESC` 裁最旧。3.7-02（投递引用 snapshotId）与 3.7-03（diff 界面）留待后续片，不在本片越界接线。

## 4. 测试策略

| 层级       | 手段                                                                                       | 覆盖                  |
| ---------- | ------------------------------------------------------------------------------------------ | --------------------- |
| U          | Schema 校验、模板纯函数快照、diff、分页断言、字体子集统计                                  | 3.1 / 3.2 / 3.3 / 3.7 |
| C          | 产物 PDF 可被解析回文本且**中文不乱码**、字形数符合子集预期、体积在阈值内、无外部字体请求  | 3.3 / 3.5             |
| V          | 界面预览与导出 PDF 逐页截图比对（同一份 DOM 应完全一致）；编辑器拖拽即时反馈               | 3.3 / 3.6             |
| 编辑轨专项 | 用固定样例 PDF：改一处文字 → 导出 → 解析回文本断言「新字在、旧字节级不存在、其余文本原样」 | 3.4 / 3.5             |

依赖许可审计（3.3-08 / 3.4-06）：`pnpm licenses` 输出与 `LICENSES.md` 一致，AGPL 条目必须出现在 NOTICE 中。

## 5. 子计划分解与顺序

| #   | 子计划                                                                                                                    | 完成判据                                                | 依赖                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| 3.1 | 文档模型与 Schema（含 `facts` 事实锁定标记、diff）                                                                        | spec 3.1 全绿                                           | 1.3                       |
| 3.2 | 模板系统：模板抽取/重写为纯函数、注册表、多模板切换、数据绑定                                                             | spec 3.2 全绿                                           | 3.1                       |
| 3.3 | **生成轨渲染管线**：React 预览 → 隐藏视图 `printToPDF` → A4 分页/度量 → 中文字体内嵌与跨端回退                            | spec 3.3 全绿（含 M5 前半判据：产出指定 JD 的简历 PDF） | 3.2 / 1.2                 |
| 3.4 | 编辑轨前置：**WASM 三引擎在 Electron 的装载可行性**（mupdf / @embedpdf-pdfium / pdf-lib 路由、CSP、随包内嵌、体积与三端） | spec 3.4 全绿或明确记缺口并回写主计划                   | 1.7                       |
| 3.5 | 编辑轨保真改写：overlay 模型、字符级 quad 白底重画、真涂黑、CJK 子集导出（抽 `canva-pdf` `core/writer`）                  | spec 3.5 全绿                                           | 3.4                       |
| 3.6 | 版面编辑器：区块拖拽重排、字号/边距/行距调节、实时预览、撤销重做                                                          | spec 3.6 全绿                                           | 3.3（编辑轨增强排后也可） |
| 3.7 | 版本与快照：导出即快照、可 diff、投递引用（接 2.6-05）                                                                    | spec 3.7 全绿                                           | 3.3                       |

> **3.4 是 P3 的分水岭**：它是一次**可行性探测**，结论会影响包体大小、CSP 策略与 1.7 打包配置。
> 若 3.4 判定编辑轨代价过高（例如 WASM 装载在打包环境不可靠），则编辑轨整体降级，
> 并把结论写回 `docs/00-master-plan.md` §6，而不是留下半残实现。

## 6. 明确不做

- 不做通用 PDF 编辑器（`canva-pdf` 是完整产品，我们只取简历所需子集：文本块编辑、涂黑、图片/签名叠加、页面增删）。
- 不做 DOCX 导出（简历投递以 PDF 为准；DOCX 属 P5 之后按需评估）。
- 不做在线模板市场、不做模板付费（与 §1.5 商业化口径不同：付费点在投递额度，不在模板）。
- 不做扫描件 OCR（P4.1 若遇扫描件按「需人工补录」处理，不在 P3 引入 OCR 依赖）。
- 不引入 Puppeteer / 任何 Chromium 下载链；不引入第二套富文本编辑器（编辑轨的文字编辑走 overlay，不引 TipTap 到简历主流程）。
- 不在渲染层直接写 PDF 文件（一律经 service，保持 IPC 契约与可测试性）。
