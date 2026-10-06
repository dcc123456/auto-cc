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

## 0.1 编辑轨的可行性结论：**降级为轻编辑**（2026-10-04 由你裁定，2026-10-05 落地）

上面那句"必须提前给结论"今天兑现。结论是**降级**，不是做、也不是整条放弃：

- **放弃的部分**：在用户既有 PDF 上做**真编辑**——具体是"旧文字字节级不可恢复"的涂黑语义（`mupdf` 的 `applyRedactions`），
  以及为它服务的三引擎路由、WASM 随包内嵌、CSP 放开。**`mupdf` 永不引入**，`canva-pdf` 的代码**一行都不搬**。
- **保留的部分（= 轻编辑）**：在既有 PDF 上**叠加**白底矩形 + 新文字（内容流不改写）、页面增删与重排、撤销重做、导出为新文件不污染源文件；
  引擎只留 `pdf-lib` 一支（MIT、纯 JS、无原生依赖，兑现 §1.4）。
- **为什么这样切**：真编辑的唯一硬依赖是 AGPL-3.0 的 `mupdf`（`LICENSES.md` 行 23），叠加 `canva-pdf` 缺 LICENSE 文件那份书面豁免（要你署名，不代写）；
  而轻编辑的全部能力落在 MIT 的 `pdf-lib` + `fontkit` 上，零许可风险、零原生依赖，且覆盖式改动天然满足"其余版式一点不动"（我们根本不重写原内容流）。
- **失去的产品能力（如实登记，不假装补齐）**：「把一份已有的简历 PDF 按 JD 改几个字、其余逐字节保持原版式」里的**逐字节**这一半，
  以及"涂黑后旧文字提取不出来"这一半。替代路径是 4.1 解析 → 4.5 定制 → 3.3 重生成，**版式改由模板决定**，不再与原文件逐字节一致；
  需要"转发前真删敏感内容"的场景得另起裁定。反向验证（`AGENTS.md` §6.5：确认这次放弃没有打断任何已验收能力）写在 spec 新增的 `3.4-11`。
- **本节的取代关系**（原判据与原文一律保留、不删除，按 §4.5 只在此声明覆盖范围）：
  §0 双轨表里"编辑轨"那一行、§1 选型表的「保真编辑」「WASM 引擎」两行、§2 的 `packages/pdf-edit` 包与 `pdf.io` / `pdf.edit` / `pdf.export` 三行 service、
  §3 第 5 条（真涂黑）、§4 的"编辑轨专项"、§5 的 3.4 / 3.5 两行，**都按本节的降级路线重读**。
  spec 侧逐行的 dated 更正在 `docs/specs/03-resume-pdf/spec.md` 的 3.4 / 3.5 / 3.6 三张表的状态格里，行 ID 与原判据原文都不动。

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

| service           | 归属                                                                                                                                                                                        | 职责                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `resume.model`    | resume-doc                                                                                                                                                                                  | `validate(json)` / `normalize(json)` / `diff(a,b)`；事实锁定字段标记不可被生成轨改写       |
| `resume.template` | resume-doc                                                                                                                                                                                  | `list()` / `get(id)` / `render(json, templateId)` → HTML                                   |
| `resume.export`   | resume-doc                                                                                                                                                                                  | `toPdf(renderTarget, options)` → 产物路径 + 内容 hash；字体就绪检查在此，失败给可读错误    |
| `resume.snapshot` | resume-doc                                                                                                                                                                                  | `save(json, meta)` / `list(resumeId)` / `restore(id)`；投递所用版本可追溯（接 2.6-05）     |
| `pdf.io`          | pdf-edit                                                                                                                                                                                    | `open(path)` → 文档句柄；`close`；页面元信息                                               |
| `pdf.edit`        | 会话级：`addOverlay` / `removeOverlay` / `moveOverlay` / `setPageOrder` / `undo` / `redo`（都只改内存 draft）——**3.5-c₂ 实落为纯模型 `createPdfEditSession`，不是 service**（理由见 §7.14） | 3.5-08 已 `[x]`；02 / 03 / 07 随渲染层那一片                                               |
| `pdf.export`      | pdf-edit                                                                                                                                                                                    | 保真导出（flatten → textBlockEdits → redact → cjkFont 管线）；涂黑失败**必须中止**不得降级 |

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
   - **降级裁定（2026-10-05，原文保留）本条作废**：`mupdf` 不引入，就没有 `applyRedactions`。取代它的硬约束是**反过来的诚实**：
     轻编辑只覆盖、不删除，界面上**不得把覆盖说成涂黑**，导出物里旧文字仍可被提取（见 spec 3.5-04 的更正）。
     "看起来涂掉了但文本还在"这件事在旧路线里是**缺陷**，在新路线里是**已声明的产品语义**，所以必须靠措辞与界面标注把它说清，而不是靠断言它不会发生。
     原判据里"失败即中止、不产出半成品"的精神仍然保留，转移进 3.5-02 的新片验收。
6. **版本快照**：每次导出产生 `{snapshotId, docJson, templateId, fontSet, hash, createdAt}`；
   投递记录引用 `snapshotId`（2.6-05），可 diff 两份简历差异。
   - **落点（3.7-01 / 04 / 05）**：新增 `resume.snapshot` 服务（`packages/resume-doc/src/snapshot-store.ts`，迁移号段 8，表 `resume_snapshots` 一导出一次行、永不覆盖），复用 `store.db` 与 `contentHash`/`normalizeDocument`（不新建连接、不重造摘要，§2.7）。它与 `resume_docs` 分表：后者是「当前工作副本」（UPSERT 覆盖），快照是「导出瞬间的不可变事实」，读写语义相反故不合表。`resume.export.toPdf` 在页数回写后 `record(finalDoc, …)`，与那次 `resume_docs.save` 吃同一份 `finalDoc`，于是快照 hash 与导出回执 hash 同源一致；`fontSet` 取自打印门面 `resumePrint.fontSet`（`FONT_SET_ID`），字体集与产物字体同源。保留上限 `maxSnapshots`（配置项，默认 20）在每次 `record` 后按 `created_at DESC, rowid DESC` 裁最旧。
   - **落点（3.7-02，跨投递域）**：新增 `outbound.deliveries` 服务（`packages/outbound/src/delivery-record-store.ts`，迁移号段 **9**，表 `delivery_records`）。三种候选里选**独立表**：给 `usage_ledger` 加列会把「额度消耗」与「经过追溯」两种语义焊在一行，且简历域的事实要挤进 1.9 的账本 schema；把 `snapshotId` 编码进账本的 `source` 字符串则是用字符串承载关系，查不动也索引不了。表形状 `PRIMARY KEY = ledger_id`（成功投递一次一行，与账本行一一对齐、免费去重，回执不再多出第二个 id）+ `platform`/`job_id`/`ts`（回答「投给了哪个 JD」）+ `snapshot_id`（回答「当时内容是什么」，唯一真正新增的事实）。**只存引用不存正文**（正文经 `resume.snapshot.restore` 读回，§2.7 不造第二份文档 JSON）；不加 `status`（行只在页面确认送达 + 落账之后写，存在即已送达）；不加 `doc_id`（经快照一跳可达）——§2.6 不留假想字段。写入点夹在 `gate.perform` 之后，`outbound.deliver` 硬 `inject` `outbound.deliveries`：缺它整条投递 PENDING，「发出去了却查不到」结构上不可能。快照引用从 IPC 请求与工作流节点参数 `snapshot` 两个入口进；agent 工具入参暂不含（还没有 `resume.export` 工具，让模型填一个它拿不到的 id 等于教它编造，P4 再接）。
   - **落点（3.7-03，diff 界面）**：比对能力**不加新实现**——`resume.snapshot.diff(from, to)` 只是「两侧各 `restore` 一次（含权威校验）→ 交 3.1-06 的 `diff()`」的薄壳，读不回合法文档时抛 2 参 `AppError('INVALID_ARGUMENT')` 并指明是起点还是终点（不静默给空 diff，否则界面会把「快照坏了」显示成「内容一致」）。界面在诊断视图的 `ResumePanel` 上加「快照历史 / 比对差异」，`snapshot.list` 后把两个下拉预置成最旧↔最新，一次点击就能看到差异；渲染层只摆主进程读数（§2.5），文档 JSON 不过进程边界（IPC 只传两个快照 id）。**diff 内容从哪来**是这一片唯一需要决策的地方：编辑轨（3.5）之前界面没有录入入口，而当日的所有导出路径都不会改变文档正文（模板/语言属呈现，不进 `contentHash`），于是给 `seedDemo` 加一个可选 `variant='edited'`——它是 3.3-10 已定性的「开发自测种子」的延伸，改两处自由文本 + 整块追加项目经历，专门造出 3.7-03 要展示的两种变化（字段级修改 + 条目级新增）。**退场条件**：3.5 落地后由真实编辑取代并删除该变体（§2.4），届时它的单测一并转成编辑轨回归。**已知覆盖面边界**：3.1-06 的 `diff()` 只比区块/条目/字段三层，`profile` 与区块标题的改动不进 diff——这条要连同 3.5 的 profile 编辑入口一起补，不在本片偷偷扩。

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

**2026-10-05 兑现**：结论 = 降级（见 §0.1），已写回 `docs/00-master-plan.md` §6 第 11 条，spec 的 3.4 / 3.5 / 3.6 三张表逐行留了 dated 更正；
半残检查实测为零（`packages/` 下没有 `pdf-edit`，全仓 0 处 `canva-pdf` 代码，CSP 没为 WASM 放开过一行）。
**这一片接下来的实现顺序**（另起子计划窗口，先 plan 再落码，§0）：3.4-03（`pdf-lib` 装载）→ 3.5 的七条轻编辑判据 → 3.6 的九条排版编辑器判据；
3.7-03 那个 `seedDemo` `variant` 的退场条件从「3.5 落地」改挂「3.6 落地」（spec 3.7 注记已同步）。

## 6. 明确不做

- 不做通用 PDF 编辑器（`canva-pdf` 是完整产品，我们只取简历所需子集：文本块编辑、涂黑、图片/签名叠加、页面增删）。
- 不做 DOCX 导出（简历投递以 PDF 为准；DOCX 属 P5 之后按需评估）。
- 不做在线模板市场、不做模板付费（与 §1.5 商业化口径不同：付费点在投递额度，不在模板）。
- 不做扫描件 OCR（P4.1 若遇扫描件按「需人工补录」处理，不在 P3 引入 OCR 依赖）。
- 不引入 Puppeteer / 任何 Chromium 下载链；不引入第二套富文本编辑器（编辑轨的文字编辑走 overlay，不引 TipTap 到简历主流程）。
- 不在渲染层直接写 PDF 文件（一律经 service，保持 IPC 契约与可测试性）。

## 7. 轻编辑子计划（降级路线的**实现面**，2026-10-05）

> 你 2026-10-05 的裁定：**先写 plan、不落码**。所以本节只交付选型证据、落点、API 面、测试策略与子计划分解；
> 本节写完时代码为零（`packages/` 下仍没有 `pdf-edit`），与 §5 末尾那句"另起子计划窗口，先 plan 再落码"是同一片。
> §0.1 定的是**放弃什么**，本节定的是**剩下的怎么做**。

### 7.1 选型与理由（`AGENTS.md` §6.1）

