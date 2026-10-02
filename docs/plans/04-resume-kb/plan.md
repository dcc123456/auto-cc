# 计划四 · 通过简历构建个人知识库（plan）

> 前置：P1（1.3 store / 1.4 IPC / 1.5 插件管理 / 1.9 额度闸门）。与 P2、P3 的关系：
> 本计划**不依赖 P2/P3**，可与 P3 并行；P2.5 的话术与 P3.3 的定制内容都以本计划为内容来源，
> 但在它们之前可以先用固定内容验收，M5 才强依赖 4.5。
> 取证依 `docs/research/source-repos-analysis.md` §2.3 / §4；规范依 `AGENTS.md`。

## 0. 对 `ai-resume`「知识库」的诚实评估（决定本计划的工作量）

| 它有什么                                                                                                                                                                                                                                                                                                                                                                                         | 它没有什么                                                                                                                                                                              | 结论                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 表结构骨架（`base_resume` / `custom_resume` / `jd`）；`vectorService` 用 embedding 做**简历查重**（0.95 阈值）与删改同步；`factCheckService`（levenshtein 归一化比对，公司/职位/时间被篡改则 RETRY_APPEND 重试一次）；`keywordService`（朴素 includes 匹配率）；`prompts/resumeGenerate`（事实锁定 + STAR 重写 + 顺序调序）；`llm/baseProvider`（指数退避 + markdown JSON 清洗）；5 套 HTML 模板 | **无 chunking、无检索增强生成**（生成时把整份简历 JSON 全量塞进 prompt）；embedding 走 LLM 网关，**失败时退化为 sha256 哈希伪向量（1536 维，仅演示意义）**；ChromaDB 是 docker 外部服务 | 「知识库」的**数据建模与生成质量控制可抽**，**检索层必须自建**。不要把它的演示级 RAG 当成现成能力排期 |

## 1. 技术选型与理由（含两条硬性改判）

| 项                   | 选择                                                                                                                 | 理由与否决                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 存储                 | `store`（node:sqlite）扩展 4.x 表                                                                                    | 复用 1.3，不新建连接池；单机单用户不需要 MySQL（`ai-resume` 的 mysql2 全局池必须丢弃）                                                                                                                                                     |
| **检索（关键改判）** | **默认本地 BM25 + 倒排关键词**（纯 JS 实现，零原生依赖、离线可用）；embedding 仅作**可选增强**                       | 否决 ChromaDB：docker 外部服务违反主计划 §1.4「用户只装一个 app」；否决 `sqlite-vec`：需三端预编译原生扩展，与「无 node-gyp / 零前置依赖」冲突。规模判断：个人知识库数十至数百条经历、千级 chunk，JS 内存暴力打分是毫秒级，不需要 ANN 索引 |
| 向量（可选）         | 若启用，向量存 SQLite BLOB，检索时 JS 内余弦；无 key/无网时**自动回落 BM25**，功能不降级为不可用                     | 明确禁止 sha256 伪向量冒充语义向量（`ai-resume` 的退化路径不可复用）；宁可不语义，也不给假语义                                                                                                                                             |
| LLM 接入             | OpenAI 兼容 provider（抽 `baseProvider` 的重试 + JSON 清洗思路，重写实现）                                           | 单一 `llm.provider` service，禁止第二个 LLM 客户端（AGENTS.md §2 基础设施唯一性）；供应商表数据化，支持用户自填 base URL                                                                                                                   |
| 内容真实性           | **事实校验闭环**为强制关卡：LLM 输出必须过 `facts.locked` 比对，命中篡改即重试，仍不过则拒绝产出并标记「需人工确认」 | 简历造假是产品级风险，不是质量问题；`factCheck` 思路可抽（MIT 声明 + 零依赖纯函数）                                                                                                                                                        |
| 部署形态             | 全部本地；无账号体系                                                                                                 | `ai-resume` 的 Express 路由 / JWT 多用户 auth 整体丢弃                                                                                                                                                                                     |

### 1.1 4.1「简历导入与解析」选型与证据（一次取证，写死结论）

依赖许可**必须以发布产物内的 LICENSE 文件为准**，不接受 README 致谢的转述——
本仓库 `docs/research/source-repos-analysis.md` §1 记录 `pdfjs-dist` 为 AGPL-3.0，
其来源是 `canva-pdf` 的 README 致谢，属二手信息。实测推翻了它：

| 候选                         | 版本                                     | 许可（实测来源）                                                          | 判定                                                                                                         |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pdfjs-dist`                 | 6.3.289 / 2.16.105（两个时点都拉了产物） | **Apache-2.0**，读自 jsdelivr 上发布包内 `LICENSE`（两份一致）            | **可用作 PDF 抽文本**。原「AGPL-3.0」结论作废；无需 AGPL NOTICE。`mupdf` 仍是 AGPL-3.0，不在本计划引入范围   |
| `mammoth`                    | 1.13.0                                   | **BSD-2-Clause**（包内 `LICENSE`，Copyright (c) 2013 Michael Williamson） | **可用作 DOCX 抽文本**（它的定位就是 docx→html/text，不做版式）。`ai-resume` 用的也是它                      |
| `unpdf`                      | 1.8.1                                    | MIT                                                                       | 备选（更薄的 pdfjs 封装）。当前不引入，等 4.1 真跑通后再评估是否替换                                         |
| OCR（tesseract.js / paddle） | —                                        | Apache-2.0 / Apache-2.0                                                   | **不引入**（spec 4.1-05 明确「不做 OCR」，模型体积与「用户只装一个 app」冲突）；扫描件只判定、只提示人工补录 |
| ChromaDB / sqlite-vec        | —                                        | Apache-2.0 / MIT                                                          | **不引入**（见 §1「检索（关键改判）」）                                                                      |

解析层的三条复用强制项（AGENTS.md §2.1/§2.5，出现第二份实现即视为缺陷）：

1. **脱敏只有 `@auto-cc/core` 的 `redactText`**：手机号 / 邮箱 / 18 位证件号的值形态与键值形态判据
   已经在 `packages/core/src/redact.ts` 落地（spec 2.7-07 的产物），4.1-09 直接复用，
   **禁止在 resume-kb 内再写一份正则**。
2. **解析产物只有 P3.1 文档模型**：解析输出必须是 `ResumeDocument`（`createEmptyDocument` + `makeField`），
   不新建「简历 JSON 第二真相源」。事实锁定字段（company / role / period / achievement）由 `makeField`
   自动带上 `locked`/`factKey`，正好是 §3-6 不可编造清单的落点。
3. **落库只有一个连接**：经 `asApp(ctx).store`，包内禁止 `new DatabaseSync`（与 1.3/3.x 同口径）。

包名与目录：新增 `packages/resume-kb`，包名沿用本仓库 cordis 插件前缀写成
**`@auto-cc/plugin-resume-kb`**（§2 代码块里的 `@auto-cc/resume-kb` 是早期写法，以本条为准）。
它必须能独立测试，因此**纯解析函数（时间归一化、区块识别）放在不依赖 cordis 的模块里**，
service 只做装配——这样 4.1-03 的 ≥8 例参数化单测不需要起 store。

### 1.2 4.1-b 依赖腿 spike 实测结论（代码即删，结论留此）

spike 与打包探针都跑在 `packages/resume-kb` 内、用完删除（AGENTS.md §6.4），以下是**实测**到的形态，不是文档转述：

| 实测项                       | 结论（可复现）                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pdfjs 的引入路径             | 包内 `package.json` 为 `main=build/pdf.mjs`、`types=types/src/pdf.d.ts`、**无 `exports` 字段**；`legacy/build/` 下有 `pdf.mjs` + `pdf.d.mts`。Node 侧走 `import('pdfjs-dist/legacy/build/pdf.mjs')`，无需 worker 进程                                                                                                                 |
| 抽文本必需选项               | `{ isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 }`，缺 `isEvalSupported:false` 会在无 DOM 环境尝试 eval 构造                                                                                                                                                                                     |
| 文本项形态                   | 每项是 `{ str, dir, width, height, transform, fontName, hasEOL }`；**断行看 `hasEOL`**，同一视觉行的两列（公司 / 时间）由 pdf.js 自己插入一个宽度 273 的空格项，所以顺序拼 `str` 就得到「公司 时间」同行——这正是 `splitHeader` 需要的形状。真实 PDF **不含空行**，所以区块边界靠 `sections.ts` 的逐行标题识别，而不是空行分块         |
| 释放入口                     | 文档代理上**没有** `destroy`（实测 `TypeError: document.destroy is not a function`）；释放要在 `getDocument()` 返回的**加载任务**上调 `destroy()`，页级用 `page.cleanup()`                                                                                                                                                            |
| ArrayBuffer 移交             | `getDocument({ data })` 会**移交（detach）**传入的 `Uint8Array` 的底层 buffer，之后再读该数组得到空壳（实测 `Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer`）。所以**来源哈希必须在抽取前算**，且包内统一「先 `bytes.slice(0)` 再交给三方库」                                                                 |
| 损坏输入的错误形态           | 空文件 `InvalidPDFException: The PDF file is empty...`；垃圾/截断 `InvalidPDFException: Invalid PDF structure.`；非 zip 的 `.docx` `Error: Can't find end of central directory ...`。四条都映射成 `SourceFailureCode`，不抛给主进程（4.1-06 的 U 半边）                                                                               |
| mammoth 的类型               | **不发布类型声明**（`package.json` 无 `types` / `exports`，registry 亦无 `@types/mammoth`），因此包内 `src/mammoth.d.ts` 只声明实际用到的 `extractRawText({ buffer }) → { value, messages }`，其余 API 不臆造。段落之间给 `\n\n`，正好是块边界                                                                                        |
| **打包（关键风险）**         | esbuild `--bundle --format=cjs` 把 pdfjs 内联时**运行期失败**：`Cannot find module '<bundle 目录>/pdf.worker.mjs'`（内联后 worker 的相对路径被改到产物目录）。把 `pdfjs-dist` / `mammoth` 标为 external 且从能解析到包的位置运行，同一探针正常抽出文本。**产物体积**：全内联 2.7 MB，external 后 825 KB（即这两个依赖约 1.9 MB JS）。 |
| 接线片（service + 打包）形态 | **已定案（2026-10-01）：依赖外置 + `asarUnpack`**，落地清单见下表之后的段落                                                                                                                                                                                                                                                           |

**接线片（service + 打包）的形态已定（2026-10-01 决策：依赖外置 + `asarUnpack`）**，落地清单如下，一次做完再谈 4.1-06 打勾：

1. `scripts/build.ts` / `scripts/dev.ts` 的 esbuild `external` 从 `['electron']` 扩到
   `['electron', 'mammoth', 'pdfjs-dist', 'pdfjs-dist/*']`（子路径必须单列，esbuild 的 external 不做前缀匹配）。
2. `scripts/build.ts` 的 staging 目录补一步**依赖搬运**：把 `pdfjs-dist`、`mammoth` 及其**传递依赖**从 pnpm 软链
   解析成真实目录后复制进 `build/app/node_modules/`（`writeAppManifest` 合成的清单要同时声明这几个依赖，
   否则 electron-builder 的依赖收集会把它们当野文件忽略）。递归解析器是这里唯一新写的基础设施，
   禁止手填依赖清单——漏一个就是装机后才炸。
3. `electron-builder.yml` 加 `asarUnpack: ['node_modules/pdfjs-dist/**']`：pdf.js 的 worker 走 ESM `import()`，
   留在 asar 内的读取路径本仓库未实测，解包到 `app.asar.unpacked` 是已验证过的稳妥形态（mammoth 不需要解包，纯 JS）。
4. **1.7-12 的后半句判据（「`app.asar` 内无 `node_modules`」）随之作废**——它的本意是「没有第二套浏览器内核、
   没有意外混入的依赖」，外置两个包之后这个本意要换个判据继续守。1.7 表里 **1.7-13 / 1.7-14 已被 CSP 两条占用**
   （§4.5：文档 ID 一经分配永不复用），所以新增判据落在空号上：**1.7-15「asar 内的 `node_modules` 只允许
   `mammoth` + `pdfjs-dist` 两个根及其传递依赖，不得出现第三个根」**与 **1.7-16「外置依赖在装机布局与真实内核内
   可解析」**。1.7-12 保留 `[x]`（它的「无第二内核」判据在新产物上复验通过），只在验证操作里追加更正说明，
   并把作废的那半句指到 1.7-15。

落地后的实测数字（同一份证据文件 `docs/acceptance/1.7/1.7-15-external-deps-audit.txt`）：外置闭包 **25 个包**
（`mammoth` 带 8 个直接依赖 + 16 个传递，`pdfjs-dist` 自身零 `dependencies`），搬运后 staging `node_modules`
20,209,668 B（已剔 `*.map` 与 pdfjs 的 `web/`、`types/`），`app.asar` 6,159,855 B（内联形态是 1,454,750 B），
`app.asar.unpacked` 只有 `node_modules/pdfjs-dist` 一项，win-unpacked 解包 407,785,028 B（原 387,469,699 B）。
optional 原生包 `@napi-rs/canvas` 刻意不搬运，代价是运行期 3 行 `Warning: Cannot load "@napi-rs/canvas"` 噪音，
不影响文本抽取。体积账：约 +20 MB 换 PDF 抽取腿；用户侧仍是「只装一个 app」，无 node-gyp、无运行期下载。

**打包形态这一半已经落地并实测通过（1.7-15 / 1.7-16）**，4.1-06 的门禁收到剩下的那一半：service + IPC

- 界面错误态没接完之前，4.1-06 仍不得打勾——「依赖能装进 app」不等于「用户点一下能拿到结果」。
  （**已由 4.1-c 结清**：`resume.parse` + `parse.fromFile` / `parse.pending` 两个白名单入口 + 界面错误态
  截图 `docs/acceptance/4.1/4.1-06-invalid-pdf-error.png`，条目已打勾。）

### 1.3 4.1-c（service + IPC + 界面）落地时补的四个决策

接线过程中定形的东西，事先没写在本 plan 里，补在这里作为 4.2/4.3 接线片的先例：

1. **入口只收绝对路径**。渲染层 `contextIsolation + sandbox` 没有读文件的通道（§8），所以界面上摆的是
   路径输入框而不是原生文件选择器——真正的选择器需要开一条受白名单约束的文件通道，那是独立条目，
   不在这一片顺手扩 IPC 面。字节只在主进程侧落地。
2. **幂等键只用来源哈希**，文档 id 由哈希前 12 位派生。spec 原文写「来源 hash + 归一化字段」，实测取窄：
   归一化字段做键会让「同一份文件改了标题行」裂成两条实体，与 4.1-07 的意图相反；哈希做主键 +
   `ON CONFLICT DO UPDATE` 已经能保证「重复导入不产生重复实体」，归一化字段的比对留给 4.2 的实体去重。
3. **失败收敛成单个 `RESUME_IMPORT_FAILED` 码**，子原因进 `AppError.details.code`。它们在界面上的处置
   完全相同（一句可读中文 + 换个文件），拆成六个码会让渲染层写六遍分支（§2.6 不为假想未来做抽象）。
4. **`@auto-cc/plugin-store` 只作 devDependency**：本包用它的类型（`asApp(ctx).store`），运行期靠内核
   注入同一实例。这是 4.1-10「无自建连接」在 pnpm 严格 node_modules 下唯一能同时满足类型与装配的形态，
   4.2/4.3 的新包照抄。

### 1.4 4.2「知识库建模与管理界面」切片分解与三条裁定（写代码之前定死）

取证一手来源：本节结论建立在**本仓库现状实测**（下表每条都带文件:行号）与 §0 的 `ai-resume` 评估、
`docs/research/source-repos-analysis.md:142`（它的 `base_resume / custom_resume / jd` 只能当数据模型骨架看）
之上。**注意**：`.research-repos/` 目录里现在只剩 `pagination-spike`，三个源仓库的取证副本已不在本机，
若需逐行核对 `ai-resume` 的表定义必须重新 clone（§9：GitHub 直连不稳定），因此本节不引用其行号。

**裁定一：导入的简历必须进 `resume_docs`，`resume_imports` 只留出处——这一条是 4.1-c 留下的真实缺口。**

现状实测：`resume_docs(id, schema_version, content_hash, doc_json, updated_at)`
（`packages/resume-doc/src/doc-store.ts:30-36`，写入点 `:114`）与
`resume_imports(doc_id, source_hash, ..., doc_json, issues_json, ...)`
（`packages/resume-kb/src/parse-service.ts:31-42`）**各存一份 `doc_json`**，而 3.x 的编辑、快照、PDF 导出
只认 `resume_docs`。后果：用户导进来的简历在库里躺着一份永远编辑不到、也导不出 PDF 的 JSON——
「根据 JD 优化简历」这条主链在入口就断了。收口沿用**本仓库已经确立的「当前态 + 历史」双表模式**
（`resume_docs` 号段 7 是当前可编辑态，`resume_snapshots` 号段 8 是不可变历史），而不是新发明第三套：

- `resume_docs`：可编辑工作副本的**唯一真相源**；导入时按 `docId` upsert（幂等语义与 4.1-07 一致）。
- `resume_imports`：降级为**不可变的原始解析出处**（保留 `doc_json` 作为「当初解析成什么样」的证据，
  与 `resume_snapshots` 同类语义，4.2-08 的导入冲突与 4.5 的可复盘都靠它）。
- 界面、检索（4.3）、生成（4.5）一律只从 `resume_docs` 读当前态。
- **落地状态（2026-10-01）**：这一条已实现，落点是 `parse-service.ts` 的 `persist()` 在写完出处后经
  `resume.doc.save` 建工作副本，且**仅在 `load(docId).status === 'missing'` 时**建（重复导入不许冲掉用户改动）；
  连带 `inject` / `dependsOn` 加上 `resume-doc`，号段 6→7 的两处陈旧注释同步纠偏。
  落点细节与单测三条（建副本 / 不冲掉改动 / 扫描件不建）见 spec「4.2 开工前置」一节。
  所以 4.2-a 剩下的只是 `kb_entities`（迁移 11）+ 实体派生 + `kb.profile` CRUD。

**裁定二：四类实体用单表 `kb_entities` + `kind` 判别，不建四张表。**

- 列（迁移号段取 **11**，紧随 4.1-c 的 10）：`entity_id`、`kind`、`parent_id`（经历 → 项目的一层归属）、
  `source_doc_id`、`payload_json`（该 kind 的字段）、`normalized_hash`（幂等与去重键）、
  `created_at` / `updated_at`。
- **四类实体与 `SectionKind` 不是一一对应**（实测 `packages/resume-doc/src/model.ts:66`：
  `summary | experience | education | skills | project | campus`），派生映射必须写死，否则 4.2-a 会现场发明：

  | KB kind       | 派生来源                                                                   | 说明                                           |
  | ------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
  | `experience`  | `experience` 区块的 entry                                                  | 字段键 `company / role / period / achievement` |
  | `project`     | `project` 区块的 entry（`parent_id` 指向同文档内时间重叠的经历，可有可无） | 同字段键                                       |
  | `skill`       | `skills` 区块的 `text` 字段按行 / 顿号 / 逗号切分                          | 库里技能只有自由文本，切分规则属确定性代码     |
  | `achievement` | **不是区块**：任何 entry 里 `factKey === 'achievement'` 的字段             | 会与所属经历文本重复，去重靠 `normalized_hash` |

  未纳入实体的区块：`summary / education / campus`。显式记为已知后果而不是留给 4.3 现场发现：
  4.3-11 要求「chunk 粒度 = 可引用粒度」，这三块没有实体行，检索侧只能按**区块级 chunk**索引它们
  （`education` 尤其要紧——4.4 的学历比对必须有据可依），届时由 4.3 切片把这条落进 spec 说明。

- 理由：个人库的量级是数十至数百条（§1 检索一节的规模判断），查询永远按 `kind` 过滤；
  四张表会把 4.2-04 的级联删除变成四种外键组合各写一遍，并把 4.3 的「chunk 粒度 = 实体粒度」
  拆成四种 chunk 来源。实体由 `resume_docs.doc_json` 的 entries **规范化派生**
  （幂等键 `source_doc_id + kind + normalized_hash`），不在本包新建简历数据结构（§2 基础设施唯一性、
  plan §3.5 只用 P3.1 文档模型）。
- 否决 `ai-resume` 的 `base_resume` 宽表（整份简历塞一行）：那种形态无法由一句简历陈述反查到支撑实体，
  4.2-03 / 4.5-06 的 `evidenceRefs` 在宽表上没有落点。
- **命名冲突预警**：`evidenceRefs` 目前全仓零命中，但 `workflow_nodes.evidence_ref`（`run-store.ts:72`）
  已经占用了「evidence」这个词，指的是**工作流失败截图的相对路径**。两者语义无关，KB 侧统一用复数
  `evidence_refs` / `evidenceRefs` 并在注释里点明区别，防止后来者把两套 readings 混为一谈。

**4.2-a 落地状态（2026-10-01）**：迁移 11 `kb_entities` + 实体派生 + `kb.profile` CRUD 已实现并通过全闸；
裁定一那一刀（导入→`resume_docs`）此前已单独落地，所以本片不再碰它。落地时新增的**事实**（不是设计变更）：

- **稳定 id 的强度只有 16 位、且绑在 `entry.id` 上**。实体 id 是 `kb-` + sha256(`docId|kind|slot`).slice(0,16)，
  slot 对经历 / 项目取 `entry.id`，对成果取 `entry.id#achievement`，对技能取 `entry.id#s<n>`。
  而 `entry.id` 本身是**位置号**（`sections.ts:235` 的 `${kind}-${index + 1}`）——**用户删除或重排中间某条经历，
  其后所有条目的实体 id 都会变**。这一条必须在 4.2-b（`evidenceFor`）与 4.2-d（界面编辑）之前写死：
  4.5 / 4.6 存的 `evidenceRefs` 只能保证「同一次同步快照内可反查」，**跨编辑不保证长期稳定**。
  若要长期稳定，得给 entry 引入真正不可变 id，那是 P3.1 文档模型的改动，不属本片，也不在本片偷偷做。
