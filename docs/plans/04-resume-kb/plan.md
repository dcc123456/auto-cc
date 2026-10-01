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

| 切片  | 内容                                                                              | 覆盖条目                   | 收口判据                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.3-a | 预分词 spike 验穿 + `kb_chunks`（派生索引表，迁移号段 **12**）与实体同事务写删    | 4.3-11 / 4.2-04 检索面     | chunk 边界=实体边界；删实体后索引无孤儿行                                                                                                              |
| 4.3-b | FTS5 虚表 + `bm25()` 召回，与 `tokenize.ts` 分数合并成一条排序（含理由与命中词）  | 4.3-01 / 02 / 03           | 排序断言：相关项在前且理由非空；`k1/b`、字段权重、`topK` 全部来自 config（实测后：`k1/b`/`topK` 达标，**字段权重在单列切片粒度下无落点，冲突等裁定**） |
| 4.3-c | `kb.search` service + IPC 白名单 + 工具面登记（对话/工作流双入口，对齐裁定三）    | 4.3-10 / 4.2 先例          | 空结果确定态（界面提示 + 可行动建议），不返回随机结果                                                                                                  |
| 4.3-d | 向量可选增强：`llm.embed` 可用时 RRF 融合；不可用返回 `unavailable` 并降级纯 BM25 | 4.3-07 / 4.3-08            | 固定评测集上融合优于纯 BM25；embed 失败路径**零 BLOB 写入**、grep 无哈希冒充向量                                                                       |
| 4.3-e | 离线与性能收口：断网/无 key 冒烟、千级 chunk P95 基准、日志脱敏、依赖树审计       | 4.3-04 / 05 / 06 / 09 / 12 | 基准脚本输出入档；`pnpm why` 证明无外部向量服务与原生扩展                                                                                              |

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