| 项         | 选择                                                                                                                        | 理由与否决                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编辑引擎   | **`pdf-lib@1.17.1`**（MIT）                                                                                                 | 覆盖式三件事（画白底矩形、画新文字、页面增删）全在它的能力半径内；纯 JS、无原生编译、无 WASM、随 `app.asar` 分发，兑现 §1.4 零首启动下载。否决：`mupdf`（AGPL，且唯一用途是真涂黑已放弃）、`@embedpdf/pdfium`（成本换的是已放弃的语义）、`pdfjs-dist`（它是**读**侧库，不做写入）。                                                                                                              |
| 字体子集   | **`@pdf-lib/fontkit@1.1.1`**（MIT，唯一传递依赖 `pako`）                                                                    | `pdf-lib` 自己不子集化，嵌 CJK 必须经 fontkit；实测见 §7.2 第二轮。否决：另引 `fontkit`（同一件事的第二套实现，§2.7）或 `harfbuzzjs`（原生/WASM 链）。                                                                                                                                                                                                                                           |
| 字体资产   | **复用 `resources/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2`**（SIL OFL 1.1，已在库、已在 `LICENSES.md` 记账） | 实测能把中文嵌进去并可提取（§7.2 第三轮），于是编辑轨与 3.3 打印轨**共用同一份字体文件**，不新增资产、不动许可台账。否决：系统字体（三端不一致，是 §1 认定的头号跨端风险）；spike 里那个 38 KB 的 TTF 读数来自 macOS 系统 `Arial Unicode.ttf`，**不可随包分发**，只能当体积天花板参照。                                                                                                          |
| 页面看得见 | 主进程用已有 `pdfjs-dist`（Apache-2.0）抽**带坐标的文本项** → IPC → 渲染层按页面尺寸等比摆线框与覆盖区                      | 判据 3.5-01 的"渲染显示 + 文本块高亮"落在"看得见版式结构与文字位置"这一层，零新依赖、零 CSP 改动。否决：位图级真实渲染——pdfjs 在主进程画位图要 `@napi-rs/canvas`（原生模块，4.3-06 已明确不引入，见 `scripts/vendor-runtime-deps.ts` 行 56），在渲染层画要 worker/`workerSrc` 而 CSP 是 1.2 定下的严格度（3.4-06 降级白捡的收益，不为这一步放开）。**这条是本节唯一需要你再裁的读法**，见 §7.9。 |
| 历史栈     | 把 `packages/core/src/graph-edit.ts` 的快照栈抽成 **`createSnapshotStack<T>`**，workflow 画布与轻编辑会话共用               | 3.5-08 原文要"基于既有历史机制、不引入第二套历史栈"，而现存那一份（5.10-19 已验收）就是它；§2.2 同一逻辑第二次出现就必须抽。否决：在 `pdf-edit` 里再写一份 past/present/future。                                                                                                                                                                                                                 |
| 存储       | **不加新表、不加迁移号段**：会话态活在内存 + 渲染层，产物落 `userData` 下已有子目录约定                                     | §2.6 不为假想需求建持久层。否决：`pdf_edit_sessions` 表——判据里没有"编辑会话跨重启恢复"，3.5-09 只要"源文件 hash 前后一致"。顺带一条实测更正：AGENTS.md §9 说号段"当前到 17"，**实际最高已到 24**（`packages/agent/src/session.ts` 的号段 24、`packages/browser/src/takeover-service.ts` 的 21/22），下一个人加表前按 §9 的口径先查台账，别照文档里的数字写。                                    |
| 文件入口   | **键入绝对路径**，与 4.1 的 `resume.parse.fromFile` 同口径（`packages/renderer/src/ResumePanel.tsx` 行 83）                 | 复用已验收的入口形态，不新增原生文件对话框（那是 shell/L1 的新能力，且判据没要）。否决：`dialog.showOpenDialog`——实测全仓源码 0 处使用，为轻编辑单开一条 L1 通道属 §2.3 的"新建平行模块"。                                                                                                                                                                                                       |

### 7.2 本机实测（`AGENTS.md` §6.2，spike 在工作区外 `.research-repos/pdf-edit-spike/`，§6.4 不入主干）

三轮都在**纯 Node 24**（不含 Electron）里跑，样例是被仓库内已有的 fixture PDF（`tmp/p3-leg/pdf/minimal-short.pdf`，27,646 B / 1 页 / 首页 `595x842` pt = A4）。读侧统一用 `pdfjs-dist@6.3.289` 的 legacy 构建（与 4.1 同一条通道）。

| 轮次 | 用例                                               | 读数（关键项）                                                                                                                            | 结论                                                                                         |
| ---- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 一   | 白底矩形 + `StandardFonts.Helvetica` 拉丁叠加      | 产物含新拉丁词 `true`；**源首词"张三"仍能被提取 `true`**；`copyPages`/`addPage`/`removePage` 可用（1 → 2 → 1）                            | 覆盖式编辑机制成立；**覆盖 ≠ 涂黑**（实证，见 §7.6）                                         |
| 一   | 把 `resources/fonts/**.woff2` 直接 `embedFont`     | 未抛错，但产物从 27,646 B 涨到 **31,951,084 B**                                                                                           | 必须先 `doc.registerFontkit(fontkit)`，且 `subset` 不许关                                    |
| 二   | 四组对照：woff2 / TTF × `subset:true` / 不开子集   | woff2 子集 **228,446 B**、woff2 全量 1,206,397 B；TTF 子集 **38,295 B**、TTF 全量 15,385,584 B                                            | `subset:true` 是**硬要求**：关掉就是 44～557 倍膨胀（源 27 KB）                              |
| 二   | 哨兵句 `'覆盖中文哨兵甲乙丙'` 四组是否都写进文本层 | 四组 `文本层含哨兵` 全 `true`                                                                                                             | `pdf-lib` + fontkit **能吃 woff2**（原以为只支持 TTF/OTF，文档转述再次被实测推翻）           |
| 三   | 子集产物的字形是否真有推进（不是空白/豆腐块）      | 文本项 `str` 与哨兵**逐字全等**，`width=126` / `height=14` / `transform=[14,0,0,14,44,717.9]`（7 字 @14 pt）                              | 中文确实被画出且可复制可搜索（3.5-06 的两条断言形态就此定死）                                |
| 三   | 读侧噪声                                           | pdfjs 对 CFF 轮廓的子集字体报 `getFontFileType: Unable to detect…` 与 `Required "loca" table is not found` 两条 warning，抽取结果不受影响 | 属警告不是失败（CFF 本无 `loca` 表）；写测试时**不要把它当错误断言**，也不许为消警告去换引擎 |

**由此定死的三条实现约束**：① `embedFont(bytes, { custom: true, subset: true })` 前必须 `registerFontkit`；
② woff2 子集产物（228 KB）明显大于同批 TTF 子集（38 KB）——CFF 的子集器不如 TTF 精准，若 3.5-06 的字形数/体积断言吃紧，
退路是补一份 OFL 的 **TTF/OTF** 资产（许可允许内嵌与子集化），但要另登记 `resources/fonts/**` 与 `LICENSES.md`，不许静默替换；
③ 拉丁短标签可以走 `StandardFonts`（零内嵌成本），**中文一律不许走 StandardFonts**（那 14 只标准字体没有 CJK 字形）。

### 7.3 落点：包与 service（`AGENTS.md` §4.3 要求写明理由）

```
packages/pdf-edit/          @auto-cc/plugin-pdf-edit   # L2，只做一件事：既有 PDF 字节 → 叠加/整页操作 → 新 PDF 字节
  src/index.ts              # 唯一出口（注册 service + `pdf.edit` 门面）
  src/edit-session.ts       # 会话模型：覆盖区列表 + 页面顺序，纯内存、可深拷贝（喂给快照栈）
  src/overlay-writer.ts     # pdf-lib 落笔：drawRectangle 白底 + drawText + 字体注册/子集
  src/page-ops.ts           # addPage / removePage / copyPages 重排
  src/text-layout.ts        # 文本项坐标：经 pdfjs 抽带 transform 的项，换算成叠加定位
  src/internal/**           # 外部禁止深入 import（§4.2）
  src/*.test.ts             # 与被测文件同目录
```

- **为什么新建包而不是塞进 `resume-doc`**：两者的契约不同——`resume-doc` 是「文档模型 JSON → PDF」（真相源是模型，PDF 是投影），
  `pdf-edit` 是「外部 PDF 字节 → 新 PDF 字节」（真相源是那份文件，没有模型）。合在一只包里会让 `resume-doc` 的依赖面多出
  `pdf-lib` + `fontkit`，而它的导出腿一行都用不到（§4.1 一个包只做一件事）。原 §2 的包图里 `pdf-edit` 这个名字**已经预留**，
  本节只是把它的职责从"三引擎 + WASM 装载"重写成"覆盖式轻编辑"，包名不变以免 §4.5 的 ID 语义漂移。
- **依赖方向**：`pdf-edit` 只依赖 `@auto-cc/core`（快照栈、`AppError`）、`@auto-cc/shared`（视图类型与 hash）、`@auto-cc/plugin-store`（不需要，见 §7.1 存储行）、
  `@auto-cc/plugin-config`（取 `paths().userDataDir`）；**禁止 import `resume-doc`**，也禁止被 `resume-doc` import（两者只在 `packages/main` 的装配层并列）。
  字节 hash 复用 `@auto-cc/plugin-resume-kb` 已复导的 `sourceHashOf`（`packages/resume-kb/src/index.ts` 行 131，唯一一份对 `Uint8Array` 算 sha 的实现），不在新包里重写。
  **← 3.5-a 落地时更正（见 §7.11）**：这条走不通——`pdf-edit` 与 `resume-kb` 同为 L2，横向 import 被 §4.1 拦住，
  而"有界读 + 字节 hash"因此上收到 `@auto-cc/core` 的 **subpath 导出** `./file-read`（不走 barrel 的理由是 `bridge.ts` 行 125 的打包陷阱）。
- **挂载顺序**（§9 的 5.1-c 坑）：`cordis.yml` 里新增的 `pdf-edit` 行必须排在它 `inject` 的那几只（`config`、`resume-kb`）**之后**，
  并且加行之后要复跑 `scripts/check-tool-contract.ts`——它现在扫的是"软问注册表"的时序，静默少一只工具正是它拦下的那类缺陷。
  **← 3.5-a 落地**：那一行是 `pdf-io` 且**没有** `dependsOn`（3.5-a 不落盘、不 inject、也不登记 agent 工具），排在 `kb-generate` 之后；见 §7.11 第 3 条。

### 7.4 对外 API 面与 IPC 白名单

| service      | 方法（入参 → 回执）                                                                                                                                                                                       | 对应 spec                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `pdf.io`     | `open(filePath)` → `{ pageCount, pages:[{ widthPt, heightPt }], sourceHash }`                                                                                                                             | 3.4-03 / 3.5-01 / 3.5-09 |
| `pdf.layout` | `textItems(filePath, pageNumber)` → 带 `transform/width/height/str` 的文本项（脱敏：只回坐标与命中框，整页原文不进渲染层）                                                                                | 3.5-01                   |
| `pdf.edit`   | 会话级：`addOverlay` / `removeOverlay` / `moveOverlay` / `setPageOrder` / `undo` / `redo`（都只改内存 draft，返回新读数）                                                                                 | 3.5-02 / 03 / 07 / 08    |
| `pdf.export` | `saveAs(filePath, draft)` → `{ outPath, sha256, pageCount }`，**源文件只读、产物另存新文件**（实落签名四参数 `saveAs(filePath, overlays, pageOrder, outPath)`，偏离理由在 §7.12 与 §7.13；`draft` 归 c₂） | 3.5-06 / 3.5-09          |

白名单在 `packages/shared/src/bridge.ts` 的常量与 `RequestMap` 里各加对应项（现表把 `resume.*` 收在行 318～356 那一段，编辑轨另起一段 `pdf.*`）。
两条边界沿用已验收的口径：文档正文/整页原文**不过进程边界**（与 3.7-03 只传两个快照 id 同一取向），
`pdf.*` **一律不登记为 agent 工具**——编辑的是用户手里的文件，判据里没有"让模型改 PDF"这一条，§2.6 不做超出需求的事。

### 7.5 渲染层形态（§5 硬约束逐条对上）

面板归属：`ResumePanel` 加第三块视图「在既有 PDF 上改」，入口形态沿用现成的「键入绝对路径 → 打开 → 页面列表 → 覆盖区列表 → 导出」。
覆盖区用**比例坐标**（0..1）存储而不是 pt 绝对值，界面缩放时按页面等比换算，避免 3.5-03 的"盖歪了"随视口变化。
Tailwind（§5.1）：线框与覆盖框全是绝对定位 + utility 类，唯一样式例外依旧只有 `@xyflow/react` 那份；
lucide（§5.3）：加框/删框/上移下移/撤销重做/导出要从现有图标里选，找不到就按 §5.4 列候选来问，不自绘；
i18n（§5.5/5.6）：新增命名空间 `pdfEdit.*`，两份语言包同批补齐（`pnpm lint` 的缺翻译校验会拦），动态值走插值、平台专名进参数。

### 7.6 反伪装约束（这条是降级裁定的安全带，落码时当成硬约束写进测试）

实测已经证明覆盖**不删原文**（第一轮：源首词在产物里仍可提取）。于是：

- 界面文案、`AppError` 提示、导出回执字段里**不许出现"涂黑/删除/覆盖后不可恢复"这类字样**；说"改"就必须同时说"原文字仍在文件里"。
- `3.5-04` / `3.5-05` 已按裁定转 `[!]`（原判据保留），新片的验收**不得把它们悄悄复活**——要真删得另起裁定，不许借这条顺手实现。
- 「看似改过实则未改」那条精神转移来的判据落在 3.5-02 的新片里：叠加/绘制任一步失败 → 报错且**不落半成品文件**（写测试断言目录里零新文件）。

### 7.7 测试策略（§7.2 fixture-only，不打真实平台，也不碰用户磁盘上的真文件）

| 层级 | 手段                                                                                                                                                                            | 覆盖                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| U    | 坐标换算（比例 ↔ pt、缩放）、快照栈往返、页面重排的纯函数用例                                                                                                                   | 3.5-03 / 3.5-07 / 3.5-08                         |
| C    | fixture PDF 进 → 产物出：文本层逐字符断言（新文字在、`str` 全等）、页数与顺序、源文件 hash 前后一致、体积阈值（防 §7.2 那种 557 倍回归）、`LICENSES.md` 与 `pnpm licenses` 对齐 | 3.4-03 / 3.5-01 / 02 / 06 / 09 / 3.4-08 / 3.4-09 |
| V    | `pnpm harness`（CDP 10222，`--url 5173`）在真实窗口里走完「键路径 → 看得见 → 框选 → 导出」并出图，截图按 §7.5 落 `docs/acceptance/3.5/`                                         | 3.5-01 / 03 / 07 / 3.4-07 的确定态               |