- **项目挂到经历靠「月份区间重叠最多」，不靠公司名匹配**。公司名在中文简历里写法散（「阿里巴巴」/「阿里云」/
  「阿里巴巴集团」），字符串相等会把同一经历拆成两棵树；重叠月数可由 `period.ts` 的 `parsePeriod` 纯函数算出，
  「至今」按 `OPEN_ENDED_MONTH = 99_999` 处理，并列时按实体 id 字典序取小者——结果与遍历顺序无关。
- **去重在派生阶段做**（键 `kind + normalized_hash`，保留首次出现），没有加 SQL `UNIQUE` 约束。原因：成果文本
  与所属经历正文天然重复，而 `source_doc_id` 允许为 `NULL`（手动实体），在 SQLite 里给含 NULL 的列建唯一索引
  等于把「多台机器上的手动实体」变成不同的约束语义，收益不值。
- **`summary / education / campus` 不产实体行**（campus 里 `factKey === 'achievement'` 的字段仍然产成果实体，
  `parent_id` 为 `null`）。与裁定二 的表格一致，且已按承诺把「chunk 粒度」的后果留给 4.3。
- **手动创建的实体永远 `source_doc_id IS NULL`**，因此 `sync()` 的修剪（按 `source_doc_id` 找回派生行）
  不可能碰到它们——这是「派生数据」与「人工数据」共表而不互伤的关键约束。
- **本切片没做 `remove()`**。4.2-04 的级联策略（删经历时下属项目/成果去留）是策略决定而不是 CRUD 缺口，
  归 4.2-c；提前写一个「删一行、留下孤儿行」的版本只会让 4.2-c 先删掉它再重写。
- **两处刻意留下的可见缺口**（不粉饰）：`kb.profile` 已进 `REGISTRY` 与 `cordis.yml`，但**渲染层没有任何调用方**，
  所以「app 真起后这张表被建、service 被挂」目前**只有单测证据、没有真窗口证据**；且
  `packages/kernel/src/lifecycle.test.ts` 用的是**它自己的假 REGISTRY**，全仓**没有任何测试校验 `cordis.yml`
  与 `REGISTRY` 的配对**——这条由 4.2-d 的 V 类验收补，不由本片声称完成。
- **fixture 教训（写进测试注释，防止下一位重演）**：`sections.ts` 只按**空行**切条目。两条经历之间不空行，
  会被合成一条 entry，于是派生出 5 行而不是 7 行，症状出现在断言里而不是解析器里，排查成本极高。

**4.2-b 落地状态（2026-10-01）**：`evidenceFor` 已实现并勾上 4.2-03，判据细节与单测清单见
spec「4.2-b 落地记录」，这里只记两条**属本计划**的决定：

- **判定权不交给模型**（对齐 §8.4）。候选与分数全由 `evidence.ts` 的纯函数给出，`kb.search`（4.3）
  与 4.5 的可解释性都建立在这条之上：一旦「有没有证据」变成提示词里的一句话，事实锁定就没有落脚点了。
- **分词器自写的取舍**：CJK 二字组是中文检索的常规粗粒度做法，但真正省事的候选是 **SQLite FTS5 自带的
  `trigram` tokenizer**（我们本就有 `node:sqlite`，不引新依赖）。本片没用它，因为反查要的是
  「集合交集覆盖率」这种可解释的分数，而 FTS5 给的是它自己的 bm25() 排名；**这一条必须作为 4.3 的
  前置 spike 实测**（FTS5 在本机 Electron 44 的 sqlite 里是否编译进来、`trigram` 中文是否真能命中、
  外部内容表能否与 `kb_entities` 共存），实测结论决定 4.3 是接 FTS5 还是复用 `tokenize.ts`——
  按 §6.2，不许拿文档转述当结论。
- **阈值是拍的**：`evidenceMinScore = 0.34` 未在真实简历语料上标定，标定与 `k1/b` 一起在 4.3 做；
  现在它在界面上的效果是「弱命中不进证据链」，不是「已调优」。

**4.2-c 落地状态（2026-10-01）**：`remove()` + 备份导出/导入已实现并勾上 4.2-01 / 04 / 08，
判据细节与单测清单见 spec「4.2-c 落地记录」，这里只记两条**属本计划**的决定：

- **4.2-04 的答案是「两种来源两套处置」**，这条把 4.2-a 在裁定二末尾留下的「归 4.2-c」那个口子收掉了：
  手工实体走 `remove()`（下属 `parent_id` 置空，不连带删除）；派生实体走 `KB_ENTITY_DERIVED` 拒绝，
  删除动作改由简历工作副本 + `sync()` 完成。**界面（4.2-d）必须按这两种来源给两套不同的处置**——
  给派生卡片挂一个删除按钮就是错的（点下去必然失败），应给「去简历里删」的跳转。
- **备份格式与 SQLite 二进制无关**，`schemaVersion` 不认识时直接拒绝而不是尽力解析；
  「导入不覆盖用户改动」的默认（`skip`）与 4.1-b 裁定一的「导入不覆盖工作副本」是同一条原则的两次落地，
  后续任何导入类入口（例如 4.2-d 若做「从文件恢复简历」）默认值都必须落在保守那一侧，并在返回体里报计数。
- **仍待 4.2-d 的两件事**（本片不声称完成）：`remove/export/import` 三个方法**没有渲染层调用方**，
  因此 4.2-05 / 06 的 V 类判据一条都还没动；`importBackup` 不校验 `source_doc_id` 指向的简历是否还在，
  界面要么在导入后提示「这些出处已不在」，要么把这类行按孤立态呈现——留给 4.2-d 定夺并写进它的落地记录。

**裁定三：管理界面挂在 diagnostics 里与 `ResumePanel` 并列（新增 `KbPanel`），但同一切片必须把
`kb.profile` 登记为 agent 工具。**

- §5.9 只固定「chat 是第一入口、workflow 是第二视图」的次序，并未禁止工程向的 diagnostics 继续放面板；
  KB 管理是低频编辑面，先在 diagnostics 落地，将来若提升为一级入口是纯 UI 改动，不动 service。
- 但 §5.9 的后半句是硬要求：新功能页**必须既能被工作流节点调用，也能被 agent 当作工具调用**，
  不允许做出「只有工程师知道怎么串起来」的孤岛。所以 4.2-d 的收尾判据包含一次 agent 侧实测：
  对话里问「库里有哪些和高并发相关的经历」，走的必须是同一个 `kb.profile`（禁止界面与工具各长一套）。

**4.2-d 开工前置（2026-10-01 实测接线面，来自 1.4/1.5/2.x 已落地的同一套桥）**

- **白名单只有一处**：`packages/shared/src/bridge.ts` 的 `RENDERER_ALLOWLIST` 是 `'service.method'`
  全限定名的唯一依据，`packages/preload` 与 `packages/ipc` 都从它推导（preload 自动按服务名建命名空间，
  网关在 `packages/ipc/src/gateway.ts` 用 `isAllowedCall` 拒绝未登记口）。所以本片的进程边界改动
  **只碰 `bridge.ts` 一个文件**，不要再去 preload 里加一层。
- **编译期保险丝是 `BridgeSignaturesCovered`**：白名单加一项而 `BridgeSignatures` 忘了补签名，`typecheck`
  立刻报错，不会出现「主进程允许、渲染层无类型」的漂移——这条是 4.2-09 的机检依据之一，别用 `any` 绕过。
- **服务名按 `provide` 匹配**：解析器取最长服务名前缀，且 `pickMethod` 只接函数，所以界面侧的调用名是
  `kb.profile.list`（`provide` 名），而不是 `REGISTRY` 里的装配 id `kb-profile`。
- **共享层不能依赖 L2**：`shared` 里放的是**镜像形状**（同 `PendingImportRowView` 之于 `PendingImportView`
  的既有做法），不是从 `@auto-cc/plugin-resume-kb` import 类型。镜像必须一字段一字段对着 service 的返回体写。
- **事件要三处同时登记**：`packages/core/src/events.ts` 的 `declare module 'cordis' { interface Events }`、
  `bridge.ts` 的 `RENDERER_EVENTS`、`RendererEventSignatures`。少第一处发不出去，少后两出不了进程 / 渲染层无类型。
  4.2-06 的「即时生效、不重启不手动刷新」就靠这条事件链，界面收到信号后**重读 `list()`** 而不是自己改本地态（§2.5）。
- **面板不是路由**：`App.tsx` 的 diagnostics 视图是一列 JSX 子元素，新增 `KbPanel` 只在栈里加一项。
- **i18n 键在单一命名空间 `shell` 下按功能分组的**，本片新增 `kb` 分组；中英键对齐由
  `scripts/check-renderer-conventions.ts` 机检，缺一个键就是 lint 失败。

**切片顺序（一次只做一个，每片自带验收）**

| 切片  | 内容                                                                                                                                                                        | 覆盖条目           | 前置            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------- |
| 4.2-a | 迁移 11 `kb_entities` + 导入→`resume_docs` upsert + 实体派生 + `kb.profile` CRUD<br>**（已落地 2026-10-01；`remove`/级联按上述留给 4.2-c，真窗口挂载证据留给 4.2-d）**      | 4.2-01 / 02 / 11   | 裁定一、二      |
| 4.2-b | `evidenceFor(claim)` 确定性反查（归一化包含 + token 重叠，不靠 LLM 自评）<br>**（已落地 2026-10-01，判据见 spec「4.2-b 落地记录」）**                                       | 4.2-03             | 4.2-a           |
| 4.2-c | 级联删除策略（删经历时下属项目/成果的去留显式化）+ 知识库备份导出/导入与冲突策略<br>**（已落地 2026-10-01：手工实体 detach、派生实体拒绝；判据见 spec「4.2-c 落地记录」）** | 4.2-04 / 08        | 4.2-a           |
| 4.2-d | `KbPanel`（实体树 + 展开证据链 + 编辑即时生效）+ `kb.profile` 的 agent 工具登记                                                                                             | 4.2-05 / 06 + §5.9 | 4.2-a / 02 / 03 |
| 4.2-e | 收尾机检：网络审计（除 llm 网关外零上行）+ 1.2 三项前端规约复跑 + 命名抽样                                                                                                  | 4.2-07 / 09 / 10   | 4.2-d           |

- 4.2-07 的「无上行」判据落点：本切片不新增任何 `fetch` / `http` 调用点，审计以**扫描 + 真实窗口内跑一遍
  全链路**留证，而不是引用文档转述（§6.2）。
- 迁移号段沿用 4.1-c 立的反撞号写法：单测里手抄已分配号段集合断言 11 未被占用
  （`packages/resume-kb/src/parse-service.test.ts:128` 的同一条模式）；store 仍按 devDependency 形态接入（§1.3-4）。
- **4.2-11 的三计划表清单对账结果**（逐张 `CREATE TABLE` 枚举过，非引用文档转述）：P1/P2 侧
  `usage_ledger`(1) / `chat_session`+`chat_message`(2) / `jobs`(3) / `workflow_runs`+`workflow_nodes`(4) /
  `conversation_messages`(5) / `automation_consents`(6)；P3 侧 `resume_docs`(7) / `resume_snapshots`(8) /
  `delivery_records`(9)；本计划 `resume_imports`(10) / `kb_entities`(11)。`jobs.experience` 是 **JD 要求串**不是简历经历，
  与 KB 实体无重叠。**唯一真实重复就是裁定一 的三份 `doc_json`**，其余无重复定义；
  迁移执行器自身还有一张 `schema_migrations`（`packages/store/src/migrate.ts:54-62`），不属于业务表。
  **4.2-a 落地后复跑（2026-10-01）**：`kb_entities` 只新增 `entity_id/kind/parent_id/source_doc_id/payload_json/
normalized_hash/created_at/updated_at` 八列，其中 `payload_json` 装的是**从 `resume_docs.doc_json` 派生**的字段值
  而不是第二份文档结构，`source_doc_id` 是指回 `resume_docs.id` 的外键式引用；对账结论未变，无新增重复真相源。

## 2. 包与 service

```
packages/
  resume-kb/    @auto-cc/resume-kb    # 解析、实体建模、检索、缺口比对
  llm/          @auto-cc/llm          # provider 抽象（唯一 LLM 出口）、prompt 注册、结构化输出解析
```

| service           | 归属      | 职责                                                                                          |
| ----------------- | --------- | --------------------------------------------------------------------------------------------- |
| `resume.parse`    | resume-kb | `fromPdf/fromDocx/fromMarkdown(raw)` → 结构化经历实体；扫描件判定并明确失败（不做 OCR）       |
| `kb.profile`      | resume-kb | 四类实体（经历/项目/技能/成果）+ 关系的增删改查；`evidenceFor(claim)` 反查支撑证据            |
| `kb.search`       | resume-kb | `query(text, opts)` → 打分排序的 chunk 列表；BM25 默认，可选向量融合（RRF）；返回命中理由字段 |
| `kb.gap`          | resume-kb | `compare(jdRequirements, profile)` → 命中/部分/缺失三态 + 支撑证据引用                        |
| `resume.generate` | resume-kb | 按 JD 重排/改写简历**内容**（输出文档模型 JSON，交给 P3 渲染；不产 HTML、不产 PDF）           |
| `script.greeting` | resume-kb | 打招呼/追问/拒绝应对话术生成，输出必须绑定 JD id + 知识库证据 id（2.5-01/2.5-09 的上游）      |
| `llm.chat`        | llm       | `complete(prompt, schema)` → 结构化对象（JSON Schema 约束 + 清洗 + 退避重试）                 |
| `llm.embed`       | llm       | `embed(texts)` → 向量数组；不可用时返回 `unavailable`，**不返回伪向量**                       |
| `fact.check`      | resume-kb | `verify(generated, lockedFacts)` → 通过/篡改列表；与 `resume.generate` 组成强制闭环           |

**复用核对（AGENTS.md §2.1）**：SQLite 走 1.3 `store`；配置（模型名、温度、频控、检索参数）走 `config`；
日志走 `logger`（prompt/response 落日志前**脱敏**）；LLM 调用计量若涉及付费额度走 1.9 `entitlement`；
界面经 1.4 IPC；文档模型是 P3.1 的那一份，**不在本包新建简历数据结构**。

## 3. 关键设计点

1. **实体模型先于检索**：知识库的价值在于「每一条简历陈述都能反查到一个证据（项目/成果/时间）」。
   因此每条生成内容携带 `evidenceRefs`，界面与投递记录都可回看依据。
2. **chunking 由实体自然分层**（经历 → 项目 → 段落），不做任意长度滑窗；检索粒度 = 可引用粒度。
3. **BM25 实现约束**：中文分词用轻量的 n-gram（bigram）+ 可选词典，禁引入需要下载的 tokenizer；
   评分参数（k1/b、字段权重）来自 `config`（AGENTS.md §2 魔法数）。
4. **缺口比对是双向的**：JD 要求 → 库内命中（可写进简历的证据）；库内能力 → JD 未提及但相关的（可作差异化亮点）。
   两向都输出证据，禁止只输出「你缺什么」的打击式结论。
5. **生成轨与渲染轨的接口就是 P3.1 文档模型**：`resume.generate` 输出 JSON，P3 负责排版。
   两边不得绕过 Schema 私有约定（防止双真相源）。
6. **不可编造清单**：公司名、职位名、起止时间、量化数字、学历、证书编号 —— 属 `facts.locked`，
   LLM 只能引用、不能改写；需要「润色」的只有描述性文字。校验失败即拒绝产出（见 spec 4.5）。

## 4. 测试策略

| 层级     | 手段                                                                                                    | 覆盖            |
| -------- | ------------------------------------------------------------------------------------------------------- | --------------- |
| U        | 解析器（固定文本→实体）、BM25 排序、RRF 融合、缺口比对三态、factCheck 归一化与篡改判定、prompt 渲染快照 | 4.1–4.6         |
| C        | 无 LLM key 时检索与比对仍可用（断网/无 key 冒烟）；伪向量不存在（`embed` 不可用时检索降级而非报错）     | 4.3 / 4.6       |
| V        | 知识库管理界面（实体列表、证据链、缺口报告、生成结果预览）截图；LLM 失败态有可读中文提示                | 4.2 / 4.4 / 4.5 |
| 固定语料 | 用**自有样例简历**（不含真实个人信息）做全链路断言，避免测试数据泄露                                    | 4.1 / 4.5 / 4.6 |

不接真实招聘平台（AGENTS.md §7.2）：JD 输入用本地固定样例文件。

## 5. 子计划分解与顺序

| #   | 子计划                                                                   | 完成判据                           | 依赖                                                        |
| --- | ------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------- |
| 4.1 | 简历导入与解析（PDF/DOCX/Markdown → 结构化经历实体；扫描件明确失败路径） | spec 4.1 全绿                      | 1.3                                                         |
| 4.2 | 知识库建模（四类实体 + 关系 + 证据反查）与管理界面                       | spec 4.2 全绿                      | 4.1（4.1-08 待裁定的 `[!]` 不阻塞，见 spec 4.1-c 落点说明） |
| 4.3 | 本地检索：BM25 + 倒排为默认，向量可选增强且失败即降级                    | spec 4.3 全绿                      | 4.2                                                         |
| 4.4 | JD → 能力要求拆解，与知识库三态缺口比对                                  | spec 4.4 全绿                      | 4.3 / llm                                                   |
| 4.5 | 定向内容生成：按 JD 重排/改写，**强制事实校验闭环**，输出 P3.1 文档模型  | spec 4.5 全绿（M5 判据的 P4 半边） | 4.4 / 3.1                                                   |
| 4.6 | 话术生成器：开场白/追问/拒绝应对，绑定 JD + 证据                         | spec 4.6 全绿（供 2.5 消费）       | 4.4 / 2.5 接口                                              |

## 6. 明确不做

- 不做多用户/账号体系、不做鉴权、不做云端同步（当前阶段无 SaaS）。
- 不做向量数据库服务（Chroma/Qdrant/Milvus 一律不引入）、不引入需用户机编译的原生扩展。
- 不做扫描件 OCR（解析失败即提示人工补录）；不做手写简历识别。
- 不做「简历打分/职级评估」这类无据可依的衍生功能。
- 不做 prompt 注入式「让 LLM 判断是否可信」——事实校验必须是确定性代码（`fact.check`），LLM 只生成不背书。
- 不做第二套 LLM 客户端、不做 prompt 硬编码在业务代码里（prompt 集中注册表，可版本化，2.5-09 需记录版本）。

---

## 4.3 开工前置：内置 sqlite 检索能力实测（2026-10-01 spike，§6.2 要求以本机实测为准）

spike 脚本只跑不入库（`tmp/43/fts-probe.cjs`，gitignored，对齐 §6.4），两个运行时各跑一次：
`node tmp/43/fts-probe.cjs` 与 `node_modules/.pnpm/electron@44.4.5/node_modules/electron/dist/electron.exe tmp/43/fts-probe.cjs`。

| 事实                                                | Node 24.18（`node:sqlite`）                               | Electron 44.4.5 主进程（同一模块） |
| --------------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| sqlite 版本                                         | 3.53.1                                                    | 3.53.4                             |
| `compile_options` 里的检索相关项                    | `ENABLE_FTS3` / `ENABLE_FTS3_PARENTHESIS` / `ENABLE_FTS5` | 同左，**没有 ICU**                 |
| `CREATE VIRTUAL TABLE … USING fts5(body)`           | OK                                                        | OK                                 |
| `tokenize='trigram'` / `'trigram case_sensitive 0'` | OK / OK                                                   | OK / OK                            |
| `bm25()` 聚合函数                                   | OK                                                        | OK                                 |

**中文查询的实测行为（这一条决定 4.3 的设计，不是文档转述）**：往 fts5(trigram) 里写
`主导订单服务重构，P99 延迟下降 40%` 后——

- `match '订单服'`（3 字）→ 命中 1；`match 'P99'`（ASCII）→ 命中 1；`match '不存在词'` → 命中 0（正常）。
- `match '订单'`（**2 字**）→ **命中 0**。trigram tokenizer 按三字符滑窗建索引，**短于 3 个字符的查询根本进不了索引**。
- 默认 `unicode61` 分词器下 `match '订单服'` → **命中 0**：它按空白/标点切词，一整段中文被当成一个 token，
  所以「不写 tokenizer 的 FTS5」对中文等于不可用。

**由此定下的 4.3 口径（写在这里，避免实现时重新发明）**：

1. **BM25 默认 = 内置 FTS5 + `bm25()`**，零新增依赖、零原生编译（对齐 §9「禁止 better-sqlite3」与
   §2「禁止第二套基础设施」）；向量检索仍是可选项，且**不能**为它引入第二个 sqlite 连接或外部引擎。
2. **中文短查询必须有兜底通道**：求职者的真实查询大量是 2 字词（订单、重构、高并发），只挂一张
   trigram 表会让这类查询恒为空——这不是性能问题而是功能缺陷。兜底沿用 4.2 已经落地的确定性打分思路
   （`evidence.ts` 的 `contains` / 词面重合），即 **FTS5 命中集 ∪ 子串重合候选集**，两路分数在同一口径下合并排序，
   而不是各出一套结果。具体合并式在 4.3 的 plan 里定，这里只锁定「必须有第二路」。
3. **索引表与实体表的关系**：FTS5 表是 `kb_entities` 的**派生索引**，不是第二个真相源——
   写入路径必须与 `sync/create/update/remove/importBackup` 同一事务收敛，删除实体时索引行必须同步消失
   （否则 4.2-04 的「不留孤儿行」在检索面被绕过）。
4. **反向验证条目（§6.5）**：本次实测已证明内置 FTS5 覆盖 BM25 需求，缺口只在中文短查询且可由应用层补齐，
   因此「不引入 tantivy / MeiliSearch / lancedb / sqlite-vec」没有造成不可补齐的能力缺口——
   4.3 的 spec 里要留一条对应条目显式回答这一点。

## 4.3 切片拆分（2026-10-01，口径由上面的实测锁定后才敢拆）

**先结掉一个悬了很久的决定**（plan 第 208~210 行留的「接 FTS5 还是复用 `tokenize.ts`」）：**两个都要，但分工不同**。
FTS5 负责「千级 chunk 里快速召回 + `bm25()` 排名」（4.3-01 / 4.3-09），`tokenize.ts` 的词面重合分数负责
「可解释的理由与命中词」（4.3-01 的理由字段、4.2-03 已有的口径）以及中文短查询兜底（4.3-02）。
否决「只用 FTS5」：实测 `trigram` 对 2 字查询恒不命中、`unicode61` 对整段中文不可用，纯 FTS5 会让
「高并发」这类真实查询返回空；否决「只用词面重合」：全表逐条打分在千级实体上是 P95 不可控（4.3-09）。

**4.3-02 的实现路径必须换**：spec 原文写的是「bigram 分词下命中」，但内置 sqlite **没有** bigram tokenizer
（只有 `trigram`），且 `node:sqlite` 不暴露自定义 fts5 tokenizer 的注册接口。所以中文召回走
**写入侧预分词**：把正文切成双字/三字 token、以空格连接后作为一个 fts5 列入库，查询侧同样预分词——
这样 `unicode61` 就能按空白切开，等价于自建 bigram 索引。

**这条已经验穿（2026-10-02 第二轮 spike，五轮脚本，§6.2）**：脚本留在 gitignored 的
`.research-repos/fts5-preseg-spike/spike{,2,3,4,5}.cjs`（§6.4：代码不进主干，结论进本文件），
两个运行时各跑一遍（`node` 与 `ELECTRON_RUN_AS_NODE=1 …/electron.exe`），逐行 diff 只差 sqlite 版本行与
轮次三 C 段的**墙钟耗时**（11.1ms vs 11.5ms、单查 0.32–0.61ms vs 0.30–0.45ms，同一量级）——
命中行数、token 序列、`bm25()` 分值、报错文本逐字节相同，**检索结论与运行时无关**。完整输出入档
`docs/acceptance/4.3/4.3-a-preseg-spike-node.txt` 与 `-electron.txt`（两份末尾各带一段 DIFF 结论）。

| 实测事实（不再是推断）                                  | 数值／表现                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 双字切分 + 空格连接 + `unicode61` 能否命中 2 字中文查询 | 能：`订单`→2 行、`高并发`→1 行、`缓存预热`→1 行（spike 轮次一 Q1）                                                                                                                              |
| `trigram` 对照                                          | 同一份数据 `订单`→**0 行**、`高并发`→1 行：坐实「trigram 不是 2 字查询的替代方案」                                                                                                              |
| 写入侧存**去重集**还是**有序含重复序列**                | 必须含重复序列：「订单、订单、订单」的堆叠句只在序列索引里排到前面，去重列把它排到后面（轮次四 A）——`bm25()` 的词频维度依赖重复                                                                 |
| 含重复的体积代价                                        | 可忽略：2,007 条真实长度条目，去重 103,082 字符 vs 含重复 103,088 字符                                                                                                                          |
| 规模与量级（为 4.3-09 的千级 P95 提前定标）             | 2,000 条 chunk 双写（实体表 + FTS5）11.3ms＝0.006ms/行；查询 0.32～0.54ms；token 长度 1.58～1.63× 原文                                                                                          |
| 单字／词尾查询                                          | `LIKE '%订%'` 命中 3 行，前缀 `订*` 只命中 2 行，漏的是「提前预**订**」——词尾字没有起始双字组，**子串（`instr`）通道是必需的而非可选**（轮次五）                                                |
| 查询串的构造方式                                        | 必须**逐 token 加双引号**（`"订单" "单服"`）。裸拼会让 `OR`/`NOT`/`NEAR`/括号静默改语义：`(订单 OR 库存)` 裸拼 2 行、加引号 0 行；多余 `"` 直接抛 `unterminated string`（轮次二 B / 轮次一 Q7） |
| 空查询／纯符号查询                                      | 预分词结果为空时 `MATCH ''` 抛 `fts5: syntax error near ""`：`kb.search` 必须在进库之前短路成确定空态（接 4.3-10）                                                                              |
| `bm25()` 的读数性质                                     | 负值，且绝对量级随语料规模变化（六个数量级）：**绝对阈值不可移植**，4.3-b 必须自己定义归一化，不能复用 `evidenceMinScore = 0.34`                                                                |
| FTS5 是否必须复制原文                                   | 不必：索引里只放 `tokens`，原文按 `seq` join 回 `kb_chunks.text`（轮次二 A / 轮次三 A），避免 1.6× 文本膨胀                                                                                     |

**因此追加的 4.3 口径（实现时不要再发明）**：

1. `kb_chunks.tokens` 存**有序、含重复**的双字组序列（`tokenSequence` 的输出，空格连接）；
   读侧查询串由同一把尺子切出来后逐 token 加双引号。写读两把尺子必须同源，否则表现为「在库里却搜不到」。
2. 检索是 **FTS5 召回 ∪ 子串（`instr`）召回**两路，单字与词尾查询只有后者能接住；
   4.3-b 的合并打分必须同时拿到这两路的候选集。
3. 空态在 service 入口判：预分词后 token 数为 0 就直接返回确定空结果，不把空串交给 `MATCH`。
4. 分数归一化在应用层做，`bm25()` 原值只用于同一次查询内的相对排序。

**反向验证（§6.5）到此有据**：内置 FTS5 + 应用层预分词已经覆盖 2 字中文查询与千级召回性能，
不需要外部引擎或原生扩展；缺口只剩「词尾单字」这一条，且已确认由 `instr` 通道补齐（不是留着的能力缺口）。
4.3 因此**不**退回「自建轻量倒排表」那条备选路。

| 切片  | 内容                                                                              | 覆盖条目                   | 收口判据                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.3-a | 预分词 spike 验穿 + `kb_chunks`（派生索引表，迁移号段 **12**）与实体同事务写删    | 4.3-11 / 4.2-04 检索面     | chunk 边界=实体边界；删实体后索引无孤儿行                                                                                                               |
| 4.3-b | FTS5 虚表 + `bm25()` 召回，与 `tokenize.ts` 分数合并成一条排序（含理由与命中词）  | 4.3-01 / 02 / 03           | 排序断言：相关项在前且理由非空；`k1/b`、字段权重、`topK` 全部来自 config（实测后：`k1/b`/`topK` 达标，**字段权重在单列切片粒度下无落点，冲突等裁定**）  |
| 4.3-c | `kb.search` service + IPC 白名单 + 工具面登记（对话/工作流双入口，对齐裁定三）    | 4.3-10 / 4.2 先例          | 空结果确定态（界面提示 + 可行动建议），不返回随机结果（已落地：两种空态各自一屏；判据细化为"同库两次读数逐字节相等"，分数随语料变是 BM25 定义的一部分） |
| 4.3-d | 向量可选增强：`llm.embed` 可用时 RRF 融合；不可用返回 `unavailable` 并降级纯 BM25 | 4.3-07 / 4.3-08            | 固定评测集上融合优于纯 BM25；embed 失败路径**零 BLOB 写入**、grep 无哈希冒充向量                                                                        |
| 4.3-e | 离线与性能收口：断网/无 key 冒烟、千级 chunk P95 基准、日志脱敏、依赖树审计       | 4.3-04 / 05 / 06 / 09 / 12 | 基准脚本输出入档；`pnpm why` 证明无外部向量服务与原生扩展                                                                                               |

**顺序上的一个硬约束**：4.3-a 的预分词 spike 不过，就不许写 4.3-b 的合并打分——否则等于把设计押在未验证的假设上
（§6.2 两次踩过）。标定项 `evidenceMinScore = 0.34` 与 `k1/b` 一起在 4.3-b/4.3-e 用真实简历语料做，不再拍
（4.3-b 实测后修订：`k1/b` 的标定连同 `searchMinScore` 一起推到 4.3-e，因为只有那时才有千级语料与 P95 基准同台，
见下面 4.3-b 落地记录里「诚实的偏离」一段）。

## 4.3-a 落地记录（2026-10-02，spike 验穿后同片建表）

**表形状**：`kb_chunks(seq INTEGER PRIMARY KEY, chunk_id UNIQUE, chunk_kind, source_doc_id, section_kind, text, tokens, updated_at)`，
迁移号段 **12**，带 `down`（单表 `DROP`）。`seq` 显式建列而不是靠隐式 rowid：4.3-b 的 FTS5 虚表要按 `seq` 对齐 rowid，
而隐式 rowid 会被 `VACUUM` 重排，那会让倒排索引指向错误的行。只建一个 `(source_doc_id, chunk_kind)` 索引——
「按文档清理切片」是当前唯一的第二种查询形态，为将来可能的查询先建索引属 §2.6 禁止的预防性抽象。

**粒度（4.3-11 的判据「chunk 边界 = 可引用粒度」怎么落的）**：只有两种切法，没有滑窗。

1. `entity`：一条实体一条切片，`chunk_id` **直接取 `entity_id`**——检索命中即引用，4.5 的事实锁定不需要
   「这段文字落在哪条实体的第几个窗口」这种二次映射。1:1 是无条件的：切不出 token 的载荷也留一行
   （`tokens` 为空串），因为「有的实体有切片、有的没有」是要调用方记住的规则，比恒定一行更难维护。
2. `section`：`summary / education / campus` 三类区块的 entry 各一条，`chunk_id = kbs-<sha256(文档+区块种类+条目槽位) 前 16 位>`。
   这一半是**兑现裁定二的承诺**——`entities.ts` 头部注释把这三类的检索归属许给了 4.3-11，
   不补就等于「简历里这三段永远检索不到」，而 4.4 的学历比对必须有据可依。
   代价是 `resume.doc` 多一个 `listIds()`（全量补建要遍历文档），它是**只回 id** 的：
   正文仍逐条经 `load()` 的 Schema 复验，不开「一次捞全部 `doc_json`」的第二条读取通道（§2.5 / 裁定一）。

**收敛方式**：`sync / create / update / remove / importBackup` 五条写路径统一包进新的
`withTransaction()`（带嵌套深度守卫——`importBackup` 已在一个事务里逐条 `upsert`，SQLite 不允许事务套事务），
切片的上写删除都发生在这同一段事务内，所以「实体写成功、切片没跟上」不是可达状态。
`prune()` 改写成**实体与切片共用同一个谓词对象**（含空 `drafts` 分支——实测（SQLite 3.53.1 / 3.53.4）
`IN ()` 返回 0 行、`NOT IN ()` 返回全部行，**都不报语法错误**，但「靠空列表把谓词退化」太脆，显式分支才稳），
两条 `DELETE` 走散的表现正是检索侧留孤儿行。

**老库升级**：补建只在 `upgrade()` 返回的 `applied` 里真的出现 12 时做一次全量（`reindexAllChunks`），
不做每次启动的自愈扫描——冷启动开销无谓，而增量写路径已经维护了 1:1。
**已知边界（写清楚，不留到出问题再解释）**：因此如果有人从库外删掉 `kb_chunks` 的行，
本版本不会自动补回，要等一次 `sync()` 或重新挂载才收敛。派生索引的这一条与 4.2 的「工作副本是真相」同一口径。

**验证入口**：`kb.profile.listChunks()` 是本片唯一的对外读口（4.3-b 的候选集来源与测试断言点）；
它**不进 IPC 白名单、不注册 agent 工具**——切片是实现内部形态，界面与对话要的是 4.3-c 的 `kb.search` 结果，
现在就暴露等于开一个将来没人维护的入口（§2.4）。

## 4.3-b 落地记录（2026-10-02，倒排召回 + 应用层 BM25 合并打分）

**表形状**：迁移号段 **13** = `ALTER TABLE kb_chunks ADD COLUMN norm_text` + `CREATE VIRTUAL TABLE kb_chunks_fts
USING fts5(tokens, tokenize='literal')`（contentless-style：虚表只放 `tokens`，原文按 `rowid = kb_chunks.seq` join 回来，
避免 1.6× 文本膨胀——这是 4.3-a spike 轮次二 A 的结论落地）+ 一次性回填。`down` 只删虚表与那一列，
`kb_chunks` 主表一行不动：倒排是派生索引的加速结构，**回滚不许变成破坏性操作**（回滚 13 后再挂载能重建，测试里验了）。
`norm_text` 是给 `instr` 子串通道用的**归一后文本**（不是原文）：实测「p99」对原文 `instr` = 0、对归一文本 = 3，
全角「Ｐ９９」也只有归一后才接得住。内置 sqlite 无 ICU，所以归一在 JS 里算（复用 4.2 的 `normalizeText`，不引第二把尺子）。

**为什么打分在应用层而不是直接用 `bm25()`**（这条推翻了本切片开始前 plan 里的写法）：
spike6 §S1 实测 `bm25(w_fts, 1.2, 0.75, 1, 1)` **不报错**，但那两个数字被当成第 3/4 列的列权重丢弃了——
即 SQLite 的 `bm25()` **根本无法设 k1/b**，只有「按列位置给权重」可用。4.3-03 要的「k1/b 来自 config」
因此只能由应用层 Okapi BM25 兑现；内置 `bm25()` 降级为**召回顺序**（谁进候选集）与一致性参照。
实测自建与内置在同一条 token 查询上排序一致（内置 `[6,2,1]` ↔ 自建 `e6 > e2 > e1`），
且 k1/b 扫描（0.5/0.3、1.2/0.75、2.0/0.95）改分值不改首位——所以「换打分函数会不会把现有排序打乱」不是风险。

**两路召回**：`buildFtsQuery()` 把查询串按同一把尺子切 token、去重、**逐 token 加双引号**再以 `OR` 连接
（多余引号转义成 `""`；裸拼会让 `or` / 括号静默改语义），接住绝大多数查询；
`instr(norm_text, ?)` 子串通道接住 FTS5 接不住的单字与词尾字（实测「订」FTS5 df=1、LIKE=4）。
两路候选去重后一起进 `rankChunks`，子串独召的切片给 `substringFloorScore` 作为分数下限——
否则「订」这种查询在 BM25 腿上是 0 分、会被 `minScore` 直接杀掉，两路召回就白做。

**打分细则**：tf 按 token **精确计数**不做子串数（实测「go」在含 logo / Django 的切片里子串数 2、精确数 0，
`MATCH "go"` 也是空）；df 逐 token 从倒排问（`MATCH '"tok"'` 计数，2000 行 × 8 token 实测 0ms）；
语料统计（切片数与 avgdl）一条 SQL 出，`avgdl` 的 SQL 算法与逐行数实测相等（99/8 → 12.375）。
最终分 = `bm25Weight × 归一 BM25 + lexicalWeight × 词面覆盖`（覆盖复用 4.2-03 的 `coverageOf`，不新写一把尺子），
归一上界取「查询 token 数 × (k1+1)」，实测落在 0.61 / 0.69 / 0.61——**绝对阈值因此与语料规模无关**，
这是 4.3-b 自己定义归一化的原因，不复用 `evidenceMinScore = 0.34`。

**参数全部来自 config**：`cordis.yml` 的 `kb-profile` 下新增 `searchTopK / searchMinScore / bm25K1 / bm25B /
bm25Weight / lexicalWeight / substringFloorScore` 七个键，service 每次检索现读（实测 2.5-d：改配置会重建下游插件，
存本地副本会在改配置后静默变空）。4.3-03 的 C 半边做成了**永久机检**：一条用例读 `cordis.yml` 确认七个键真在配置里，
再读 `search.ts` / `profile-service.ts` 源码（剔掉注释行）确认七个参数名一处 `<名> [:=] <数字>` 都没有——
运行期断言证明不了「默认值没长在代码里」，只有 grep 能补这一半。schema 上的 `.default(...)` 与 4.2 的
`evidenceMinScore` 同一口径，是配置文件漏写键时的兜底而不是算式里的常量，所以不在拦截范围内（判据写成
「参数名被赋数字」正好放过它）。**诚实的偏离**：这七个默认值现在是 Okapi 惯例值（k1=1.2 / b=0.75）与
「能同时接住两路」的保守取法，**不是真实简历语料标定值**——plan 上面那句「与 k1/b 一起在 4.3-b/4.3-e 标定」
只兑现了一半，标定整体推到 4.3-e（那时才有千级语料与 P95 基准同台）。默认值进 `cordis.yml` 而不是代码，
正是为了 4.3-e 改数值不动实现。

**4.3-03 里的「字段权重」这条不达标，保留未勾**：切片文本是 `evidenceTextOf` 拼出来的**单列文本**，
`kb_chunks` 没有 company / title / description 这样的列可供 `bm25(fts, w1, w2, w3)` 按位置加权。
要么把切片拆成多列（动 4.3-a 的表形状与 4.2 的证据口径），要么承认「字段权重」在当前粒度下没有落点。
按 §0 的冲突处理，这里**先把冲突写清楚等裁定**，不用「列权重」含糊替代，也不把 4.3-03 报成通过。

**维护路径**：`upsertChunk` 用 `INSERT … ON CONFLICT(chunk_id) DO UPDATE … RETURNING seq`
（实测新增与改文返回同一个 seq，倒排才不会指错行），拿到 seq 后 `replaceFtsRow`——**先按 rowid DELETE 再 INSERT**，
FTS5 对复用 rowid 不覆盖（spike7 §C）。删除一律走 `deleteChunksWhere(where, args)`，
它在删主表行之前先用同一谓词清倒排（`rowid IN (SELECT seq FROM kb_chunks WHERE …)`）；
`prune()` 改成调它而不是自己写 `DELETE FROM kb_chunks`，否则表现是「删掉的经历仍然搜得到」，
而它只在同步之后发生、人工最容易滑过。五条写路径跑完后 `fts 行数 === chunks 行数` 且孤儿 rowid 为 0，是永久机检。

**回填**：迁移 13 的 `up()` 自带全量回填，因为它只读 `kb_chunks` 自己一张表，不需要 `resume.doc`；
迁移 12 的全量补建仍留在 `ensureSchema()` 的 `applied.includes(12)` 分支（要遍历文档）。
**已知边界**与 4.3-a 同一口径：从库外删 `kb_chunks_fts` 的行不会被自动补回，等一次写路径或重新挂载收敛。

**验证入口不变**：`search()` 与 `listChunks()` 一样**不进 IPC 白名单、不注册 agent 工具**（4.3-c 才开 `kb.search`）。
日志按 4.3-12 只记「token 数 / 候选数 / 命中数 + 状态」，不落查询原文之外的简历正文。**性能已过**：
2000 切片下 8 次 df 查询 0ms、`OR` 召回 1ms、取候选 token 串 3ms、子串全表扫 0ms、语料统计 1ms（spike7 §E），
所以 4.3-e 的 P95 基准要防的是「查询 token 数随长查询线性增长的 df 循环」，不是单次查询本身。

**双 runtime 证据**：`docs/acceptance/4.3/4.3-b-fts5-scoring-node.txt` 与 `-electron.txt`
（spike6 §S1–S7 + spike7 §A–F，逐行 diff 去掉抬头后唯一差异是 sqlite 版本号 3.53.1 / 3.53.4）——
4.3-b 的召回与打分口径**不必按运行时分支**，实现里的 SQL 与自建 BM25 只写一份。spike 代码按 §6.4 留在 `.research-repos/`。

**测试规模**：纯函数侧新增 `search.test.ts` 23 例，装配侧「本地检索」describe 10 例，
该包 9 文件 / **188** 用例全绿（4.3-a 时 8 / 154）。一个语料事实顺带被用例撞出来并写进了断言注释：
`校园经历` 里的条目若被 4.1 锁成 `achievement` 事实，就**同时**有实体级与区块级两条切片——
「三类区块不建实体行」说的是区块本身，不是区块里的被锁事实，检索侧因此不必二选一。

## 4.3-c 落地记录（2026-10-02，`kb.search` 双入口 + 检索确定空态界面）

**这一片只做接线，不做新算法**：4.3-b 的 `search()` 已经在库里跑通，本片把它同时接到 IPC 白名单与 agent 工具面，
并把「查不到」在界面上做成两种看得懂、可行动的态。覆盖条目 4.3-10（V+C）。

**同一个入口两处开（裁定三 / §5.9）**：`packages/shared/src/bridge.ts` 的 `RENDERER_ALLOWLIST` 加 `kb.profile.search`
（`BridgeSignatures` 里同批声明，漏签名会直接 `typecheck` 失败），`profile-service.ts` 的 `[Service.init]` 里
`registerAgentTools` 再登记一只同名工具，`run` 就是 `this.search(query)`——**两处都不许再写一遍查询逻辑**。
视图类型 `KbSearchRowHit` / `KbSearchRowResult` 在 `shared` 里做**镜像**而不是 import L2（§4.1 的分层），
与 4.2 那九个视图类型同一口径。活体读数：`agent.tools.list()` 11 只，`kb.profile.search` 的
`effect=read` / `requiresConfirmation=false`，且它与 `window.autoCC.kb['profile.search']` 的整段 JSON 逐字段相等。