依赖面新增两条要同时过的闸门：`scripts/check-licenses.ts`（MIT 家族不触发 copyleft/非商用闸门，但记账表要补 `pdf-lib` / `@pdf-lib/fontkit` 与其传递依赖的行）、
`scripts/check-dependency-floor.ts`（三层扫描：声明层与锁文件层的 `TREE_BANS` 禁令打不到 `pdf-lib`——它禁的是外来向量库 / 非内置 SQLite 绑定 / 图表引擎；
搬运层逐包查 `.node`/`.dll`/`binding.gyp` 与 `preinstall`/`install`/`postinstall`，`pdf-lib` 与 fontkit 都是纯 JS 且无安装脚本，预期通过）。
记账表的补行走它自己的正道：`LICENSES.md` 那张生成节写明"由 `tsx scripts/check-licenses.ts --write` 生成，请勿手改"，
而裁定③（commit `d522fbf`）已经把"名字以 `-<平台>-<架构>` 结尾的可选二进制包"从生成表里排除、三道闸门仍扫全量条目，
**所以在这台 macOS 上跑 `--write` 不再让表逐台漂**——引入 `pdf-lib` 后照常跑它，人工记账那半节不动（现在的读数：生产依赖 83 个包条目 / 记账表 82 行）。

### 7.8 子计划分解与顺序

| 片                                                                                       | 内容                                                                                                                                                                                            | 判据                                                                     | 依赖         |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| **3.5-a** 引擎腿（**已落地 2026-10-05**，见 §7.11）                                      | 引入 `pdf-lib`、建 `packages/pdf-edit`、`pdf.io.open`（fontkit 与 `pdf.layout.textItems` 顺延到 3.5-b，理由在 §7.11）                                                                           | `3.4-03` 已 `[x]`；`3.5-01` 的 C 半边随顺延仍 `[ ]`                      | 1.3 / 1.7    |
| **3.5-b** 覆盖腿（**前半已落地 2026-10-05**，见 §7.12）                                  | 覆盖区模型 + `overlay-writer`（白底矩形 + 中文字体子集）+ `pdf.export.saveAs` + 失败不落半成品——前半=不要字体的那半边（裁定⑧），中文/fontkit 半边另裁                                           | `3.5-02` / `09` 已 `[x]`；`3.5-03` 只剩截图目视；`3.5-06` 随中文字体顺延 | 3.5-a        |
| **3.5-c** 整页与历史腿（**c₁ 页序腿 + c₂ 会话腿均已落地 2026-10-05**，见 §7.13 / §7.14） | `page-ops`（增删/重排，**已落**）+ `createSnapshotStack<T>` 抽取（**已落** `4db0fb0`）+ `edit-session`（覆盖区增删改与撤销重做，**已落**）+ `pdf.edit.*` 的白名单行与页序控件（随渲染层那一片） | `3.5-08` 已 `[x]`；`3.5-07` 只剩截图腿；5.10-19 的原有用例复跑未变绿→红  | 3.5-b / 5.10 |
| **3.6** 排版编辑器                                                                       | 生成轨的文档模型编辑器（区块拖拽、度量调节、模板切换、i18n、拦截未保存离开）——**与轻编辑无关**，判据与状态不动；**实现面见 §8**（2026-10-05 立：边界三条 + 拖拽通道选型 + 三片切法）            | `3.6-01…09` 九条                                                         | 3.3          |

顺序裁定：a → b → c 是依赖链，**3.6 排在其后或并行都可**（它只依赖 3.3），但一次只推进一个窗口（§0）。
3.5-c 那一片动到 5.10 已验收的画布栈，属于跨计划的重构，落码前要在 `docs/plans/05-chat-agent/plan.md` 里留一条对应记号，别让两个计划各自以为栈是自己的。

### 7.9 需要你再裁 / 必须在场的（本窗不动手）

1. **3.5-01 的"渲染显示"读法**：我按上表选了"文本项线框"（零新依赖、CSP 不动）。
   如果你要的是**位图级真实渲染**，就得裁一条"允许渲染层引入 pdfjs worker 并为此调整 CSP"，代价是把 3.4-06 降级白捡的那条收益吐回去。
2. **`3.4-08` 包体增量的同轮 win 读数**：降级后只剩 `pdf-lib` 一支纯 JS，量级远小于三引擎方案，但判据要的"与 P1 基线同轮对比"仍缺 Windows 宿主——本机现在给不出。
3. **V 腿要在场**：3.5-01 / 03 / 07 的截图按 §7.1 要在真实窗口里取，取证据期间会改 dev 的 `userData`，按惯例要你在场再跑。

### 7.10 明确不做（本节新增，与 §6 并列）

- 不做真涂黑 / 字节级删除 / 内容流改写（§0.1 已裁，且本节 §7.6 把话说死）。
- 不做图片、签名、水印叠加——判据里没有，覆盖式文字与整页操作已够 M5 之后的那条用户需求。
- 不做 PDF 表单（AcroForm）、加密文档、批注；遇到即给"该文件不受支持"的确定态，不静默产出坏文件。
- 不做逐像素位图预览（除非 §7.9 第 1 条裁成要）；不引入 `@napi-rs/canvas` 或任何需编译的原生模块。
- 不让 agent 工具面出现 `pdf.*`（见 §7.4）。

### 7.11 3.5-a 落地记录（2026-10-05，`3.4-03` 转 `[x]`）

**实际落点**：`packages/pdf-edit`（`@auto-cc/plugin-pdf-edit`，L2）三个源文件
（`pdf-document.ts` 装载与另存、`io-service.ts` 服务 `pdf.io`、`index.ts` 门面）+ 同目录两份测试；
`packages/main/src/registry.ts` 与 `cordis.yml` 的 `pdf-io` 行；渲染层白名单 `pdf.io.open`
与 `BridgeSignatures` 同批加（那里的 `BridgeSignaturesCovered` 是编译期保险丝，逼两边一起改），
接线判据落在 `packages/main/src/pdf-link.test.ts`。

**三条顺延**（写在这里，是为了让 §7.4 那张表不被读成"许可证"——它是路线图）：

1. `@pdf-lib/fontkit` → **3.5-b**。3.5-a 只装载与量页，没有要嵌入字体的一笔，此刻引入就是一条没人评的空依赖（§2.6）。
   所以 §7.7 那句"记账要补 `pdf-lib` / fontkit 的行"这轮只落了 `pdf-lib` 那一支：`LICENSES.md` 生成节多四行
   （`pdf-lib@1.17.1` / `@pdf-lib/standard-fonts@1.0.0` / `@pdf-lib/upng@1.0.1` / `tslib@1.14.1`）。
2. `pdf.layout.textItems` → **3.5-b 的线框腿**。理由是实测出来的：它需要**第二条 PDF 解析链**
   （`pdfjs-dist` 的 textItems 与 `pdf-lib` 是两套解析器，两份对同一页的理解得并进同一个坐标空间），
   而 3.4-03 的判据里没有这件东西；两条链一起进来反而让"装上了"有两个真相源。
   于是 `3.5-01` 的 C 半边**没有**跟着 3.4-03 一起收，那一行仍 `[ ]`。
3. `dependsOn: [config]` 与 `paths().userDataDir` → **3.5-b**。3.5-a 不落盘，也就没有要取的作用域目录；
   `pdf-io` 因此排在 `kb-generate` 之后而不依赖任何东西（§9 的 5.1-c 顺序坑在这条上不存在），
   摘掉这一行只是打不开文件，不会留下半截记录——它不建表、不占迁移号段。

**更正 §7.3 的一条**：原写"字节 hash 复用 `@auto-cc/plugin-resume-kb` 复导的 `sourceHashOf`"。落码时做不到——
`pdf-edit` 与 `resume-kb` 同为 L2，横向 import 被 eslint boundaries 拦住（§4.1）；借道 `@auto-cc/shared` 也不对，
`shared` 在 L1 且是渲染层要打进包里的东西。做法是**上收到 L0**：`@auto-cc/core` 新增 **subpath 导出** `./file-read`
（`readBoundedFile` + `sha256Hex`），刻意**不**出现在 `src/index.ts`——`bridge.ts` 行 125 记过的那个打包陷阱
（走 barrel 会把 `node:path` 拖进 Vite 产物）。两个 L2 消费者各自决定错误码（`RESUME_IMPORT_FAILED` / `PDF_EDIT_READ_FAILED`），
而"绝对路径 + 字节上限 + 读出字节"这一段从两份变成一份（§2.2 说的第二回使用）；
`resume-kb` 侧的 `sourceHashOf` 保留公开名字与 detach 顺序注释，内部改为委派。

**打包归属的实测决定**：`pdf-lib` 由 esbuild **打进 `main.cjs`**，不进 `scripts/vendor-runtime-deps.ts` 的
`RUNTIME_EXTERNAL_ROOTS`（那三只外置的理由是要跑原生/二进制或体积巨大：`mammoth` / `pdfjs-dist` / `electron-updater`）。
读数：`pnpm app:build` EXIT=0，`build/app/main.cjs` 3987713 字节内含 `pdf-lib` 628 处，`build/app/node_modules` 里 0 份。
MIT 归属照样随包分发，因为 `LICENSES.md` 已经在 extraResources 里。

**实测推翻的一处假定**（必须写进代码注释，否则下次又会按"load 失败就等于坏文件"来判）：
`PDFDocument.load('%PDF-1.4' + 垃圾字节, { ignoreEncryption: true })` **不抛异常**，返回一份"装得上"的文档，
崩的是下一步 `getPages()`。所以装载器把**逐页量得出宽高**当作装载成功的一部分（`pdf-document.ts` 的结构探针），
度量在这里一次算好，`pageCount` 与 `pageMetrics()` 同源。

**加密文件的夹具**：spike 那轮给不出真加密 PDF，这轮按 §6.2「以实测为准」用手写 `/Encrypt` trailer
（Standard / V1 / R2 / 40 bit）让 `pdf-lib` 把 `isEncrypted` 报成真，于是 §7.10 那句"加密文档给确定态"有 C 类测试可判，
而不是伪造一套加解密。夹具进 `@auto-cc/testing` 的 `minimalEncryptedPdf`，为此把 `wrapPdf` 收成模块私有并加第二个实参
（trailer 多写 `/Encrypt n 0 R`）；同一轮删掉 `index.ts` 里没人用的 `wrapPdf` 复导（§2.4）。
`packages/resume-kb/src/source.test.ts` 那份重复的最小 PDF 生成器也在这轮抽掉了——它就是 §2.2 说的第二次出现。

**这轮的闸门读数**：`pnpm typecheck` EXIT=0、`pnpm lint` EXIT=0（许可证记账节按裁定③ 用 `--write` 重生成，
在这台 macOS 上不再逐台漂）、`pnpm test` EXIT=0（`pdf-edit` 16 例、`main` 69 例含新接线腿、`resume-kb` 398 例夹具抽取后不降级）、
`pnpm app:build` EXIT=0。P3 的实现面因此从 17 条变 **16 条**（剩 3.5 的六条轻编辑判据 + 3.6 的九条 + 3.4-03 之外的 BLOCKED 腿）。

### 7.12 3.5-b 前半落地记录（2026-10-05，裁定⑧："先做不要字体的半边"）

**裁定⑧的原话范围**（照抄以免下次被读宽）：这一半只做**覆盖区模型 + 白底矩形 + `StandardFonts` 拉丁叠加 +
`pdf.export.saveAs` + 失败不落半成品**，收 `3.5-02` 的"不改写原内容流"与 `3.5-09` 的"源文件 hash 前后一致"，
以及 3.4-04/07 转移来的确定态；`3.5-03` 的截图目视、`3.5-06` 的中文 / fontkit /"随包资产目录读数"仍等后续裁定；
**不动任何已验收代码、不引新依赖**。三条约束这轮都守住了：`git status` 里没有 3.3 / 3.4 / 5.10 的已验收实现，
`package.json` 与锁文件的 `pdf-edit` 依赖仍是 `pdf-lib` 一支（fontkit 没进），中文在边界上被 `text-not-supported` 拒掉而不是画豆腐块。

**实际落点**（四份新文件 + 六处接线）：`packages/pdf-edit/src/overlay-writer.ts`（覆盖区的比例模型与校验、
两种坐标的换算、七条拒绝腿）、`export-service.ts`（服务 `pdf.export` + 方法 `saveAs`）、同目录两份测试；
`packages/testing/src/pdf-inspect.ts`（`pdfContentText`，理由在下面 §"内容流断言"）；
接线是 `packages/core/src/errors.ts` 的错误码、`packages/shared/src/bridge.ts` 的三条 view + 白名单行 + `BridgeSignatures` 行、
`packages/main/src/registry.ts` 与 `cordis.yml` 的 `pdf-export` 行（排在 `pdf-io` 之后，它不 inject 任何名字，所以 §9 的 5.1-c 顺序坑在这条上仍然不存在）、
`packages/main/src/pdf-link.test.ts` 重写为两腿装配对账。