**入参校验的取舍（本片唯一一处"反直觉"的写法，注释里也写了）**：工具入参是 `z.strictObject({ query: z.string() })`，
**没有** `.min(1)`。因为注册表在 `safeParse` 失败时统一回 `TOOL_INPUT_INVALID`，一旦让 schema 拦空串，
「这句查询切不出词」和「这只工具坏了」就会被压成同一个错误，agent 拿不到可行动的信息。
空态因此一律做成**返回值**：`no_query_tokens` 与 `ok` + `hits: []` 两条码各自独立。

**界面三态**：结果态（`data-kb-search="ok"` + 命中清单，每行「出处 · 正文 · 理由码 · 分数 · 命中词」）、
查询无效态（`no_tokens`，提示换成一两个中文词并给三个例子）、库里没有态（`empty`，给三条可行动作：
先同步 / 换更短更通用的词并说明按两字一组切词 / 新建手工实体补录）。样式全 Tailwind、图标用 lucide 的 `Search`、
文案全部进 `shell` 命名空间的中英双份（§5）。**出处标签复用 `resume.kind.*` 既有词条**（§2.5），
只有三个理由码是新键。

**改库即失效**：`kb/entities-changed` 处理器里顺手 `setSearchResult(undefined)`。理由与 4.2-06 同源——
界面不在本地改态，但**陈旧的一批命中**必须清掉，否则用户会拿旧结果当当前库的读数；输入框文本保留，重打一次即可。

**分数随语料变化这件事要写进文档**：活体复跑时新建一条实体后，「订单」首条分数从 0.6585 变到 0.6829。
这不是抖动，BM25 的 N / df / avgdl 本来就随语料变；4.3-10 的「不返回随机结果」判据因此定成
**同一份库内两次读数逐字节相等**，而不是"分数恒定"。标定推到 4.3-e 时也要按这个口径看绝对阈值。

**本片边界**：不做分页（`searchTopK` 截断即止）；命中行不做"点回实体树"的跳转——`chunkId` 对实体切片等于 `entityId`，
对区块切片不等，跳转形状要等 4.4 / 4.5 真需要"从命中看上下文"时再定，现在做就是猜。

**harness 实测补一条通用坑（写进 1.6 的经验）**：`window.autoCC.*` 返回的是 `{ ok, value }` 信封，
渲染层拿到的 `bridge` 已经解包过一次；而 `agent.tools.call` 的 `value` 里**还套一层** `{ ok, value }`。
在页面里做「工具面 vs IPC 等价」断言要解两层，只解一层会得到 `identical=false` 的假阴性——
这类差异在单测里看不见，因为单测直接拿 service 对象。

**测试规模**：装配侧新增 1 例（工具元数据 + 与 `search()` 逐字段相等 + 空态是值不是入参错误），
该包 9 文件 / **189** 用例全绿。V 证据四张截图 + 一份八段 DOM 断言，见
`docs/acceptance/4.3/4.3-10-*`。

## 4.3-d 选型与证据（2026-10-02，向量增强走硅基流动 BAAI/bge-m3）

**provider 由用户裁定**（2026-10-01）：embedding 走**硅基流动**的 `BAAI/bge-m3`。下面四条是为本片取的实测证据，
其中两条直接改变了实现形状。

| 候选                                                   | 结论                     | 依据                                                                                                                 |
| ------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 硅基流动 `BAAI/bge-m3`（OpenAI 兼容 `/v1/embeddings`） | **采用**                 | 端点与维度实测见下 [1][2][3]；中文/多语混排是 bge-m3 的主场，个人知识库数十至数百条、千级 chunk 的规模按次计费可忽略 |
| 本机跑 bge-m3（ONNX / transformers）                   | 否决                     | 要带权重与原生算子库，直接违反 4.3-06「无 node-gyp / 无用户机编译」与主计划 §1.4「用户只装一个 app」                 |
| ChromaDB / `sqlite-vec`                                | 否决（4.3-05 / 06 已定） | 外部服务或需三端预编译扩展                                                                                           |
| 哈希伪向量（`ai-resume` 的 sha256 退化路径）           | **明令禁止**             | 4.3-08 的判据就是它：embed 不可用只能返回 `unavailable` 并降级纯 BM25，不许造一个"看起来能算余弦"的东西              |

- **[1] 端点路径实测**：`POST https://api.siliconflow.cn/v1/embeddings` 在无 key 时回
  `401 {"code":30014,"data":null,"message":"Token is invalid."}`，而单数形式 `/v1/embedding` 回 `404 Not Found`
  → 路径钉死为复数 `embeddings`，鉴权是 `Authorization: Bearer <key>`（与 chat 同一支头）。
- **[2] 错误体不是 OpenAI 形态（这条改了实现）**：硅基流动回的是**顶层** `{code, data, message}`，
  而 OpenAI / DeepSeek 回 `{error: {message, code}}`。现有 `describeError()` 只读 `error.message`，
  遇到前者会把整段 JSON 原文塞进错误文案。所以本片要给它加第三支（顶层 `message` / `code`），
  顺带让 chat 侧遇到同类网关也能给出人话。这是 §6.2「文档转述不可信、以实测为准」在本项目的第三次命中。
- **[3] 模型参数实测**：`config.json` 里 `hidden_size = 1024`、`max_position_embeddings = 8194`
  （走 `hf-mirror.com` 取的——本机 `huggingface.co` 直连被 connection reset，与 §9 的 GitHub 直连不稳定同源）。
  **但代码里不写 1024**：`embedDimensions` 默认 `null` = 不向对端传该字段、用模型默认维度，
  实际维度以每次响应回来写进 `kb_vectors.dim` 列。写死数字等于把"换模型要改代码"埋回实现里（4.3-03 的口径）。
- **[4] 为什么不能复用 `llm.chat` 的 baseUrl/model**：DeepSeek 官方文档只列了 chat completions，
  **没有 embeddings 端点**（实测其文档站端点清单）。聊天网关与向量网关在现实里就是两家服务，
  所以配置必须各自独立，`llm.embed` 未配置时 `llm.chat` 照常可用（话术生成与检索增强互不绑架）。
- **OpenAI 兼容 embeddings 的请求/响应契约**（同族形态，取自阿里云百炼 compatible-mode 文档）：
  请求 `{model, input: string | string[], dimensions?, encoding_format?}`；
  响应 `{data: [{embedding: number[], index, object: "embedding"}], model, object: "list", usage: {total_tokens}}`。
  `input` 支持数组 → **一次批量喂多条切片**，`embedBatchSize` 控制每批大小，避免一条切片一次 HTTP。

**实现形状（本片要动的四处，都不新建平行基础设施）**：

1. `packages/llm` 内**新增** `llm.embed` 服务，复用同一个 fetch / 超时 / 错误骨架（§2.7 禁的是第二个客户端，
   不是同一个客户端的第二个方法）；配置新增 `embedBaseUrl` / `embedModel` / `embedKeyEnv`
   （默认 `AUTO_CC_SILICONFLOW_API_KEY`）/ `embedDimensions`（默认 null）/ `embedBatchSize`，超时复用 `timeoutMs`。
   （**落地时改名并拆出超时**，实际键名见下面「4.3-d 落地记录」的偏离段。）
   默认全空 = 未配置 = `unavailable` 且**一次网络都不发**（与 `llm.chat` 同口径，4.3-04 的离线冒烟靠这一条成立）。
2. `check-llm-single-entry` 随之升级，否则机检会与新现实脱节：provider 断言从"`llm.chat` 声明唯一"扩成
   "`llm.*` 只允许出现在 `packages/llm`，chat 与 embed 各一"，并把 `/embeddings` 加进端点痕迹清单。
3. 迁移号段 **14** 建 `kb_vectors(chunk_id PRIMARY KEY, model, dim, vec BLOB, updated_at)`，float32 小端序列化。
   它是**派生索引**，与 `kb_chunks` 同生命周期（删切片即删向量，`prune()` 一并带走），
   `model` 列就是失效判据——换模型或换维度即整表作废重算，不做"半新半旧混着算余弦"。
4. 融合用 **RRF**（`1/(k + rank)`，`k` 来自配置默认 60），**只用名次不用分数**：
   BM25 侧是归一到 0..1 的自建分，向量侧是余弦，两者量纲不同且都会随语料漂移
   （4.3-b 已经为绝对阈值吃过一次教训），加权求和会把漂移直接乘进排序。
   embed 不可用/失败 → 结果里带 `vectorStatus: 'unavailable'`，排序退回纯 BM25，**零 BLOB 写入**。

**诚实的边界（不粉饰）**：4.3-07 的判据是"固定评测集上融合**优于**纯 BM25"，这需要真实可用的 embedding 端点；
本机没有 key（`env` 里无 `SILICONFLOW` / `AUTO_CC_*` 变量，仓库也没有 `.env`）。因此本片把可离线证明的部分
（机制、批量、降级、零写入、维度/模型失效、RRF 排序正确性）用本地 fixture 打满，
**增益那一条如实标 `[!]`**，并在此写明复跑步骤：导出 `AUTO_CC_SILICONFLOW_API_KEY` →
在 `cordis.yml` 的 **`llm-embed` 块**（不是 `llm` 块）补 `baseUrl: https://api.siliconflow.cn/v1` +
`model: BAAI/bge-m3` → 跑评测集脚本对比 topK 命中率。

## 4.3-d 落地记录（2026-10-02，向量可选增强：`llm.embed` + RRF 融合）

判据细节、五态语义、活体读数见 spec「4.3-d 落地记录」与 `docs/acceptance/4.3/4.3-08-*`。
这里只记三条**属本计划**的结构性决定与一处对原稿的更正。

**跨包能力用「软查」而不是 `static inject`**：向量出口的形状（`EmbedGateway` / `embedGatewayOf(ctx)`）声明在
`packages/core`，`resume-kb` 用的时候按名字现问（`maybeService`），**不写 `static inject`**。
理由有两条：① AGENTS.md §9（2.5 实测）——热改配置会连带重建下游插件，本地存一份"别人 init 时推给我的引用"
会在改配置后静默变空；② 这一腿是**可选增强**，一旦做成硬注入，摘掉 `llm-embed` 会让 `kb-profile` 整个 PENDING，
"可选"就变成"必需"。装配清单里 `resume-kb` 也**不**列 `dependsOn: [llm-embed]`，同一个理由。

**传输骨架是抽出来的，不是复制的（§2.2 在本项目的第一次兑现于 L2 之间）**：`llm.chat` 已有的
fetch + `AbortSignal.timeout` + 三种错误形态归一，在 `llm.embed` 这里是**第二次出现**，所以直接抽成
`packages/llm/src/http.ts` 给两个方法共用；`describeError()` 顺带补了硅基流动那种顶层
`{code, data, message}` 错误体（实测证据 [2]），chat 侧同受益。§2.7 禁的是第二个客户端，
不是同一个客户端的第二个方法——`check-llm-single-entry.ts` 现在把这条写成了断言：
`llm.*` provider 只允许 `chat` / `embed` 两个名字、各自只有一个真实声明者，端点痕迹（含 `/embeddings`）
只允许出现在 `packages/llm`。

**补建向量是外发动作，入口只留一条**：`kb.profile.syncVectors` 登记为 `effect: 'outbound'` +
`requiresConfirmation: true`，且**不进 `RENDERER_ALLOWLIST`**。界面上因此没有任何按钮能"顺手"把切片发给模型，
它只负责显示当次检索少了哪一腿。这与 §7.3（外发必经闸门）同源，也是 4.3-08「绝不产生伪向量」的另一半：
不自动补建 ⇒ `kb_vectors` 空表是正确状态 ⇒ 不存在"为了填满表而造点什么"的动机。

**对原稿的更正（键名与超时）**：上面「实现形状」第 1 条写的 `embedBaseUrl` / `embedModel` / `embedKeyEnv` /
`embedDimensions` / `embedBatchSize` 落地为 `llm-embed` 块内的 `baseUrl` / `model` / `keyEnv` / `dimensions` /
`batchSize`（默认 `16`），超时**不复用** `llm.chat` 的 `8000`，向量侧独立 `timeoutMs` 默认 `15000`
（一批 16 条切片的编码耗时随批大小线性增长，沿用聊天默认等于把"批量"做成"批量超时"）。
`dimensions` 默认 `null` = 不向对端传该字段，实际维度以响应为准写进 `kb_vectors.dim`——原稿这条照原样落地了。

**测试规模**：`vectors.test.ts` 13 例（纯算式）、`search.test.ts` RRF 6 例（含 `rrfK` 翻转反例）、
`profile-service.test.ts` 装配侧 11 例 + 迁移号段 14 的建表/回滚例；`resume-kb` 10 文件 / **220** 用例全绿，
`packages/llm` 侧 `embed.test.ts` 覆盖批量切分、超时、三种错误形态与"未配置时一次都不发"。

## 4.3-e 选型与证据（2026-10-02，离线与性能收口：4.3-05 / 06 / 09 / 12）

这一片不收新功能，收的是**四条"永远不许倒退"的门槛**：离线能跑（4.3-04 已在 4.3-d 关）、没有外部向量服务
（4.3-05）、没有要用户机编译的东西（4.3-06）、千级规模下延迟有数（4.3-09）、日志侧不泄露（4.3-12）。
所以它的产物是**两件常驻机检 + 一个可复跑基准 + 一条脱敏断言**，不是一次性人工核对。

| 候选做法                                          | 结论     | 依据                                                                                                                                                                                                                                                |
| ------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拿 4.3-a 的 spike 数字当 4.3-09 的证据            | **否决** | 那份读数是 `.research-repos` 里**裸 FTS5 查询**（2000 行双写 11.1ms、单次查询 0.30～0.61ms），没有过 `search()` 的分词、候选取数、应用层 BM25 重算、词面覆盖、子串兜底、排序、视图组装、向量腿短路。4.3-09 判的是用户等的那个函数，不是它的某一条腿 |
| 基准打在真实 app（GUI + CDP）里                   | 否决     | 要的是检索函数本身的 P95；掺进 IPC 序列化与渲染会把两件事糊成一个数，而且换机器/无显示环境就不能复跑。界面侧的 V 类证据已由 4.3-c / 4.3-d 覆盖，本片不重复                                                                                          |
| 基准脚本放根 `scripts/`                           | 否决     | 实测：根包没有 workspace 依赖链接（`node_modules/@auto-cc` 不存在，`tsconfig.base.json` 也没有 `paths`），从 `scripts/` import `@auto-cc/plugin-resume-kb` 连 typecheck 都过不去；而基准**必须**打真装配                                            |
| 基准放 `packages/resume-kb/src/bench.ts` + 包脚本 | **采用** | 与被测代码同包，装配腿（config / logger / store / resume-doc）已在该包 `devDependencies` 里；装配形状与 `profile-service.test.ts` 的 `boot()` 同构（§2.1 复用现有形状）                                                                             |
| 延迟预算加一个 `kbProfileSchema` 键               | 否决     | app 运行期不读它，等于让插件配置携带一个死键（§2.6 不为假想的未来做抽象）；4.3-09 要的是「阈值来自配置」，不是「阈值来自插件配置」                                                                                                                  |
| 延迟预算放 `cordis.yml` 顶层 `bench:` 段          | **采用** | 配置文件仍只有一个（§2.7 禁的是第二套配置**系统**，不是第二份读数）；`parseManifest` 只认 `plugins` 数组，多一个顶层段不影响装配（实测见下方证据 [2]）；解析用的 `yaml` 已在锁文件里（kernel 的依赖），只给本包加 devDependency，不引入新包（§6.3） |
| 断网冒烟用「拔网线 / 挡防火墙」                   | 否决     | 不可复跑、且分不清「没网」和「代码根本没用网络」。改成把 `globalThis.fetch` 换成**调用即抛**的存根，跑完整条检索后断言零调用——与 4.2-e 的零上行审计同一口径（可写全局只有 `fetch`，见 §9 的 Node 命名空间只读实测）                                 |

- **[1] 规模量级的现实性**：真实库里目前是「数十到数百条切片」（一份简历派生的实体 + 三个区块切片），
  4.3-09 要「千级」是**远超真实负载**的压力位——所以基准的语料要按"多份简历 + 手工补录攒到千级"来造，
  而不是把一条长简历切成一千段（后者会让 avgdl 与 df 分布失真，BM25 的统计腿就不是它平时的那个形状）。
- **[2] 清单解析的实测边界**：`packages/kernel/src/manifest.ts` 的 `parseManifest()` 只要求根对象里有
  `plugins` 数组（`manifest.test.ts:200` 那条例子证明「缺 plugins」才报错），多余的顶层键原样忽略；
  因此新增 `bench:` 段对运行期装配零影响。**这也是为什么 `enabled`/`dependsOn` 之外的键不会误伤**：它压根不看。
- **[3] `yaml` 的取用**：`node_modules/.pnpm/yaml@2.9.1` 已存在于 store（`pnpm-lock.yaml` 里由 `plugin-kernel` 引入），
  给 `plugin-resume-kb` 加 `"yaml": "^2.7.0"` 的 devDependency 是**离线 relink**，不需要下载。
- **[4] 依赖门槛为什么不能只靠 `pnpm why`**：`pnpm why` 是人肉一次性动作，问完就没了；而"引入 ChromaDB / sqlite-vec"
  恰恰是某次顺手 `pnpm add` 的产物。所以 4.3-05 / 06 落成 `pnpm lint` 链里的常驻机检，扫三层：
  声明层（每个 `package.json` 的 deps）、解析层（`pnpm-lock.yaml` 全量包名，传递依赖也拦得住）、
  搬运层（`resolveRuntimeDeps()` 的闭包里不得有 `.node` / `binding.gyp` / 安装期编译脚本）。
  第三层用现成的 `scripts/vendor-runtime-deps.ts`——它就是"装机用户实际拿到哪些包"的唯一真相源（1.7-15 的审计读的也是它）。

**实现形状（三处，均不新建平行基础设施）**：

1. `packages/resume-kb/src/bench.ts`：不进 `index.ts` 门面（它不是能力出口，是验收工具）。
   流程 = 读 `cordis.yml` 的 `bench.kb-search`（`chunks` / `queries` / `p95BudgetMs`）→ 挂 config+log+store+resume.doc+kb.profile
   （**不挂 `llm-embed`、不给 key**）→ `fetch` 桩成调用即抛 → 经 `kb.create()` 逐条灌到千级（走真实事务：实体行 +
   `kb_chunks` + FTS5 三写）→ 用一组真实中文查询打 `search()`，逐次记墙钟 → 报写入吞吐、P50/P95/P99/max、
   命中分布、`fetch` 调用数，超预算 exit 1。输出原样入 `docs/acceptance/4.3/4.3-09-*`。
2. `scripts/check-dependency-floor.ts`：进 `pnpm lint` 链（与现有四只检查脚本同形状：内联规则表 + 逐行注释写清
   每条否决理由的出处 + 失败即列清单退 1）。规则表按上面 [4] 的三层分工，禁止清单里每一项都对应
   plan/spec 里已经写明的一次否决（chromadb/qdrant/weaviate/milvus/lancedb/faiss/hnswlib/usearch/pgvector、
   docker 类、`better-sqlite3`/`sqlite3`/`sqlite-vec`、node-gyp 预编译链），不是随手列的黑名单。
3. 4.3-12 的脱敏断言：写在 `profile-service.test.ts` 的装配用例里（那套真库 + 真日志的脚手架已经在那儿，
   §2.2 不再抄第二份）。判据要**同时**成立才算过：日志文件里查不到切片正文短语、查不到 PII 哨兵、
   查不到查询原文；**且**那一条检索日志行确实存在、带着 token/候选/命中三个计数——否则就是"日志压根没写"
   造成的假通过。

**本片边界（不粉饰）**：

- 不做并发与压测曲线：这是单用户桌面 app，检索串行；并发吞吐是服务端命题，现在做属于超需求（§2.6）。
- 不预先加缓存/分页/截断等性能优化：基准的产物是**读数**。真超预算再谈优化，且优化要另开一片重新定判据。
- 不动 `rrfK` / `vectorMinCosine` 的取值标定：那需要真实 embedding 端点，与 4.3-07 的 `[!]` 同源，
  复跑步骤已经写在 4.3-d 那一节里，本片不重复。
- 依赖机检只判"名字与产物痕迹"，不判许可证（许可证记账归 §8.7 与 `LICENSES.md` 那条线，两码事不要混）。
- 「装机冒烟」在本片只做**搬运层扫描**这一半；完整的三端安装包冒烟仍属 M2b/2.x 的收口，
  macOS 与 Linux 在本机不可验证（§9），届时如实标 BLOCKED。

## 4.3-e 落地记录（2026-10-02，离线与性能收口）

**实测读数（两次连跑，同机同配置）**

| 项                                         | 第 1 次                                        | 第 2 次                         | 判据                            |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------- | ------------------------------- |
| 写入侧 1500 条（实体行 + 切片 + 倒排三写） | 1778.28ms ＝ 844 条/秒                         | 1681.59ms ＝ 892 条/秒          | 只记录，不设门槛                |
| 检索 P50 / **P95** / P99 / max             | 3.15 / **7.76** / 8.41 / 8.78ms                | 3.24 / **7.49** / 8.45 / 9.19ms | P95 ≤ 150ms → PASS              |
| 库内不变量                                 | `kb_chunks`=`kb_chunks_fts`=1500、孤儿倒排行 0 | 同                              | 任一不符先抛后打印              |
| 出网                                       | `globalThis.fetch` 存根被调用 0 次             | 同                              | 必须为 0（4.3-04 在基准里复证） |
| 命中分布                                   | 0 命中 86 次 / 均值 6.42 / topK=10             | 同                              | 只记录，用来证明冷门腿被跑到    |

**与原稿实现形状的四处偏离（以代码为准）**

1. 语料生成里的 `?? ''` 换成 `pick()` **越界即抛**。原稿打算用空串兜住索引类型问题，实现时发现空串兜不住 bug 只
   会掩盖它：词表下标越界会产出一批前缀相同的雷同句子，基准负载被悄悄测轻。现在六张表的乘积（147456）与
   `chunks` 上限（50000）的关系写在注释里，越界就是配置或算法错了，直接炸。
2. 4.3-12 的日志读取用**轮询等最后一次操作的日志行**而不是固定 sleep。`createWriteStream` 只保证入队顺序、
   不保证同步可见；轮询到"删除手工实体"这一行，就同时保证了它之前所有行都已落盘（写流内有序），
   负向断言因此覆盖整条链路而不是截到半截。等不到就抛——不给"日志没写"留成"查不到所以干净"的出口。
3. 依赖机检的提示行做了一次**家族聚合**（`@napi-rs/canvas` 的 11 个平台变体收成一条）。原稿一条一行，
   14 行提示会把"结论"两行的信噪比压没；聚合只改输出形状，判定逻辑仍是逐包名。
4. 新增了一条**反向验证**（三层各造一次违规输入，见 spec 4.3-e 落地记录第三条）。plan 原稿只写了"跑通即入库"，
   实现时判断"绿"如果没有反证就只是没测过，所以补齐 chroma/better-sqlite3/fake-native 三个假违规各红一次，
   跑完即还原（还原后 `git status` 逐字一致）。这是对 AGENTS.md §6.5 同源要求的自愿扩展。

**依赖面**：`yaml` 作为 **devDependency** 加进 `packages/resume-kb`（基准要读 `cordis.yml`）。它不是新依赖——
锁文件里已有 `yaml@2.9.1`（`plugin-kernel` 的运行期依赖），`pnpm install --offline` 2.9s 通过，
且 dev 依赖不进 `resolveRuntimeDeps()` 的搬运闭包，所以 4.3-06 的装机面一个字节都没变。
基准产物写在 `tmp/kb-bench/`（gitignored，§7.5），每次先 `rmSync` 再建库，避免上一轮实体让"行数 == 配置值"偶然成立。

**4.3 的收口与下一片**：12 条里 10 条 `[x]`，`4.3-03` / `4.3-07` 保持 `[!]`，卡的都是"本机没有 embedding key + 没有评测集"
这一同一件事；机制与配置面已全部证死，key 到位后的动作是跑评测、改 `cordis.yml` 的取值，不改代码。
下一片按主计划是 **4.4（JD → 能力要求拆解与缺口比对）**，它直接消费本片留下的两个入口：
`kb.profile.search` 的证据腿与 `evidenceFor` 的反查阈值（`evidenceTopK` / `evidenceMinScore` 已在 4.2-03 接进配置）。

## 4.4 选型与证据（2026-10-02，写代码之前的四条一手取证）

取证副本在 `.research-repos/src/ai-resume-master/`（AGENTS.md §6.4：代码不进主干，结论进本节）。

**[1] 四类口径来自 `server/src/prompts/jdParse.ts`（17 行，逐字读过）**
它的字段是 `title / hard_skills / soft_skills / exp_years / edu_level`。**采纳**后四类作为 spec 4.4-01 的分类口径，
**两处改判**：① `title` 不是能力要求而是岗位名，2.3 已经把它落在 `jobs.title`，再拆一份是第二个真相（§2.7）；
② 学历不让模型自由产字符串——词表固定 5 档（博士 / 硕士 / 研究生 / 本科 / 大专），因为 4.4-c 的三态比对要做
「硕士 ⊇ 本科」这类有序比较，自由文本排不出序。许可记账：该仓库 README 声明 MIT 但无 `LICENSE` 文件、
`server/package.json` 写 ISC，且已由版权方（即本项目需求方）确认归其所有——见
`docs/research/source-repos-analysis.md` §1.1 与 §1.2。**本仓库只借鉴分类口径，未复制其任何文本**。

**[2] 它的比对做法被实测读死后否决：`server/src/services/keywordService.ts`**
`computeKeywordMatchRate()` 把整份简历 `JSON.stringify` 后逐词 `lowerText.includes`，返回 0–100 的整数；
`getMissingKeywords()` 返回没命中的词。与本项目的判据差两件事：
① **单值百分比不可解释**——spec 4.4-06 要求缺失项同时给出可用证据或补救建议，一个数字给不出；
② **stringify 让字段名也进入比对**——简历 JSON 的 `company` / `period` 这些键会参与 `includes`，是假命中来源。
→ 改判：4.4-03 做三态（命中 / 部分命中 / 缺失）且每项附知识库实体 id，比对经 4.3 的检索腿而不是全文 `includes`。

**[3] 腿的顺序做了改判：词面腿先落地、模型腿后加、词面腿永久保留为回落**
源仓库只有模型腿（`getLLM()` 抛错整条失败）。这里分两条腿且先做词面，依据三条：

- 本机没有可用的 chat/embedding key（§9 的诚实边界，4.3-03 / 4.3-07 卡的就是同一件事），
  只有词面腿能在今日**离线测穿并给出真读数**；
- `packages/outbound/src/script.ts` 已经立了「模型不可用 → 可见回落 + 版本号随结果」的同源先例（2.5-09），
  4.4-b 照它接，而不是另发明一套回落形状；
- spec 4.4-02 写的正是「回落关键词抽取」。**把回落做成第一条真跑过的路**，这条分支才是被覆盖过的；
  反过来（只有模型腿失败时才第一次跑到词面）它就是一条从没测过的冷路径。

**[4] 不建新表、不改 `jobs.requirements_json`**
实测 `packages/platform-boss/src/jd-store.ts`：`requirements_json` 装的是 2.3 从页面 DOM 原样抓下来的要求标签，
那是**页面真相**。把派生结果写回同一列就是第二个真相源（4.2-11 与 §2.7 的同一件事）。
词面拆解的代价是 61 组代表词的正则扫描，与一次检索同量级（4.3-e 实测 P95 7.5ms），
所以**可重建的投影不落库，用时现算**；迁移号段 15 本片仍空着。若 4.4-c/d 需要复盘某份报告，
只记「JD id + 词表版本 + 结果指纹」，正文与日志一律不落（4.3-12 口径）。

## 4.4 切片分解（2026-10-02，按依赖顺序，一次只推一片）

| 片    | 内容                                                                                                                               | 覆盖的 spec 条目           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 4.4-a | 词面拆解腿：`requirements.ts` 纯函数 + `kb.gap.extract` + 配置项 + 注册表接线                                                      | 4.4-01 / 07 / 08 / 10      |
| 4.4-b | 模型腿与回落播报：先问 `llm.chat.status()`，可用走 JSON 输出并做形状校验，失败退回词面并把原因随同一个视图返回                     | 4.4-02（U 半边）           |
| 4.4-c | 三态比对 + 反向比对：a/b 的条目经 `kb.profile.search` 与 `evidenceFor` 比，产三态 + 证据实体 id；再给「库内具备、JD 未提」的候选   | 4.4-03 / 04 / 06           |
| 4.4-d | 缺口报告界面：分栏 + 证据链跳转 + i18n，并同时注册为 agent 工具（§5.9 双入口共用同一 service）                                     | 4.4-02 的 V 半边 / 4.4-05  |
| 4.4-e | 额度与合规收口：`entitlement.gate` 接线判定、URL allowlist 复跑、**五个阈值的标定（三条测量型 + 两条口径型）**、逐项验收与证据归档 | 4.4-09 / 4.4-08 的机检半边 |

> **4.4-06 的归属更正（2026-10-02，写 4.4-b 收口自检时定）**：本表初稿把它同时挂在 4.4-b 与 4.4-c 名下，
> 这是错的——它判的是"缺失项必带 `suggestion` 字段"，而"缺失"这个概念要到**比对腿**才存在；
> 拆解腿（a/b）产出的只是 JD 侧的要求列表，没有"缺"可言。现只归 4.4-c，4.4-b 交回的是它的前置件
> （四类计数 + 腿状态 + 丢弃原因），界面据此出建议，但结构判据要等 4.4-c 的输出面才能钉住。

顺序依据：a 是 b 的回落分支，c 消费 a/b 的条目，d 消费 c 的读数，e 只能在链完整后收口。
4.4-05 是 V 类，界面那一片必须用 CDP harness（端口 **10222**）真看页面并留截图，单测不能替代（§7.1）。

## 4.4-a 落地记录（2026-10-02，词面拆解腿）

**实测读数**（真装配 `config + logger + kb.gap` 的一次性脚本，跑完即删；全量输出在
`docs/acceptance/4.4/4.4-01-lexical-extraction.txt`）：

| 项                                     | 读数                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| 样例 JD（虚构，去空白 264 字）拆出     | 硬技能 11 / 软技能 4 / 学历 1 / 年限 2，丢弃 0                                             |
| `quote` 与 `slice(start,end)` 逐条比对 | 18 / 18 全部一致（4.4-01 的"带原文引用位置"就是按这条判的）                                |
| 连跑两次的序列指纹                     | `50327bd7…ba46298`，两次相同（sha256，4.4-07）                                             |
| 日志落盘那一行                         | `[kb-gap] 词面拆解 264 字 → 硬技能 11 / 软技能 4 / 学历 1 / 年限 2（丢弃 0，词表 lex-v1）` |
| 日志里 grep 哨兵                       | 星桥科技 / 正文长句 / 抗压能力 / Kubernetes **全部 0 次**                                  |

**词表规模**：61 组代表词（硬技能 46 / 软技能 10 / 学历 5）+ 一条年限正则。每组一个 `label` 加若干书写形式，
别名归并到同一 `label`（`容器化`→Docker、`K8s`→Kubernetes、`英文文献`→英语），所以「同一能力写两种」只产一条要求。

**与原稿实现形状的五处偏离（以代码为准）**

1. **纯字母别名加词边界**（`(?<![A-Za-z0-9])…(?![A-Za-z0-9])`）。原稿只写"按词典匹配"，实现时发现
   `SQL` 会在 `NoSQL` 里被捡走、`Go` 会在 `logo` 里被捡走、`Java` 会在 `JavaScript` 里重复产一条。
   边界只加给"纯 ASCII 字母"的别名——带元字符或中文的别名（`C++`、`Node.js`、`数据仓库`）本身已足够独特，
   加边界反而伤到 `C++/Java` 这种连写。三处误伤各有一条用例钉住。
2. **单字母语言不进词表**（C / G / R 这类）。中文正文里的「3C 数码」「C 端」会把它们误捡起来；
   词面腿宁可漏（漏了报告短一条），错了就是凭空给用户造一个缺口——与 §8.4 事实锁定同一立场。
3. **偏移量用 JS 字符串下标（UTF-16 code unit）而不是字节偏移**。消费方（界面高亮 `String.slice`、
   4.1 的 `rangeText`）都在 JS 字符串上操作，中间换一层字节只会引入错位。这个口径写在 `RequirementItem` 的注释里。
4. **脱敏从 4.3-12 延到 JD 正文**，且**错误路径同样只带字数**：过短的 JD 抛 `INVALID_ARGUMENT`，
   消息里是「只有 N 字，少于下限 M 字」而不是那段正文。用例是双向断言（计数行必须出现 + 哨兵必须查不到），
   防止"日志压根没写"蒙过负向断言。
5. **轮询等日志行的 helper 抽成 `log-file.ts`**（§2.2 的第二处使用即抽）：`profile-service.test.ts` 的 4.3-12
   用例与本片的服务用例都要它，原来那份内联实现搬进公共文件，两边的 75 + 5 例都改用它。

**四处刻意不做**：不建新表（证据 [4]）、不在本切片接 `llm.chat`（那是 4.4-b，且现在接了也没有 key 可测）、
不做界面入口（4.4-d；本片服务在装配里可解析，工具面与界面按 §5.9 一起在 d 接）、
不在 `index.ts` 外露 `extractRequirementsLexically`（绕过服务自己拆就是开第二条拆解通道，§2.5）。
`RequirementItem.via` 现在恒为 `'lexicon'`——`'model'` 这一支在本切片确实没有生产者，
留它是因为它是 4.4-b 的唯一接入口且已被用例覆盖到形状；这是契约位，不是死代码。

**依赖面**：无新增依赖、无新表、无迁移号（15 仍空着）。接线只有三处：
`packages/main/src/registry.ts` 的 `'kb-gap'`、`cordis.yml` 的 `kb-gap` 段（`perKindLimit: 12` / `minJdChars: 20`）、
`packages/resume-kb/src/index.ts` 的出口。装配里不 `inject` `store` 与 `llm.*`，
所以 4.4-08 的"不联网"是**结构性成立**——这条链根本没有出网入口，而零上行机检
（`check-llm-single-entry.ts`）已经保证出网只在 `packages/llm`。

**单测与门**：`requirements.test.ts` 11 例 + `gap-service.test.ts` 5 例（其中 4 例判服务、1 例判脱敏）；
本包 12 文件 / 238 例全绿。根 `pnpm typecheck`（0 error）/ `pnpm lint`（六项全过）/
`pnpm format:check` / `pnpm test` 全绿。`[机检]` 与 `[验收]` 的逐条对应在 spec 4.4 表里。

**下一片**：4.4-b（模型腿 + 回落播报）。它要做的动作已经定死：先问 `llm.chat.status()`，
可用则让模型产 JSON 并**逐条校验形状 + 用 `start/end` 反查原文是否真的存在该 `quote`**（模型给的偏移必须验，
不能信），失败或不可用退回本片，并把回落原因随同一个视图给界面播报（4.4-02 的 U 半边）。

## 4.4-b 选型与证据（2026-10-02，模型腿与可见回落）

**[1] `llm.chat` 的契约以 `packages/llm/src/index.ts` 为准（§6.2，读实现不读文档）**
`complete({messages, maxTokens?, temperature?})` 三件事决定了模型腿不用自己造轮子：
未配置时抛 `LLM_UNAVAILABLE` 且**一次请求都不发**；网络失败 / 超时 / 非 2xx / **空回复**统一 `LLM_REQUEST_FAILED`；
成功时回 `{text, model, promptTokens, completionTokens}`。
所以本片只需要处理三种结局：可用性判定、抛错、以及"回了文本但内容不合约定"——第三种是 `outbound.script` 没有的
（它只要一句话），JSON 拆解必须有，且它是 4.4-02 判据里"拆解失败"的主要形态。

**[2] 跨包取手沿用 4.3-d 的软取形状，并把 chat 补齐**
实测：`EmbedGateway` / `embedGatewayOf` 在 `packages/core`，`resume-kb` 用的时候按名字现问；
chat 侧今天**没有**软取形状——`outbound.script` 是 `static inject = ['llm.chat']` + `asApp(ctx)['llm.chat']` 硬注入，
因为它没有"不装也能用"的形态（注释里写得很清楚：装上半个不如不装）。
4.4-b 要的恰恰是"摘掉模型出口照常拆"，所以按 §2.2 在 core 补 `ChatGateway` + `chatGatewayOf`，与 `EmbedGateway` 同套路：
形状在 L0、实现方结构上满足、调用方现问现用。**不新建第二套询问面，也不把 `outbound.script` 改成软取**
（它的硬依赖是它的正确形态，改成软取反而会让话术生成在缺出口时静默降级成模板，那是 2.5-01 明确拒绝的"静默"）。

**[3] 输出契约：模型只许"指认原文"，不许生产位置**
让模型产 `{items: [{kind, label, quote}]}`，**不要求它给 `start/end`**——LLM 的数字偏移不可信，
而 `quote` 是不是真的在原文里，是可以用 `indexOf` 一刀判死的。定不了位的条目（模型改了字面、补了空格、
近义替换）一律判该条无效并计数播报。这就是 §8.4「事实锁定」在拆解层的对应物：
**模型可以决定"哪句是要求"，但不可以决定"JD 里写了什么"**。
参考项目那份 prompt（`jdParse.ts`）连 `quote` 都不要，只出关键词数组，所以它的产出无法回查原文、
也无法给 4.4-05 的界面高亮提供位置——这条是本片与它最大的实现差异（口径借鉴见 §4.4 证据 [1]）。

**[4] 对原稿的更正：回落方向反过来——词面为基线，模型为增强**
上面 4.4-a 记录里写的下一片是"先问 status，可用走模型腿，失败退回词面"，实现时改成
**词面腿始终跑（确定性基线），模型腿只做"校验通过才并入"的增强**，与 4.3-d 的"BM25 为基线 + 向量为增强 + 五态读数"同构。三条理由：

- 4.4-02 的"功能不中断"因此是**结构性成立**，不是靠 `catch` 分支兜住——基线永远在，增强失败只是这一条腿没加上东西；
- 主备关系会丢信息：词面抓到而模型漏掉的、模型抓到而词面没有的，两类差额都是 4.4-c 三态比对的输入。
  "模型为主、词面为备"意味着模型可用时词面结果被整体丢弃，恰恰把最可复现的那一半扔了；
- 本机没有 chat key（§9 的诚实边界，4.3-03 / 07 卡的就是同一件事），"模型为主"的形状今日无法验收；
  反过来，基线 + 增强的形状可以用**测试替身**把两条腿都真跑一遍（替身按 4.3-d 的 `FakeEmbedService` 同套路）。

`modelStatus` 五态（随结果返回，界面据此播报）：

| 状态          | 含义                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `merged`      | 模型回了且至少一条通过原文校验并入                                       |
| `rejected`    | 模型回了但一条都没通过（JSON 不合约定 / quote 全部定不了位），计入丢弃数 |
| `failed`      | 请求抛错（网络 / 超时 / 非 2xx / 空回复）                                |
| `unavailable` | `llm.chat` 未挂载，或配置齐但 status 判不可用（缺 key / 端点 / 模型）    |
| `disabled`    | 配置显式关掉模型腿（`allowModelLeg: false`）                             |

**[5] 外发与脱敏口径**
把 JD 正文发给远端模型是**离开 app 的动作**，因此三条同时成立：
① 配置留 `allowModelLeg` 开关（默认开），4.4-e 讨论把它接到 `entitlement.gate` 的判定口径（spec 4.4-09）；
② `modelStatus` / `modelReason` 随结果返回，界面必须说清这次用没用模型——与 4.3-10「确定空态」同口径，
不让用户把"词面拆出 8 条"读成"模型认为只有 8 条"；
③ 日志只有计数与状态，**JD 正文与模型的原始回复都不落**（4.3-12 / 4.4-a 的同一判据）。
prompt 版本随结果返回（`promptVersion`，2.5-09 的 `scriptVersion` 同机制），改提示词必须同时改它。

**实现形状（四处，都不新建平行基础设施）**：

1. `packages/core`：`ChatGateway`（`status()` / `complete()` 最小形状）+ `chatGatewayOf(ctx)`，紧邻 `EmbedGateway`；
2. `packages/resume-kb/src/requirements-model.ts`：纯函数层——拼消息、剥代码围栏、解析并校验 JSON、
   `indexOf` 定位 `quote`、与词面条目做确定性合并；不碰 cordis、不发请求（同 `requirements.ts` 的规矩）；
3. `gap-service.ts`：`extract()` 变异步，先跑词面再问模型腿，产出 `modelStatus` 与合并后的稳定序列；
   **仍然不建表、不加迁移号**（§4.4 证据 [4]），配置的三个新键进 `cordis.yml`；
4. `index.ts` 出口加 `GapModelStatus`；`packages/main/src/registry.ts` 不动（服务名不变，只是方法变异步）。

## 4.4-b 落地记录（2026-10-02，模型腿与可见回落）

**实测读数（真装配，五个形态各跑一次；全量输出在 `docs/acceptance/4.4/4.4-02-model-leg-fallback.txt`）**

装配是四个真服务：`ConfigService + LogService + LlmChatService（真类）+ KbGapService`，模型端点是脚本内起的
一个本地 fixture HTTP 服务（127.0.0.1 随机端口，回 OpenAI 信封）。本机没有 chat key，所以这一片能证到的是
**形状与接线全链穿通**，不是真实模型的召回质量——那条写在证据文件第 6 节，不粉饰。

| 形态（`modelStatus`）                 | items 指纹         | 条数 | 播报要点                                                    |
| ------------------------------------- | ------------------ | ---- | ----------------------------------------------------------- |
| `unavailable`（真服务在场但没配端点） | `d668f55a7d54d3f7` | 6    | `reason=模型未配置，缺 baseUrl / model`，一次请求都不发     |
| `merged`（打到本地 fixture 端点）     | `752f3c49a71c6721` | 7    | 并入 1 条 / 丢弃 2 条 / `提示词 jdreq-v1`，连跑两次序列一致 |
| `rejected`（回了文本但不是 JSON）     | `d668f55a7d54d3f7` | 6    | `reason=模型产出不是合法 JSON`                              |
| `failed`（端点指向已关闭的端口）      | `d668f55a7d54d3f7` | 6    | `reason=问模型失败：模型请求发不出去：fetch failed`         |
| `disabled`（`allowModelLeg=false`）   | `d668f55a7d54d3f7` | 6    | 替身处于可用状态，但 `complete` 一次都没被调到              |

四个回落形态的指纹与「完全不问模型」的词面基线**逐字相同**，这就是 4.4-02「功能不中断」的证法：
不是"catch 住了没崩"，而是**交回来的序列就是基线**。`merged` 只增不减（6 → 7）。

**与原稿实现形状的五处偏离（以代码为准）**