**一处与 §7.4 那张表的签名偏离**（表是路线图，落码按当轮实际需要）：原写 `saveAs(filePath, draft)`，
实落 `saveAs(filePath, overlays, outPath)`。两处偏离各有原因：
① `draft` 是"编辑会话"那一层的对象，而会话模型与快照栈（`pdf.edit.*` 的增删改查 + `createSnapshotStack<T>`）
按计划落在 **3.5-c**——现在传 `draft` 就得先造一个只被 `saveAs` 用过一次的假类型，等 3.5-c 再改签名，
反而把同一层逻辑写两遍（§2.3 反过来用：不新建还没有第二个消费者的抽象层）；所以这一轮实参就是覆盖区数组本身。
② `outPath` 由调用方给，而不是服务自己拼：本轮**没有保存对话框**（那是渲染层那一半，随 3.5-03 的截图腿一起落），
也没有 `dependsOn: [config]` 去取 `paths().userDataDir`（§7.11 顺延第 3 条仍然有效）。
代价是"另存到哪"这个决定暂归界面，收益是服务不藏任何路径拼接规则——顺带一条边界：`outPath` 必须绝对路径，
且 `resolve(outPath) === resolve(filePath)` 直接拒（`out-is-source`），因为覆盖式编辑最容易犯的错就是拿产物盖掉源文件。

**三条实测更正**（都由"读 `.d.ts` + 一次性 tsx 探针"得出，探针写在 gitignore 的 `packages/pdf-edit/tmp/` 里、跑完即删，§7.5；
按 §6.2 记录，因为三条都会让下一次照抄文档的人写出编译不过或断言不成立的代码）：

1. **`page.drawText({ font })` 只收 `PDFFont`，不收 `StandardFonts` 枚举**——TS2322 报出来的。
   所以 `applyOverlays` 是 `async` 的，且字体在进循环前 `await this.pdf.embedFont(StandardFonts.Helvetica)` 一次
   （只在至少一块覆盖区带文字时才 embed，纯白底矩形的产物里不多出一只字体对象）。
   网上那批"直接传枚举"的 pdf-lib 示例在这一版上是错的。
2. **新落笔进的是**一条**新建的、Flate 压缩的内容流**，原内容流逐字不动（这正是 3.5-02"不改写原内容流"的实现形态），
   后果是：`(Jane Doe) Tj` 这类原文在**字节层仍然可搜**，而新写的文字是**大写十六进制串**
   `<5245444143544544> Tj` 配 `/Helvetica-<id> 11 Tf`——也就是说"在产物里 grep 明文新文字"这种断言永远红，
   必须解压 + 认十六进制两种形态。
3. **`drawRectangle` 在 `borderWidth: 0` 下不发 `re` 操作符**，发的是 `q / 1 1 1 rg / 0 w / [] 0 d / … cm / 0 0 m / 0 h l / w 0 l / h / f / Q`
   （用路径 `m l h` 画的矩形），而且**操作符之间是换行分隔的**。所以判"画了个空心矩形"的写法是 `/h\s+f/`，
   写成 `/re f/` 是拿一个不存在的操作符当判据。顺带一条同族的格式读数：流字典是多行写的
   （`<<\n/Filter /FlateDecode\n/Length 139\n>>\nstream`），且按 PDF 规范 `endstream` 前那个 EOL 不属于流数据，
   解压前要 `/\r?\n$/` 剥掉，否则 `inflateSync` 报错。

**内容流断言为什么抽进 `@auto-cc/testing`**：`pdfContentText(bytes)` 是上面第 2、3 条那个"解压 + 归一"的壳，
`export-service.test.ts` 与 `pdf-document.test.ts` 各要写一遍就是 §2.2 说的第二次出现，所以直接落在测试支持包（那里本来就有 `minimalEncryptedPdf` 这类 PDF 夹具）。
它只在测试面导出，不进 `pdf-edit` 的 `index.ts`——生产代码不需要读自己刚写的内容流。

**错误码只加了一支**：`PDF_EDIT_SAVE_FAILED`。不按"读失败 / 加密 / 校验失败 / 绘制失败 / 落盘失败"分五支，
理由是 `packages/core/src/errors.ts` 里 `RESUME_IMPORT_FAILED` 那条注释定下的口径：**UI 处置相同就共用一支**，这几种子原因在界面上
全都是同一条"这份文件没能另存"的提示条，细分只进 `details.code`（本轮取值：`out-path-not-absolute`、`out-is-source`、
七条覆盖区拒绝码、`invalid-pdf`、`encrypted`、`empty`、`draw-failed`、`write-failed`，全部逐条列在 `bridge.ts` 的签名注释里，
免得界面按猜的字符串分支）。

**"失败不落半成品"是结构而不是承诺**：绝对性检查 → 同路径检查 → 读字节 → 装载 → 比例换算与校验，
全在**第一次碰磁盘之前**；唯一可见的写是 `${outPath}.part` 写完 `rename`，`rename` 之前的异常路径带 `rm({ force: true })`。
测试因此不判"提示语对不对"，判**目录清单**：七条失败腿各自断言 `readdirSync(dir)` 等于 `['resume.pdf']`，
`out-is-source` 那条也一样——这样"少写了半截文件"这类缺陷不可能靠改断言蒙过去。
白底矩形那半边另有一条反向断言：`not.toMatch(/h\s+[SB]/)`（`S`/`B` 是描边类绘制，出现即说明边框又回来了）。

**测试夹具里一处刻意的取值选择**：覆盖区比例用 `0.25 / 0.125 / 0.5` 这类二进制精确分数，而不是好读的 `0.1 + 0.05`。
原因是浮点噪声会让 `0.1 + 0.05 = 0.15000000000000002`，乘页宽拿到 `356.99999999999994`，
于是"证明坐标换算正确"的断言实际在测 IEEE754 而不是测换算公式（本轮就这么红过一次：`1 0 0 1 59.5 715.7 cm` 找不到）。
换算本体在 A4 上拿到的读数是 `x=148.75`、`yBottom=526.25`、`baseline=573.375`。

**这轮的闸门读数**：`pnpm format` 后 `typecheck` / `lint` / `format:check` 各 EXIT=0；
`pnpm test` EXIT=0（`pdf-edit` 从 16 例变 **46 例**：overlay-writer 15 + export-service 13 + pdf-document 9 + io-service 9；
`main` 70 例含重写的接线腿；`resume-kb` 398 例不降级；`platform-boss` 139 例不动）；
`pnpm app:build` EXIT=0，`build/app/main.cjs` 3,999,124 字节内含 `pdf-lib` 631 处、`build/app/node_modules` 里 0 份
（§7.11 那条"打进主 bundle、不进外置名单"的决定这轮没被推翻）。
P3 的实现面因此从 16 条变 **14 条**（`3.5-02` / `3.5-09` 转 `[x]`；`3.5-03` 的 U 半边过、截图目视仍 `[ ]`）。

**顺延清单**（这轮明确没做，别在下一轮被当成"顺手补齐"）：
① 中文叠加腿＝`@pdf-lib/fontkit` + 字体子集 + §7.11 顺延第 1 条欠的记账行 + `3.5-06` 的"随包资产目录读数"，等裁定；
② `pdf.edit.*` 的会话面（草稿 CRUD、覆盖区的增删改）与 `page-ops`、`createSnapshotStack<T>` 抽取一起进 **3.5-c**，
动 5.10-19 前要在 `docs/plans/05-chat-agent/plan.md` 留记号（§7.8 末段那条纪律仍然有效）；
③ `3.5-03` 的截图目视与 §7.9 第 3 条同源，要你在场；
④ 白名单这轮只多了 `pdf.export.saveAs` 一行——`pdf.edit.addOverlay` / `pdf.layout.textItems` 都还在名单外，
`pdf-link.test.ts` 用一条"精确等于两项"的断言把它们钉在门外（§7.4 的表是路线图，不是许可证）。

### 7.13 3.5-c₁ 页序腿落地记录（2026-10-05，`3.5-07` 的 U 半边过了、V 半边仍缺）

**这一片是 §7.8 里 3.5-c 的前半**，按 §7.12 顺延清单② 拆开的：c₁＝页序（`page-ops` 校验 + `PdfEditDocument.arrange`），
c₂＝`pdf.edit.*` 的会话面（覆盖区增删改、`setPageOrder`、`undo`/`redo`，直接吃 commit `4db0fb0` 抽好的 `createSnapshotStack<T>`）。
拆成两片的理由是回归门不同：c₂ 的红可能来自 5.10-19 那 7 例画布用例，也可能来自 `3.5-08` 的新用例，
同窗做的话分不清是哪一头坏了（§7.8 末段那条"别让两个计划各自以为栈是自己的"纪律，落到操作上就是一窗一件事）。

**页序就是一只数组**：`pageOrder[k]` 是"产物第 k+1 页取自源文件的第几页"（1 起）。于是删页＝少写一项、增页＝把同一项写两次、
重排＝换个顺序，**三个动作一个入口**。为什么不落 `addPage` / `removePage` / `movePage` 三只（三条理由写在 `page-ops.ts` 的头注释里）：
① §7.4 那张表本来只登记了 `setPageOrder`；② 三只动作各自都要回答"撤销一步退到哪"，而一份页序快照天然被历史栈覆盖；
③ 三只入口之间会互相造出对方不认的中间态。顺带一条实测：`pdf-lib` **没有** `movePage` 这类 API，
整页操作只有"拷到新文档"这一条路，所以三只入口在这支引擎上也不会更自然。

**两条实测读数**（决定 `arrange()` 长什么样，本机 `pdf-lib@1.17.1`，用一次性 tsx 探针跑在 gitignore 的 `packages/pdf-edit/tmp/`、跑完即删，§7.5）：

1. **`copyPages(sourceDoc, indices)` 是逐指标各取一份新拷贝，对重复指标不设限**，所以 `[0, 0, 1]` 得到**三页**而不是两页。
   这正是覆盖区语义所要求的（见下面那条"按来源页绑"），但它也不拦"源与目标是同一份文档"——
   自己拷到自己身上会得到什么，本层没试，因为 `arrange` 的目标永远是新建的 `PDFDocument.create()`。
2. **`copyPages` 保留 MediaBox**：排过页再存、再装载，逐页宽高仍是源档那三页的量得（`export-service.test.ts` 钉住这件事）。
   于是新文档继续带**源档**那份度量，不必重量一遍。

**直通不走拷贝**：页序恰好是 `1…n` 时 `arrange` 直接返回 `this`。理由是 `copyPages` 会把整份文档的资源重嵌一遍，
白拷一次不只是慢，还让"根本没改页序的产物"与源档的字节结构无谓地不同——用户没动页面时，产物就该是"源 + 覆盖区"。

**覆盖区按来源页绑，不按产物页号绑**（`applyOverlays` 里那一句 `pageSources.map/filter`）：
同一源的每一张副本都要盖上覆盖区，只盖第一处就等于"改了一份、另一份还露着那句旧话"，那正是 §7.6 反伪装精神要拦的形态。
反向的一条也守住了：覆盖区指向的源页在这份页序里**根本不存在**时抛错而不是跳过（3.5-05 转移来的"不许产出看似改过实则少画几区的文件"），
`pdf-document.test.ts` 与 `export-service.test.ts` 各钉一条。

**签名对 §7.4 又偏一格**：`saveAs(filePath, overlays, pageOrder, outPath)`（四实参）。§7.4 写的是 `saveAs(filePath, draft)`，
而页序本属于 `draft`；它现在单列成一个入参，原因与 §7.12 那条① 同源——会话模型（`pdf.edit.*` + 快照栈）在 c₂ 才落，
本轮先把它当外部输入接进来。代价是渲染层此刻要自己把页序数组递过来（`bridge.ts` 的 `pdf.export.saveAs` 行已同步成四参数），
收益是 c₂ 落的时候只换"谁生产这只数组"，不动另存腿。

**新增的是一条尺度，不是一条行为**：`pdfExportSchema` 多一个 `maxPages`（默认 64、上界 500，`cordis.yml` 的 `pdf-export` 块随之五行）。
页序数组来自渲染层，不设界等于允许它用一只长数组把主进程的内存顶满；它和 `maxOverlays` 同族，都只回答"多到多少就拒"。
错误码只多三个**子原因**（`empty-order` / `page-out-of-range` / `too-many-pages`），错误码本身仍是那支 `PDF_EDIT_SAVE_FAILED`；
`arrange` 抛出的 `pdf-lib` 异常折进已有的 `draw-failed`，不另开一支——界面分支不看它（§7.12"错误码只加了一支"那条口径继续有效）。
校验顺序没动：全部检查（路径 → 读字节 → 覆盖区 → 页序）都在第一次碰磁盘之前，失败仍然既不落 `<outPath>` 也不落 `<outPath>.part`。

**一处改名要记进账**（它动的是已验收那一片的公开名字，不是新代码）：`pageMetrics()` → `sourcePageMetrics()`，并新增 `outputPageSources()`。
原因是 3.5-c₁ 之后"每一页"有**两个**含义（源档的页 / 产物的页），旧名字模棱两可；`pdf.io.open` 的回执口径同时明确为**源档**
（打开的是用户手里那份文件，它还没被排过页），所以 `3.4-03` / `3.5-09` 的判据一字未动。