1. **`promptVersion` 在"根本没问模型"的两支为 `null`**。原稿写「prompt 版本随结果返回」，实现时先做成恒返回
   常量，真装配跑出来第 ①（unavailable）与第 ⑤（disabled）那两行日志带着「/ 提示词 jdreq-v1」——
   等于向用户宣称发过一个根本没发出去的请求。加了 `wasAsked()`（状态不是 disabled / unavailable 才算问过），
   两支的 `promptVersion` 改成 `null`、日志里那段一并抑制。**这一条是"跑真装配"才暴露的**，单测里断言不到，
   因为替身的用例只判状态字符串。
2. **错误文案的双重前缀**：`llm.chat` 抛出的句子已经以「模型请求…」开头，我这侧再拼「模型请求失败：」就成了
   `模型请求失败：模型请求发不出去：fetch failed`。前缀换成动词「问模型失败：」，界面上是一句能读的话。
3. **模型条目不"追加到尾部"，而是与词面条目一起重排**。我原本断言模型补的那条排在同类别最后，实测稳定序是
   「类别 → 原文起始下标」（4.4-a 定的序），而长尾引文常常出现在正文靠前的位置，于是它排在 Java / Kafka 前面。
   合并函数因此只做 `dedupeAndSort([...lexical, ...added])`，**不引入第二条排序规则**（§2.5）——
   这条同时是"合并确定性"的最省事证法：模型给的次序乱序后逐字节相同，已有用例。
4. **`ChatStatusView` 刻意不含 `endpoint`**。端点属于 `packages/llm` 的内部事实，而零上行机检
   （`check-llm-single-entry.ts`）就是按"端点痕迹只允许出现在 `packages/llm`"扫的——把它经网关形状复导出到 L0，
   等于自己造一次扫描误报，也让 `resume-kb` 有机会读到并使用端点。缺项只用 `missing: ('baseUrl'|'model'|'apiKey')[]` 表达。
5. **跨包取手只加了一层形状，没有第二套询问面**：`ChatGateway` + `chatGatewayOf(ctx)` 与 4.3-d 的
   `EmbedGateway` 紧邻同套路，`outbound.script` 的 `static inject = ['llm.chat']` **保持硬注入不动**——
   它没有"不装也成立"的形态，改成软取会让话术生成在缺出口时静默降级，那正是 2.5-01 拒绝的"静默"。

**两条腿的分工落点**（对 4.4-a 记录末尾"下一片"那句的更正已写在上面 [4]，这里记落地形态）：
词面腿始终跑，模型腿产 `{kind,label,quote}`；`quote` 用 `indexOf` 定位不回原文即丢弃并计数，
`start/end` 由我们自己算，经验年限从**定位到的那段引文**里重新取（模型给的数字一律不采信）。
这是 §8.4 事锁在拆解层的对应物：模型可以决定"哪句是要求"，不可以决定"JD 里写了什么"。

**依赖面**：`packages/core` 加 `ChatGateway` / `ChatStatusView` / `ChatRequestView` / `ChatCompletionView` +
`chatGatewayOf()`；`packages/main/src/registry.ts` 不动（服务名不变，`extract()` 变异步）；
`cordis.yml` 的 `kb-gap` 段加 `allowModelLeg: true` / `modelMaxTokens: 1200` / `modelTemperature: 0`
（**温度取 0**：拆解是读数不是创作，与话术侧的 0.7 刻意不同；`maxTokens=1200` 在真装配的请求体里验过确实带出去了）。
**无新表、无新增迁移号**（15 仍空着），与证据 [4] 一致。

**单测与门**：`requirements-model.test.ts` 13 例（纯函数：拼提示词、剥围栏、定位、逐条契约校验、合并与上限）+
`gap-service.test.ts` 14 例（五态各一、含"没挂替身"与"挂了但没配 key"两种 unavailable、日志级别与脱敏）+
`requirements.test.ts` 11 例复跑；本包 13 文件 / **260** 例全绿。根 `typecheck` / `lint`（六项）/
`format:check` / `test` 全绿，`check-llm-single-entry` 扫 276 个文件通过。

**一处门禁里的既有抖动**（不属于本片，但如实记录）：`pnpm test` 首轮里
`packages/resume-kb/src/source.test.ts` 的「DOCX 中文简历与文本腿同形」在 13 个测试文件并发时超过默认 5s 超时，
单独复跑同一文件 12 例 / 276ms 全绿。它是 4.1-b 那条依赖腿的冷启动耗时被并发放大，
与 4.4-b 的三个文件无 import 关系；收口轮次复跑通过，读数记在 `docs/acceptance/4.4/4.4-b-gates.txt`。

**下一片**：4.4-c（三态比对 + 反向比对）。它消费的是本片的 `items`（含 `via` 与 `start/end`）与 4.3 的
`kb.profile.search` / `evidenceFor`；4.4-07 的"确定性"要在比对腿接上后**在全链上复跑一次**（现在只覆盖拆解层），
`4.4-02` 的 V 半边（界面上那句"这次没用上模型"）与 `4.4-05` 一起到 4.4-d 收。

## 4.4-c 设计定稿（2026-10-02，写代码之前把判据钉死）

前置事实（本仓库现状实测，不是设想）：`evidence.ts` 已经有 `rankEvidence(claim, targets, options)`
这把尺子（token 交集覆盖率、`contains` / `overlap` 两态、同分按 id 升序），
`KbProfileService.evidenceFor()` 已经会把库内实体投影成 `EvidenceTarget`——**比对腿不该再写一份打分**（§2.1）。
所以 4.4-c 的新东西只有三件：**按类别换判据**、**反向比对的"相关"怎么定义**、**缺失项的建议从哪来**。

**判据一：四类要求不能共用一把尺子**（这是本片最容易做错的地方）。

| JD 要求的类别               | 「据」在哪                                                                                                                                                                    | 命中                         | 部分命中                                | 缺失                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------- | -------------------------------------- |
| `hard_skill` / `soft_skill` | 全库实体的载荷文本，经 `rankEvidence`                                                                                                                                         | best ≥ `evidenceHitMinScore` | ≥ `evidencePartialMinScore` 但 < 命中线 | 无命中或 best 低于部分线               |
| `experience_years`          | `experience` 实体的 `period` 字段，月份区间**合并去重叠**后的总年限                                                                                                           | 总年限 ≥ 要求                | ≥ 要求 × `yearsPartialRatio`            | 其余，以及「库里没有任何可解析时间段」 |
| `education`                 | `kb_chunks` 里 `section_kind='education'` 的区块切片（4.2 裁定二：`education` **不产实体行**，所以这一类的据只能在区块级——这正是裁定二末尾承诺"由 4.3/4.4 落进文档"的那件事） | 库内最高档 ≥ 要求档          | 正好低一档                              | 低两档及以上，或库里没有学历切片       |

- **年限为什么不能走词面反查**：JD 写「5 年经验」，库里的实体文本是「2019.03 - 至今」，
  两者没有任何共同 token，词面尺子只会给「缺失」。它是一个**算术**判断，不是文本相似度判断。
- **"至今"必须给一个今天**：`monthSpanOf` 对 open-ended 存的是 `OPEN_ENDED_MONTH = 99_999`（那是归属排序用的
  哨兵值，直接参与求和会得到几万个月）。所以本片的总年限算法把 open-ended 的终点**夹到 `nowMonth`**，
  而 `nowMonth` 是**显式入参**（服务层传当前月，测试传固定值）——不读 `Date.now()` 的隐式现状，
  否则 4.4-07 的"两次运行 hash 相同"在跨月的那一刻会莫名其妙地红。界面上要把"截至某年某月"显示出来（4.4-d）。
- **学历档位表复用抽取腿**：`EDUCATION_GROUPS` 那 5 档从 `requirements.ts` 导出成 `EDUCATION_TIERS`
  （档位 = 数组下标 + 1），比对腿不另写一份档位表。放宽口径「硕士 ≡ 研究生」也写在这同一份表里（3 档），
  因为 4.4-a 记录已经说明"归并是有据的放宽，不该混进抽取阶段"——归并发生在比对阶段，就是这里。
- **无据 ≠ 部分命中**：库里根本没有学历切片时判 `missing`（附 `education_missing` 建议），
  不给 `partial`——"没有据"和"据不够强"是两件事，混起来等于把空库读成"差一点就合格"。

**判据二：反向比对（4.4-04）的"相关"是一道门槛，不是一句形容词**。

候选 = 库里 `kind ∈ {skill, achievement}` 的实体，同时满足：
① 与**所有** JD 要求的 best 覆盖率 < `evidencePartialMinScore`（=JD 没提这条），且
② 与 **JD 全文**的覆盖率 ≥ `highlightMinScore`（=确实和这个岗位沾边，附命中的 token 作为"相关在哪"的读数）。
排序 `score` 倒序 → `entityId` 升序，截 `maxHighlights`，丢弃数随结果报出。

- 为什么 ② 不可省：只判 ① 会把「驾照 C1」「英语六级」这类**库里确实有、但对这个岗位无关**的东西当亮点推给用户，
  报告于是变成"我个人简介"。第二道闸用的还是同一把 token 尺子，只是把"要求列表"换成"JD 全文"，
  因此它同样确定性、同样可解释（`relatedTokens` 就是理由）。
- 为什么排除 `experience` / `project`：那两类是整段经历，当"一句话亮点"会退化成长文本，
  而且它们的技能面已经由 `skill` / `achievement` 实体代表（4.2-a 的派生映射）。
- 阈值与 4.4-b 的 `evidenceMinScore` 一样是**拍的**，未标定：标定要与 `k1/b`、`k` 权重一起等真评测集，
  复跑步骤归 4.4-e，界面上则统一按"阈值可调"呈现（对齐 4.2-b 的同一诚实口径）。

**判据三：4.4-06 的"不得只输出负面结论"落成一个结构断言，而不是提示词**。

报告里凡是 `state !== 'matched'` 的条目**必须**带 `suggestion: { key, params }`（i18n key + 插值参数，
文案本体归渲染层，§5.5/§5.7：不在服务里拼中文句子）。五个 key：
`add_evidence`（技能无据）、`strengthen_evidence`（有弱据，`params` 带最强的那条实体 id 与其文本摘要 → 建议"这样改写"）、
`years_gap`（带 `required` 与 `have`）、`education_gap`（带 `required` 与 `have`）、`education_missing`。
机检方式就是 spec 4.4-06 写的"输出结构断言"：用例遍历报告，缺失/部分命中的条目 `suggestion` 为 `null` 即失败。

**接线形状**：

- 纯函数文件 `requirements-compare.ts`（不认 cordis、不认 SQLite，同 `evidence.ts` / `requirements.ts` 的规矩），
  服务方法 `kb.gap.report(jdText, filter?, nowMs?)`：拆解**复用** `extract()`（不开第二条拆解通道，§2.5），
  然后现问 `kb.profile` 拿实体与切片读数，交给纯函数。
- `kb.profile` 按名字现问、不写 `inject`（与本片模型腿同理，且 §9 的 2.5-e 禁的是"本地存第二份事实"）。
  拿不到库时抛 `KB_LIBRARY_MISSING`：这与模型腿不同——模型腿是增强（可回落），库是**必需输入**
  （没有库就没有"缺口"这回事），静默给一份"全是缺失"的报告是最坏的假读数。
- **无新表、无新迁移**（15 仍空着）：报告是 `JD × 库` 的现算投影，两者都有真相源；
  落库就会在 `resume_docs` 与 `kb_entities` 之外造出第三份会过期的真相（4.2-11 的同一件事）。
- 日志延续脱敏口径：只记「要求 N 条 → 命中 a / 部分 b / 缺失 c · 亮点候选 d（丢弃 e）· 截至 <月份>」，
  **不落 JD 正文、不落实体文本**；`strengthen_evidence` 的 `params` 里只放实体 id（界面按 id 去库里取文案，
  服务不把个人内容塞进建议对象）。

## 4.4-c 落地记录（2026-10-02，三态比对 + 反向比对）

判据细节、真机读数、六条门禁的原始输出见 spec「4.4-c 落地记录」与
`docs/acceptance/4.4/4.4-03-*`、`4.4-04-*`、`4.4-06-*`、`4.4-c-gates.txt`。这里只记**设计定稿与实际落地的差异**
和三处需要后来者知道的判断。

- **定稿的两处措辞冲突按"更严的那条"落地**：上面判据三写 `strengthen_evidence` 的 `params` 带
  「最强的那条实体 id **与其文本摘要**」，而「接线形状」最后一条写"只放实体 id，服务不把个人内容塞进建议对象"。
  实际落地取后者：`params = { label, evidenceId }`，`label` 是 **JD 侧**的要求名（不是个人内容），
  证据文本由界面按 id 回库里取。理由就是那句口径——建议对象会过 IPC、会进日志的邻近面，
  把库内正文塞进去等于给脱敏开一个新口子（§8.5）。
- **年限行的 `score` 只是展示值**：定稿说"年限走算术"，落地后仍然给这一行填 `score`
  （词面覆盖率 0.5625 一类），因为界面的进度条需要一个 0~1 的数。但**状态由算术定、不由 score 定**
  （`compareByYears` 自己判），所以真机读数里出现"best=0.5625 却判 matched"——这不是阈值失效，
  而是这一行的分界来自 64 月 ÷ 12 ≥ 3 年。4.4-d 做界面时不要把这一行的进度条按三态阈值上色，
  否则会显示成"部分命中"，与状态矛盾。
- **档位表外的学历 label 退回文本反查**（定稿判据一的补集情形）：模型腿可以产「中专」「高中」这类
  本仓库词表没有的档位，`educationRankOf` 返回 `null`。落地按 `null` 走 `hard_skill` 那条尺子
  （`compareByText`），宁可给一个偏保守的 partial/missing，也不猜一档把"没读过"说成"低一档"。
- **missing ⇒ 证据恒为空**这条不变量在落地时红过一条用例（「起点在未来的区间直接不计」最初要求 12 年
  却断言带证据）。改的是用例（要求改 1 年）而不是实现——反着改就得把"塞一条弱据圆场"那条判据删掉，
  那是用实现去迁就测试。全过程记在 `4.4-c-gates.txt` 第 6 节。
- **本片新增的对外面**：`GapReportView` 与 `GapRequirementView` / `GapEvidence` / `GapSuggestion` 等**形状**，
  以及 `GAP_SUGGESTION_KEYS`（4.4-d 补语言包时要逐一对齐）；`compareRequirements` 本体**不外露**，
  比对只能从 `kb.gap.report()` 这一个入口出（§2.5）。为此把 `coverageOf` / `evidenceTextOf` / `monthSpanOf`
  三个包内私有函数改为包内可见并复用，没有新写第二套打分或第二套时间解析（§2.1/§2.2）。
- **下一片**：4.4-d（缺口报告界面 + agent 工具面，§5.9 双入口）。它要一次收掉三条：`4.4-05`（分栏 +
  证据链跳转，V 类，必须出 harness 截图）、`4.4-02` 的 V 半边（界面上那句"这次没用上模型"，按五态出五句）、
  以及本片五个 `gap.suggestion.*` 文案键（zh-CN + en 同时补，缺一边 `pnpm lint` 当场红）。
  `kb.gap.report` 过 IPC 要进 `packages/main` 的白名单注册表，与 4.3-c 的 `kb.search` 同一处登记。

## 4.4-d 设计定稿（2026-10-02，写代码之前把界面与工具面的判据钉死）

本片收三条：`4.4-05`（缺口报告界面，V 类）、`4.4-02` 的 V 半边（界面上那句"这次没用上模型"）、
以及 `kb.gap.report` 的**双入口**接线（§5.9：界面与 agent 打同一个 service，不许各长一套）。
接线清单以 4.3-c 的 `kb.search` 为模板，逐处对应如下。

**判据一：界面挂在哪儿**（决定"这算不算一个桌面 app 的功能页"）

- 新建 `packages/renderer/src/GapPanel.tsx`，挂进 `App.tsx` 的 `diagnostics` 视图区
  （与 `<KbPanel />` 相邻，沿用"面板常驻、只切 display"的现状）。
- **不塞进 `KbPanel.tsx`**：那个文件已是本包最大的界面文件（27 KB），且两者方向相反——
  `KbPanel` 是"我的库有什么"，缺口报告是"这份 JD 要我有什么"。混在一起会让 4.4-05 要的
  "分栏"与库列表在同一屏里争焦点。（§2.3 的"优先扩展现有模块"指的是**服务能力**，不是把两个视图缝在一起。）
- 输入是一份 JD 正文（粘贴），与 2.3 的 JD 抓取来源无关：本片**不**接 `jobs` 表，
  避免与 P2 的 JD 列表页产生第二个入口真相（"从某条 JD 打开缺口报告"是 4.4-e 之后的接线，
  届时的入参是 `jdText` 而不是数据库 id，报告仍然现算不落库）。

**判据二：三态分栏的"栏"是状态，不是类别**

- 三栏 = `matched / partial / missing`，栏内**保持拆解序**（不再按类别或分数二次排序，
  4.4-07 的稳定序在界面上的兑现就是"两次跑出来一眼看上去是同一页"）。
- 栏头显示计数，数字来自报告的 `counts`，不由前端 `filter().length` 重算
  （两处各算一遍就会在边界输入上对不上，§2.5 的"一个入口"延伸到展示层）。
- 亮点区（`highlights`）单独一栏在右侧，`highlightsDropped > 0` 时必须显示"另有 N 条未展开"，
  截断不可静默（4.4-06 的计数可见口径）。
- **年限行的分数不上三态色**：4.4-c 落地记录里那条"best=0.5625 却判 matched"是本片界面必须
  显式处理的一处不一致——这一行的状态来自算术，`score` 只作展示。色带按 `state` 上，不按 `score` 上，
  否则会出现"命中"行显示成黄色进度条的自相矛盾画面。

**判据三：证据链跳转要新开一个只读口，不能在报告里带正文**

- 报告里每条证据只有 `{ id, origin, score, matchedTokens }`，**没有正文**（§8.5 + 4.4-c 接线形状最后一条）。
  所以"点证据看原文"必须有一口 id→文本的读口。
- `kb.profile.get(entityId)` 只认实体 id，而学历证据的 id 是 `kbs-` 前缀的切片 id（4.2 裁定二），
  两个表。故在 `KbProfileService` 上加**一个**公开方法 `evidenceBody(id)`：先按实体查、查不到再按切片查，
  返回 `{ id, origin, kind, text, sourceDocId } | null`；文本复用 `evidenceTextOf`（§2.1，不新写第二套取文本逻辑）。
- 相应进 `RENDERER_ALLOWLIST` 的是 `kb.gap.report` 与 `kb.profile.evidenceBody` **两条**，
  每条都要在 `BridgeSignatures` 补签名（`BridgeSignaturesCovered` 那个编译期引信会强制），
  返回值形状在 `shared` 侧要写**镜像类型**（L1 不许 import L2 的包，沿用 `KbSearchRowResult` 的既有做法）。
- 跳转交互：点行内证据 → 该行下方**内联展开**原文（同 `KbPanel` 的 `data-kb-evidence` 既有形状），
  不做路由跳转、不弹新窗（§8.1 的窗口策略 + 桌面 app 里"离开再回来"比"就地展开"贵）。

**判据四：模型腿五态在界面上是五句文案，不是一句"降级了"**

- `GapModelStatus` 五值 → 五个 i18n key，用 `Record<GapModelStatus, string>` 接（4.3-c 的
  `KIND_LABEL_KEY` 同法：漏一个键就是编译错误，不靠人记）。
- `merged` 那句要说"补了几条"（`modelAdded`），`rejected` 那句要说"采了 0 条"（`modelDropped`），
  `unavailable` 那句要说**缺什么**（`modelReason` 已由服务侧写好，界面不再拼句子）。
  这条是 4.4-02 的 V 半边：判据不是"有句提示"，而是"五种结局各不相同且都读得出原因"。
- `KB_LIBRARY_MISSING` 是**另一种**空态：库缺席时报告根本没产出，界面给"先去导入简历"的引导，
  而不是给一份全缺失的报告（与服务的处置一致，错误经 `useBridgeAction` 的 `onError` 落一句 i18n 文案）。

**判据五：五个 suggestion key 的双语文案在本片补齐，机检点已就位**

- `add_evidence / strengthen_evidence / years_gap / education_gap / education_missing`
  进 `shell.gap.suggestion.*`，zh-CN 与 en **同时**补。
- 强制力来自 `scripts/check-renderer-conventions.ts`：键在两个语言包间对齐（:55-72）+
  代码里引用的键必须存在、`{{占位符}}` 必须有实参（:74-111）。所以"只补一边"不是风格问题，是 `pnpm lint` 红。
- `params` 的形状由服务给死（4.4-c 第【1】节的表），界面只填插值，不追加字段。

**判据六：工具面与界面共用同一个 `report()`**（§5.9，与 4.3-c 裁定三同一件事）

- `KbGapService` 补 `[Service.init]`，经 `core` 的 `registerAgentTools` 登记 `kb.gap.report`，
  `effect: 'read'`、`requiresConfirmation: false`（只读本地库与一段文本，不碰外发——§7.3 的闸门只管
  打招呼/发简历这类外发动作，本地计算不经它、也不误扣额度，正是 4.4-09 要的那条）。
- 入参 zod 形状与 `report()` 的实参一致（`jdText` 必填，`filter`、`nowMs` 可选）。
  **`nowMs` 不进工具入参**：agent 说"截至这个月"是唯一合理语义，把它暴露给模型只会诱发编造时间戳；
  服务侧的默认值就是 `Date.now()`，而 `report()` 内部仍按 `monthIndexOf(nowMs)` 显式夹取（4.4-c 判据二）。
- `ChatPanel.tsx` 的 `TOOL_LABEL_KEY` 加一条 → `agent.tool.labels.kbGapReport`（双语）。
  工具 `description` 是给模型读的中文串（沿用现状），与界面文案是两条面，不共用键。