**这轮的闸门读数**：`pnpm format` 后 `typecheck` / `lint` / `format:check` 各 EXIT=0；
`pnpm test` EXIT=0——`pdf-edit` 从 46 例变 **62 例**（新增 `page-ops.test.ts` 6 例、`pdf-document.test.ts` +3、
`export-service.test.ts` +3 且失败腿从 7 条变 11 条）；`main` 70 例（接线那条改成四实参：`saveAs` 的入参表变了，
网关测试要跟着给全，否则 `outPath` 落成 `undefined`、`isAbsolute` 抛的是 `TypeError` 而不是本轨的码——这次就是这么红了一下）；
`core` 52 例、`workflow` 209 例**未降级**（c₁ 没碰快照栈，`4db0fb0` 抽取的原有用例仍然是回归门）；
`pnpm app:build` EXIT=0，`build/app/main.cjs` 4,003,592 字节内含 `pdf-lib` 632 处、`build/app/node_modules` 里 0 份。

**状态位**：`3.5-07` 仍 `[ ]`——U 半边（操作后断言）已过，V 半边（截图）要真实页面上的页序控件，而控件在 c₂ 之后才有落点，
且取证据要你在场（§7.9 第 3 条）。所以 P3 的实现面**仍是 14 条**，这轮一个勾都没打。
**顺延**：① c₂ 的会话面与 `3.5-08`；② `3.5-07` 的截图腿；③ 渲染层的页序控件与 `pdf.edit.*` 白名单行（§7.12 顺延④ 那条"精确等于两项"的断言仍未松动）。

### 7.14 3.5-c₂ 会话腿落地记录（2026-10-05，`3.5-08` 转 `[x]`）

**落点**：`packages/pdf-edit/src/edit-session.ts`（`createPdfEditSession`）+ 同目录测试（9 例）。接线只两处：
包的门面 `index.ts` 多一组导出，`packages/core/package.json` 的 `exports` 多一条 `"./snapshot-stack"`。

**形态裁定：它是纯模型，不是 service**（这是本节第三次偏离 §7.4 那张表，也是三次里唯一动**行**而不是动签名的）。
三条理由，按重要性排：

1. §7.1 的存储行写的是「会话态活在内存 + **渲染层**」，而 §7.5 定的入口形态是渲染层自己拿 draft；
   画布那份编辑栈就是同一条路——`createWorkflowGraphEditor` 由 `packages/renderer/src/WorkflowCanvas.tsx` 直接调用，
   不过 IPC（5.10-19 已验收）。同一件事再开一条 IPC 通道就是 §2.5 禁止的「两个都能用」。
2. 主进程此刻**没有**任何持久会话的依据：`pdf.export.saveAs` 每次按路径重读源文件（§7.12 记过这条），
   把 draft 挪进主进程就得回答「会话什么时候销毁、跨窗口算几份」，而这两个问题在判据里都没有。
3. 少一份 IPC 面就少一份要审的白名单：`pdf-link.test.ts` 那条「`pdf.*` 精确等于两项」的断言这轮**不动**，
   `pdf.edit.*` 那六行等界面真有调用点再登记（§7.12 顺延④ 同一条纪律）。

**由此得出一条要写进代码头的约束**：`edit-session.ts` 一条 Node 能力都不许 import（`node:fs`、`pdf-lib`、
以及带 `readBoundedFile` 的服务文件都不行），否则渲染层将来取它就得把整支 PDF 引擎打进 Vite 的 bundle。
所以：源页度量走 `import type { PdfPageMetric }`（类型擦除，运行时不拖 `pdf-document.js`），
历史机制走 `@auto-cc/core/snapshot-stack` 这条**窄出口**而不是 `@auto-cc/core` 的门面（后者含 cordis 与 Node 依赖），
这也是这轮给 core 加那一条 `exports` 的唯一原因。尺度类型在本地重新声明成 `PdfEditSessionLimits = OverlayLimits & { maxPages }`
而不是复用 `PdfExportConfig`：形状相同，但后者所在的文件带 Node 依赖，拿不到。

**draft 是「覆盖区列表 + 页序」合在一份快照里**，不是两条历史。理由：用户先排页再框两个区，按一次撤销要退的是
**那一个动作**（少一个框），页序不动；两份独立历史会让「退到底」这件事无法逐字段比对，也和 5.10-19 定下的
「快照而非逆操作」取向分叉。

**六个动作都只在真的改了 draft 时长出撤销单元**（沿用画布那份的语义），四种返回 false 的输入各有一条用例：
id 重复、中文（`planOverlays` 的 `text-not-supported`）、条数超上限、空编辑（挪回原处 / 删不存在的 id / 指回同一份页序）、
非法页序（空数组与越界页号）。其中一条是**结构性的**而不是UX的：会话里判覆盖区合不合法用的就是另存那一份 `planOverlays`
（连同同一份尺度），所以不会出现「界面放行、另存被拒」与「界面拦住、另存偏能过」这两种分叉（§2.5）。
`removeOverlay` 是唯一不过 `planOverlays` 的腿——少一条只会更合法，不会更非法。

**判据怎么过的**：`3.5-08` 的验证操作是「连续 5 步 undo/redo 状态一致」，用例就走五步（加区、加区、挪区、改页序、删区），
把每一层的读数记进 `trail` 数组，再逐层 undo 比一次、逐层 redo 比一次——只比「退到底那一份」会放过一份跳步的实现
（一次退两层、下一次补三层，末态看着也自洽）。这条用例本身在写的时候就抓出一处 off-by-one：退到底之后
最后那一份读数也在 `future` 里，redo 要五次而不是四次。