- `cordis.yml` 的 `kb-gap` **不加 `dependsOn: [kb-profile]`**：报告拿库是软取后抛 `KB_LIBRARY_MISSING`，
  加了硬依赖会让摘掉 `kb-profile` 时 `kb-gap` 整体降 PENDING——界面于是显示"服务没起来"，
  而不是本片要的"库里还没东西，去导入"。装配顺序上 `kb-profile`（:343）本就排在 `kb-gap`（:383）之前，
  正常运行不依赖这个字段。

**V 判据的证据形状**（§7.1：必须是亲眼看到页面，不是单测）

- 面板根节点 `data-testid="gap-panel"`；三栏分别 `data-gap-column="matched|partial|missing"`；
  证据展开体 `data-gap-evidence="<id>"`；腿状态条 `data-gap-model="<status>"`；库缺席空态 `data-gap-library-missing`。
  有 `data-*` 钩子是因为 harness 的 `assert` / `dom` 靠属性定位，而 `shot --reveal` 只吃 CSS 选择器。
- 计划出四张图（`harness shot --url 5173` → `archive --id 4.4-05`）：
  ① zh 三态分栏全貌 ② 证据内联展开（实体一条 + 学历切片一条，证明两个 origin 都能跳）
  ③ en 同页 ④ 腿状态/库缺席空态。命令原文与退出码进 `docs/acceptance/4.4/4.4-05-*` 与
  DOM 断言文本，图只走 §7.5 的验收路径。
- 跑真界面要先起 app：`AUTO_CC_USER_DATA_DIR="$PWD/tmp/dev-userdata" pnpm dev`（§9 的实测：
  装机版在跑时 `pnpm dev` 会静默退出 0、CDP 端口根本不监听），CDP 用 10222，不用 9222。

**本片不做的事**：不做报告导出、不做阈值调参界面、不做"从 jobs 表某条 JD 打开报告"、
不接 `entitlement.gate` 的扣额度（4.4-09 归 4.4-e）、不落新表（号段 15 继续空着）。

## 4.4-d 落地记录（2026-10-02，缺口报告界面 + agent 工具面）

判据细节、真机 DOM 断言、四闸输出见 spec「4.4-d 落地记录」与
`docs/acceptance/4.4/4.4-05-ui-and-tool-surface.txt` + 五张 `4.4-05-*.png`。这里只记**定稿与落地的差异**
和三处后来者会踩的现场事实。

- **亮点区没有做成"右侧第四栏"**（定稿判据二的偏离）：落地是**三栏下方独立一节**
  （`gap.highlights` + 每条 `entityId · 种类 · score · 相关词`）。理由是三栏已经占满 `grid-cols-3`，
  再切一份宽度会让每栏的 JD 引文与证据行频繁折行；而亮点判的是"库内有、JD 没提"，
  与三栏的"JD 要什么、我有没有"是**两个方向**，塞进同一排视觉上就成一栏状态了。
  `highlightsDropped > 0` 仍显式给"另有 N 条未展开"，截断可见这条没打折。
- **四张图变五张**：定稿的④把"腿状态"与"库缺席空态"写在一张里，落地拆成两张——
  两者是**互斥的页面状态**（库没装配时连报告都没有，同一张图拍不出两件事），
  合拍只会得到一张空态图 + 一句"另外腿也关着"的口头说明。
- **现场语料要经真实入口灌，且 docId 是内容哈希**：`resume.parse.fromFile` 得到
  `docId = resume-<sha256(正文).slice(0,12)>`，所以**改一次 demo 简历再同步 = 库里两份文档**
  （实体 id 内嵌 docId，旧 doc 的行 `remove()` 抛 `KB_ENTITY_DERIVED`，也没有 doc 级删除口），
  10 条变 20 条、摘要行就开始说谎。正确做法：停 app → 用 `node:sqlite` 清空 `tmp/dev-userdata/store.db`
  的 `kb_*` / `resume_*` 表（FTS 影子表 `*_fts_*` 不能 DELETE，跳过）→ 起 app → 只同步一次。
  脚本留在 `tmp/wipe-kb.mjs` / `tmp/seed-gap-kb.js`（tmp 不入库，§7.5）。
  为了让学历那条 `section_chunk` 证据可达，demo 简历的教育段加了「本科」二字——
  `libraryEducationOf` 只认 `EDUCATION_TIERS` 别名，没有别名就没有档位，也就没有那条跳转。
- **`window.autoCC` 的命名空间按第一个点切**（`packages/preload/src/index.ts`）：
  `agent.tools.list` 在页面上是 `b.agent['tools.list']()`，**不是** `b.agent.tools.list()`。
  探针按后者写会得到 `Cannot read properties of undefined (reading 'list')`，
  看起来像"agent 工具面没接线"，其实是取错了键。同理 `kb.gap.report` → `b.kb['gap.report']`。
  另外 `agent.tools.call` 的返回是**两层**：外层 `BridgeReply{ok,value}`，内层才是协议内的
  `ToolCallReply{ok,code|value}`——工具失败不抛异常，所以探针要读 `reply.value.code` 才看得到
  `TOOL_INPUT_INVALID`。
- **`nowMs` 拒收是实测出来的**：工具入参用 `z.strictObject`，真机传 `{jdText, nowMs: 1}` 得
  `TOOL_INPUT_INVALID`（不是"被忽略"）。这条边界只有 strict 才守得住，写成 `z.object` 就会静默收下
  一个模型编出来的时间基准。
- **下一片**：4.4-e（额度/合规收口 + 阈值标定）。它要接 `4.4-09`（LLM 计入额度时必经 `entitlement.gate`，
  本地调用不误扣），并把五个阈值（`evidenceHitMinScore` / `evidencePartialMinScore` / `yearsPartialRatio` /
  `highlightMinScore` / `maxHighlights`）从"未标定"推到"有依据"——界面上那句
  「各阈值当前未标定，可在 cordis.yml 的 kb-gap 段调整」在标定完成时要跟着改。
  `4.4-02` 的 `[!]` 也在那一片收口（要一个真能用的模型网关才能拍到 `merged` / `rejected` / `failed`）。

## 4.4-e 设计定稿（2026-10-02，写代码之前把额度判定、机检射程与标定方法钉死）

本片收 `4.4-09` 与 `4.4-08` 的机检半边，并把五个阈值从"拍的"推到"有依据"，最后逐项复跑 4.4-01～10。
它**不是**一片"加功能"的切片：最大的风险是把一条本来不该接的线接上（额度），和把一次没有对照的
读数说成标定（阈值）。三片按依赖走，一次一片：

| 子片   | 内容                                                                  | 交付面                            |
| ------ | --------------------------------------------------------------------- | --------------------------------- |
| 4.4-e1 | 额度接线判定（4.4-09 的三条断言）+ §7.2 的测试面/运行面机检           | 测试 + 两个既有脚本/包，无新表    |
| 4.4-e2 | 三个测量型阈值的标注集与扫描、两个口径值的书面依据、界面文案与复拍    | `gap-calibration*` + `cordis.yml` |
| 4.4-e3 | 4.4-01～10 逐项复跑、四闸、证据归档，`4.4-02` 的 `[!]` 按实测状态收口 | `docs/acceptance/4.4/4.4-e-*.txt` |

**4.4-e1 已落地（2026-10-02）**，本节判据按原文兑现为可执行断言，落点：

- 判定一（额度接线）→ `packages/main/src/gap-quota-link.test.ts`（四条：耗尽挡不住报告、两条腿都不落账、
  正向对照证明落账口是活的、`unlimited` 语义），模型腿的结构面 → `packages/llm/src/quota-boundary.test.ts`。
- 判定二（§7.2 机检）→ 字符串面是 `scripts/check-compliance-redlines.ts` 的规则三（含两条白名单与反向探针），
  运行面是 `packages/testing/src/cdp.ts` 的 `localTestUrlViolation` + `CdpSession.navigate` 守卫，
  用例在 `packages/testing/src/cdp.test.ts`。
- 证据与逐项验收：`docs/acceptance/4.4/4.4-09-quota-and-allowlist.txt`、spec 的 4.4-09 与「4.4-e1 落地记录」，
  AGENTS.md §10 的 §7.2 行已从"待落地 1.6"改为"已落地（4.4-e）"。

**4.4-e2 已落地（2026-10-02）**，本节判据三按原文兑现，落点与偏离：

- 三个文件一份脚本，一次抽公共不留两份：`gap-calibration-corpus.ts`（29 + 13 条标注，每条带人判理由）、
  `gap-calibration.ts`（`sweepTextThresholds` / `sweepHighlightThreshold` / `evaluate*`，只调 `coverageOf`，
  不重新实现任何打分）、`gap-calibration.test.ts`（13 例回归锁）、包脚本 `pnpm --filter @auto-cc/plugin-resume-kb calibrate`。
  测试与脚本共用同一只手，所以"脚本绿了而用例跑的是另一把尺子"这种失效不可能出现。
- **定稿没说清、落地时补的一条**：判据三只写了"取类间间隔最大"，没写**并列怎么破**。第一版按错分数 +
  单一 margin 破并列，16 组并列被网格顺序判成了贴着样本的 `hit=0.51`——正是判据三禁止的那个方向。
  落地把第三判据定成"余量剖面逐位比"（`pickBestIndex`），选型才落到带中点 0.58。
- 标定值 `0.33 / 0.58 / 0.11` 与两条口径值的依据、翻脸与盲区清单、界面文案与两张复拍图，
  全部记在 spec「4.4-e2 落地记录」与 `docs/acceptance/4.4/4.4-e-threshold-calibration.txt`。
  顺带修掉的两处（schema 缺 `.refine` 而注释声称有、两份测试各自手抄出厂阈值）也记在那条里。

**4.4-e3 已落地（2026-10-02），4.4 切片到此收口**：

- 复跑分三层（用例 / 机检 / 页面），逐项读数与命令见 `docs/acceptance/4.4/4.4-e3-recheck.txt`、
  状态位判定见 spec「4.4-e3 落地记录」。九条 `[x]`，**`4.4-02` 保持 `[!]`**：
  缺的只是 `merged` / `rejected` / `failed` 三态的界面播报截图，要一次经授权的真对话网关；
  机制侧五态用例已钉死。不为凑绿改状态位。
- 判据四（"`4.4-02` 的 `[!]` 只有真网关能收"）按原文兑现：本片**没有**用推测写 `[x]`，
  也没有为了让页面出现 `merged` 去伪造腿状态。
- 下一片按计划树进 4.5（定向内容生成 + 强制事实校验闭环）。挂在 4.4 名下的欠账如实随片带走：
  真网关三态截图、4.3-d 的 `k1/b` 与 `k` 权重、阈值的上线后复标。

**判据一：`entitlement.gate` 管的是"平台侧代价"，本地计算今天不进 ledger**（4.4-09 的判定）

- `QUOTA_ACTIONS` 现在的三条（`shared/bridge.ts:324`）有一个共同属性：**在真实平台上留下痕迹**，
  日上限存在的理由是 §8.3 的风控与封号风险，不是计费。闸门自己的头注释也写着"所有外发与抓取动作的
  唯一必经口"。模型调用没有这个属性——它不碰平台、不给站点增加任何请求。
- 所以**不**给 `kb.gap` 接 `gate.perform`，尤其不许复用 `search` 那一键。复用的后果是可指出的：
  拆 20 份 JD 就吃掉 20 轮抓取额度，这与 2.7-03 刚判过的"抓 40 轮不该吃掉打招呼的额度"是同一条论证，
  只不过这次是拿它反着破坏自己。
- 但 4.4-09 的验收操作是"断言 ledger 行为符合配置"，所以这条判定必须落成三条**断言**，不是落成一段话：
  1. **额度耗尽挡不住报告**：`mode:'daily'` + 三键上限都取 1 + 当天先落 1 条 `search` 账（=额度见底），
     在此装配下 `report()` 仍然产出完整报告。这是"本地计算不经闸门"的正向证明，
     比断言"没调 perform"强——它会随着接线变化自动失效。
  2. **两条腿都不落账**：词面腿（`allowModelLeg:false`）与模型腿（`llm.chat` 打存根、正常回复）
     各跑一次，`usage_ledger` 行数在前后相等。这一条同时兑现"若计入额度"尚未成立（今天 0 扣）
     与"本地调用不误扣额度"两半。
  3. **报告不需要闸门也能装起来**：测试装配里**根本没有** `entitlement.*` / `usage.*` 服务，
     `kb.gap` 依然挂载并跑通——把 4.4-08 已经用过的"结构性成立"论证从注释升级成一条用例。
- **将来真要计费时的落点先定死在本节**（写下来，本片不实现）：
  ① 给 `QuotaAction` 加**第四键** `llm`，而不是复用现有三键。三处联动是既有的：`shared` 的枚举、
  `gate.ts` 的 `dailyLimitsSchema`（`strictObject`，少一键就 `INVALID_ARGUMENT`）、
  账本无需迁移（`action TEXT`，索引在 `(action, ts)` 上）。`UsagePanel` 是
  `QUOTA_ACTIONS.map(...)`，加了键界面自然多一行，不用改代码就能显示。
  ② 落账点在 **`packages/llm` 的 `chat()` / `embed()` 那一个出口**，不在各调用方。
  理由是 §2.5 与已有机检：LLM 入口唯一性由 `check-llm-single-entry.ts` 守着，
  所以"一个点包全部模型调用"在结构上成立；放进 `kb.gap` 就等于 4.5 的生成、2.5 的话术各写一份 perform。
  ③ 语义用 `perform` 不用 `check` + 自己发（1.9-05 的立足点）。`perform` 在 `task` 成功后才落账
  （plan §8.4 决策 1），对模型同样正确：网关 5xx 不该扣用户的额度。

**判据二：§7.2 的机检做成两半，各自落在它唯一能守住的面上，不新建第三个脚本**

- **字符串面（进 `pnpm lint`）**：扩展 `scripts/check-compliance-redlines.ts` 为**规则三**，
  射程只限**测试与脚本面**（`**/*.test.ts`、`**/test-doubles.ts`、`packages/testing/**`、`scripts/**`）——
  app 的本业就是驱动真实站点，生产代码不在这一条的射程内，写进去就会把项目该做的事判成违规。
  通过条件三选一：① loopback（`127.0.0.1` / `localhost` / `[::1]`）；② RFC 保留名
  （`.invalid` / `.test` / `.example` / `.localhost`，本仓的模型与 fixture 假地址已经在用）；
  ③ 显式登记在脚本内的 `TEST_REAL_HOST_ALLOWLIST`（host + 一句"这里为什么可以出现真实域名"）。
  登记表的形状沿用同文件已有的 `PARTITION_ALLOWED` / `PACING_ALLOWLIST`（§2.2/§2.3：扩现有模块，不新造）。
- 先量再判：现状里真实平台域名只应出现在"期望被拒绝"的负例（`navigate-policy.test.ts`、
  `platform-registry.test.ts`、`platform-boss/*.test.ts`、`sessions/consent-store.test.ts`、
  `workflow/runner.test.ts`）与 `packages/llm` 的模型域名（由 `check-llm-single-entry.ts` 独占管辖）。
  **登记表逐条列名与理由**，列不进的就是违例——这一步会把"我以为测试没打真站点"变成读数。
- **运行面（harness 配置，AGENTS.md §10 里 §7.2 的那另一半）**：`CdpSession.navigate(url)`
  （`packages/testing/src/cdp.ts:362`）是自测通道唯一能把页面开去任意地址的口。给它加 loopback 守卫：
  host 非 `127.0.0.1` / `localhost` / `[::1]` 时结构化拒绝，并配一条单测。
  `listTargets` 已经写死 `http://127.0.0.1:port`（:105），所以端口面本来就没有远程通道，
  缺的正是这一句 navigate 的判定——补上之后"agent 自己驱动页面"这条链在任何一次误操作下都到不了真实站点。
- **明确不做**：不在 vitest 全局 setup 里把 `globalThis.fetch` 换成会抛的存根。看着最像"全面防线"，
  实际只覆盖可写通道的一支（Node 内置 `http/https/net` 的 ESM 命名空间只读，4.2-07 实测），
  而且要给 21 个包各加一份 `setupFiles` 配置。本项目对"全本地"的既有口径是
  **结构面 import 断言 + 每条链路自带计数存根**（4.2-07 / 1.9-09 / `bench:kb` 三处已是先例），
  本片沿用并把它延伸到 `kb.gap` 这条新链路（`profile-service.test.ts:1818` 的包级源码扫描
  已经覆盖 `gap-service.ts`，所以只需补运行面的那一次调用）。

**判据三：五个阈值分两类，只有三条需要标注集；标定必须有方法，不能是"看着像对了"**

- **测量型（需要标注）**：`evidenceHitMinScore`、`evidencePartialMinScore`、`highlightMinScore`——
  三条都读同一把 `coverageOf` 的 token 覆盖率。
- **口径型（不需要标注，需要写明依据）**：`yearsPartialRatio` 是"干满几成算部分命中"的产品判断
  （年限走的是月区间算术，与文本阈值无关，4.4-c 判据一）；`maxHighlights` 是界面容量（4.4-05 分栏一屏）。
  把这两条也拉进"标定"，等于给一个产品决策套上数据的外衣。
- **标注集形状**：`(要求文本, 库内实体文本, 人判三态)` 若干条 + `(库内实体文本, JD 全文, 人判是否算相关亮点)`。
  判的是**尺子**，所以直接喂 `coverageOf`，**不经过 `report()`**——否则读数翻脸时分不清是拆解错还是尺子错。
- **选值方法**：在 0~1 网格上扫满足 `partial ≤ hit` 的可行带，取**类间间隔最大**的那条，
  不取"错分最少"的那条。样本小的时候错分率会奖励贴着某一条样本走，换一份 JD 就翻。
- **反循环约束（本片最容易自己骗自己的地方）**：标注由我一人给，词面腿的 61 组代表词也是我写的，
  所以语料必须**故意收边界样本**——每类至少 1~2 对"人判 X、朴素 token 覆盖会判成 Y"的条目
  （例：「熟悉 MQ」对「用过 Kafka / RocketMQ」算命中还是部分；「大型分布式系统经验」对
  「订单服务重构」这种库内短句）。标定产出里要**列出在选定阈值下仍然翻脸的那几条**，
  而不是宣称全部对上；一条都不剩的标定等于没标。
- **冲突处理方向**：阈值与标注不一致时，先怀疑标注（改标注要在语料里留一句 reason），
  **不许**为了让某条对上把阈值推到贴着它——那是"拿实现迁就测试"的镜像版本，
  与 4.4-c 那次"改用例不改实现"是同一条纪律的两个方向（那次是断言写错了，这次是要素贴边）。
- **落地形状（一次抽公共，不留两份）**：`gap-calibration-corpus.ts`（纯数据 + 每条人判理由）、
  `gap-calibration.ts`（`sweepThresholds(corpus)` 与 `evaluate(corpus, thresholds)`，测试与脚本共用，
  本文件**不重新实现任何打分**，只调 `coverageOf`）、`gap-calibration.test.ts`（回归锁：
  出厂默认值必须复现全部标注 + 扫描间隔断言）、包脚本 `pnpm --filter @auto-cc/plugin-resume-kb calibrate`
  （打印网格与选型表，输出进 `docs/acceptance/4.4/4.4-e-threshold-calibration.txt`）。
- **界面上的话要跟着读数改**：`gap` 面板那句「各阈值当前未标定」换成
  「三条文本阈值按本地 N 条标注初标定（日期）· 年限比例与亮点条数为产品口径」——
  仍走 i18n、双语同补（§5.5/§5.6），并**重拍一张缺口面板图**，
  否则 `docs/acceptance/4.4/4.4-05-*.png` 与代码不符（V 类证据必须对应现状）。
- **本片做不到的，如实写**：标注集是本地样例，不是真实用户库；单标注人 ≠ 群体判断；
  上线后的复标动作留在 4.4-e 落地记录的"下一片"里。同理，4.3-d 的 `k1/b`、`k` 权重仍需真
  embedding key + 评测集，不在本片范围（同一诚实边界）。

**判据四：`4.4-02` 的 `[!]` 只有真网关能收，不为凑绿用推测写 `[x]`**

- 已拍到 `disabled`（配置关腿）与 `unavailable`（`llm.chat` 未装配）两态的界面文案（4.4-d 两张图）。
  剩 `merged` / `rejected` / `failed` 三态**必须真打模型端点**才拍得到。
- 收口动作是可执行的：用真 key（用户此前为 4.3-d 提供过硅基流动 bge-m3）在 dev app 上跑一次真拆解 →
  `merged`；把 model 名改成一个不存在的值 → 4xx → `failed`；让 prompt/温度产出非契约 JSON 不可控，
  所以 `rejected` 只在真网关确实给出不合契约的回答时才算拍到，**拍不到就继续留 `[!]`**。
- 这一条含**用户授权**：真打外部模型服务要花钱、且 key 不入仓库（§8.6）。所以它排在 e1/e2 之后，
  并且到那一步再单独征求，不静默进行（§7.2 只禁真实招聘平台，模型网关不属禁区，但花的是用户的钱）。

**本片不做的事**：不给 `kb.gap` 接 `gate.perform`（判据一）、不建第三类合规脚本（判据二）、
不做阈值调参界面、不把报告落库（号段 15 继续空着）、不做 4.5 的相关性重排。

---

## 4.5 选型与证据（2026-10-02，写代码之前的四条一手取证）

取证通道先记一条环境事实：`git clone` 本仓库两次都在 `curl 56 Recv failure: Connection was reset` 上失败
（AGENTS.md §9 已记"直连与 clone 不稳定"，第一次尝试还留下一个只有 `.git` 的破损目录，已删）。
最终用 GitHub Contents API 逐文件取回**原文 `.ts`**，落 `tmp/ai-resume-src/`（gitignored，§6.4/§7.5：
结论进文档，副本不进主干）。本节引的每行都是源码原文，不是 `docs/research/source-repos-analysis.md` 的转述
（§6.2——那份转述这次自己也偏了：它写的是 `server/src/keywordService.ts`，实际路径带 `services/`）。

**取证一：源仓库的 `factCheckService` 不能照搬——它的容差正是编造的入口**

- 原文 `server/src/services/factCheckService.ts:34-76`：`normalizeString` 取小写并只留 `[一-龥a-z0-9]`，
  然后 `levenshteinDistance(...) > MAX_EDIT_DISTANCE`（`:53` 定为 **3**）才算一条 diff。
- 可指出的失效（不是理论风险，是能写进用例的输入）：**「字节跳动」与「字节科技」归一化后编辑距离 = 2**，
  在源实现里判为"公司名一致"。中文法人名的区分度就是两三个字，3 个字符的容差等于对"公司"不设防——
  这与 §8.4 的事实锁定红线直接冲突。**整条 levenshtein 路线否决，事实比对只用全等。**
- 第二条失效：比对按**下标配对**（`genExps[i]` vs `baseExps[i]`，`:59-62`），而 4.5-02 要求的正是"按 JD
  相关性重排条目顺序"。重排一次下标全部错位，表现为相邻两段互判篡改、真篡改反而漏判。
  本项目的对齐键是 id（`sectionId / entryId / fieldKey`），重排对它不可见。
- 第三条失效：只查 company / title / date 三项；`responsibilities`（真正会被"润色"的散文）不看，
  数字、学历、证书号没有对应字段 → 4.5-03 / 08 在它上面落空。
- 本项目已有的确定性实现（§2.1 按能力搜到了）：`packages/resume-doc/src/schema.ts:168 checkFactLock`——
  3.1-03 的判据是"同一区块、同一 id 条目、同一 key、`locked` 且值不同即违规"，**新增条目/字段不算违规**。
  所以 `fact.check` 是**扩展它**，不是另写一份比对（§2.3 扩展现有模块接口 > 新建平行模块；§2.5 一处真相源）。

**取证二：源仓库的"闭环"缺的正是 4.5-05 那一道闸**

- `server/src/services/generateService.ts:33-39`：第一次 `factCheck` → 有问题就带 `RETRY_APPEND` 重试一次 →
  **然后不再判第二次结果**，直接 `renderMarkdown(generatedJson)` 并把产物与报告一起落库。
  也就是"知道它篡改了，照样出简历"。这不是实现没写完，而是把报告当日志而非闸门——语义上就没有闭环。
- 可取的一半：`RETRY_APPEND`（`server/src/prompts/resumeGenerate.ts:22`）点名"你上一次改了公司名/职位名/时间"。
  本项目强一档：重试提示里附**机器可读的被拒清单**（`sectionId/entryId/fieldKey` + 违规类型），不靠模型回忆自己错在哪。
- 所以 4.5-05 的落地判据是"重试后仍不过 → **无产物**"，并且必须有一条断言钉住它，否则 4.5 抄来的还是假闭环。

**取证三：源 prompt 用自然语言约束"事实/改写"边界，本项目把这条边界挪进数据结构**

- `resumeGenerate.ts:4-16` 六条规则里"禁止修改公司名称、职位名称、起止时间"是一句话，
  同时要求输出结构与输入完全一致——约束全靠模型自觉，校验只能在后面追赶。
- 本项目有两个更强的现成落点：`Field.locked` + `factKeyOf`（`resume-doc/src/model.ts:152`，四类
  `company|role|period|achievement`）把"哪些字段承载事实"写进数据；`documentSchema` 是 `z.strictObject`
  （`schema.ts:61`），**多一个键即非法**。由此 4.5 的改写面不是一段 prompt，而是一个可判的集合：
  - **可改写面 = 散文键 `{text, achievement, description}`**（2026-10-02 裁定 A 的口径，本节此前写的是
    "只有 `key === 'text'`"，已被推翻并就地更正——留旧文不改会让后来者按不存在的白名单读代码）。
    当前字段词表全量是 `company / role / period / achievement / school / degree / major / text`
    （见 `resume-kb/src/sections.ts:203-242` 与 `resume-doc/src/export-service.ts:119-159`；`text` 装的是
    summary / skills / 区块正文这类散文，`description` 是解析层给经历正文用的键）。
  - **为什么不把 `achievement` 排除掉**：它是 3.1 的 locked 事实，按旧口径"整句原样引用"看似最严，实际把
    4.5-02 / 4.5 的全部价值拦在门外——会被 JD 重排与润色的句子恰恰是「主导订单服务重构，P99 延迟下降 40%」
    这一类。改成"允许改写、但受两条确定性判据约束"：**数字多重集守恒**（那个 40 必须还在，既不许润色成
    「大幅」也不许凭空多出一个 12）+ **具名机构词面回查**（不许出现库里没有的组织名）。
  - **`company / role / period / school / degree / major` 一律原样引用**：前三个由 locked 全等拦，
    后三个不在 locked 表里，靠"可改写键白名单"反向拦。不给 3.1 的 `FactKey` 加枚举这条不变——加枚举会连带
    `documentSchema`、`contentHash`/快照、模板、diff 全动，而 3.1-03 的判据写死是四类事实；为当前没有消费者的
    语义去改模型，与 4.1-08 头像那条是同一条论证（不给不存在的消费者做建模）。
  - 4.5-08 因此检的是**白名单内文本的数字多重集守恒**（原文每个数字都还在、且不出现新数字），
    技能行不进**提议面**（不给模型改 skill 行的通道）但仍在**校验面**里：产物与基线整份比，
    谁动了没被提议的键都会撞上 `editable-allowlist`。
  - 「主导 → 参与」这类不带数字的弱化，确定性判据抓不到（词面与数值都守恒）。这是裁定 A 明确接受的残余，
    兜底面是 4.5-11 的逐项人工接受——界面必须把原文与改写文并排给出，人才判得动这一类。
  - 落地形状：`checkFactLock(original, proposed, editableKeys?)` 加**一个可选参数**，缺省行为与现在逐字相同
    （既有 3.1 用例一条不动），`fact.check` 传 `['text', 'achievement', 'description']`。一处实现，两个口径，
    不留第二份比对。

**取证四：模型腿不需要新接口，状态与取用方式都是现成的**

- `llm.chat` 已有 `status()`（纯本地判定、不发请求）与 `complete()` 的 `LLM_UNAVAILABLE` /
  `LLM_REQUEST_FAILED` 两档异常（`packages/llm/src/index.ts:72-140`），4.4-b 又把"哪五种结局 + 为什么没用上模型"
  的播报口径钉死在 `GAP_MODEL_STATUSES`（`resume-kb/src/gap-service.ts:73`）。4.5 复用同一套状态字面量，
  不新造第二套"生成腿状态"。
- 取用方式沿用 §9 实测（2.5）的教训：**用的时候按名字现问**（`asApp(this.ctx)['llm.chat']`），
  不在本地存第二份事实；`resume-kb` 的 `package.json` 也不因此新增 `@auto-cc/plugin-llm` 依赖。
- prompt 版本沿用 `REQUIREMENT_PROMPT_VERSION = 'jdreq-v1'`（`resume-kb/src/requirements-model.ts:33`）的形状，
  新增 `resume-generate-v1` 常量 + 一个模块装一个 prompt。4.6-09 要的"集中注册"此刻就是"别在 service 里散写
  字面量"，不必先建注册表框架（§2.6 不为假想的未来做抽象）。

## 4.5 切片分解（2026-10-02，按依赖顺序，一次只推一片）

| 切片  | 内容（判据来源）                                                                                                                                                      | 覆盖的 spec 条目                       | 新增面                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| 4.5-a | `fact.check` 纯函数：可改写白名单 + 数字多重集守恒 + 具名候选回查 + PII 哨兵<br>**（已落地 2026-10-02，代码半边；spec 五行仍 `[ ]`，判据见 spec「4.5-a 落地记录」）** | 4.5-03 / 04 / 07 / 08 / 14（代码半边） | **零新表、零 LLM、零界面**，只在 `resume-doc` 扩参数 + `resume-kb` 新文件 |
| 4.5-b | `resume.generate` service：确定性重排 + 模型腿改写 + 重试一次 + 拒绝产出 + 生成记录表（号段 15）+ agent 工具 + IPC 白名单                                             | 4.5-01 / 02 / 05 / 06 / 09 / 10 / 12   | 1 张表、1 个 service、prompt 模块                                         |
| 4.5-c | 生成结果预览界面：逐项接受/回退、重排依据展示、保守版播报（i18n 双语 + harness 真页面截图）                                                                           | 4.5-02(V) / 09(V) / 11 / 05(V)         | 渲染层一个面板                                                            |
| 4.5-d | M5 判据的 P4 半边全链路：指定 JD → 生成内容 → 经 3.3 的公开入口出 PDF → 文本层断言 + 截图                                                                             | 4.5-13 / 4.5-01(全链)                  | 无新实现，只做接线与取证                                                  |
| 4.5-e | 4.5-01～14 逐项复跑、四闸、证据归档，状态位如实收口                                                                                                                   | 全部                                   | `docs/acceptance/4.5/`                                                    |

**判据一：重排由确定性代码算，顺序不进模型（4.5-02）**

- 让模型"顺便返回新顺序"会同时毁掉两件事：同一输入两次读数不一致（4.4-07 已判过这条），
  以及"重排依据可解释"变成模型的一句自述。界面要显示的是"这段被提前，因为它命中 JD 的 Kubernetes / 高并发"，
  这种依据只能来自代码手里的那份读数。
- 现成的读数就在 4.4 的输出里：`GapRequirementView.evidence` 带 `entityId` 与强度，`bestScore` 是
  最强那条证据的强度（`requirements-compare.ts:72-100`）。于是条目的相关性分 =
  **它作为证据在报告里出现过的最大强度**，缺失项不影响它；平分时的次序**保持基线原序**（稳定排序，
  不做二次猜测）。区块顺序 = 按"该区块内最高分"降序，无高分的区块留在后段。
- 4.5-02 的"引用命中项"由此可给：重排依据就是那条 `RequirementItem` 的文本与它命中的 token，
  界面直接引用报告行，不需要新造一份数据。

**判据二：`evidenceRefs` 不进文档模型（4.5-06 / 10 / 12 必须一起成立，否则自相矛盾）**

- `documentSchema` 是 `strictObject`：往文档里塞 `evidenceRefs` 的那一刻，4.5-01（Schema 零错误）与
  4.5-12（不存在私有约定字段）就同时破了。所以 `resume.generate` 的返回体是
  `{ document, evidence: [...], checks, receipt }`——**引用与文档并排，不嵌进文档**。
- 并排的这一份要有自己的落点，否则刷新即失、4.5-06 的"能反查到"只剩一次进程寿命。新表
  `resume_generations` 取空号 **15**（现用号段 1–14，见 `profile-service.ts:66` 的那张号段注释），
  存 `id / docId / jdId / promptVersion / model / createdAt / status / evidence_json / violations_json`，
  **不存文档正文**（判据三）。反查方向：`evidence_json` 里的 id 交给界面另问 `kb.profile.evidenceBody`
  （4.4-d 已定的口径——正文不进生成记录，个人信息最小化，§8.5）。
- 4.5-12 的验证落成两条断言：P3 与 P4 对**同一个 JSON** 各自 `validateDocument` 都 ok，
  且 `Object.keys(document)` 的集合与 `documentSchema` 的键集完全相等（用 strict 校验反向证明没有私有键）。

**判据三：拒绝产出不等于丢历史（4.5-05 / 10 / 11 三条的交汇点）**

- 二次校验仍不过 → `status:'rejected'` + 违规明细（字段路径级）+ **无产物**：界面拿不到可接受的文档，
  工作副本一次 `save` 都不发生。这条与源实现（取证二）正好相反，是本片对"强制闭环"的全部兑现。
- 但记录行**照落**，否则 4.5-10 的"可复盘"只覆盖成功的一半，而失败恰恰是最需要复盘的那一半。
  记录里只放字段路径、违规类型与前后值长度的读数，不放 `before/after` 原文——公司名不是 §8.5 那三类，
  但把被拒内容整段留在库里会诱导"绕过闸门自己捞出来用"。
- 写入工作副本只经 `resume.doc.save`（`parse-service.ts:126-128` 已立过这条：本包不写裸 SQL 进 `resume_docs`）。
  快照不在本片代劳：3.7 的快照由用户既有动作产生，生成轨没有理由替用户按一次"保存版本"。

**判据四：模型腿不可用走"仅重排"保守版，且不冒充个性化（4.5-09）**

- 保守版 = 确定性重排 + **所有字段照抄**，因此它必然通过 `fact.check`（没动任何东西），
  这让 4.5-09 的断言变成"产物合法 + `modelStatus` 播报 + 界面写明未改写"，而不是"没产物"。
  功能不降级为不可用，但降级必须可见——与 4.6-06「模板话术标识『模板』」是同一条口径。
- 播报复用 4.4 的五态与 `modelReason`，界面上那句"没用上模型"的文案形状已在 `gap` 面板立过，
  生成面板照此补齐，双语同补（§5.5/§5.6）。

**判据五：生成动作不接额度闸门（把 4.4-e1 判据一的论证用第二次）**

- `QUOTA_ACTIONS` 的三条（`shared/src/bridge.ts:324`）共同属性是"在真实平台上留下痕迹"。
  生成内容既不发请求给站点也不花钱（模型腿未配置时纯本地），给它接 `gate.perform` 会造出
  "改 20 次简历吃掉 20 轮抓取额度"这种新坏结果。所以 `resume.generate` **不**接闸门，
  `resume-doc` / `resume-kb` 也不 import `entitlement`（§4.1 依赖方向）。
- 4.6-08 那条写的是"若配置为付费项"——真付费网关那天要不要第四个动作键，由那时的 spec 判定，
  现在预接就是给假想的未来做抽象（§2.6）。`packages/llm/src/quota-boundary.test.ts` 已经是销针：
  真接的那天它会红。

**判据六：4.5-07 的强保证在结构面，不在比对面**

- 模型腿的输出形状是**逐条目的散文改写**（落地为 `{ entries: [{ sectionId, entryId, fieldKey, text }] }`，
  比原设想多带 `sectionId / fieldKey`：一个可改写字段要三键才定位得了，而 `applyRewrites` 与
  `checkFactLock` 都是按这三键对齐的——少一个就得在服务里再查一遍文档结构才能装回去），
  它没有"新增条目 / 新增区块 / 改字段键"的通道。库外公司名、编造的一段经历在数据结构上**表达不出来**——比"表达得出来再被比对抓住"强一档，
  也与 §2.6"不为不会发生的情况写异常处理"对称：不会发生的违规不需要检查，需要检查的是能发生的违规。
  4.5-07 的用例因此是：给模型一个塞了库外公司的回答 → 整条被判契约不合格丢弃 → 文档与产物里都不出现该名字。
- 残余风险在 `text` 内部：被拒的只是形状，模型仍可在合法散文里写一个库外公司。对此做一条**诚实的启发式**：
  把库内 `company / role / school` 收成全名词表，从改写后的 `text` 抽具名候选（大写串、书名号、
  「公司 / 集团 / 科技 / 有限 / 大学」后缀），候选既不在词表也不在 JD 原文 → 记一条违规。
  它**会漏判**（无分词器的中文 NER 做不到完备），spec 里就得写明强保证来自结构面、这条只是补刀——
  不许把它写成"零虚构已完全拦截"。

**判据七：4.5-14 用哨兵证明，不用否定式**

- "我们没打印"不是证据。做法与 2.7-d / 4.3-12 同一套：样例语料里**植入**手机号、邮箱、身份证号形态的哨兵值，
  跑一次完整生成（含被拒路径），断言日志文件、生成记录表、返回体三处都取不到这些哨兵串；
  并把这条断言做成机检级别的红——哨兵没被植入（测试自己写错）时用例必须失败，而不是空跑通过。

**4.5-a 已落地（2026-10-02）**，本节判据兑现为纯函数与 23 例单测，落点与三处偏离：

- 兑现为：`resume-doc/src/schema.ts` 的 `checkFactLock(original, proposed, editableKeys?)`
  - `FactViolation.gate`（`fact-lock` / `editable-allowlist`）+ `FactKey | null`，
    以及 `resume-kb/src/fact-check.ts` 的 `verifyGeneration()` 与 `describeViolations()`。
    判据一的"比对实现只有一份"按原文兑现：字段级 diff 没有第二处。
- **偏离一（口径收窄，比原计划更保守）**：判据六里设想的候选形状含"大写串、书名号"，实现只做了
  **机构后缀**一类（公司/集团/大学/学院/研究院/研究所/实验室/银行/证券/事务所/医院/事业部/社区）。
  理由不是偷懒：拉丁裸名（「OpenAI」）与前无后缀的中文裸名（「字节」）无法用词面正则稳定识别，
  把它们写进候选只会把"漏判"换成"误报"——而误报会打断 4.5-09 的保守路径（合法改写被拒 → 用户拿不到产物），
  比漏判更坏。人名与地名刻意不抽（同理），漏判面已在 spec 记录里逐条列出。
- **偏离二（多了一条计划外的必要处理）**：判据七原来只要求"读数不含字段原文"，实测发现
  **数值守恒的读数本身就装着一串数**——手机号就是一个数值，`describeViolations` 不整行过 `redactText`
  就等于把哨兵写进日志与生成记录。这条处理不在原计划里，是测试逼出来的，已在代码注释与 spec 记录留档。
- **偏离三（中文数词加了一条限定）**：原计划只说"中英数字都折成数值"，实现要求**紧跟量词才算一个数**，
  否则「十分匹配岗位要求」的「十」会被当成数据，润色成「非常匹配」即误报。量词集里刻意不含「成」
  （「两成」= 20%，与 2 不在同一口径，宁可两边都不数）。
- **给 4.5-b 的硬约束**：`fact-check.ts` 现在包外无消费者（未从 `index.ts` 导出）。§4.4 禁孤儿文件——
  4.5-b 若不接 `resume.generate`，这个文件与 18 例必须删除，不许以"以后会用"长期挂着。
  判据二的 `{ document, evidence, checks, receipt }` 返回体与号段 15 一片未动，仍在 4.5-b。

**4.5-b 已落地（2026-10-02，代码与接线半边；V 半边在 4.5-c）**，判据二～七的兑现与三处计划外偏离：

- 判据二（返回体四件套）与号段 15 落进 `resume-kb/src/generate-service.ts`；判据三（不写工作副本）由
  `packages/main/src/generate-link.test.ts` 用**真库按字节**判：`SELECT updated_at, doc_json` 跑前跑后相等，
  配一条正向对照（同一份装配里 `resume_generations` 确实多出一行），否则"没变"可能只是"没跑"。
- 判据四（一次都不问模型的通道）比原计划多做了一层：`targets.length === 0` 时**连提示词都不拼**——
  没有内容可改写还要把整份简历发出去，是纯粹的泄露面而不是成本问题。这一支同时是 4.5-09 的保守版路径。
- 判据五（不接闸门）在装配面上结构性成立：那份真装配用例里**根本没有** `entitlement.*` / `usage.*` 服务，
  生成照样跑完。与 4.4-e1 判据三同一手法，不需要额外写一条"我没调用它"的注释型断言。
- 判据七（哨兵）扩到**四条出口**：提示词、返回体、日志文件、生成记录表。前两条在包内用例，后两条只在
  真 store + 真 LogService 的装配里判得准。
- **偏离一（两侧入口的返回体故意不对称）**：IPC 面（`shared` 镜像 `GenerationRunRowView`）**不带** `document`，
  agent 工具面带。理由是 `shared` 在 L1、不许依赖 L2 的 `resume-doc`，镜像 P3.1 文档模型就是造第二个真相源
  （§2.5），而"有没有产物"由 `receipt.outcome` 判——它与 `document` 出自服务里同一句三元表达式；
  对话入口要把产物交给导出工具（4.5-d），那边需要完整返回体。
- **偏离二（生成记录表多了两列）**：计划里的复盘面只有 prompt 版本 / 模型 / JD id / 时间，实现补了
  `model_status` 与 `retried`。前者是 4.5-09 的播报根据（"为什么没用上模型"要能事后回答），
  后者是 4.5-05 的闸门痕迹（重试过但仍不过才叫拒绝产出）。
- **偏离三（机检口径补正）**：假 `llm.chat` 从 `gap-service.test.ts` 搬进 `test-doubles.ts`（第二个消费者
  出现，§2.2），`scripts/check-llm-single-entry.ts` 的"测试替身不计入声明者"从按 `.test.ts` 后缀判定改为
  与 `check-compliance-redlines.ts:101` 同一条口径（`.test/.spec.ts` 或 `test-doubles.ts`）。
  端点痕迹那一断言不豁免，所以放宽的只是"声明者计数"，不是"能不能碰模型"。
- **本片没消费者的一行**：`GenerationView.document` 在界面侧暂时无人渲染（4.5-c 的预览面板是它的第一个
  消费者）。同 4.5-a 那条 §4.4 禁孤儿文件的账，4.5-c 若不做，两侧镜像里只为 `document` 存在的形状要一并删。

**4.5 不做的事**：不做 DOCX/PDF 回写（产物交 3.3 的既有管线）、不做多候选版本 A/B 对比、
不做"生成质量打分"这类无据衍生功能（plan §6）、不给 `FactKey` 加枚举、不建 prompt 注册表框架、
不在本片接真模型网关的 V 半边（同 4.4-02：要用户授权与一次真花钱的调用，单独征求）。