**这轮的闸门读数**：`pnpm -F @auto-cc/plugin-pdf-edit test` 71 例（62 → 71，净增 9）；
全量 `pnpm test` EXIT=0（core 52 / pdf-edit 71 / workflow 209 / main 70，`main` 那 70 例未降级）；
`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 均 EXIT=0；`pnpm app:build` EXIT=0，
产物 `build/app/main.cjs` 4,003,604 字节内含 `pdf-lib` 引用 632 处、外置资源目录 0 份（兑现 §1.4 零首启动下载）。
`3.5-08` 转 `[x]`，所以 **P3 的实现面从 14 条变 13 条**（剩 `3.5-01` 的 C 半边线框腿、`3.5-03` 与 `3.5-07` 两条截图腿、
`3.5-06` 的中文字体腿 + 3.6 的九条），全局未做 16 → **15 条**。

**顺延**（别在下一轮被当成"顺手补齐"）：① 界面上的撤销/重做两颗按钮、页序控件与 `pdf.edit.*` 的白名单行，
连同 `@auto-cc/plugin-pdf-edit` 给渲染层用的窄出口 `"./edit-session"` 一起，等面板落地那一片（§7.5 的第三块视图）；
② `3.5-07` 与 `3.5-03` 的截图腿要真实窗口与你在场（§7.9 第 3 条）；③ 中文腿随字体资产那条裁定（`3.5-06`）不动。

---

### 7.15 3.5-d 线框腿落地记录（2026-10-06，`pdf.layout.textItems`：`3.5-01` 的非可视半边有了，状态位照旧不动）

**落点**：`packages/pdf-edit/src/text-layout.ts`（纯换算，16 例）+ `packages/pdf-edit/src/layout-service.ts`（`pdf.layout` 服务，12 例），包内 71 → **99 例**。
接线四处：`packages/shared/src/bridge.ts` 的白名单第三行 + `RequestMap` 一条 + 两只视图类型（`PdfTextBoxView` / `PdfTextItemsView`）、
`packages/main/src/registry.ts` 的 `'pdf-layout'` 行、根 `cordis.yml` 的 `- id: pdf-layout` 行（与上面两行一样不 inject、不 `dependsOn`，`pdf.*` 仍不登记 agent 工具）、
以及装配对账那一份（`packages/main/src/pdf-link.test.ts`）78 → **79 例**——那条「`pdf.*` 精确等于两项」的断言按字面改成三项，
`isAllowedCall('pdf.layout.textItems')` 从 `false` 翻成 `true`，同时补了 `pdf.layout.items` 与 `pdf.layout` 两条"抄错的名字进不来"。

**为什么这一片现在能做、不等裁定**：§7.9 第 1 条欠的是"**位图级**真实渲染要不要为 pdfjs worker 动 CSP"那一条表态，
而它给的默认读法（文本项线框）本身就写在 §7.3 的包图（`src/text-layout.ts`）与 §7.4 的表（`pdf.layout` 那一行）里，没有欠东西。
这条腿落的正是**默认读法的非可视半边**；`3.5-01` 那行的 V（样例 PDF 截图含高亮）仍归 §7.9 第 3 条那个在场时段，所以状态位是 `[ ]` 原地不动。

**与 §7.4 那张表的一处偏离（只收窄读数，不动签名）**：表里原本写「带 `transform/width/height/str` 的文本项（脱敏：只回坐标与命中框，整页原文不进渲染层）」。
落码时按后半句的字面把 `str` 摘了，三条理由：① 判据要的是"看得见有哪些块"，线框自己就够了；
② 覆盖式轻编辑下框选是**人工画的**（降级裁定对 3.5-01 的改写原文），界面上没有一处需要原文；
③ 搬原文过界就是 §8.5 那条默认脱敏的反面，而 §2.6 不许为假想的将来留通道。
`textItemRect` 只用 `str` 判"这一项有没有可画的东西"，判完就丢。钉住这件事的用例是把读数 `JSON.stringify` 之后搜 `Jane` / `Doe` / `138` 全搜不到、而 `xRatio` 在（口径照 3.6-b 那条 `structuredClone` 断言）。

**页面宽高只问 pdf-lib 一份**（§2.5 的"一个入口"）：`pdf.io.open` 报的、另存腿 `toPageRect` 换算用的、线框换算用的必须是同一个数，
否则会出现"框看得见但盖上去偏了"。pdf.js 在这里只干"取文本项"这一件事，**不用它的 viewport 当尺寸**。
**由此继承一条限制**（写在这里以免被当成新缺陷）：换算按 MediaBox、假定原点 (0,0)、旋转不参与——与 `overlay-writer.ts` 完全同一条口径，
所以 CropBox≠MediaBox、MediaBox 原点非零、页面带旋转这三类文档上线框与覆盖区**要么一起对、要么一起偏**；要修就两条一起修（另裁一片，不在这里单改一侧）。

**实测读数（§6.2：框架 API 形态以真库为准，不信文档转述）**：`minimalPdf(['Jane Doe','Zurich'])` 那份 A4（595×842，基线 y=800、每行 −20 Td）
经**真的** pdf.js 6.3.289 抽出两项——`transform[4]` 就是左边距 50、`transform[5]` 就是基线、`width`/`height` 是 pt 而不是像素。
用例三条硬断言分别钉：左边距 `50/595`、两行 `yRatio` 之差 ×842 正好 20（这一步同时证明轴没翻反、步进没被缩放吃掉）、
以及"第一行 `yRatio` 小于 0.5"（没翻轴会报成 0.95 附近）；项高落在 6…40pt 的合理带内。图片型那一类（`minimalPdf([])`）回空数组而不是失败，与 4.1 的扫描件判定同一口径。

**这轮的闸门读数**：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 四道 EXIT=0
（`pdf-edit` 99 / `main` 79 / `resume-doc` 136 / `workflow` 214 / `core` 52）；`pnpm app:build` EXIT=0，
产物 `build/app/main.cjs` 4,028,770 字节（上一轮 4,003,604），`pdfjs-dist` 在产物里只以**外置 require** 出现——
`RUNTIME_EXTERNAL_ROOTS` 早已含它（第 19 行），第 173 行那条"子路径必须单列"也是 4.1 那份动态 import 立下的，本片直接复用同一份 externals，
**外置资源目录没有新增一支**（§1.4 的"用户零手动下载"照旧）。`LICENSES.md` 按裁定③ 跑过 `check-licenses.ts --write` 后**字节未变**：
包集合没添新条目，只是 `pdf-edit` 多了一条对同一版本的声明。

**状态机读数**：一个 `[x]` 都没新增、一个 `[!]` 都没动（P3 未做仍 **4 条**、全局 `[ ]` 仍 **6 条**，`447 / 32 / 6`）——
新增的是 `3.5-01` 的 C/U 半边证据，那行的验收方式写的是 V。

**顺延（别在下一轮被当成"顺手补齐"）**：① `3.5-01` 的线框截图与 `3.5-03` / `3.5-07` 的截图腿一起等 §7.9 第 3 条那个在场时段；
② §7.5 那块「在既有 PDF 上改」的第三视图——它现在**两头都齐了**（`pdf.io.open` 报页数、`pdf.layout.textItems` 报线框、
`createPdfEditSession` 在渲染层拿 draft、`pdf.export.saveAs` 落盘），下一片就是把它拼起来，连 `@auto-cc/plugin-pdf-edit` 的窄出口
`"./edit-session"`（§7.14 顺延①）一并给；③ `3.5-06` 的中文腿随字体资产那条裁定不动。

### 7.16 3.5-e 面板腿落地记录（2026-10-06，§7.5 的第三视图进主干；状态位照旧不动）

**落点**：`packages/renderer/src/PdfEditPanel.tsx`（新组件）+ `ResumePanel.tsx` 的入口按钮与挂载两处 +
两份语言包的 `pdfEdit.*` 命名空间（42 键 × 2）。接线两处：`packages/pdf-edit/package.json` 的窄出口
`"./edit-session"`（§7.14 顺延① 那条，至此才登记，因为直到本轮它才有真的调用点）与 `packages/renderer/package.json`
对 `@auto-cc/plugin-pdf-edit` 的 workspace 依赖。链路与 §7.5 一致：键绝对路径 → `pdf.io.open` → 页面列表 →
`pdf.layout.textItems` 的线框 → 拖框进会话 → 页序/撤销重做 → `pdf.export.saveAs`。

**本片没有新增任何 IPC 白名单行**：§7.8 的表里那句"`pdf.edit.*` 的白名单行随渲染层那一片"按 §7.14 的裁定**落空了**——
会话既然是渲染层的纯模型，就不存在 `pdf.edit.*` 这六条通道，再开一条正是 §2.5 禁止的"两个都能用"。
`pdf-link.test.ts` 那条「`pdf.*` 精确等于三项」照旧成立，一行未动。

**尺度从主进程现读，界面上不写死第二个数**：会话要 `maxOverlays / maxPages / defaultTextSizePt / minAreaRatio` 才建得起来，
取值走**已有**的 `plugins.readConfig('pdf-export')`（内核的生效配置，schema 默认值已补在里面），
没有为此新增一只 `pdf.export.limits`——§7.14 那句"界面从配置读来传进来"至此落实。
**一条已知偏差**：热改 `pdf-export` 配置会重建注入它的下游服务（§9 的 2.5 那条），而界面里的会话不会跟着换尺度；
本轮的处理是"尺度真的变了才重建会话"（重建会丢撤销历史，所以不做每次动作都重建）。判据的权威始终在另存那一侧，
界面放行而另存被拒时，主进程那句中文原样摆在界面上，界面不自己解释。

**与 §7.5 的一处偏离（改的是"用什么画"，不是"画什么"）**：§7.5 写的是"线框与覆盖框全是绝对定位 + utility 类"，落码换成了 `<canvas>`。
那条路在本仓走不通：线框位置是**那份文件算出来的数据**（任意小数），而 Tailwind 只认源码里逐字出现的静态类，
§5.1 又禁内联 `style`（`RENDERER_SYNTAX` 第一条就是机检），既拼不出类、也不许写 style。
canvas 的宽高取 `width`/`height` **属性**（不是样式），页面比例按那份文件的 pt 等比换算，换算比例 `CANVAS_SCALE` 只影响清晰度、不参与任何判定。
副作用如实记在这里，别到验收时才发觉：**线框层不再是 DOM 节点**，harness 对它能取的证据只有截图（§7.1 两种都收，够判 `3.5-01` 的 V），
而覆盖区列表、页序行、提示行、回执仍是 DOM，`data-testid`（`pdf-edit-*`）与 `data-action`（同样加 `pdf-edit-` 前缀，
避免与 `ResumeEditor` 的 `undo`/`redo` 同名——§9 的 5.4-b ⑦ 那条命中隐藏同名元素的坑）一应俱全。

**§7.6 的反伪装口径落成常驻文案**：`pdfEdit.coverHint`（"覆盖是白底加新字：原文字仍在文件里，只是被盖住了"）
只要打开过文件就一直挂在界面上。文案里不出现涂黑/删除原文那类字样，删区的按钮写的是"撤掉这一区"。

**`moveOverlay` 这一片故意没接**：会话六个动作里只有它没有界面调用点——§7.5 列的图标是加框/删框/上移下移/撤销重做/导出，
"拖拽改位置"不在其中。按 §2.4 不为接而接；这条腿等 `3.5-03` 那条截图腿的真人在场验收里长出来再说。

**纯度从此有机检**：`edit-session.test.ts` 最后一节扫 `edit-session.ts` / `page-ops.ts` / `overlay-writer.ts` 三个文件的
**运行期** import（`import type` 擦除后不算），走正向白名单：只许 `@auto-cc/core/snapshot-stack` 加闭包内相对模块。
这一条在本轮写的时候就抓到我自己把 `./page-ops.js` 漏在白名单外而先红一次——它确实拦得住东西。
比这条更硬的读数在构建产物里（下面那段）。

**这轮的闸门读数**：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 四道 EXIT=0
（`pdf-edit` 99 → **100** 例，就是那条纯度用例；`main` 79 例未动、`resume-doc` 136、`workflow` 214、`core` 52）；
`pnpm app:build` EXIT=0，`build/app/main.cjs` 仍是 4,028,770 字节（主进程一侧一字未增），
渲染层产物 `build/app/renderer/assets/index-*.js` 939,925 字节，其中 `pdf-lib` / `PDFDocument` / `pdfjs` / `readBoundedFile`
各搜 **0 次命中**、`pdf-edit-panel` 有命中——这就是 §7.14 那条"零 Node 依赖"约束真正要的读数：
窄出口确实把引擎留在了主进程。`LICENSES.md` 无需重跑（包集合没添新条目，`pdf-edit` 对 `pdf-lib`/`pdfjs-dist` 的声明早已在册）。

**状态机读数**：一个 `[x]` 都没新增、一个 `[!]` 都没动（P3 未做仍 **4 条**、全局 `[ ]` 仍 **6 条**，`447 / 32 / 6`）。
`3.5-01` / `3.5-03` / `3.5-07` 三行的界面落点至此全部就位，欠的只有"真实窗口 + 你在场"那一段（§7.9 第 3 条）。

**顺延（别在下一轮被当成"顺手补齐"）**：① 三条截图腿要你在场，一次跑完；② `moveOverlay` 的界面调用点；
③ 拖框精度与"画布上点不动"这类只有活体才暴露的坑（§9 的 5.10-a ⑩ 一族）——第一次在场跑就要按 ⑩ 那条写法核，
不要相信 `pointerdown` 的返回值；④ `3.5-06` 的中文腿随字体资产那条裁定不动。

---

## 8. 排版编辑器（3.6 的九条）的实现面计划（2026-10-05，先 plan 再落码，`AGENTS.md` §0）

**为什么这一片现在可动**：3.5 余下的四条 `[ ]` 全卡在裁定或在场（§7.9 三条 + 裁定⑧ 未落的字体半边），
而 3.6 只依赖 3.3（已 `[x]`），§7.8 那句"与轻编辑无关、判据与状态不动"意味着它不需要新裁定——
这是 P3 里当前唯一一条能离线推进的轨。本节只立边界与分片，**不动一行业务代码**。

### 8.1 三条必须先立的边界（都是本仓已存在的决定，不是我新加的约束）

1. **文档正文不过进程边界**。`packages/shared/src/bridge.ts:1381-1397`（4.5-11 那段）已经写死三条理由：
   `shared` 在 L1 不许依赖 L2 的 `resume-doc`、在 L1 抄一份文档模型就是第二个真相源（§2.5）、
   3.3 / 4.1 定的"文档正文不过界，界面只认 docId"。所以 3.6 **不是**"把 `ResumeDocument` 搬进界面改"，
   而是照 5.10 画布那条已经走通的样子：**动作过桥、投影回来**。渲染层拿到的是一条 view
   （区块的 id/kind/标题/条目数、度量读数、校验问题、dirty 与可撤销位），改一律经 service 的口。
   `WorkflowGraphView` + `workflow.graph.save` 是同形态先例——`ResumeEditorView` 是它的**投影版**而非镜像版。
2. **模板不进文档模型**。`Layout`（`packages/resume-doc/src/model.ts:28-38`）只有 `pageSize`/`margin`/`baseFontPt`(pt)/
   `lineHeight`(倍数)/`columns`，**没有 templateId**；模板是纯函数注册表（`src/template.ts:26-68`，
   内置 `classic|modern|minimal` 在 `src/internal/templates.ts`），预览与导出都按 `(docId, templateId, locale)` 现取
   （`src/export-service.ts:204/219`）。于是 3.6-04"切换即时生效且不丢数据"的正确实现是**切换根本不碰数据**：
   模板 id 只当预览实参，判据落成两条断言——切完之后 `resume_docs` 里那份文档的 `content_hash` 一字不变，且预览 HTML 变了。
   不许为了"记住选了哪条模板"往模型加字段（那是把视图状态塞进文档模型，还会连带改 `content_hash` 的语义）。
3. **校验只有一处**。`layoutSchema`（`src/schema.ts:36-47`）现在只有 `.positive()` 与 `columns int 1..2`，
   **没有任何上下界**——3.6-02 要的"非法值被拒并提示"是净新增，且必须加在这份 schema 上
   （`validateDocument` 是唯一入口，`doc-store.ts:102` 的 save 与 `:131` 的 load 都过它）。
   界面上那句提示读服务返回的 `ReadableIssue`，渲染层不再判一次范围（§2.5；也是 §7.4 的④）。

### 8.2 拖拽通道选型（`AGENTS.md` §6.1 的"候选 + 否决理由 + 一手来源"）

| 候选                                        | 结论     | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生 HTML5 DnD（`draggable` + `dragstart`） | **否**   | 本仓唯一被活体证明能驱动的拖拽通道是 **CDP 派发的可信鼠标事件**，且 `harness drag` 中间每一步都带 `buttons: 1`（`packages/testing/src/cdp.ts:451-460` 的注释就是 5.10-14 的活体缺口写下的）。HTML5 那一路要的是带 `DataTransfer` 的 `dragstart`/`dragover`/`drop`，这条通道在本仓**一次都没派发成功过**；而 3.6-01 的判据原文是"拖拽前后截图对比"，取不到活体就等于没做（§7.1）。"不确定它行不行"的成本是把一条 V 判据挂在一个未验证的通道上——不赌                                                                                                                                                                                                    |
| 引入 `@dnd-kit/*`                           | **暂不** | §6.3 先回答"现有依赖能否覆盖"：需要的两样本仓已有——历史栈是 `@auto-cc/core/snapshot-stack`（全仓唯一一份，画布 5.10-19 与 pdf-edit 3.5-08 是两个已验收消费者，spec 的原话是"不许引入第二套历史栈"）；落点数学要另写，**不能复用 `reorderDocument`**（`packages/resume-kb/src/generate-reorder.ts:200`，它的实参是缺口报告行与实体草案，是**相关性驱动**的换序，与"人把第 i 块拖到第 j 位"不是同一件事，复用它是误用；只借它 `ReorderBasis` 那个"谁动了、从哪到哪"的读数形状）。@dnd-kit 卖的是传感器（触摸/键盘/无障碍）与碰撞算法，九条判据里都没要；引入它还得多三条记账行与一层许可面。检索到的只有 SEO 级对比文（本节末链接），按 §6.2 不作为依据 |
| 自己做 pointer/mouse 把手拖拽（**推荐**）   | **是**   | 与 react-flow 的 d3-drag 同一条通道，已被 5.10-14 / 5.10-k 两次活体跑通（`harness drag` 真能拖起来并留下截图证据）。一个把手 + `pointerdown/move/up` + 落点算 index，代码量小于引入依赖带来的记账与边界扩大。§2.7 的"禁止第二套同类基础设施"在这里不触发：全仓的**列表**拖拽此前不存在（画布是图，不是列表）                                                                                                                                                                                                                                                                                                                                          |

反向验证条目（§6.5，落 spec 时补一行）：确认"不引 @dnd-kit、不用原生 DnD"没有造成能力缺口——九条里对拖拽的全部要求
只有 3.6-01（区块重排 + 即时预览），pointer 通道覆盖它并且能取活体。

### 8.3 落点：包、service、白名单、迁移（§4.3 要求写明理由）

- **不新建包**：编辑器属于生成轨的文档域，扩 `packages/resume-doc`（§2.3 扩展现有模块）。新增两个纯文件：
  `src/editor-ops.ts`（`moveSection` / `moveEntry` / `setMetric` 三个纯操作：输入 draft 输出 draft + issue 列表，
  形状照 `packages/pdf-edit/src/page-ops.ts` 的"拒绝腿在前、合法才产 draft"）与 `src/editor-session.ts`
  （`createResumeEditorSession()`：draft + `createSnapshotStack` + dirty 位 + 当前 templateId/locale，
  与 `packages/pdf-edit/src/edit-session.ts` 同构——同一逻辑的第二次出现，按 §2.2 抽的是**栈**而不是再写一份栈）。
- **service 名 `resume.editor`**（`src/editor-service.ts`，注入 `resume.doc` 与 `resume.print`）：
  `packages/main/src/registry.ts` 与 `cordis.yml` 各加一行，且 **`resume-editor` 必须排在 `resume-doc` 之后**
  （§9 的 5.1-c：清单顺序就是挂载顺序，早挂的问不到晚注册的）。
- **白名单行**（与 `BridgeSignatures` 同批改，`BridgeSignaturesCovered`（`bridge.ts:2183`）是编译期保险丝，
  两边不齐 `pnpm typecheck` 直接红）：`resume.editor.open` / `.view` / `.move` / `.metric` / `.preview` /
  `.undo` / `.redo` / `.save`，返回统一是那条 `ResumeEditorView`；`.preview` 返回 string HTML 且必须走
  `resumePrint.buildHtml` 那**同一个** builder（§3 关键设计点第 3 条：预览用的 DOM 与导出用的 DOM 必须同一份）。
  这一批是渲染层第一条 resume 域的**写**口，口径照 5.10-e 那四条：只由人按、**不登记为 agent 工具**
  （它改的是"以后投出去的那份简历长什么样"，与 §3 第 1 条的事实锁定是同一条线）。
- **本片不需要新迁移**：draft 与历史是编辑会话的运行期状态，活在 service 内存里；保存走 `resume.doc` 已有的
  `save`（表 `resume_docs`，号段 7）。按 §9 的 5.3-a（改老迁移的 `up` 不会重跑）这片压根不碰台账；
  只有 §8.5 第 1 条裁成"草稿要跨重启"时才需要新增表（取号段 **30**，当前最高 29，`packages/workflow/src/run-store.ts:123`）——
  **裁定⑨ 已裁"只拦不存"，所以 3.6 全程不碰迁移台账**。

### 8.4 九条判据 → 三片（顺序依赖与能否离线收）

| 片               | 内容                                                                                                                                                                              | 收哪几条                                                                                                                        | 离线可收                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **3.6-a** 模型腿 | `editor-ops` + `editor-session` + `layoutSchema` 的上下界，纯函数单测（fixture 文档现造，不碰用户磁盘）                                                                           | 3.6-01 的落点数学、3.6-02 的 U、3.6-03 的 U、3.6-04 的"数据一字不变"断言                                                        | 能                                                   |
| **3.6-b** 契约腿 | `resume.editor` service + registry / `cordis.yml` 顺序 + 白名单与签名 + `ResumeEditorView` 投影 + `packages/main/src/editor-link.test.ts`（照 `pdf-link.test.ts` 的接线判据形态） | 3.6-02 的界外拒绝跨进程不丢 message、3.6-05 / 06 / 07 的 C 半边（现成机检复跑）                                                 | 能                                                   |
| **3.6-c** 界面腿 | 编辑器组件（把手拖拽、滑杆、撤销/重做两颗按钮、模板下拉、未保存离开拦截）+ i18n 双语                                                                                              | 3.6-01 的 V、3.6-02 的提示截图、3.6-03 的 V、3.6-04 的 V、3.6-05 的双语截图、3.6-06/07 的目视、3.6-08 的计时与截图、3.6-09 的 V | **不能**（要真实窗口与你在场，§7.9 第 3 条同一口径） |

3.6-08 的阈值按判据原文"阈值来自配置"落在 `resume.editor` 自己的 `static Config`（`maxPreviewResponseMs`、
`largeDocumentSectionCount`），不新开一套配置读取（§2）。3.6 落地还带一笔连带：spec 3.7 注记把
`seedDemo` 的 `variant='edited'` 的退场条件挂在"3.6 落地"（`export-service.ts:33/95/110`、`bridge.ts:1009/2002`），
真编辑面出现之后那条演示用的"第二版内容"就该退掉——这一笔属 3.6-c 收口时一起处理，不夹带进 a/b。

### 8.5 需要你再裁 / 必须在场的（2026-10-05 已裁三条，只剩第 4 条）

1. **3.6-09 的字面读法** → **裁定⑨：只拦不存**。未保存时给确认框，重进看到的是上一次保存的那份
   （"数据不静默丢失"= 已保存的没被覆盖、也没被半截草稿污染）。draft 与历史**只活在 service 内存里**，
   所以 3.6 **不新增迁移**，号段 30 不启用。
2. **界面形状** → **裁定⑩：另起组件 + 面板按钮进入**。新建 `ResumeEditor.tsx`，由 `ResumePanel` 一个按钮进，
   **不占首页位**（5.9 只规定 chat 是第一入口、工作流是第二视图），`ResumePanel.tsx` 里不再塞编辑器逻辑。
3. **拦到哪一层** → **裁定⑪：只拦组件卸载**（切视图 / 收起面板）。app 关闭那一条要 `packages/shell` 的窗口 close
   事件加一次跨进程问答，判据原文只写"关闭编辑器"，按字面不做。
4. **V 腿时段** → **2026-10-06 已跑（你在场）**：3.6-01/02/03/04/05/08/09 的活体按 §7.1 走 `pnpm harness`
   （CDP 10222、`--url 5173`、同批 `md5 -q` 去重），dev 换了一份 `userData`（`tmp/v6-userdata`）没动你正在用的 app。
   结果：八条 `[x]`、`3.6-08` 记 `[!]`（>5 区块的前提在现有界面上到不了）。逐条读数与三条活体坑见 §8.9。

### 8.6 3.6-a 模型腿落地记录（2026-10-05，九条判据一条都不打勾：U 半边过了、V 半边全缺）

**落点**：`packages/resume-doc/src/editor-ops.ts`（`planMetric` / `planSectionMove` / `planEntryMove` + `EDITOR_METRIC_BOUNDS`）
与 `editor-session.ts`（`createResumeEditorSession`），各带同目录测试（9 + 9 例，包内 106 → **124 例**）。
接线只一处：包的门面 `index.ts` 多两组导出。**没有新文件、没有新包、没有新 service、没有新迁移**（§8.3 的口径）。

**一处与 §8.4 那行的自我矛盾要在这里裁定掉**：表里 3.6-a 写的是"`layoutSchema` 的上下界"，而 §8.1 第 3 条立的是
"校验只在一处、界不加进 schema"。按后者落。理由是这两句其实是两个问题：`layoutSchema` 回答"一份文档合不合法"，
3.1/3.2 的已验收判据全挂它身上；3.6-02 回答"人的滑杆允许推到哪儿"。把后者塞进前者，等于用今天新立的界面范围
**追改**昨天已验收的判据——一份 5pt 字号的旧文档会因为今天立了"最低 6pt"而突然变非法，那是 §2.4 的反面。
所以界表是编辑器自己的事实，`editor-ops.ts` 是唯一读它的地方，`schema.ts` 一字未动。

**界表取值**（`EDITOR_METRIC_BOUNDS`）：字号 6…24pt、行距 1…3 倍、边距四边各 5…40mm。
两条约束反过来钉它：`DEFAULT_LAYOUT`（10.5pt / 1.5 / 14·16mm）必须落在正中，且**表里必须容得下 DEFAULT_LAYOUT 的每一个值**
——这条不是注释里的愿望，是一条用例（遍历界表逐项比对默认值），改默认值忘了改界就红。
`columns` 明确**不在**界内：模型只有 1..2 两档，`layoutSchema` 已经管着，给人一根两档滑杆是把同一件事做两遍（§2.6）。

**落点数学只抽了一处**：`reorderAt` 是泛型的"抽掉再插入"，区块与条目各调一次（§2.2：同一逻辑第二次就抽）。
语义取人的直觉——`toIndex` 是**结果数组里的下标**，不是"跨过几个"。条目重排限在所属区块内，跨区块搬条目
返回 `unknown-entry` 而不是偷偷挪家：条目是某个 kind 的一条记录，挪进别的区块改的是内容归类（3.1 的语义），不在这九条里。
其余区块**按引用原样保留**（用例钉住"没被搬的那个区块还是同一个对象"），否则一次拖拽会把整份文档的引用全部重造。

**空编辑不进栈的判据是 `contentHash` 相等**，不是逐动作写三份比较逻辑：`normalize.ts` 那份 canonical 已经定义了
"两份文档内容上是不是同一份"（`updatedAt` 不参与）。顺带来一个白捡的正确读数——`isDirty()` 就是"与打开时 hash 不同"，
于是**撤销回原样自动不再 dirty**，3.6-09 的拦截提示不会在用户手动退回去之后还拦他一次。
拒绝腿（界外、NaN、未知 id、越界下标）都不动栈也不抛异常，界面读的是 `code`；会话这一层只回答"进没进一步"。

**模板与语言放在历史栈之外**（两个普通局部变量，不在快照里）。这是 §8.1 第 2 条"模板不进模型"的直接兑现，
也是把 3.6-04 从"要小心的判据"变成"结构上不可能失败的判据"：一次切换不改文档一个字节，
用例于是写成 `contentHash` 前后相等 + `toEqual` 全等 + `canUndo()` 仍为 false（切换**不产生**撤销单元）。

**一条自己写错、值得记下来的用例**：`moveSection('exp', 1)` 之后我去断言 `sections[0].entries`，
而那一刻 `sections[0]` 已经是 `skills` 了——报错是 `expected [ 'e4' ] to deeply equal [ 'e1','e2','e3' ]`。
这不是笔误级别的问题，而是**按下标断言一份正在被重排的数组**必然踩的坑。改法是把断言按 id 现查
（测试里加了 `entryIds(session, sectionId)` 一只小 helper），区块顺序另断言。3.6-c 写界面时同一口径适用：
DOM 与状态都要按 id 寻，不要按下标缓存位置。

**这轮的闸门读数**：`pnpm typecheck` EXIT=0、`pnpm lint` EXIT=0、`pnpm format` + `format:check` EXIT=0；
`pnpm test` EXIT=0——23 个包全绿、无 failed 无 Errors，`resume-doc` 12 文件 / **124 例**，
`core` 52 例（没碰快照栈抽取）、`workflow` 214 例、`main` 70 例、`pdf-edit` 71 例均未降级。
中途一次 TC=2：`editor-ops.test.ts` 里对 `PageMargin` 用变量键索引触发 TS7053（`noUncheckedIndexedAccess`），
改成字面量比较分流 + `as const` 边距键表后过了。

**状态位**：3.6 九条**全部保持 `[ ]`**。U 半边（3.6-01 的数学、3.6-02 的界内界外、3.6-03 的五步一致性、
3.6-04 的数据不变）已过，但四条判据的原文方式都带 V，spec §7 的验收标准不允许用单测替代可视项。
所以 P3 的实现面**仍是 14 条**，这轮一个勾都没打。
**顺延**：① 3.6-b 契约腿（`resume.editor` service + 白名单/签名 + `ResumeEditorView` 投影 + `editor-link.test.ts`，离线可收）；
② 3.6-c 界面腿（要你在场）；③ §8.4 那笔连带——`seedDemo variant='edited'` 的退场，留给 3.6-c 收口，不夹带。

### 8.7 3.6-b 契约腿落地记录（2026-10-05，九条状态位仍然一条都不动）

**落点**（§8.3 那四条登记一次做完，没有新包）：`packages/core/src/errors.ts` 加四条码、
`packages/resume-doc/src/editor-service.ts`（**新文件**：`ResumeEditorService`，provide 名 `resume.editor`，注入 `resume.doc` 与 `resume.print`）
与 `editor-service.test.ts`（11 例，包内 124 → **136**）、`packages/shared/src/bridge.ts`（白名单 9 行 + 5 个投影类型 + 9 条签名）、
`packages/main/src/registry.ts` 与 `cordis.yml` 各一行、`packages/main/src/editor-link.test.ts`（**新文件**，8 例，包内 70 → **78**）。
迁移台账一字未动（裁定⑨：draft 只活在内存，所以本片没有表要建）。

**四处与 §8.3 的偏离，逐条写理由**（不是随手改的，每条都是"照原文写会留下第二种事实"）：

1. **白名单九行，比表里那八行多一条 `resume.editor.use`**。模板与语言是会话的读数（`editor-session.ts` 把它们存在历史栈之外），
   界面若不经主进程就换不了它们；若让界面自己记着"当前是哪套模板"，就是 §2.7 禁止的第二份事实——而且 2.5-e 那条实测
   （热改配置重建下游 → 本地那份静默变空）在这里同样成立。`.use` 返回的仍是同一条 `ResumeEditorView`，
   所以"切完之后界面拿到什么"只有一种形状。
2. **码只开四支，子原因进 `details.reason`**：`RESUME_EDITOR_NOT_OPEN` / `RESUME_EDITOR_DOC_UNAVAILABLE` /
   `RESUME_EDITOR_TEMPLATE_UNKNOWN` / `RESUME_EDITOR_EDIT_REJECTED`。最后一条后面跟着 `editor-ops` 的六种拒绝码
   （`unknown-metric` / `not-a-number` / `out-of-bounds` / `unknown-section` / `unknown-entry` / `index-out-of-range`）
   作为子原因。先例是本仓的 `PDF_EDIT_SAVE_FAILED`（`errors.ts` 里那条注释写着为什么）：**界面处置相同就共用一支码**，
   六种界外/越界的处置都是"这次没改成，改完再试"，开六支只会让界面的 switch 长六条一模一样的分支（§2.6）。
   界值本身随投影给（`metricBounds`），界面因此不需要抄一份界表——`editor-ops.ts` 仍是全仓唯一读那张表的地方。
3. **会话的三个变更方法从 `boolean` 改成 `EditorOutcome<ResumeDocument>`**。第一版是把服务写成"先看 `boolean`、
   再自己拼一条拒绝"，那等于判据有两处（`editor-ops` 一处、服务一处），按 §2.5 当场退回：会话直接把 planner 的
   判定原样转发，服务只负责把 `!ok` 翻成 `AppError`。`3.6-a` 那 9 条用例的断言因此跟着改了形状（`toBe(true)` → `.ok`），
   一条判据没少。空编辑（拖回原地、改成同一个值）走的是 `{ ok: true }` 那一支——它没有推进栈，但也没被拒，
   界面读到的是"当前读数原样"，这正是 §8.6 立的那条"空编辑不进栈"。
4. **3.6-08 的两只配置键本片不装**（`static Config` 是空的 `z.strictObject({})`）。判据原文要的是"预览响应计时与阈值一致"，
   而计时发生在界面那侧、阈值此刻没有任何读者——先接上就是无人读的死配置（§2.4），随 3.6-c 一起落。

**`markSaved()` 是这片新加的会话能力**（3.6-09 的另一半）：`save` 把 `resume.doc` 存完，会话把 dirty 的**基线**推到当前内容，
历史栈照旧保留。用例钉的是这组读数：存完 `isDirty=false` 而 `canUndo=true`；再退一步 `isDirty` 回到 `true`——
因为"与已存那份不同"这件事又成立了。没有这一位，保存之后用户会看到一颗永远亮着的"未保存"。

**投影的形状**（`ResumeEditorState` ↔ `bridge.ts` 的 `ResumeEditorView` 一一对应）：`docId` + 区块的 `{ id, kind, entryIds }` +
`layout` 全量度量 + `templateId` / `locale` / `templates` + `metricBounds` + 三位读数（`isDirty` / `canUndo` / `canRedo`）。
**没有一句正文**：区块标签由界面按 `kind` 走 i18n（3.2-06 已有口径），条目要显示内容走 `.preview` 那份打印 HTML。
这条边界在两层各有一条可执行断言：包内是 `JSON.stringify(view)` 不含 `岗位-e1` / `经历`，装配面是**经网关拿到的投影再过一次
`structuredClone`**（IPC 载荷的真实通路）之后仍不含正文——正文一旦出现在克隆串里，"界面只认 docId"就已经破了。

**装配面判据**（`editor-link.test.ts`，四组八例）：① 注册表与 `cordis.yml` 都有 `resume-editor`，
且它排在 `resume-doc` 与 `resume-print` **之后**（§9 的 5.1-c：清单顺序就是挂载顺序，顺序写反在包内用例里看不出来）；
② 白名单九条逐条 `resolveCall` 切成服务 `resume.editor` + 同名方法，并断言那个方法在挂起来的实例上**真的是函数**
（名单写了而服务没有，界面按下去得到的是网关的 `METHOD_NOT_FOUND`，不是结构化业务码）；
③ 界外值经网关抛出的仍是 `RESUME_EDITOR_EDIT_REJECTED`，`message` 带键名与界表两端、`details.reason` 带子原因（3.6-02 的判据原文）；
④ 未登记的名字（`dropSession` / 带点的 `save.all` / 整名大小写）与 `resume.doc.save` / `.load` 一律进不来，
且 `agent.tools` 的清单里没有 `resume.editor*`（正向对照是同一次装配里句柄确实按名挂起来了，所以那条空清单不是"什么都没装"）。

**两条只有装配面用例才会踩到的坑，记下来**：
① `resume.editor` 与 `workflow.graph` 一样还没进 cordis 的 `AppServices` 声明，所以 `asApp(ctx)['resume.editor']` 直接写是
TS2551（"Did you mean 'resume.doc'?"）——沿用 `graph-link.test.ts` 已有的手法：先 `as unknown as Record<'resume.editor', unknown>`
再按句柄类型收口，**不去改 cordis 的声明**（那是框架的表，本片没有理由动它）。
② 编辑器九条方法都是**同步**的（会话在内存里），所以 `Promise.resolve(invoke(…)).catch(…)` 接不住抛错——实参求值那一刻就抛了，
`.catch` 挂在返回值上，于是错误穿透到测试体外（表现是两条用例红而错误信息就是那条业务 `AppError` 原话）。
`pdf-link.test.ts` 那两条走的是异步另存腿，所以这个写法在那儿是对的；这里改成 `try/catch`。

**这轮的闸门读数**：`pnpm typecheck` EXIT=0（第一次是 EXIT=2，就是上面那条 TS2551）、`pnpm lint` EXIT=0、
`pnpm format` + `format:check` EXIT=0、`pnpm test` EXIT=0——23 个包全绿、无 failed 无 skipped，
`resume-doc` 13 文件 / **136 例**、`main` 12 文件 / **78 例**，其余包未降级（`core` 52、`pdf-edit` 71、`workflow` 214、`agent` 223、`resume-kb` 398）。

**状态位**：3.6 九条**仍全部 `[ ]`**。这轮收的是 §8.4 那行写的"3.6-02 的界外拒绝跨进程不丢 message、3.6-05 / 06 / 07 的 C 半边"，
但九条的验收方式每一条都带 V 或界面读数，spec §7 不允许用单测替代可视项；按 master plan 的口径（P3 未做 **13 条** / 全局 **15 条**）
这轮一条都没翻。**剩余实现面只有 3.6-c 界面腿**（`ResumeEditor.tsx` + `ResumePanel` 一个按钮进入，裁定⑩；未保存拦截只拦组件卸载，裁定⑪；
3.6-08 的计时阈值配置随这片落；连带 `seedDemo variant='edited'` 的退场）——它要真实窗口与你在场（§7.1 / §7.9 第 3 条同一口径）。

### 8.8 3.6-c 界面腿落码（2026-10-06，代码进主干、九条状态位仍然一条都不动）

**这片写的是什么**：`packages/renderer/src/ResumeEditor.tsx`（新建）+ `ResumePanel.tsx` 的一颗进入按钮（裁定⑩：另起组件、
不占首页位、面板里不再塞编辑逻辑）+ 两份语言包各 **44 键**（`shell.resume.editor.*`，键集对齐由 lint 链里的渲染层规范检查机检）。
形状照 §8.1 第 1 条：**动作过桥、投影回来**——界面手里只有区块 `{ id, kind, entryIds }`、度量数、`metricBounds`、
`timing`、三位 dirty/undo/redo 读数，加一份 `resume.editor.preview` 的打印 HTML；一句简历正文都不到这边（`sandbox=""` 的 iframe 摆它）。

**逐条对着判据写的界面**：3.6-01 是 pointer 把手拖拽（`pointerdown` 起手、window 上的 `pointermove` 按行中心算落点、
`pointerup` 才发一次 `resume.editor.move`；落点没变就一个字节都不发）——选型与否决理由照 §8.2，原生 HTML5 DnD 与 @dnd-kit 都没用；
3.6-02 是六条度量的滑杆，**可拖范围在界表两端各外放 25%**（`OUT_OF_BOUNDS_REACH`，否则"滑杆到界外"这条在界面上永远到不了），
判定仍只在主进程做一次，被拒的 message 单留一行 `resume-editor-rejected` 不被下一个动作冲掉；
3.6-03 是撤销 / 重做两颗按钮 + `canUndo` / `canRedo` 驱动禁用；3.6-04 是模板下拉与预览语言下拉（都走 `.use`，不碰文档）；
3.6-05 是全部文案走 i18n（`zh-CN` / `en` 双语）；3.6-06 图标只取 lucide 现有六只（`GripVertical` / `Undo2` / `Redo2` / `Save` / `X` /
`AlertTriangle` / `Timer`）；3.6-07 样式全是 Tailwind utility，无内联 `style`；
3.6-08 是每次取预览量一次往返毫秒 + `timing` 两个阈值读数（超阈值与大文档各一句）；
3.6-09 是"关闭编辑器"的拦截块（保存并关闭 / 放弃并关闭 / 继续编辑三颗），按裁定⑪**只拦组件卸载**，app 关闭不做。

**一处按 §8.4 的字面补齐**：`resume.editor` 的 `static Config` 从空对象变成 `maxPreviewResponseMs`(1200ms) 与
`largeDocumentSectionCount`(5) 两只带 `.default()` 的键，并随投影出去——§8.7 里"此刻接上是无人读的死配置"那句的前提
（无读侧）到这片结束了。带 `.default()` 的键在**直接调用点必须显式给出**（§9 的 1.3），所以两只测试装配点各补一份实参。

**刻意没做的一笔**：`seedDemo variant='edited'` 的退场**留在真正收口时**。它的退场条件写的是"3.6 落地"，
而 3.6 落地要的是九条 V 判据取到证据；此刻界面还没跑过真实窗口，先退掉会让 3.7-03 已经入库的 diff 证据失去数据源。

**门禁读数（2026-10-06 本机）**：`pnpm format` / `format:check` / `typecheck` / `lint` / `test` 全部 **EXIT=0**；
`resume-doc` 13 文件 / **136 例**（多了一条投影 `timing` 断言，例数不变）、`main` 12 文件 / **78 例**，其余包不变。
**渲染层没有测试面**（无 `test` 脚本、无 `*.test.ts`），所以这片在离线下的全部证据就是这四道门 + 键集对齐机检。

**状态位**：九条**仍全部 `[ ]`**，一条都不翻（P3 未做仍 13 条 / 全局仍 15 条）。这片只是把界面写出来并通过静态门，
判据要的截图与目视一条都还没取——那需要真实窗口（CDP 10222、`--url 5173`、dev 换 `userData`、同批 `md5 -q` 去重），
也就是 §8.5 第 4 条"V 腿时段"仍未定。**下一步就是在场跑这一轮**：载入种子 → 进编辑器 → 拖一把看预览变了 →
滑到界外看那句拒绝 → 连撤销重做 → 切模板与语言 → 有改动时点关闭看拦截块。

### 8.9 3.6 的 V 腿已在活体窗口跑完（2026-10-06，你在场）：八条 `[x]`、`3.6-08` 记 `[!]`

**怎么跑的**：`AUTO_CC_USER_DATA_DIR="$PWD/tmp/v6-userdata" pnpm dev`（换一份 dev 专用 userData，不动你正在用的 app）→
CDP 10222、每个动词都带 `--url 5173` → 诊断视图 → 载入演示内容 → 进排版编辑器 → 逐条动作 + `shot --reveal <小元素>` →
`harness archive --id 3.6-0X --in …` 归档到 `docs/acceptance/3.6/`（12 张）。逐条读数写在 spec 3.6 那条落地记录里，此处只记三条**下一窗口用得着**的事实。

1. **`harness` 的 `drag` / `click` 与 `eval` 一样必须带 `--url 5173`**：不带时它 attach 到默认 target（内嵌内核视图），
   报的是「拖拽起点未找到：<选择器>」，而同一份选择器在 `eval --url 5173` 里查得到——两条命令的 target 不同，容易误判成组件问题。
2. **真实鼠标动作前先确认隐私遮罩不在**：渲染层一 reload 就长出 `data-testid=privacy-notice` 那层全屏遮罩，
   CDP 事件被它接走（在把手中心 `document.elementFromPoint` 拿到的是 `privacy-notice`），而 `element.click()` 跳过命中测试。
   于是"程序化点击有效、可信拖拽无效"看起来像监听挂错时机。先 `click --url 5173 --selector '[data-action=privacy-acknowledge]'`。
   **本轮那条误诊**：我据此把拖拽监听从 `useEffect([drag !== undefined])` 改到 `pointerdown` 当场挂——遮罩才是真因，
   这次改动不是缺陷修复。保留的理由是它去掉了"提交后才挂监听"的那一拍竞态，行为等价、少一只依赖数组；已按实记账。
3. **`--reveal` 对相邻元素不产生新滚动位**：`3.6-08-timing.png` 第一版与 `3.6-02-metric-ok-2.png` 字节完全相同
   （度量行与计时行同屏），靠同批 `md5 -q` 去重才发现。改成页面里 `scrollIntoView({ block: 'start' })` 后不带 `--reveal` 重拍才拿到独立画面。
   **收尾前对整批截图跑一次 `md5 -q | sort | uniq -c` 是硬步骤**（§9 的 5.10-18 那条在 3.6 又命中一次）。

**`3.6-08` 为什么是 `[!]` 而不是 `[x]`**：判据原文的前提是"大文档（>5 页）"，而种子文档只有 3 个区块、
`largeDocumentSectionCount=5` 那条分支在界面上到不了（编辑器入口按裁定⑩ 只挂在种子文档，导入文档没有进编辑器的口）。
阈值那半句已兑现（「预览耗时 1 ms（阈值 1200 ms）」+ 阈值来自 `static Config`，截图为证），
但拿 3 区块的读数冒充大文档读数就是虚报。补法两条（>5 区块的种子 / 编辑器接受任意 docId）都是新增面，不夹带进 3.6。

**3.6 收口后 P3 还剩什么**：`3.6-08` 的那条前提、`3.5-01` 的线框 vs 位图裁定、`3.5-06` 的中文字体半边（裁定⑧ 余下）、
`3.4-08` 的 Windows 同轮读数（本机给不出）、`3.5-03`/`3.5-07` 两条截图腿，以及 `seedDemo variant='edited'` 的退场——
现在九条 V 已取到证据，这笔退场的条件成立了，但它会连带 3.7-03 已入库证据的数据源，属独立一片，不在本轮夹带。
