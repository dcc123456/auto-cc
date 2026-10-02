# 计划四 · 通过简历构建个人知识库（spec 验收清单）

方式：**V** = 可视验收（CDP harness 截图/DOM 断言）；**C** = 命令/脚本可机检；**U** = 单元测试。
状态：`[ ]` 未验 / `[x]` 通过 / `[!]` 受阻（必须写原因）。

> **条目统计**：71 条（4.1×12 / 4.2×11 / 4.3×12 / 4.4×10 / 4.5×14 / 4.6×12）。
>
> 前置门禁：1.3 / 1.4 / 1.9 已 `[x]`；4.5 的完整达成还需 3.1（文档模型）已 `[x]`。
> 数据纪律：全部测试使用自有样例简历，**不得**把真实个人信息写入仓库或测试夹具。

---

## 4.1 简历导入与解析

| ID     | 验收标准                                                                                      | 方式 | 验证操作                                             | 状态 |
| ------ | --------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------- | ---- |
| 4.1-01 | PDF / DOCX / Markdown 三种输入均可解析为结构化经历实体                                        | U+C  | 三种样例文件各跑一遍，断言实体数量与关键字段         | [x]  |
| 4.1-02 | 解析结果字段完整：公司、职位、起止时间、职责条目、项目、技能、教育                            | U    | 字段级断言                                           | [x]  |
| 4.1-03 | 时间归一化：`2021.03-2023/11`、`2021年3月至今`、`至今` 等多种写法归一为 `{from,to,isCurrent}` | U    | 参数化单测 ≥8 例                                     | [x]  |
| 4.1-04 | 解析不确定项标记为「待确认」而非猜测填充（宁缺勿造）                                          | U+V  | 断言低置信字段带 flag；界面显示待确认列表（截图）    | [x]  |
| 4.1-05 | 抽文本过短（<100 字符）判定为疑似扫描件，走明确失败路径并提示人工补录                         | U+C  | 单测 + 界面提示截图；**不引入 OCR 依赖**             | [x]  |
| 4.1-06 | 解析失败不崩主进程，返回 `AppErrorPayload`，界面可读中文提示                                  | V    | 注入损坏文件 → 截图错误态                            | [x]  |
| 4.1-07 | 同一份简历重复导入不产生重复实体（幂等键：来源 hash + 归一化字段 →**改判为仅来源 hash**）     | C    | 导入两次断言数量不变；字段级去重移交 4.2             | [x]  |
| 4.1-08 | 头像从 PDF 内嵌图像正确抽取，缺失时不报错                                                     | U+C  | 有/无头像两例断言                                    | [!]  |
| 4.1-09 | 敏感原文（手机号/邮箱/身份证）在入库与日志中默认脱敏                                          | C    | 断言落库与日志已掩码（对齐 8.5 红线）                | [x]  |
| 4.1-10 | 解析过程使用 1.3 `store`，无自建数据库连接                                                    | C    | grep 包内无 `node:sqlite` 直接打开；`store` 依赖声明 | [x]  |
| 4.1-11 | 每个解析函数有中文 JSDoc（作用/入参含格式与边界/返回含失败语义）                              | C    | AGENTS.md §3.1 抽样核对                              | [x]  |
| 4.1-12 | 抽取来源标注：与 `ai-resume` `fileParser` 思路对应的实现注明源路径 + 许可判定                 | C    | 文件头核对（MIT 声明 + 授权确认状态见 3.3-13）       | [x]  |

**4.1-a（纯解析层）落点与边界**

- 新增 `packages/resume-kb`（`@auto-cc/plugin-resume-kb`，见 plan §1.1 的包名裁定）：
  `src/period.ts` 时间归一 + `src/sections.ts` 文本→`ResumeDocument`。**不依赖 cordis / SQLite**，
  目的是让解析规则能离线逐字段断言；装配成 `resume.parse` service 属 4.1-b。
- 4.1-03 实测覆盖 **16 例**参数化（点/斜杠/连字符/`~`/`—`/`至`、中文年月、单位数月补零、全角数字、
  只有起点、只有终点、整段「至今」、两端只到年、终点早于起点、既给终点又写至今、畸形月份 `2021.13`、
  纯中文相对时间、空输入）+ 3 例独立断言，超过 spec 的 ≥8 例下限。
- 4.1-02 只对**文本 / Markdown 输入**成立（PDF / DOCX 两条腿未接，见 4.1-01），字段级断言覆盖
  经历的公司 / 职位 / 时间 / 成果（四项均 `locked`）、教育走 `school`/`degree`/`major`、技能与简介走 `text`，
  键名与 `resume-doc` 模板槽位（`internal/bind.ts`）逐一对齐，不自造键。
- 4.1-04 / 4.1-05 / 4.1-09 的 **U 半边已过**：认不出的时间、缺项、抬头首行是手机号、无已知标题、
  三段时间等一律产出 `ParseIssue`（不猜填）；`<100` 字符走 `status: 'too-short'` 且不返回半份文档；
  手机号 / 邮箱 / 身份证在**解析产物**层面只以掩码存在（`JSON.stringify(document)` 断言不含原文），
  且薪资区间 `15000-25000` 与 `40%` 不被误遮。
- 仍 `[ ]` 及原因（4.1-b 之后）：
  4.1-04 的 V 半边（待确认列表界面）、4.1-05 的 C 半边（真实扫描件界面提示）、
  4.1-06（service + IPC + 损坏文件错误态截图，且受 4.1-b 的打包前置门禁）、4.1-07（幂等入库与迁移号段）、
  4.1-08（头像抽取，PDF 那条腿已经通了，缺的是图像项抽取本身）、4.1-09 / 4.1-10 的**入库与日志**半边
  （本包当前不接触 SQLite，包内 `node:sqlite` 直开为零，但 `store` 依赖尚未声明，故 4.1-10 不算通过）。
- 复用核对（AGENTS.md §2.1 / §2.2）：PII 判据与掩码取自 `@auto-cc/core` 的 `PII_VALUE_PATTERNS` + `redactText`，
  本包**没有第二个脱敏实现**；输出模型取自 `@auto-cc/plugin-resume-doc` 的 `createEmptyDocument` / `makeField`，
  本包**没有第二份简历数据结构**。

**4.1-b（PDF / DOCX 依赖腿）落点与边界**

- 新增依赖（许可实测见 plan §1.1）：`pdfjs-dist@6.3.289`（Apache-2.0，走 `legacy/build/pdf.mjs`）与
  `mammoth@1.13.0`（BSD-2-Clause）。**不引入 OCR**：图片型 PDF 抽不到文本，统一由 `MIN_TEXT_CHAR_COUNT` 判过短。
- 唯一入口 `parseResumeSource(bytes, docId, nowMs)`，三条路径 `ok` / `too-short` / `failed{code}`，
  `code ∈ {empty, unsupported-format, invalid-pdf, invalid-docx}`；底层库错误原文只进 `reason`（日志面），
  界面文案留给渲染层 i18n。**抽取失败不抛异常**——这是 4.1-06 的 U 半边，V 半边仍待 service 接线。
- 格式判定按**魔数**不按扩展名（`%PDF-` / `PK\3\4` / UTF-8 严格可解码）。实测 `getDocument` 会移交（detach）
  传入的 ArrayBuffer，所以 `sourceHashOf` 必须在抽取前调用、字节交给三方库前先复制；4.1-07 的幂等键依赖这个顺序。
- 单测 12 例：三条输入腿各断言区块顺序与关键字段。PDF 腿用英文语料——最小 PDF 只能用 Type1/Helvetica，
  不含中日韩字形，这是夹具生成方式的硬约束而非解析缺陷；DOCX 与 Markdown 腿复用同一份中文语料断言同形。
  全部内容为虚构，测试内生成，不含真实个人信息。
- 标题词典补英文词条（`summary / work experience / education / skills …`）：没有它「三种输入」实际只剩一种半。
- **打包前置门禁已落地（2026-10-01，判据落在 1.7-15 / 1.7-16）**：pdfjs 内联进 CJS 会运行期找不到
  `pdf.worker.mjs`，改为「依赖外置 + `asarUnpack`」后，同一探针在 staging 布局返回 `status: ok`，
  真实 Electron 内核经 `app.asar` 路径读到解包后的 worker。于是「桌面 app 内可用」的这一半已经成立，
  4.1-06 剩下的门禁只是它字面要求的那半：service + IPC + 损坏文件的界面错误态截图（**下一节的 4.1-c 已补齐**）。
- 本节列出的 `[ ]`（4.1-04 V、4.1-05 C、4.1-06、4.1-07、4.1-09 / 4.1-10 的入库与日志半边）已由下一节的
  4.1-c 逐条结清并留证，只剩 4.1-08——它已改标 `[!]`，受阻原因与待裁定项见 4.1-c 落点说明。
- 复用核对：PDF / DOCX 抽文本各只有 `source.ts` **一个**调用点，`sections.ts` 不感知来源格式；
  脱敏仍然只有 `@auto-cc/core` 的 `redactText` 一处（已断言 PDF 腿上的邮箱不以原文进入文档）。

**4.1-c（service + IPC + 待确认界面）落点与边界**

- 新增 `resume.parse` service（`packages/resume-kb/src/parse-service.ts`），建**迁移号段 10** 的
  `resume_imports` 表；三条输入腿（PDF / DOCX / Markdown·TXT）在桌面端只有这一个落点。
  号段撞车的后果是「见号已存在就跳过建表」，所以单测里用手抄的已分配号段集合显式断言 10 未被占用。
- **幂等键是来源哈希，不是文件名**（这一条是对本行原文「来源 hash + 归一化字段」的**改判**，理由见
  plan §1.3-2：把归一化字段也放进键，同一份文件改一行就裂成两条实体，与条目意图相反；字段级去重移交
  4.2）：`doc_id` 由哈希前 12 位推出（`resume-722fb0f92b8b`），`source_hash`
  是主键，二次导入走 `ON CONFLICT (source_hash) DO UPDATE`（只刷 `updated_at`，`created_at` 保持首次值）。
  于是 4.1-07 的「不产生重复实体」是**表结构保证的**，不是靠代码里数一遍。哈希必须在把字节交给
  pdf.js **之前**算——`getDocument` 会移交（detach）传入的 `ArrayBuffer`，顺序反了幂等键就是空壳。
- 失败腿收敛成**单个** `RESUME_IMPORT_FAILED` 码：路径非绝对、文件不存在、是目录、超 `maxBytes`、
  格式不认识、PDF/DOCX 结构损坏，界面对它们的处置相同（一句可读中文 + 换文件），拆成六个码只会让
  渲染层写六遍分支（AGENTS.md §2.6）。子原因（`empty` / `unsupported-format` / `invalid-pdf` /
  `invalid-docx`）放在 `AppError.details.code` 里供日志与后续统计用。4.1-06 的截图证实底层原文
  （`Invalid PDF structure.`）经 `AppErrorPayload` 成为界面文案，主进程不崩。
- `@auto-cc/plugin-store` 被声明为 **devDependency**：本包只用它的**类型**（经 `asApp(ctx).store` 取
  共享连接），运行期由内核注入同一个实例，因此包内 `node:sqlite` 直开次数为零——4.1-10 的单测把这两件
  事（无自开连接 + `static inject = ['store']`）合在一条断言里，光看依赖声明是判不出来的。
- 4.1-09 的判据强度刻意指名：**单测把 `LogService` 的 `redact: false` 故意关掉**，日志里仍然扫不出
  手机号 / 邮箱 / 身份证原文——证明的是「本服务压根没把原文交给日志」，而不是「日志出口帮忙遮掉了」，
  两者是完全不同的结论。库里的 `doc_json` / `issues_json` 同样是脱敏之后的产物；`pending()` 与导入回执
  只带区块计数，整份 JSON 不过进程边界。
- 界面侧（`ResumePanel.tsx`）新增导入行与待确认清单。渲染层没有读文件的通道，所以摆的是**绝对路径输入框**
  而不是原生文件选择器（§8 的隔离底线优先于顺手做 UX；真正的选择器要等 1.4 网关开一条受白名单约束的
  文件通道，属后续条目）。`useBridgeAction` 的 `read` 从空实现改成真的回读 `parse.pending()`，
  所以导入之后列表自己刷新，不需要手动重进面板。
- 可视验收（CDP 10222、真实桌面窗口，非单测替身）证据：
  `docs/acceptance/4.1/4.1-04-pending-list.png`、`4.1-05-scanned-no-ocr.png`、`4.1-06-invalid-pdf-error.png`、
  `4.1-07-idempotent-reimport.png`、`4.1-10-resume-parse-mounted.png`。
  DOM 读数里最有分量的是**回环**：用 3.3 的 `export.toPdf` 导出的 PDF，再经 `parse.fromFile` 导回来，
  得到「已导入 resume-7a0437afa136：PDF · 159 字 · 3 条待确认」——两条腿对同一份文档能对上。
  幂等则用「三次导入（其中一次是重复文件）后待确认行数仍为 2」证明，且回执文案区分
  「已导入」/「同一份文件已在库中，行数不变、只更新时间」。
- **两条 dev 工作流实测**（写下来防止下次重新踩，都是环境而非产品缺陷）：
  ① 长期运行的 dev watcher 若启动得比 1.7-15 的 esbuild 依赖外置修复更早，它内存里那份 `main.cjs`
  仍然把 pdf.js 内联了，导入 PDF 会报 `Cannot find module …\packages\main\dist\pdf.worker.mjs`；
  用当前脚本重跑一次打包可复现「内联出现次数 0 + 动态 import 保留」，重启 dev 即恢复。
  ② 已打包的 auto-cc 实例持有 `%APPDATA%\auto-cc` 的单实例锁（`packages/main/src/index.ts:19`），
  此时 dev 实例会打印 `[dev] 主进程重启` 后静默 `electron exited (0)`；
  用 `AUTO_CC_USER_DATA_DIR` 换 userData 目录（本次用 `tmp/41/userdata`）即可与打包实例并存。
- **4.1-08 标 `[!]`（受阻，需用户裁定，不自行放宽）**：技术侧不缺能力——pdf.js 的
  `page.getOperatorList()` + `page.objs` 能在 Node 里拿到解码后的图像（已核对
  `types/src/display/api.d.ts:1536` 与 `:1459`，本项目用的 legacy 构建自带纯 JS 解码器，不需要 canvas），
  缺的是**这条能力没有落点**：P3.1 文档模型里根本没有图像字段（`packages/resume-doc/src/schema.ts` 的
  strict schema 会把 `avatar_url` 当未知顶层字段**直接拒掉**，导入路径也把它归入 `unknown-field-dropped`），
  三套模板也没有头像槽位——这正是 3.2-08 至今 `[!]`（「当前模型无图片字段、三套模板无头像槽位」）的同一件事。
  于是两种收口方式都越界：① 在本切片里给 P3 加图像字段 + 模板槽位，违反 AGENTS.md §0
  「一次只推进一个子计划」并且撞上 3.x 尚未答复的许可 / WASM 前置；② 只把图像抽出来落盘、
  界面上摆一句「已抽取头像」，产出一段**没有任何消费者的持久化基础设施**（§4.4 禁止孤儿实现、
  §2.6 禁止为假想未来做抽象）。待用户在两条里裁定：**(A)** 授权一个独立的 P3 切片先补图像字段与
  槽位（4.1-08 与 3.2-08 一起打勾）；**(B)** 把 4.1-08 降格为「落盘 + 回执读数」的窄口径并接受其
  暂无消费者。**在裁定之前，4.1 不得声称全绿，4.2 的开工按「4.1 除 4.1-08 外全绿」这一显式让步执行。**
- §6.5 的反向验证条目（被否决路线留档）：确认「不在 4.1 里顺手加图像字段」**没有造成能力缺口**——
  简历生成主链（4.5 定向内容 → 3.3 导出 PDF → 2.6 投递）不依赖头像；缺的只有「带照片版式」这一
  展示形态，已由 3.2-08 独立记账，不会被本计划静默遗忘。
- 复用核对（AGENTS.md §2.1 / §2.2）：读文件 + 卡字节上限**没有**复用 `outbound.deliver` 的
  `readAttachment`，理由写在 `parse-service.ts` 头部注释里（一边验 `.pdf` 扩展名、一边按魔数判四种格式，
  判定口径与失败语义都不同，合并只会让两边长出开关参数）；脱敏仍然只有 `redactText` 一处；
  简历数据结构仍然只有 `@auto-cc/plugin-resume-doc` 一份，本切片未新增第二份。

**4.2 开工前置：plan §1.4 裁定一（导入即建可编辑工作副本）已落地（2026-10-01）**

- 修的是 4.1-c 留下的**真实产品缺口**，不是重构：`resume.parse` 此前只把文档写进 `resume_imports.doc_json`，
  而 3.x 的编辑 / 快照 / PDF 导出只认 `resume_docs`——「根据 JD 优化简历」这条主链在入口就断了。
  现在 `persist()` 在写完出处之后调用 `resume.doc.save(document)`，工作副本由**已有的 service** 写，
  本包不往 `resume_docs` 落裸 SQL（§2.5 一处真相源，`AppError` 与 Schema 校验因此自动继承）。
- **不覆盖用户改动**是这一刀的语义核心：写入前先看 `resume.doc.load(docId).status`，只有 `missing` 才建，
  重复导入按 4.1-07 只刷新出处与时间。单测第 2 例把这条打死——导入→改工作副本→再导入，
  断言 `isNew === false`、`resume_docs` 行数仍为 1、且库里 JSON 与**改过之后**的那份逐字相等。
- 派生的接线改动三处，都是这一条依赖的必然结果：`static inject = ['store', 'resume.doc']`、
  `cordis.yml` 里 `resume-parse` 的 `dependsOn: [store, resume-doc]`（`inject` 缺席即 PENDING，
  装配顺序必须显式声明）、4.1-10 的依赖声明断言随之改为新字符串。扫描件（`status: 'scanned'`）
  不产生工作副本——没有文档可存，第 3 例断言 `resume_docs` 行数为 0。
- 顺手纠出两处**文档与常量对不上**的陈旧注释（`cordis.yml` 与 `packages/main/src/registry.ts`
  把 `resume-doc` 的迁移号段写成 6，实际常量是 7）：号段是防撞车的唯一依据，写错的号段比没有注释更坏。
- 本条当时不改动 4.2 任何一行的状态位：4.2-01/02/11 的判据还要等 `kb_entities`（迁移 11）与实体派生落地。
  后续更新：4.2-a（2026-10-01，见本节下方落地记录）已勾上 4.2-02 与 4.2-11，4.2-01 当时因「可删」未做而保持 `[ ]`；
  4.2-c（同日）补上 `remove()` 后，4.2-01 与 4.2-04 / 08 一并勾上。

## 4.2 知识库建模与管理界面

| ID     | 验收标准                                                              | 方式 | 验证操作                           | 状态 |
| ------ | --------------------------------------------------------------------- | ---- | ---------------------------------- | ---- |
| 4.2-01 | 四类实体（经历/项目/技能/成果）+ 关系定型，可建可查可改可删           | U+C  | CRUD 单测 + migration up/down      | [x]  |
| 4.2-02 | 每条实体有稳定 id，供 `evidenceRefs` 反查引用（4.5/4.6 依赖）         | C    | 引用完整性断言                     | [x]  |
| 4.2-03 | `evidenceFor(claim)` 能由一句简历描述反查到支撑实体                   | U    | 单测：给定句子命中正确项目         | [x]  |
| 4.2-04 | 删除经历时其下属项目/成果级联处理策略明确（不留孤儿行）               | U+C  | 断言外键/级联结果                  | [x]  |
| 4.2-05 | 管理界面展示实体树与关系，条目可展开查看证据链                        | V    | 截图（列表 + 展开态）              | [x]  |
| 4.2-06 | 界面新增/编辑实体即时生效（事件流驱动，不需重启或手动刷新）           | V    | 编辑后截图显示新值                 | [x]  |
| 4.2-07 | 知识库数据全本地，无任何上行请求（除用户显式配置的 LLM 网关）         | C    | 网络审计：除 llm 外零外部请求      | [x]  |
| 4.2-08 | 支持导出/导入知识库备份（本地文件），导入冲突有明确策略               | C    | round-trip + 冲突用例              | [x]  |
| 4.2-09 | 界面文案全部 i18n、样式全部 Tailwind、图标全部 lucide                 | C    | 1.2-13~16 规则复跑 0 违规          | [x]  |
| 4.2-10 | 变量与函数命名有含义，无 `data/res/temp/flag` 类命名                  | C    | AGENTS.md §3.4 抽样核对            | [x]  |
| 4.2-11 | 表结构与 P2 的 JD 表、P3 的文档表无重复定义（同一实体只有一处真相源） | C    | 三计划表清单对账，重复项必须已合并 | [x]  |

**4.2-a 落地记录（2026-10-01）**——迁移 11 `kb_entities` + 实体派生 + `kb.profile` CRUD

- **建表与号段**：`KB_PROFILE_MIGRATION_VERSION = 11`，列为
  `entity_id`(PK) / `kind` / `parent_id` / `source_doc_id` / `payload_json` / `normalized_hash` / `created_at` /
  `updated_at`，另两条索引 `idx_kb_entities_doc(source_doc_id, kind)`、`idx_kb_entities_parent(parent_id)`；
  `down` 只 DROP 本表。防撞号用本仓库既有的写法：单测手抄 1–10 已分配号段断言 11 未被占用，
  并实测 `store.rollback(10)` **只**回收 `kb_entities`，`resume_imports` / `resume_docs` 的行都还在
  （`down` 写窄了会静默删掉别人的表，这条断言是唯一的防线）。
- **派生是纯函数**：`entities.ts` 不认识 cordis、不认识 SQLite，输入 `ResumeDocument` 输出草稿数组，
  所以「关系定型」这件事能被单测直接打死（谁挂谁、去重、顺序无关）。落库只在 `profile-service.ts`。
  四种 kind 的来源与 plan §1.4 裁定二 的映射表逐字一致；`summary / education / campus` 不产实体行，
  campus 里的 `achievement` 字段仍产成果实体且 `parent_id` 为 `null`。
- **`parent_id` 靠月份重叠，不靠公司名**：项目挂到「与它时间重叠最多」的经历上，「至今」按开区间上界处理，
  并列时取实体 id 字典序小者——同一份文档永远派生出同一棵树。没有项目没有时间段、或所有经历都无时间段时
  `parent_id` 为 `null`（不猜）。
- **稳定 id 的真实强度必须写清**（防止 4.5 / 4.6 误用）：id 是 `kb-` + sha256(`docId|kind|slot`) 前 16 位，
  而 `slot` 对经历 / 项目取 `entry.id`，`entry.id` 是**位置号**（`sections.ts:235` 的 `${kind}-${index + 1}`）。
  所以「稳定」的含义是**同一文档同一条目结构下、重复同步幂等**（单测断言两次 `sync` 得到的 id 列表逐字相等、
  且第二次 `{created:0, updated:0, removed:0}`），**不含**「用户删掉中间某条经历后，后面条目的 id 不变」。
  跨编辑的不可变 entry id 属 P3.1 文档模型的改动，本片不动，4.2-d 做界面编辑时必须把这条当作已知约束。
- **手动实体永远 `source_doc_id IS NULL`**，因此 `sync()` 的修剪不可能误删人工录入的行（单测直接断言）；
  回查手动实体走 `list({ sourceDocId: null })`，用 `IS NULL` 而不是 `= NULL`。
- **本片没有 `remove()`**：4.2-04 的级联策略是「删经历时下属项目/成果的去留」这个**策略**决定，
  归 4.2-c。提前写一个删一行留一堆孤儿的版本，等于让 4.2-c 先删掉它再重写，故 4.2-01 的「可删」判据
  **仍未满足**，这一行保持 `[ ]`。
- **4.2-02 勾 [x] 的确切范围**：`验证操作` 那一栏要求的引用完整性断言已落在单测里——成果实体的 `parent_id`
  一定指向同一次派生内的经历实体（或 `null`），派生 id 列表可重复取得，手动实体能被 `get` 原样读回。
  「由一句简历陈述反查」的行为本身是 4.2-03 的判据，不在本行了结。
- **4.2-11 复跑**：对账清单见 plan §1.4 的「4.2-a 落地后复跑」一条——`kb_entities` 只新增派生投影列，
  `payload_json` 内容来自 `resume_docs.doc_json` 而不是第二份文档结构，`source_doc_id` 指回 `resume_docs.id`；
  全部业务表逐张枚举后无第二处真相源。
- **两处不粉饰的缺口**（本片刻意不声称完成的部分）：
  ① `kb.profile` 已进 `REGISTRY` 与 `cordis.yml`，但**渲染层没有任何调用方**，界面/真窗口证据归 4.2-d（4.2-05 / 06）；
  ② 全仓**没有测试校验 `cordis.yml` 与 `REGISTRY` 的配对**（`packages/kernel/src/lifecycle.test.ts` 用自己的假
  REGISTRY，`delivery-snapshot-link.test.ts` 只挂自选子集），所以「app 真起后这张表被建」目前只有 vitest
  装配证据（测试里真的 mount 了 `store → resume.doc → kb.profile` 并建表），没有真窗口证据。
- **写 fixture 的人必须知道的规则**：`sections.ts` 按**空行**切条目。两条经历之间不空行会被合成一条 entry，
  症状是 `sync` 出来 5 行而不是 7 行、且解析器不报任何错。这条已经写进
  `packages/resume-kb/src/profile-service.test.ts` 的 fixture 注释里。
- **单测覆盖**：`packages/resume-kb test` 6 文件 / 91 用例全绿，其中本片新增 `entities.test.ts` 8 例、
  `profile-service.test.ts` 14 例（含端到端：`resume.parse.fromFile` → `kb.profile.sync`，断言落库
  `payload_json` 里没有原始手机号）。

**4.2-b 落地记录（2026-10-01）**——`evidenceFor(claim)` 确定性反查（spec 4.2-03）

- **判定不经过模型**：这一条是刻意的架构选择，不是省事。§8.4 要求「LLM 不得编造公司/职位/时间/数字」，
  而「这句话有没有据可依」正是编造最顺手的地方——让模型自评等于既当运动员又当裁判。
  落点是 `evidence.ts`（纯函数，不认识 cordis 也不认识 SQLite）+ `tokenize.ts`，
  `kb.profile.evidenceFor` 只做两件事：按 `filter` 从库里取候选、把配置里的阈值套上去。
- **计分口径**：`max(陈述覆盖率, 实体覆盖率)`，两个方向分别是
  `|交集| / |陈述 token|` 与 `|交集| / |实体 token|`；取最大值就同时表达「归一化包含」与「词重叠」，
  不需要先跑一遍包含判断再算重叠。强度 1（阈值 0.9999）标 `contains`，其余标 `overlap`，
  界面按这两个码取 i18n 文案（英文串不直接上界面，对齐 §5.5）。
- **为什么不用 `String.includes` 判包含**：技能 `Go` 会被 `logo` 里的两个字母命中。
  按 token 比时 `go` 与 `logo` 是两个不同的词，这类误命中不会发生——单测里那条就是把这句话打死。
- **确定性三件套**（同分排序、命中词顺序、浮点）：分数相同的候选按 `entityId` 升序，
  所以结果与 `list()` 的返回顺序无关；`matchedTokens` 排序后返回；分数取 4 位小数
  （浮点尾差会让断言与去重都不稳定）。
- **阈值来自配置**：`evidenceTopK`（默认 5）与 `evidenceMinScore`（默认 0.34）进 `kbProfileSchema`，
  并在 `cordis.yml` 的 `kb-profile` 块里显式写出；代码内不留魔法数（同 4.3-03 的口径）。
  单测不是靠 grep 证明这件事，而是用**两份不同配置各起一套服务**：默认阈值挡在门外的弱命中，
  把 `minScore` 调到 0.05 才放出来并标 `overlap`；`topK` 调成 1 时只回同分里 id 最小的那一条。
- **反查范围**是 `list()` 的过滤参数（`kind` / `sourceDocId`），**手工实体天然在候选内**
  （单测用 `sourceDocId: null` 只取手工那一条）——4.5 不能出现「界面能编辑、证据查不到」的两张皮。
- **查无支撑返回空数组，不抛错**：4.5 要靠它区分「有证据」与「这条是模型编的」，那是业务正常态。
- **已知弱点（不粉饰，留给后续切片处理）**：
  ① bigram 没有词边界，跨词会合成出无意义 token（「与高并发网关」里会产出 `与高`）；
  这只影响分数噪声、不影响「命中哪条」的判定，因为交集只统计两边都出现过的 token。
  ② `minScore = 0.34` 是**拍的初值**，尚未在真实简历语料上标定——标定属 4.3（检索参数一起扫），
  届时若发现阈值不合适要连同本条一起调，不在这里假装它是调过的。
  ③ 反查目前**只在单测里被调用**：渲染层还没有任何 `kb.profile` 的调用方（4.2-05 / 06 仍是 `[ ]`）。
- **单测覆盖**：`evidence.test.ts` 13 例（分词 3 例 + 命中判定 5 例 + 确定性 3 例 + 空态 2 例）、
  `profile-service.test.ts` 新增「证据反查」6 例（候选来自库里、阈值来自配置、手工实体在范围内）。
  `packages/resume-kb test` 7 文件 / 110 用例全绿。

**4.2-c 落地记录（2026-10-01）**——删除的级联策略（4.2-04）+ 知识库备份导出/导入（4.2-08）

- **4.2-01 这一条是在本片收口的**，不是 4.2-a 漏了：那条记录里写明「可删」未落地所以保持 `[ ]`。
  现在 `remove()` 存在，四个动词各有断言（`create` / `list`+`get` / `update` / `remove`），
  加上迁移 up/down 各一条（回滚到 10 之后 `kb_entities` 消失、`resume_imports` 与 `resume_docs` 不受波及），
  验证操作「CRUD 单测 + migration up/down」才第一次全项对上，因此勾 `[x]`。
- **删除的入口只有一条，且分两种来源**（这是 4.2-04 的实质决定，不是实现细节）：
  `remove()` **只服务手工实体**。派生行的真相在 `resume_docs` 工作副本，直接在库里删会在下一次
  `sync()` 时被原样写回来——用户看到的是「删了又活过来」。所以派生行走的是拒绝路径
  （`KB_ENTITY_DERIVED` + `details.sourceDocId`），界面据此给「去简历里删」的跳转而不是失败提示；
  新错误码为此加进 `packages/core/src/errors.ts`。
  删除派生经历的**正确路径**同样有断言：改写工作副本只留技能区块 → `sync()` →
  经历与它的成果从库里消失（`prune`），挂在被删经历下的手工实体被解除归属。
- **级联策略选 detach，不选 cascade delete**：下属（项目/成果）可能是用户手写的内容，
  只是恰好归属在一条被删实体下，连带删除会把还有记录的行一起抹掉。
  「不留孤儿行」的准确含义是**不留引用不存在父实体的行**，而不是「不允许没有父」。
  断言方式是拿 `orphanParentCount(db)`（`parent_id IS NOT NULL AND parent_id NOT IN (SELECT entity_id …)`）
  在每次删除/同步/导入后打一遍 0，而不是只看某一条行。
- **表里没有 FK 约束，所以 4.2-04 验的是「级联结果」而不是「外键行为」**——这一点要说清，
  否则读 spec 的人会以为 `ON DELETE CASCADE` 在兜底。约束由 `remove()` 与 `sync()` 末尾的
  `detachOrphanParents()` 两条 SQL 承担，`store.db` 是共享的单连接、写入全经这两个入口，
  因此没有旁路把悬空引用带进来（备份导入是第三条写路径，它自己也走同一套判定）。
- **备份格式是自己的一种 JSON，不是 `.db`**：用户要能在文本编辑器里看出库里都有什么，
  而表结构换版本时二进制文件不会跟着兼容。带 `schemaVersion`（当前 **1**）且不认识的版本**直接拒绝**，
  不假装能读旧文件。两个刻意的编码选择：
  ① **不写 `normalized_hash`**——它是载荷的派生量，写进文件就等于允许「改载荷而哈希不变」，
  导入时一律用 `payloadHashOf` 重算，库里哈希只有一种来源；
  ② **按 `entityId` 升序写出**——同一份库两次导出必须逐字节相同，否则 round-trip 只能比集合不能比串。
- **导入的三条不变量**（每条都有对应断言）：
  ① **一个事务**（`BEGIN`/`COMMIT`，异常 `ROLLBACK`）：文件中途一条载荷不合法就整批回滚，
  前一条好记录也不会留下——半个库比失败更坏；
  ② **时间戳取文件里的原值**，本方法因此**没有 `nowMs` 入参**：恢复备份不该把全部记录的
  `created_at`/`updated_at` 刷成「刚刚」，那会让界面「最近改动」排序在每次恢复后失真；
  ③ **归属不悬空**：`parent_id` 既不在库里也不在这份文件里时置空并计入 `danglingParents`。
  判定用「库内原有 id ∪ 文件内全部 id」这个集合，不按遍历顺序——文件里「父排在子后面」是完全正常的写法。
- **冲突策略的默认值是 `skip`**：`overwrite` 必须调用方显式选。默认盖掉用户这几周的手工修改是不可接受的，
  所以两条断言分别打死「旧备份不盖新值」与「选了 overwrite 就以文件为准」，
  返回体把 `created / overwritten / skipped / danglingParents` 四个计数分开报（界面要能对用户说清动了什么）。
- **fs 边界**：路径读不到与目标目录不存在都包成 `AppError('INVALID_ARGUMENT')`（消息里带上原始 reason），
  不往外抛裸 `ENOENT`——这条路径的调用方将是渲染层经 IPC 的按钮（1.4 的白名单调用要求错误是 plain data）。
- **本片的已知边界（不粉饰）**：
  ① 备份是**全库**语义，没有「只导某一份简历派生出的那部分」的选择性导出，也没有加密（简历是 PII，
  导出文件落在用户选的路径上，加密与脱敏若要做属于 4.2 之后的独立条目，不在这里假装已经安全）；
  ② `importBackup` 不校验 `source_doc_id` 指向的简历是否还在——导入派生行后如果那份简历已被删，
  实体仍会留在库里（`sync()` 只清它自己那份文档名下的行）。这一条留给 4.2-d 的界面处理；
  ③ `remove()` / `exportBackup()` / `importBackup()` **目前只在单测里被调用**，
  渲染层仍无任何 `kb.profile` 调用方（4.2-05 / 06 保持 `[ ]`）。
- **单测覆盖**：`profile-service.test.ts` 新增「删除与归属级联」4 例 + 「备份导出/导入」9 例
  （逐字节导出稳定、round-trip 逐条等值、skip 与 overwrite 两种冲突、悬空归属、事务回滚、
  三种非法文件在动库之前被拒、fs 边界两条、出处 `source_doc_id` 原样恢复且重复导入不重复写）。
  该包 7 文件 / **123** 用例全绿；根 `pnpm typecheck` / `lint` / `format:check` / `test` 全绿。

### 4.2-d 落地记录（4.2-05 / 06 的界面与工具面，2026-10-01）

- **即时生效走的是事件，不是轮询**：`kb/entities-changed`（`action / docId / changed / at`）由 `profile-service`
  在 `sync / create / update / remove / importBackup` 五条写路径末尾发出，界面订阅后重读 `list()`。
  载荷**刻意不带实体内容**——带了就等于渲染层自己养一份状态，与「主进程是唯一真相源」冲突（AGENTS.md §2.5）。
  两处**不发光标**：载荷哈希未变（内容没动）与同步失败都不发事件，所以提示行不会把「什么都没发生」说成「已更新」。
- **按来源给两套处置**（4.2-04 的界面兑现）：派生行只标「来自简历 <docId>（改内容请在简历工作副本里改后同步）」
  并只留「证据链」按钮；手工行标「手工创建（不会被同步清理）」并给编辑/删除。给派生行挂删除按钮
  等于挂一个必然失败的按钮，这条策略在 DOM 断言 [2] 里逐行打死（6 条派生行 `hasEdit=false / hasDelete=false`）。
- **证据链不是装饰**：展开一行 = 拿这一行自己的正文去 `profile.evidenceFor`，界面显示理由码（完全覆盖 / 词面重合）、
  分数、命中词、`updatedAt`。分数与理由全部由 `evidence.ts` 给出，渲染层不重算（§2.5）；空命中是正常态，
  提示行说「查无支撑」而不是报错。
- **视图形状在 `shared` 里做镜像**（不是 import L2 类型）：`shared` 是 L1，反向依赖 L2 会破 §4.1 的分层，
  所以 `KbEntityRowView` 等九个视图类型与 `bridge.ts` 的签名条目一起声明，由 `BridgeSignaturesCovered`
  在编译期保证「白名单里每一条都有签名」——加一条漏一条签名的表现是 `pnpm typecheck` 直接失败，不是运行期 undefined。
- **裁定三兑现到工具面**：`kb.profile.list` 在 service 自己的 `[Service.init]` 里经 `registerAgentTools` 登记
  （`effect: 'read'`、`requiresConfirmation: false`），真实进程内 `agent.tools.list()` 能看到它，
  `agent.tools.call('kb.profile.list', { kind: 'experience' })` 返回的行与界面树逐字段一致
  ——**同一个入口**，界面与 agent 读同一张 `kb_entities`，没有第二条数据通道（证据 [5]）。
  单测侧沿用 L2 各自留一份薄 `FakeAgentToolsService` 的先例（`packages/browser/src/test-doubles.ts`），
  零键配置必须用 `NO_CONFIG` 挂载——直接传 `{}` 会被 cordis 的 schema 校验判成非法配置。
- **harness 实测到一个通用坑（写进 1.6 的经验）**：诊断视图是 `hidden`/`block` 切换的三个容器之一，
  未激活时元素存在但 `getBoundingClientRect()` 宽高为 0，此时 CDP 的原生坐标点击**静默落空**（回执仍是「已点击」）。
  所以驱动任何非默认视图前必须先点 `[data-view="diagnostics"]` 激活，再 `type`/`click`。
- **本片未收口的部分（不粉饰）**：
  ① 4.2-05 / 06 的 V 证据只覆盖到「工具面读数与界面一致」，**没有覆盖自然语言对话入口**——
  在 chat 里问「库里有哪些和高并发相关的经历」、确认它确实挑中 `kb.profile.list` 这条真链路，
  需要 LLM 网关在场，与 2.8-c 的对话真工具卡片属同一类验证，留作 4.2 收口时补；
  ② 「导入派生行后原简历已被删」这一 4.2-c 遗留边界，界面只在派生行文案里指了「去简历工作副本改后同步」，
  没有做「源文档已不存在」的显式提示；
  ③ 备份导出/导入的路径是用户手填绝对路径（渲染层不读文件，§5.8），未接原生文件对话框。
- **单测覆盖**：`profile-service.test.ts` 新增「变更事件与 agent 工具面」3 例
  （动作序列 `create/update/remove/import/sync` 且失败同步不发事件、载荷未变不发事件、工具元数据与委派等价于 `list()`）。
  该包 7 文件 / **126** 用例全绿；根 `pnpm typecheck` / `lint`（含渲染层规范：2 个语言包 22 个源文件键对齐）/
  `format:check` / `test` 全绿。V 证据：`docs/acceptance/4.2/4.2-05-tree-evidence.png`、
  `4.2-06-manual-created.png`、`4.2-06-instant-update.png`、`4.2-05-dom-assertions.txt`。

### 4.2-e 落地记录（4.2-07 / 09 / 10 的收口，2026-10-01）

- **4.2-07 用「结构断言」而不是「一次快照」**：先按 1.9-09 的先例做 grep 审计，随后把它升级成单测——
  对 `packages/resume-kb/src` 每个非测试文件断言不命中 `node:(http|https|net|dns|tls|dgram)`、`fetch(`、
  `WebSocket`、`XMLHttpRequest`、`undici|axios|got|superagent|node-fetch`。动机是实测撞到的环境事实：
  **Node 内置模块的 ESM 命名空间只读**，`http.request = stub` 直接抛
  `TypeError: Cannot redefine property: request`，所以"运行期打桩覆盖全部通道"在这台机器上做不到，
  只留 `globalThis.fetch`（可写）+ `WebSocket` + `XMLHttpRequest` 三个存根跑完
  `list → evidenceFor → create → update → sync → exportBackup → importBackup → remove → agent 工具面`
  并断言零调用，其余靠 import 面守住。两条都是永久机检，比一次性日志审计强。
- **4.2-09 复跑的是 1.2 那套机检本身**，不另写一套：`pnpm lint` = eslint（样式只 Tailwind、图标只 lucide、
  JSX 裸中文硬拦）+ `check-renderer-conventions.ts`（zh-CN / en 键逐条对齐）。对 `KbPanel.tsx` 另做定向 grep
  复核：无 `style={}`、无 `<svg>`、无 `dangerouslySetInnerHTML`、无非入口样式 import；
  中文只剩注释，41 条文案全在 `shell.kb` 下且动态值走插值。
- **4.2-10 抽样口径**：按 §3.4 的禁用名做标识符级 grep（不是全文 grep，避免误伤正文），
  `KbPanel.tsx` 与 `resume-kb` 四个新文件 0 命中；同时列出承担语义的新名字
  （`deriveEntities` / `payloadHashOf` / `rankEvidence` / `linesToPayload` / `primaryTextOf` / `isDerived` …）
  供人工复核，布尔量用 `is` 前缀。
- **本片的已知边界**：4.2-07 的审计范围是**知识库这条链**（解析 → 派生 → 实体表 → 证据反查 → 备份文件）
  与"全仓唯一出网入口是 `packages/llm`"这条既有不变量；它**不等于**整个 app 的运行时抓包审计——
  后者要等 2.x 的浏览器内核与真实平台链路一起看，届时按 §7.2 只能在 fixture 上做。
- **单测覆盖**：`profile-service.test.ts` 新增「零上行审计」2 例，该包 7 文件 / **128** 用例全绿；
  根 `pnpm typecheck`（0 error）/ `lint`（四项检查全过）/ `format:check` / `test` 全绿。
  证据：`docs/acceptance/4.2/4.2-07-network-audit.txt`、`4.2-09-10-ui-conventions-naming.txt`。

## 4.3 本地检索（BM25 默认，向量可选）

| ID     | 验收标准                                                                           | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 状态 |
| ------ | ---------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 4.3-01 | BM25 + 倒排检索可用：给定查询返回排序 chunk 列表，含分数与命中理由字段             | U    | 排序断言（相关项在前）+ 理由非空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [x]  |
| 4.3-02 | 中文检索有效：bigram 分词下，「推荐算法」「高并发」类查询能命中对应经历            | U    | 语料样例断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [x]  |
| 4.3-03 | 检索参数（k1/b、字段权重、topK）来自 `config`，代码内无魔法数                      | C    | 参数扫描断言 + grep 无内联常量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [!]  |
| 4.3-04 | **离线可用**：无 LLM key、无网络时检索与比对全链路正常                             | C    | 断网冒烟测试通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [x]  |
| 4.3-05 | 不引入外部向量数据库服务：依赖树中无 `chromadb` / 需下载的服务                     | C    | `pnpm why chromadb` 无结果；无 docker 依赖。**2026-10-02 落地为常驻机检**（不再是一次人肉 `pnpm why`）：`scripts/check-dependency-floor.ts` 进 `pnpm lint` 链，三层扫「声明层 package.json 四类依赖表 / 解析层 pnpm-lock.yaml 全量包名 / 搬运层 `resolveRuntimeDeps()` 装机闭包」，禁令含 chroma/qdrant/weaviate/milvus/faiss/lancedb/usearch/docker 客户端与非内置 SQLite 绑定。实测 25 份清单 + 锁文件 544 个包名零命中；并把三层各造一次违规输入验红（证据 `4.3-05-06-dependency-floor.txt`）                                                                                                                                                            | [x]  |
| 4.3-06 | 不引入需用户机编译的原生扩展：无 `sqlite-vec` / `better-sqlite3` / node-gyp 路径   | C    | `pnpm why` + 装机冒烟（对齐 M2b）。同上一条的三层机检：搬运层逐个装机包扫 `.node/.dll/.so/.dylib/.o/binding.gyp` 与 `preinstall/install/postinstall` 钩子，25 个装机依赖共 1476 个文件零命中；锁文件里的 dev-only 传递链路（`node-gyp`、pdfjs 的 optional `@napi-rs/canvas` 家族 14 个包名）**记为提示而不记失败**，由搬运层确认它们不进装机包（与 1.7-15 的搬运审计一致）。装机冒烟：装机产物侧由 1.7-15 的搬运审计与 1.7-12 的「含外置依赖新产物」复验接续（`app.asar.unpacked` 只有 `pdfjs-dist`，optional 原生包未被搬运）；三端安装包的完整启动冒烟仍属 M2b / 2.x 收口项，macOS / Linux 按 AGENTS.md §9 是本机不可验证项，BLOCKED 记在 1.7-09 / 1.7-10 | [x]  |
| 4.3-07 | 向量检索为**可选增强**：可用时与 BM25 做 RRF 融合，结果优于纯 BM25（固定评测集上） | U    | 评测集 topK 命中率对比断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [!]  |
| 4.3-08 | embedding 不可用时返回 `unavailable` 并自动降级纯 BM25，**绝不产生伪向量**         | U+C  | 断言 `llm.embed` 失败路径无 BLOB 写入；grep 无哈希冒充向量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [x]  |
| 4.3-09 | 检索延迟可接受：千级 chunk 下 P95 在配置阈值内                                     | C    | 基准脚本输出记录。**2026-10-02 实测**：`pnpm bench:kb`（`packages/resume-kb/src/bench.ts`）灌 1500 条真实事务写入的切片后跑 240 次 `search()`，两次连跑 P95=7.76ms / 7.49ms（P50 3.2ms、max 9.2ms）对预算 150ms → PASS；预算与规模来自 `cordis.yml` 的 `bench.kb-search` 段，超预算脚本 exit 1。不用 4.3-a 的 spike 数字代替（那轮只测双写与单条 FTS 查询）。并发下的延迟与向量腿 `ok` 时的融合开销未测，见 plan §4.3-e 的边界条                                                                                                                                                                                                                            | [x]  |
| 4.3-10 | 检索为空时给出确定态（界面提示 + 可行动建议），不返回随机结果                      | V+C  | 冷门查询截图                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [x]  |
| 4.3-11 | chunk 粒度 = 可引用粒度（按实体自然分层），无任意滑窗切碎语义                      | U    | 断言 chunk 边界与实体边界一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [x]  |
| 4.3-12 | 检索日志不记录简历正文原文（只记查询与命中 id），防日志侧泄露                      | C    | 断言日志内容已脱敏。**2026-10-02 实测**：`profile-service.test.ts` 新增两条装配用例打真临时目录 + 真 `node:sqlite` + 真日志文件（`redact: false`，不靠日志服务兜底），判据双向成立——检索计数行必须出现（否则是「日志没写」的假通过），而切片正文短语 / 姓名 / 手机号 / 查询原文一律查不到；覆盖 sync·create·update·remove·导出·导入·反查·检索正常态·向量编码失败退回态。实现比 spec 更严：查询原文也不落（计数行足够排障）。证据 `4.3-12-log-desensitization.txt`（含 4.3-09 那轮 1987 行真实日志的 grep 读数）                                                                                                                                             | [x]  |

### 4.3-a 落地记录（4.3-11，2026-10-02）

- **4.3-11 的判据怎么落的**：切片只有两种粒度，**没有滑窗**。实体级切片 `chunk_id` 直接取 `entity_id`
  （命中即引用，4.5 的事实锁定不必再解「这段落在哪条实体的第几窗」），且与实体保持 **1:1 无条件**
  ——切不出 token 的载荷也留一行（`tokens` 空串）：「有的实体有切片、有的没有」是要调用方记住的规则，
  比恒定一行更难维护。区块级只覆盖 `summary / education / campus` 三类**裁定二明确不建实体行**的区块，
  `chunk_id = kbs-<sha256(文档+区块种类+条目槽位) 前 16 位>`，一个 entry 一条——这是兑现 `entities.ts`
  头部注释许给 4.3-11 的承诺，不补就是「简历里这三段永远检索不到」的能力缺口（4.4 的学历比对必须有据）。
- **同事务而不是后台修补**：`sync / create / update / remove / importBackup` 五条写路径统一包进新的
  `withTransaction()`（带**嵌套深度守卫**——`importBackup` 已在一个事务里逐条 `upsert`，
  SQLite 不允许事务套事务，少这层守卫直接抛 `cannot start a transaction within a transaction`）。
  `prune()` 重写成实体与切片**共用同一个谓词对象**（含空 `drafts` 分支——实测（3.53.1 / 3.53.4）`IN ()` 返回 0 行、
  `NOT IN ()` 返回全部行，都不报语法错误，但靠空列表把谓词退化太脆，显式分支才稳），
  分成两份表达式迟早会在空列表那一支走散，走散的表现就是检索侧留孤儿行。
- **老库升级只补建一次**：判据是 `upgrade()` 返回的 `applied` 里有没有 12（台账而不是水位，见 `store/migrate.ts`），
  命中就 `reindexAllChunks()` 把已有实体 + 已有工作副本全算一遍；不做每次启动的自愈扫描（无谓的冷启动开销）。
  **已知边界**：从库外删掉 `kb_chunks` 的行不会被自动补回，要等一次 `sync()` 或重新挂载才收敛——
  派生索引与「工作副本才是真相」同一口径。
- **为此扩展的不是新包**：`resume.doc` 加 `listIds()`（补建区块级切片要遍历文档）。它是**只回 id** 的，
  正文仍逐条经 `load()` 的 Schema 复验，避免开出第二条读取通道（§2.3 扩展现有接口 / 裁定一）。
- **实现前必须先读的实测口径**（plan §4.3 预分词小节，spike 五轮、双 runtime 逐行比对：命中行数 / token 序列 /
  `bm25()` 分值 / 报错文本全等，只差 sqlite 版本行与墙钟耗时）：
  写入侧存**有序含重复**的双字组序列（去重会让 `bm25()` 丢掉词频维度，堆叠句排不到前面）；
  查询串**逐 token 加双引号**（裸拼会让 `OR`/`NOT`/`NEAR`/括号静默改语义，多余 `"` 抛 `unterminated string`）；
  预分词后 token 数为 0 时 `MATCH ''` 抛 `fts5: syntax error near ""`，**必须在 service 入口短路成确定空态**（接 4.3-10）；
  `bm25()` 是负值且量级随语料规模漂移，绝对阈值不可移植（4.3-b 自己定义归一化，不复用 `evidenceMinScore = 0.34`）；
  词尾单字查询前缀匹配接不住（实测 `订*` 漏「提前预**订**」），所以 **FTS5 ∪ `instr` 子串**两路召回是必需项。
- **本片未收口的部分（不粉饰）**：4.3-11 只交付**切片与派生索引表**，FTS5 虚表与合并打分是 4.3-b；
  `listChunks()` 目前只用于测试与 4.3-b 的候选集，**未进 IPC 白名单、未注册 agent 工具**（对外要的是 4.3-c 的 `kb.search`，
  现在暴露切片等于开一个没人维护的入口）。4.3-01/02/03 的排序与阈值断言在本片收口时仍为 `[ ]`，由 4.3-b 交付（见下）。
- **单测覆盖**：新增纯函数侧 `chunks.test.ts` 15 例（切分口径、实体级 1:1、区块级派生与 id 稳定性），
  装配侧 `profile-service.test.ts` 的「检索切片收敛」10 例 + 迁移/回滚 2 例，
  该包 8 文件 / **154** 用例全绿；根 `pnpm typecheck` / `lint`（含渲染层规范四项机检）/ `format:check` / `test` 全绿。
  证据：`docs/acceptance/4.3/4.3-a-preseg-spike-node.txt`、`4.3-a-preseg-spike-electron.txt`
  （双 runtime 逐行 diff 只差 sqlite 版本行与性能段的墙钟耗时，两份末尾各附 DIFF 结论）。

### 4.3-b 落地记录（4.3-01 / 4.3-02 / 4.3-03，2026-10-02）

- **4.3-01 的「BM25 + 倒排检索可用」怎么成立的**：`kb.profile.search(query)` 给 `KbSearchResult`
  （`status` / `hits` / `queryTokens`），每条命中带 `score`、`bm25Score`、`lexicalScore`、`coverageReason`、
  `reasons`（`bm25` / `lexical` / `substring` 三个码，界面按码取 i18n 文案）、`matchedTokens` 与出处
  （`chunkId` / `chunkKind` / `sourceDocId` / `sectionKind`）。断言的是「相关项在前 + 每条命中的理由与命中词非空 +
  与查询无关的那条不进来」，而不是某个具体分值——分值由下面的归一化决定，绝对阈值在 4.3-e 标定。
- **4.3-02 的中文检索**：「高并发」在语料里只出现在个人简介那一段，命中它的切片 `matchedTokens` 就是 `['并发','高并']`
  （二字组切开的直接证据）；「算法竞赛」同时命中实体级与区块级两条切片（校园那条被 4.1 锁成了 `achievement` 事实，
  所以两边都有——**断言只断句子不断段头**，否则就挂在「区块切片多带公司名与时间」这种与检索无关的差异上）；
  「推荐算法」靠手工建技能实体后进检索，验的是切片与实体 1:1 对能力词也成立。
- **打分为什么在应用层（4.3-03 的前提被实测推翻过一次）**：spike6 §S1 实测 SQLite 的 `bm25(fts, 1.2, 0.75, …)`
  **不报错也不生效**——多给的数字被当成不存在列的列权重丢弃，`k1` / `b` 根本设不进去。所以 4.3-03 要的
  「k1/b 来自 config」只能由自建 Okapi BM25 兑现（`search.ts`，纯函数、不碰 SQLite），内置 `bm25()` 退居**召回排序**。
  实测同数据下自建与内置给出同一条排序（`订单` → e6 > e2 > e1），k1/b 扫描只改分值不改头部次序。
- **两路召回都是必需项**：`buildFtsQuery` 逐 token 加双引号再 `OR`（不 `AND`：部分命中也要进候选集，由分数定次序），
  `instr(norm_text, 查询串)` 接住倒排切不出来的单字与词尾字（前置事实先在库里证明 `MATCH '"订"'` 为 0 行，
  否则这条用例就没在判子串通道）。子串独召的切片靠 `substringFloorScore` 给地板分——不打这个分，
  「订」在两腿上是 0 分、会被 `minScore` 直接杀掉，两路召回等于白做。
- **归一化是绝对阈值能成立的原因**：合并分 = `bm25Weight × 归一 BM25 + lexicalWeight × 词面覆盖`，
  BM25 上界取「查询 token 数 × (k1+1)」，实测三档归一值 0.61 / 0.69 / 0.61（内置 `bm25()` 是负值且随语料规模漂移，
  所以**不复用 `evidenceMinScore = 0.34`**）。覆盖腿复用 4.2-03 的 `coverageOf`，不新写第二把尺子（§2.2 / §2.5）。
- **4.3-03 判据的 C 半边做成了永久机检**：一条用例同时读 `cordis.yml`（七个键 `searchTopK / searchMinScore / bm25K1 /
bm25B / bm25Weight / lexicalWeight / substringFloorScore` 必须真的在 `kb-profile` 段里）和
  `search.ts` / `profile-service.ts` 源码（剔掉注释行后，七个参数名一处 `<名> [:=] <数字>` 都不许出现）。
  运行期断言只能证明「传进去的配置被用了」，证明不了「默认值没长在代码里」——这条 grep 补的就是那一半。
  schema 上的 `.default(...)` 与 4.2 的 `evidenceMinScore` 同一口径，是配置文件漏写键时的兜底，不是算式里的常量。
- **倒排与主表不分离维护**：`upsertChunk` 用 `RETURNING seq`（实测新增与改文返回同一个 seq）后 `replaceFtsRow`
  ——FTS5 对复用 rowid **不覆盖**，必须先按 rowid `DELETE` 再 `INSERT`；批量删除一律走 `deleteChunksWhere`
  （先按同一谓词清倒排再删主表，顺序反了就没参照对象），`prune()` 也改成调它。
  五条写路径跑完之后 `kb_chunks_fts` 行数 === `kb_chunks` 行数、两侧孤儿均为 0，是永久机检而不是抽查。
- **`norm_text` 列与迁移 13 自回填**：子串通道必须打在**归一后**文本上（实测「p99」对原文 `instr` = 0、对归一 = 3，
  全角「Ｐ９９」只有归一后接得住），内置 sqlite 无 ICU 所以归一在 JS 里算、落成列。
  迁移 13 的 `up()` 自带全量回填（只读 `kb_chunks` 自己，不需要 `resume.doc`），`down` 只删虚表与那一列——
  **回滚不许变成破坏性操作**，回滚 13 后切片行一条不少、重新挂载即可恢复检索（两条都写成了用例）。
- **4.3-03 的「字段权重」这一半不达标，标 `[!]` 等裁定**：切片正文是 `evidenceTextOf` 拼出来的**单列文本**，
  `kb_chunks` 没有 company / title / description 这样的列可供 `bm25(fts, w1, w2, w3)` 按位置加权——
  「字段权重」在当前切片粒度下**没有落点**。两条出路：把切片拆成多列（要动 4.3-a 的表形状与 4.2 的证据口径），
  或承认这条判据在单列粒度下无意义并从 4.3-03 里删掉。**按 §0 先提出冲突**，不用「列权重」含糊替代，也不报 `[x]`。
- **标定整体推到 4.3-e（不粉饰）**：七个键当前是 Okapi 惯用值与「能同时接住两路」的保守取法，
  不是真实简历语料标定值；plan 里原本「与 k1/b 一起在 4.3-b 标定」那句只兑现了一半，
  默认值进 `cordis.yml` 而不是代码，正是为了 4.3-e 改数值不动实现。
- **本片的已知边界**：`search()` 与 `listChunks()` 一样**未进 IPC 白名单、未注册 agent 工具**（4.3-c 才开 `kb.search`
  与确定空态界面）；从库外删 `kb_chunks_fts` 的行不会被自动补回，等一次写路径或重新挂载收敛（同 4.3-a 口径）。
  日志按 4.3-12 只记「token 数 / 候选数 / 命中数 + 状态」。性能侧已确认单次查询不是瓶颈
  （2000 切片：8 次 df 查询 0ms、`OR` 召回 1ms、取候选 3ms、子串全表扫 0ms、语料统计 1ms），
  4.3-e 的 P95 要防的是长查询让 df 循环线性增长，而不是单条 SQL。
- **单测覆盖**：新增纯函数侧 `search.test.ts` 23 例（切词与转义、tf 精确性、k1 饱和、idf 稀有度、
  `b=0` 取消长度惩罚、归一上下界、空态、两腿取向、子串地板、平票按 id 破、topK 在排序之后截），
  装配侧新增「本地检索」describe 10 例（倒排收敛、排序与理由、单字/全角、确定空态、参数来自配置 + grep 判据、
  改实体后收敛、老库回填、回滚 12/13 两向）；该包 **9 文件 / 188** 用例全绿（4.3-a 时 8 / 154），
  根 `pnpm typecheck` / `lint`（含渲染层规范四项机检）/ `format:check` / `test` 全绿。
  证据：`docs/acceptance/4.3/4.3-b-fts5-scoring-node.txt`、`4.3-b-fts5-scoring-electron.txt`
  （spike6 §S1–S7 + spike7 §A–F，双 runtime 逐行 diff 去掉抬头后唯一差异是 sqlite 版本号 3.53.1 / 3.53.4，
  两份末尾各附 DIFF 结论；spike 代码按 §6.4 留在 `.research-repos/`，只有结论入档）。

### 4.3-c 落地记录（4.3-10，2026-10-02）

- **一个 `search()`，两个入口（裁定三 / §5.9 的第三次兑现）**：`kb.profile.search` 与 `kb.profile.list` 一样，
  在 service 自己的 `[Service.init]` 里经 `registerAgentTools` 登记（`effect: 'read'`、`requiresConfirmation: false`），
  IPC 侧走 `RENDERER_ALLOWLIST` 的 `kb.profile.search`。活体实测 `agent.tools.list()` 11 只里含它，
  且 `window.autoCC.kb['profile.search']('订单')` 与 `agent.tools.call('kb.profile.search', {query})` 的整段 JSON
  **逐字段相等**（`uiAndToolIdentical=true`）——界面检索框、agent 工具、4.5 的事实锁定读的是同一条通道，
  没有第二套查询。
- **空态是返回值，不是入参错误（4.3-10 的关键取舍）**：工具入参用 `z.strictObject({ query: z.string() })`，
  **刻意不设 `.min(1)`**。注册表的 `call` 在 `safeParse` 失败时回 `TOOL_INPUT_INVALID`，若把「切不出词」交给 schema，
  两种态会被吃成同一个错误码，agent 就分不清「换个词再问」和「这只工具坏了」。
  现在两条码各自独立：`no_query_tokens`（查询侧无效）与 `ok` + `hits: []`（库里确实没有），
  界面各自一屏文案（`data-kb-search="no_tokens"` / `"empty"`），且都带**可行动建议**而不是「无结果」了事。
- **「不返回随机结果」做成了可复跑判据**：排序键是分数，分数由库内统计量（N / df / avgdl）决定，算式里无随机项；
  同一份库同一查询连打两次整段 JSON 相等。顺带记下一条容易被误读成抖动的性质：**分数随语料变化**——
  中途新建一条实体后「订单」的首条分数从 0.6585 变 0.6829，这是 BM25 定义的一部分，不是不稳定（证据 [5]）。
- **界面侧两条既有纪律，不新长一套**：出处标签复用 `resume.kind.*` 的既有词条（§2.5，区块切片的段名不再翻第二遍），
  理由码新增 `kb.searchReason{Bm25,Lexical,Substring}` 三键并同补中英双语（缺翻译即 lint 失败）；
  收到 `kb/entities-changed` 时**清空上一批检索结果**（`data-kb-search*` 归 0），避免库改了、命中清单还是旧的——
  输入框文本保留，原样再打一次即可。
- **倒排维护在真实写入路径上复验了一次**：界面上新建的手工实体立刻可被检索到（「离线检索失效验证」命中 1 条，
  命中词是它的二字组集合），不需要重启或重新同步（证据 [7]）。
- **本片的已知边界**：检索区只到「给出命中与分数」，**没有做分页/翻页**（`searchTopK` 默认 8 条，超出即截断，
  与 4.3-b 的口径一致）；命中行不可点进实体树（`chunkId` 对实体切片就是 `entityId`，对区块切片则不是，
  跳转会指到不存在的行——等 4.4/4.5 需要「从命中回到上下文」时再一起定这层的形状）。
- **单测覆盖**：`profile-service.test.ts` 新增「工具面登记与 service 直调逐字段相等 + 空态是值不是错误」1 例
  （沿用 4.2-d 的 `FakeAgentToolsService` 替身，零键配置用 `NO_CONFIG` 挂载）；该包 **9 文件 / 189** 用例全绿，
  根 `pnpm typecheck` / `lint`（渲染层规范：2 语言包 / 22 源文件键对齐）/ `format:check` / `test` 全绿。
  V 证据：`docs/acceptance/4.3/4.3-10-search-hits.png`、`4.3-10-search-no-tokens.png`、`4.3-10-search-empty.png`、
  `4.3-10-search-hits-en.png` 与 `4.3-10-dom-assertions.txt`（八段读数，含活体工具面与英文态）。
  **harness 实测补一条**：`window.autoCC.*` 的返回是 `{ ok, value }` 信封，而渲染层拿到的 `bridge` 已解包一次；
  `agent.tools.call` 的 `value` 里还套一层 `{ ok, value }`——在页面里做等价性断言要**解两层**，
  只解一层会得到 `uiAndToolIdentical=false` 的假阴性。

## 4.3-d 落地记录（4.3-08 / 4.3-04，2026-10-02；4.3-07 记 BLOCKED）

- **判据的拆法**：4.3-07 的原文是「融合 + **结果优于纯 BM25（固定评测集上）**」，后半句要真 key 与评测集，
  所以本片只把**机制**做完并证死（RRF 算式、融合只改名次不改读数、向量腿五态、失败路径零写入），
  量化增益整条标 `[!]`，复跑步骤写在 plan §4.3-d 的「待真端点」小节；4.3-08 的两个判据（失败路径无 BLOB 写入、
  grep 无哈希冒充向量）都是**离线可证**的，本片收口为 `[x]`。
- **4.3-04 的「断网冒烟」换成了更强的判据**：不是把网线拔了再跑，而是**这条路径根本不产生请求**——
  `llm-embed` 三项缺一即 `available: false`，检索侧看到 `unavailable` 直接走纯词面（活体日志：启动一条
  「向量出口未就绪…」、每次检索一条「向量腿 unavailable / 语义名单 0 条」，全程 0 次出网）。
  不出网所以断不断网等价，这一条比原判据覆盖面更大；比对腿本来就不碰模型（3.7-03 / 4.2 的快照 diff 已验）。
- **`unavailable` 与 `no_vectors` 是两件事，各自短路在不同位置**：前者是「向量出口没配好」（`EmbedGateway.status()`
  三项缺失），后者是「出口能用、但当前 model 在 `kb_vectors` 里一行都没有」。第二种**故意不发查询向量**——
  库里没货时把 query 编码一次等于花一次钱买一个必然空的名单。加上 `failed`（请求真出错）、`ok`、
  `not_attempted`（查询切不出词，在 SQL 与网络之前就返回），五态一起进 `KbSearchRowResult.vectorStatus`，
  界面单独一行、日志单独一条（`…（ok · 向量腿 unavailable / 语义名单 0 条）`）。
  **降级必须看得见**：用户看到的排序少了哪一腿，是这一片唯一的交付物。
- **`kb_vectors` 空表是正确状态，不是待办**：它是派生索引（float32 小端 BLOB + `model` 作失效键），
  向量**永不在启动或同步时自动补建**——补建要出网、要花钱，所以只有 `kb.profile.syncVectors` 这一只
  `effect: 'outbound'` / `requiresConfirmation: true` 的工具能做，且它**不在 `RENDERER_ALLOWLIST` 里**
  （活体实测 `window.autoCC.kb['profile.syncVectors'] === undefined`）。这条取舍与 §7.3「外发必经闸门」同源：
  界面能读、能显示降级，但不能替用户决定出一次网。
- **融合不改动既有读数（本片最重要的回归保护）**：`fuseByRrf` 只重排名次，`score` / `bm25Score` /
  `lexicalScore` / `text` 一律原样；只被向量捞到的命中从 `kb_chunks` 反查补正文，**不受 `minScore` 约束**
  （词面分数为 0 是「词面没查到」，不是「质量差」，用词面闸门拦它是类别错误）。活体复跑：无向量腿时
  「订单」首条仍是 **0.6829 / 0.6034**，与 4.3-c 归档逐位相同——「可选增强」真的是可选，接不上就等于本片不存在。
- **迁移号段 14 打在真实旧库上**：验收用的 `tmp/43c-userdata` 带着 4.3-c 时期的 11/12/13 与 7 条实体，
  重启后 `PRAGMA user_version` = 14、`kb_vectors` 五列建好、`kb_chunks` 8 行而 `kb_vectors` **0 行**
  （升级 + 不自动补建同时成立）。`store.rollback(12)` 的降级面在单测里覆盖（回滚顺序 [14, 13]）。
- **两处与 plan §4.3-d 原稿的偏离（以代码为准）**：① 配置键**不带 `embed` 前缀**——plan 里写的
  `embedBaseUrl` / `embedModel` / `embedKeyEnv` / `embedDimensions` / `embedBatchSize` 落成为 `llm-embed` 块内的
  `baseUrl` / `model` / `keyEnv` / `dimensions` / `batchSize`，块名已经给过这层信息，再加前缀是同一件事说两遍；
  ② `timeoutMs` **不复用 `llm.chat` 的 8000**，向量侧自己一个键、默认 **15000**——一整批（`batchSize` 默认 16）
  切片的编码耗时随批大小线性增长，沿用聊天默认值会把「批量」变成「批量超时」，而超时是不可重试的静默降级。
  两处都是实现期决定，写在这里是为了让 plan 与代码不各说一套。
- **`check-llm-single-entry.ts` 加了一条测试替身豁免**：provider 计数只算**真实实现**（`*.test.ts` 里的
  `provide = 'llm.embed'` 替身不计入），否则「一个名字只有一个声明者」这条断言等于禁止给 `llm.embed` 写用例；
  **端点痕迹那一断言不豁免测试文件**，替身里出现 `embeddings` 字样照样红。
- **单测覆盖**：`vectors.test.ts` 13 例（float32 字节往返 / 余弦的长度无关性与零向量 / `rankByCosine` 排序、
  截断、坏行跳过），`search.test.ts` 新增 6 例 RRF 纯算式（含 `rrfK` 在 1 与 60 之间**名次翻转**的反例），
  `profile-service.test.ts` 新增「向量补建与 RRF 融合」11 例（含失败路径零 BLOB 写入、`no_vectors` 零请求、
  九个检索参数的 grep 判据）；该包 **10 文件 / 220** 用例全绿，根 `pnpm typecheck`（0 error）/
  `lint`（四项检查全过，含 LLM 入口唯一性）/ `format:check` / `test` 全绿。
  V 证据：`docs/acceptance/4.3/4.3-08-vector-status-zh.png`、`4.3-08-vector-status-en.png`
  与 `4.3-08-dom-assertions.txt`（七段读数：界面两语态、IPC 同源、日志零上行、迁移 14 打在旧库、
  工具面 12 只含 `syncVectors` 外发口、`not_attempted` 整行不出现、i18n parity 由类型面强制）。

## 4.3-e 落地记录（4.3-05 / 06 / 09 / 12，2026-10-02）

- **4.3-05 / 06 从"人肉看一眼"变成常驻机检**：spec 原本的验证操作是 `pnpm why chromadb`，那是一次性快照——
  下一次顺手 `pnpm add` 就作废了。现在落在 `scripts/check-dependency-floor.ts`，接进 `pnpm lint` 链的末位，
  三层各管一段：**声明层**（根与每个 `packages/*/package.json` 的四类依赖表）、**解析层**
  （`pnpm-lock.yaml` 全量包名，传递依赖也拦得住，且不依赖本机装没装）、**搬运层**
  （`scripts/vendor-runtime-deps.ts` 的 `resolveRuntimeDeps()` 闭包 = 用户真正拿到的那 25 个外置包，
  逐个文件挑 `.node/.dll/.so/.dylib/.o/binding.gyp`，逐个包挑 `preinstall/install/postinstall`）。
  搬运层读的是构建脚本同一个真相源（§2.1 复用，与 1.7-15 的白名单审计同源），不是再手填一份清单。
- **一条写进代码的边界：解析层只判能力类禁令**。锁文件里本来就有的 dev-only 传递原生链路
  （`node-gyp` 与 pdfjs optional 的 `@napi-rs/canvas` 家族，共 14 个包名）**记为提示、不记失败**——
  lint 不该宣布"npm 生态里不许有编译工具"，它们会不会到用户机上由搬运层判。这条放宽写在脚本头注释里，
  而不是悄悄把规则调松，因为下一个人需要知道机检守了什么、没守什么。
- **三层都造过一次违规输入证明"绿"是测出来的**：临时给 `resume-kb` 加 `"better-sqlite3"` → 声明层红；
  临时往锁文件末尾加 `@zilliz/milvus2-sdk-node` 包键 → 解析层红；临时放一个带 `install` 脚本与
  `prebuilt.node` 的假装机包 → 搬运层同时给两条红。改动跑完即还原，还原后 `git status` 与改动前逐字一致。
  实测读数：25 份清单 / 锁文件 544 个包名 / 25 个装机依赖共 1476 个文件，全部零命中。
- **4.3-09 的基准为什么不用 4.3-a 的数字**：那轮 spike 只有「FTS5 双写 11.1ms、单次查询 0.30～0.61ms」，
  覆盖不到真链路里的预分词、候选取数、应用层 BM25 重算、词面覆盖、子串腿、排序、视图片装配这七步，
  拿它当验收等于用零件重量冒充整车称重。`pnpm bench:kb` 打的是**真实 `search()`**：1500 条切片经
  五条写路径的真实事务灌库（844～892 条/秒），预热 22×11 轮不计入，再取 240 个样本
  （几十次采样时 P95 就是最大值，读数没有意义）。两次连跑 **P95 = 7.76ms / 7.49ms**，预算 150ms → PASS，
  余量两个数量级，所以按 plan 的边界**不做任何投机性优化**，读数入档即止。
- **语料确定性是这条判据能被复跑比对的前提**：混合进制组合（六张词表、乘积 147456 > `chunks` 上限），
  不用 `Math.random`；词表越界直接抛而不是补空串——空串会悄悄产出一堆雷同句子，把负载测轻。
  脚本自己判三件事（任一不过 exit 1，不等人工读表）：P95 ≤ 预算、`globalThis.fetch` 存根零调用、
  `kb_chunks` 与 `kb_chunks_fts` 行数都等于配置值且孤儿倒排行 0。
- **预算放 `cordis.yml` 的 `bench:` 段而不是放 `kbProfileSchema`**：往插件配置里塞一个只有验收脚本会读的键
  是 §2.6 禁止的死配置（运行期没人用它）；而 `parseManifest()` 只认 `plugins` 数组、多余顶层键原样忽略
  （证据 `manifest.test.ts:200`），所以基准直接读同一份清单的顶层 `bench.kb-search`，
  检索参数仍经 `ConfigService.resolve()` 分层解析——一套配置系统（§2.7）没被破坏，
  而且基准跑的就是 app 平时那套装配参数（含 `wal` 日志模式）。
- **4.3-12 的判据做成双向，防的是"假通过"**：只断言"日志里查不到正文"会有一种蒙对的方式——日志压根没写。
  所以两条用例都要求那条检索计数行**必须出现**（`检索 N 个 token / M 条候选 → K 条命中（status · 向量腿 … / 语义名单 X 条）`），
  再要求切片正文短语、姓名、手机号、查询原文一律查不到。查询词故意选成与正文同串（「主导订单服务重构」），
  一条断言同时锁死"不记查询原文"与"不记命中内容"；实现比 spec 允许的范围（只记查询与命中 id）更严。
  装配用真临时目录 + 真 `node:sqlite` + 真 `LogService` 落盘文件，且 `redact: false`——不靠日志服务的脱敏兜底，
  要求写日志的调用点本身就不带原文。覆盖 `sync / create / update / remove / 导出 / 导入 / 反查 / 检索正常态 /
向量编码失败的 warn 退回态`。补充读数：4.3-09 那轮跑完留下的 1987 行真实日志里，
  grep 那 1500 条正文用到的词（星桥科技 / 沧海数据 / 高并发 / 订单服务 / P99）**全部 0 次**。
- **两处实现细节是为"读数的可信度"服务的**：① `bench.ts` 每次先 `rmSync` 整个基准目录再建库，
  否则上一轮的实体会让「库内行数 == 配置值」这条判定变成偶然成立；② 日志断言用轮询等到
  最后一次操作的日志行出现再读文件（`createWriteStream` 只保证入队顺序、不保证同步可见），
  固定 sleep 要么慢要么不稳，而写流内顺序保证它之前的行都已刷完。
- **单测与门**：`profile-service.test.ts` 75 例（新增 2 条 4.3-12 用例）、该包 10 文件 / 222 例全绿；
  根 `pnpm typecheck`（0 error）/ `lint`（**六项**检查全过，末位是本轮新增的离线依赖门槛）/
  `format:check` / `test` 全绿，`pnpm bench:kb` exit 0。
  证据：`docs/acceptance/4.3/4.3-09-p95-benchmark.txt`、`4.3-05-06-dependency-floor.txt`、
  `4.3-12-log-desensitization.txt`。
- **4.3 的收口状态**：12 条里 10 条 `[x]`，`4.3-03` 与 `4.3-07` 保持 `[!]`——两条卡的同一件事：
  参数标定与量化增益都要一个**真 embedding key + 固定评测集**，本机没有（AGENTS.md §9 的诚实边界），
  复跑步骤写在 plan §4.3-d / §4.3-e。机制侧本轮已全部证死，key 到位后的动作是跑评测、改 `cordis.yml`，不改代码。

## 4.4 JD → 能力要求拆解与缺口比对

| ID     | 验收标准                                                                    | 方式 | 验证操作                                 | 状态 |
| ------ | --------------------------------------------------------------------------- | ---- | ---------------------------------------- | ---- |
| 4.4-01 | 从 JD 文本拆出能力要求列表（硬技能/软技能/学历/经验年限），带原文引用位置   | U    | 固定样例 JD 断言                         | [x]  |
| 4.4-02 | 拆解失败或 LLM 不可用时回落关键词抽取，功能不中断                           | U+V  | 断网断言仍产出粗粒度要求 + 界面提示      | [!]  |
| 4.4-03 | 三态比对：命中 / 部分命中 / 缺失，每项都附证据实体 id                       | U    | 断言三态与引用                           | [x]  |
| 4.4-04 | 反向比对：库内具备但 JD 未提的相关能力，作为差异化亮点候选输出              | U    | 单测                                     | [x]  |
| 4.4-05 | 缺口报告界面可读（分栏 + 证据链跳转），文案 i18n                            | V    | 截图两栏 + 点击跳转                      | [x]  |
| 4.4-06 | 报告不得只输出负面结论（缺失项必须同时给出可用证据或补救建议）              | C    | 输出结构断言：缺失项必带 suggestion 字段 | [x]  |
| 4.4-07 | 比对结果稳定：同一 JD + 同一库重复运行输出一致（无随机抖动）                | U    | 两次运行 hash 相同                       | [x]  |
| 4.4-08 | JD 输入使用本地样例文件，**测试不访问真实招聘平台**                         | C    | URL allowlist 复跑（AGENTS.md §7.2）     | [x]  |
| 4.4-09 | LLM 调用若计入额度（如后续付费）必经 `entitlement.gate`，本地调用不误扣额度 | C    | 断言 ledger 行为符合配置                 | [x]  |
| 4.4-10 | 抽取来源标注与许可判定记录（对齐 `ai-resume` prompt 风格借鉴，未复制文本）  | C    | 文件头核对                               | [x]  |

### 4.4-a 落地记录（4.4-01 / 07 / 08 / 10 的词面腿，2026-10-02）

- **4.4-01 做到了哪一步**：`kb.gap.extract(jdText)` 返回四类齐全的稳定序列，每条带 `kind / label / quote /
start / end / years / via`。判据不是"条数看起来对"而是**位置可反查**——用例与验收脚本都逐条断言
  `SAMPLE_JD.slice(start, end) === quote`（18/18 一致），因为 4.4-05 的界面高亮与证据链跳转吃的就是这两个下标。
  偏移口径是 **JS 字符串下标（UTF-16 code unit，end 不含）**，不是字节偏移：消费方全在 JS 字符串上操作，
  换一层字节只会引入错位。
- **词面腿的定位是"回落"而不是"完整拆解"**（这条决定 4.4-02 后面怎么验）：它只认「JD 里出现了词表里就有的词」。
  61 组代表词（硬技能 46 / 软技能 10 / 学历 5）+ 一条年限正则；中文 JD 的长尾表达（「熟悉分布式家族那一套」）
  它抓不到，那归 4.4-b 的模型腿。词面腿**故意宁可漏**：单字母语言（C / G / R）不进词表——「3C 数码」「C 端」会误捡，
  而漏一条只是报告短一些，错一条是凭空给用户造一个缺口（§8.4 同一立场）。
- **三处误伤路径各有用例钉住**（原稿没写，实现时才撞出来的）：纯字母别名加词边界，于是 `NoSQL` 里不捡 SQL、
  `logo` 里不捡 Go、`JavaScript` 不会被 Java 抢占（长别名先占位 + 区间不重叠）；年限正则带 `(?<!\d)`，
  于是「2020 年 3 月 1 日」不会被读成 20 年经验；空文本与全空白是**合法读数**（空列表、零丢弃、不抛异常），
  "JD 太短"这件事由服务在系统边界判（过短抛 `INVALID_ARGUMENT`，而不是给一份看着干净的空报告）。
- **4.4-07 的稳定判据落在拆解层**：同一 JD 连跑三次 sha256 逐字相同（验收脚本里两次运行同一串
  `50327bd7…ba46298`），序列次序是「四类表书写序 → 原文起始下标」，词表次序由「别名长度 → 字典序」排序定死，
  与源码里的书写顺序无关；不依赖 `Date.now`、不依赖对象遍历序、不用 `Set` 的迭代序做判定。
  **注意本条现在只覆盖"同一 JD + 同一库"的前半**：比对腿（4.4-c）接上后再复跑一次全链 hash。
- **4.4-08 是结构性成立**：`KbGapService` 不 `inject` `store` 与 `llm.*`，测试装配只挂 `config + logger + kb.gap`，
  这条链根本没有出网入口；两份用例的 JD 都是**写在文件里的虚构字面量**（虚构公司「星桥科技」、虚构手机号
  13800002222），`grep -n "http"` 在这两个文件 0 命中。零上行机检在 `pnpm lint` 里同轮复跑
  （LLM 入口唯一性：扫描 274 个文件）。4.4-e 会按本条判据把 allowlist 在全链上再复跑一次。
- **4.4-10 核对的是"借鉴到了哪一层"**：`requirements.ts` 头注释写明四类口径参考
  `.research-repos/src/ai-resume-master/server/src/prompts/jdParse.ts`、比对做法读自同仓库 `keywordService.ts`，
  并声明未复制任何文本；许可记账指向 `docs/research/source-repos-analysis.md` §1.1（README 写 MIT、
  `server/package.json` 写 ISC、**无 LICENSE 文件**）与 §1.2（版权方书面豁免）。反向核对也做了：
  那份 prompt 里的字段名（`hard_skills` 等）与示例句一个都没进本仓库代码，本项目用的是自己的中文 label 与别名组。
- **顺手把 4.3-12 的脱敏口径延到了 JD**：服务只落一行 `[kb-gap] 词面拆解 N 字 → 硬技能 a / 软技能 b / 学历 c /
年限 d（丢弃 e，词表 lex-v1）`，错误路径同样只带字数；验收脚本对日志文件 grep 四个哨兵（公司名 / 正文长句 /
  软技能词 / 硬技能词）全部 0 次，`redact: false`——不靠日志服务兜底，要求写日志的调用点本身不带原文。
  轮询等日志行的 helper 这次被第二处用到，按 §2.2 从 `profile-service.test.ts` 抽进 `log-file.ts`，
  原处 75 例改用它后仍全绿。
- **不建新表**（plan §4.4 证据 [4]）：`jobs.requirements_json` 是 2.3 从页面 DOM 原样抓的要求标签，那是页面真相；
  把派生结果写回同一列就是造第二个真相源（4.2-11 / §2.7）。迁移号段 15 本片空着，拆解用时现算。
- **单测与门**：`requirements.test.ts` 11 例 + `gap-service.test.ts` 5 例，本包 12 文件 / 238 例全绿；
  根 `typecheck`（0 error）/ `lint`（六项全过）/ `format:check` / `test` 全绿。
  证据：`docs/acceptance/4.4/4.4-01-lexical-extraction.txt`。
- **本片没有的四条**：4.4-02（回落要有"模型腿"才谈得上回落）、4.4-03 / 04（比对腿）、4.4-05 / 06（报告与界面）、
  4.4-09（额度接线）一律保持 `[ ]`。界面与 agent 工具面按 §5.9 一起在 4.4-d 接，
  本片的 `kb-gap` 在装配里可解析但**暂无调用方**——这是 4.2-a 用过的「先可见地空着」处理，不是漏接。

### 4.4-b 落地记录（4.4-02 的 U 半边：模型腿与可见回落，2026-10-02）

- **「功能不中断」的实测形状是指纹相同**，不是"没抛异常"。真装配（`ConfigService + LogService +
LlmChatService + KbGapService`）跑五种结局：`unavailable / failed / rejected / disabled` 四种交回的
  `items` 序列 sha256 都是 `d668f55a7d54d3f7`，与"完全不问模型的词面基线"逐字相同；第五种 `merged`
  只增不减（`752f3c49a71c6721`，词面 6 条一条没少 + 模型补 1 条长尾）。因此回落不靠 try/catch 兜住就算数，
  判据是**产出没被模型腿污染或削减**。唯一例外是 `INVALID_ARGUMENT`（我们把请求拼错了），照旧上抛——
  回落不该掩盖自己的 bug，与 `outbound.script` 同一口径。
- **五态而不是两态**（与 2.5-01 话术回落的形状差异，记在这里防止后来者合并两者）：话术那侧的回落是
  **换产出者**（模型不行本地模板出文案），拆解这侧的回落是**减少产出**（模型不行只交词面基线）。
  界面 4.4-d 要按这五态出五句文案，所以 `modelStatus + modelReason + modelAdded + modelDropped`
  四个字段随结果返回，且非 merged 那一路日志级别是 **WARN**（"没用上模型"在日志里也要显眼）。
- **模型说的位置一律不信**：`start / end` 由本仓库在自己那份 JD 原文上 `indexOf` 算出来；算不出来的条目
  **丢弃并计数**，绝不保留一条无据的要求（§8.4 在本条的对应物）；`experience_years` 的数字从定位到的那段
  原文里重新取，不采信模型自己填的 `years`；模型重复认领同一区间时只留第一条。本轮 fixture 三声明
  → 采信 1 / 丢弃 2（一条引文原文里没有、一条与词面腿重label），`modelAdded=1 · modelDropped=2` 就是这条判据的读数。
- **合并结果与词面基线一起重排，不是追加**（纠正 4.4-a 初稿设想）：稳定序是「类别 → 原文起始下标」，
  长尾引文完全可能落在 `Java` 前面，追加会让同一个 JD 的序列随模型给的次序抖动。
- **模型腿是软依赖**：经 `core` 的 `chatGatewayOf(ctx)`（与 `embedGatewayOf` 同形状的 L0 网关形状）
  **用的时候按名字现问**，`KbGapService` 不 `inject` `llm.chat`。两个理由叠在一起：4.4-02 要判"装配里
  没有 llm 那一行时功能照常"（硬 inject 会让 `kb-gap` 永远 PENDING），以及 AGENTS.md §9 的 2.5-e 实测
  （改配置会重建下游插件，本地缓存的第二份事实会静默变空）。`ChatStatusView` 刻意**不含 endpoint**，
  零上行机检按这条扫。
- **参数进配置**：`modelTemperature: 0`（拆解是读数不是创作，4.4-07 的稳定判据）、`modelMaxTokens: 1200`、
  `allowModelLeg: true`；提示词版本常量 `jdreq-v1`，且**只在真问过模型之后才播报**——第一轮真装配实测到
  `unavailable` 那一路的日志行仍写着"提示词 jdreq-v1"，等于播报了一个根本没发出的东西（详见 plan §4.4-b 落地记录）。
- **标 `[!]` 而不是 `[x]` 的两条原因**（不粉饰）：① 条目是 U+V，V 半边（界面上那句可读的回落提示）
  按切片表归 **4.4-d**，本片只到服务与结果层；② 本机 `AUTO_CC_LLM_API_KEY` 未设置，`merged` 那一路打的是
  **本地 fixture 端点**（§7.2 禁的是真实招聘平台，这里也没有任何外发），它证明请求体形态、OpenAI 信封解析、
  契约校验、定位、合并、五态播报全链穿通，**不证明**真实模型的召回质量与 JSON 合规率——真 key 到位后的
  复跑步骤与要记的读数写在证据文件第 6 节。
- **单测与门**：`requirements-model.test.ts` 13 例 + `gap-service.test.ts` 14 例（由 5 例扩），
  `requirements.test.ts` 11 例原样复跑；本包 13 文件 / **260 例**全绿，根 `typecheck` / `lint`（六项机检，
  其中 LLM 入口唯一性扫 276 个文件）/ `test` 全绿。`format:check` 在收口轮红过一次，红因是本片追加进
  plan 的那张表未按 prettier 对齐，`--write` 该文件后复跑通过（第一轮的四条 lint 红因与一条既有并发抖动
  见证据）。证据：`docs/acceptance/4.4/4.4-02-model-leg-fallback.txt`、`docs/acceptance/4.4/4.4-b-gates.txt`。
- **本片没有的**：4.4-03 / 04（比对腿，4.4-c）、4.4-05（缺口报告界面，4.4-d）、4.4-06（缺失项必带
  `suggestion`——那是**比对产物**的结构判据，词面与模型两条腿都只是拆解，不能提前打勾）、
  4.4-09（额度接线）一律保持 `[ ]`。迁移号段仍停在 14，15 空着：4.4 的拆解不落库（plan §4.4 口径 3）。

### 4.4-c 落地记录（4.4-03 / 04 / 06 的比对腿，2026-10-02）

- **四类要求不共用一把尺子**（4.4-03 的实现形状，plan §4.4-c 判据一）：技能类走 4.2-c 的 `coverageOf`
  token 覆盖；`experience_years` 走**月区间合并后的算术**——JD 写「3 年以上经验」、库内写
  「2021.07-2024.06」时两边零共同 token，词面尺子在这里只能给 0 分假读数；`education` 走**档位比较**
  （`EDUCATION_TIERS`：大专 1 / 本科 2 / 硕士 3 / 研究生 3 / 博士 4），证据落在 `kb_chunks` 的 section
  切片上（4.2 裁定二：学历不产实体行），所以 `evidence.origin` 是 `section_chunk` 而不是 `entity`。
  档位表外的学历 label（模型腿会产「中专」）**退回文本反查，不猜一档**。
  本片**没有新增任何相似度算法**，自写的只有区间合并、档位比较、两道闸编排（§2.1/§2.2）。
- **「今天」是入参不是时钟**：`report(jd, filter, nowMs)` 把月份索引一路传到比对层，「至今」夹到它。
  为的是 4.4-07 在跨月重跑时仍然成立——内部读 `Date.now()` 的实现会让同一份 JD + 同一个库
  在月初翻脸，而且这种抖动只在月末复跑时才看得见。真实装配两次 `report()` 的整份视图 sha256
  均为 `260f1b58202d4e44aa8e9e469a3f207b07c4e6a454e4e6bfec79ef750c25b1ff`（含 `asOfMonth` 一起进 hash）。
- **反向比对要两道闸**（4.4-04 的判据，plan §4.4-c 判据三）：第一道「JD 没提」（对全部要求的覆盖率
  < `evidencePartialMinScore`），第二道"与这个岗位有关"（对 **JD 全文**的覆盖率 ≥ `highlightMinScore`）。
  只开第一道会把「C1 驾照」「英语六级」推成差异化优势——那比"没有亮点"更糟。候选还只从
  `skill` / `achievement` 里出，`maxHighlights` 截断的条数随报告返回（`highlightsDropped`），不静默丢。
  真机读数：两条候选 0.1429 / 0.125，门槛 0.12 的余量很小，所以**未标定的风险集中在这一项**，
  4.4-e 标定时的首要对象就是 `highlightMinScore`。
- **4.4-06 做成结构断言而不是内容断言**：每一行 `state !== 'matched'` 必带 `suggestion`，
  且建议只有 `{ key, params }`——五个 key（`add_evidence / strengthen_evidence / years_gap / education_gap /
education_missing`）**在 service 层不拼中文**。这同时兑现 §5.5（页面文案全走 i18n，服务端拼好的句子是
  机检扫不到的裸文案）与 §5.7（动态值进 params，不同语言语序不同）。partial 给 `strengthen_evidence`
  并**带 `evidenceId`**（库里有可用的料，建议是"把它写得更实"），missing 才给 `add_evidence`；
  `education_missing` 与 `education_gap` 分开是为了不把"没填"读成"不够格"。
- **missing ⇒ 证据恒为空**是本片自己立的不变量，代价是一条用例红过：「起点在未来的区间直接不计」
  最初要求 12 年却断言该行带证据——砍掉未来段后确实不够，该行按规格就是 missing。
  **改的是用例不是实现**（把要求改成 1 年）；反过来改实现就得删掉"塞一条弱据圆场"那条判据，那是自证。
- **库缺席与模型缺席是两种处置**：`kb.profile` 没装配 → `AppError('KB_LIBRARY_MISSING')`，
  因为报告**没有可比对象**，此时给一份"全是缺失"是把"库里没东西"说成"你不行"；
  `llm.chat` 没装配 → 只降级成 `unavailable`（4.4-02），词面基线照常。错误消息同样脱敏
  （实测：消息里含 JD 正文 = false）。`KB_LIBRARY_MISSING` 与 `KB_SOURCE_MISSING` 分两个码，
  是因为处置不同：前者用户能自己去导入，后者界面只能报"功能不可用"。
- **不落库**（plan §4.4 口径 3）：报告是拆解 + 比对的**可重算投影**，迁移号段仍停在 14、15 空着。
  落库会造出 `jobs.requirements_json` 之外的第二个真相，而阈值一改它立刻失效。
- **日志口径延续 4.3-12**：`[kb-gap] 比对：要求 N 条 → 命中 a / 部分 b / 缺失 c · 亮点候选 x（丢弃 y） ·
库内实体 z 条 · 经验合计 m 月 · 截至 YYYY-MM`，只有计数与年月；六个哨兵
  （`13800002222 / 星桥科技 / 抗压能力 / 订单服务重构 / Java / 推荐接口`）在整份日志里各命中 **0 次**。
  一条都没命中时那一行走 **WARN**——全是缺失的报告是产品最该显眼的时刻。
- **单测与门**：`requirements-compare.test.ts` 26 例（新增文件）+ `gap-service.test.ts` 由 14 例扩到 23 例；
  本包 14 文件 / **295 例**，仓库 21 包 / 83 文件 / **1184 例**全绿。六条门禁：`typecheck` / `lint`
  （LLM 入口唯一性扫 278 个文件）/ `format:check` / `test` / `bench:kb`（p95=7.64ms，预算 150ms，`fetch` 0 次）
  收口轮全 0；前三轮的红因（8 个 typecheck error、1 条 unused 形参、1 条用例判错方向）逐条记在证据里。
  证据：`docs/acceptance/4.4/4.4-03-three-state-comparison.txt`、`4.4-04-reverse-comparison.txt`、
  `4.4-06-suggestion-structure.txt`、`4.4-c-gates.txt`。
- **本片没有的**：4.4-05（缺口报告界面：分栏 + 证据链跳转 + i18n 文案，V 类）与 4.4-02 的 V 半边
  一起在 **4.4-d** 接，§5.9 的双入口（界面 + agent 工具）也在那一片；4.4-09（额度接线）与阈值标定归
  4.4-e。五个 suggestion key **尚无语言包文案**，这是按切片表留给 4.4-d 的动作，不是遗漏。

### 4.4-d 落地记录（4.4-05 的界面与双入口 + 4.4-02 的 V 半边，2026-10-02）

- **界面只摆事实，不做二次判定**（plan §4.4-d 判据二）：`GapPanel.tsx` 拿到的 `rows` 已经是
  「四类表次序 → 原文起始位置」的稳定序列，三栏按 `row.state` 分桶**不重排**，栏头计数直接读
  `report.counts`。栏内顺序等于要求在原文件里出现的顺序——界面再排一次，4.4-07 的"同一输入两次读数一致"
  就有了第二个可能漂移的地方，而它没有任何补偿价值。
- **三栏是三种状态，不是三种性质**，所以色带按 `state` 给、不按 `score` 给。这条在页面上的具体形状是
  年限行：`bestScore 0.59 < hitMinScore 0.62` 却判 `matched`（年限走月区间算术，不走 token 覆盖，
  见 4.4-c 判据一），若按分数上色就会把"够格"染成玫红。界面对这一行额外播一句
  「年限行的分数只作展示，色带按状态给」，因为把 0.59 摆在命中栏里不解释就是可疑。
- **证据链跳转是"就地展开"，正文另问一只手**（判据三）：报告里的证据只有 `{id, origin, score, matchedTokens}`，
  点开才调 `kb.profile.evidenceBody(id)`。这是本片**唯一新增的公开读口**，返回 `null` 而不是抛错——
  报告是旧读数而那条依据已被删掉是正常态，界面据此播「这条依据在库里已经找不到了」。
  `RENDERER_ALLOWLIST` 净增 2 条（`kb.gap.report` / `kb.profile.evidenceBody`），
  每条都有 `BridgeSignaturesCovered` 要求的签名；不新开窗、不跳路由（桌面 app 里为一段正文换视图是倒退）。
  实体与切片两类 id 走同一只手、不问前缀——"这是实体还是区块"是服务侧的事实，界面不需要复制一份。
- **两类 origin 都真跳得动**（真机，`tmp/dom-evidence.js`）：`kb-ba545af11d6c16b5 → "Java"`（entity），
  `kbs-f9eccc4cf5cb30c6 → "本科 / 软件工程 / 2017-09 - 2021-06 / 江海大学"`（section_chunk）。
  后者在页面上出现**两次**——`本科`（命中）与 `硕士`（部分命中 0.67）指向同一条学历区块，
  这正是 4.2 裁定二（学历不产实体行）在界面上的后果，也是"凭什么叫部分命中"可查的证据。
- **库缺席与模型缺席是两种空态**（判据四）：`KB_LIBRARY_MISSING` 给的是「还没有可比对的知识库：先在下方
  「知识库实体」面板导入简历并同步，再回来比这份 JD。这不是「你不合格」，是根本没比过。」，
  与"拆不出要求"（`no_requirements`）、"库里没实体"（`no_entities`）三个确定空态分开。
  `kb-gap` 的 `[Service.init]` 因此**不** `dependsOn: [kb-profile]`（`cordis.yml` 未改动）：
  硬依赖会让整个服务起不来，界面只能播一句"服务没起来"，而用户能自己做的那件事（导入简历）就没人告诉他了。
  真机验证方式是把 `kb-profile` 停掉再点比对（截图 5），同时证明旧报告在 `kb/entities-changed` 后被清掉。
- **建议句在服务层是 `{key, params}`，中文只在语言包里**（判据五）：五个 `gap.suggestion.*` key
  在 zh-CN / en 两份齐全，`pnpm lint` 的渲染层机检只解析**字面** `t('key', {…})` 调用，所以界面里
  写了 5 条字面建议 + 5 条字面腿播报（switch 分支），没有动态拼 key——动态拼会绕过机检，
  §5.5 的"缺翻译即失败"在这两处就形同虚设。`years_gap` 还要按 `params.noPeriod` 分叉成两句
  （"差 N 年"与"库里根本没有带时间的经历"是两件不同的事，不能合成一句）。
- **双入口读的是同一个 `report()`**（判据六，§5.9）：agent 侧 `kb.gap.report` 声明
  `effect: 'read'` + `requiresConfirmation: false`，真机整表读数（`tmp/tool-effects.js`）里
  它与 `kb.profile.list/search` 同排，外发那六只仍是 `outbound` + 需确认。
  `nowMs` **刻意不进工具入参**（`z.strictObject` 实测拒收 → `TOOL_INPUT_INVALID`）：
  那等于让模型自己填"今天是几月"，而 4.4-07 要的是同一输入两次读数一致。
  跑工具与直接调 service 的整份返回体 `JSON.stringify` **逐字节相等**（`identicalFullJson: true`），
  不是"看起来一样"。对话卡片标题走 `ChatPanel.TOOL_LABEL_KEY` + `agent.tool.labels.kbGapReport`。
- **复用检查**（§2.1/§2.2）：实体种类标签表从 `KbPanel.tsx` 抽到 `entity-kind-labels.ts`，
  两个面板共用（这是本片第二次出现同一份四类映射）；`FakeAgentToolsService` 从 `gap-service.test.ts`
  提到 `test-doubles.ts`，因为 `profile-service.test.ts` 也要挂（同包内第三处）。
  界面没有新增任何比对、打分或换算逻辑，月数/档位/三态全部来自服务返回体。
- **单测与门**：`gap-service.test.ts` 23 → **27 例**（工具面 4 例）、`profile-service.test.ts` 75 → **79 例**
  （`evidenceBody` 4 例）；本包 14 文件 / **303 例**，仓库 21 包 / 83 文件 / **1192 例**全绿。
  四闸 `typecheck` / `lint`（渲染层规范：2 个语言包、24 个源文件）/ `format:check` / `test` 收口轮全 0。
  证据：`docs/acceptance/4.4/4.4-05-ui-and-tool-surface.txt` + 五张 `4.4-05-*.png`
  （zh 三栏全貌 / 两类证据展开 / en 同页 / `disabled` 腿播报 / 库缺席空态）。
- **4.4-02 的 V 半边收到哪里**：五态里在**真实页面**上看到的是 `unavailable`（缺 baseUrl/model/apiKey）
  与 `disabled`（配置关腿）两种，截图各一张；`merged` / `rejected` / `failed` 要一个真能用的模型网关才排得出，
  本机没有 → 4.4-02 保持 `[!]`，机制侧由 4.4-b 的 U 半边钉死。同理 `highlights` 在本语料下 0 条，
  亮点区与「另有 N 条未展开」只有单测证据、没有截图，不写成通过。
- **本机为 Windows**，macOS / Linux 的运行期验证无法在本机完成 → 相关条目 BLOCKED。

### 4.4-e1 落地记录（4.4-09 的额度接线 + 4.4-08 的 §7.2 机检，2026-10-02）

- **4.4-09 判到的形态是"三条断言"而不是"一段说明"**（plan §4.4-e 判据一）：本切片**没有**给 `kb.gap` 接
  `gate.perform`——闸门管的从来不是"花了多少钱"而是"平台侧的代价"（`QUOTA_ACTIONS` 只有 search/greet/deliver，
  每个都对应一次可能被风控的页面动作）。把 JD 拆解套进 `search` 会造出比不接更坏的后果：拆 20 份 JD 就吃掉
  20 轮抓取额度，这与 2.7-03 当初拒绝"把额度键当计费分类用"是同一条论证。所以验收操作落成
  `packages/main/src/gap-quota-link.test.ts` 的四条断言：额度见底挡不住报告、两条入口都不落账、
  **落账口活性对照**（同装配里 `perform('greet')` 确实多一行并转为拒绝，否则"行数不变"可能只是账本坏了）、
  以及 `unlimited` 与 `daily` 两种配置下的读数——"符合配置"得有第二个配置值才成立。
- **为什么住 `packages/main`**：`resume-kb` 不依赖 `entitlement`（§4.1 依赖方向，领域包之间也不许横向 import），
  在自己包里只能用替身演一遍"没扣额度"，而替身既不会拒绝也不会落账，那条断言是空的。
  这与 3.7-02 那份跨包用例住同一处、同一个理由。账本行数直接 `SELECT COUNT(*) FROM usage_ledger`，不读服务自报值。
- **模型腿半边住 `packages/llm`**（§2.1 的复用口径反过来用：判"所有调用方"就在唯一出口判）：
  `quota-boundary.test.ts` 扫本包非测试源码 + `package.json` 依赖清单，闸门/账本的**全部**可辨识入口
  （service 名、类名、包名、表名 `usage_ledger`、`QUOTA_ACTIONS`、`perform('…`、`countToday`）命中即红。
  它同时是"尚未计费"的销针：将来真要计费（第四个动作键 `llm`，用 `gate.perform` 落在这两个方法里），
  这条用例会红，必须连同 spec 一起改而不是加豁免。第三条"不计费也要回报用量"没在这里重复断言——
  `llm.test.ts` 已按存根判过 `promptTokens/completionTokens`（§2.5）。
- **§7.2 从"结构性成立"升级为有机检**（AGENTS.md §10 里那条"待落地 1.6"就此收口，两半都做）：
  字符串面 = `check-compliance-redlines.ts` 新增**规则三**，射程只限测试与脚本面
  （`*.test.ts`/`*.spec.ts`/`test-doubles.ts`/`packages/testing/**`/`scripts/**`）——生产代码不在内，
  因为这个 app 的本职工作就是驱动真实站点，把产品形态扫成违规没有意义。放行条件是回环、
  RFC 2606/6761 保留名、无点单标签主机，或登记进 `TEST_REAL_HOST_ALLOWLIST` 并写清理由
  （今天两条：`schemas.openxmlformats.org` 是命名空间字符串、`(www.)zhipin.com` 出现在**拒绝路径**上，
  换成 `*.invalid` 就把要检的事检掉了）。运行面 = `CdpSession.navigate` 在发第一条 CDP 命令前判
  `localTestUrlViolation`，管的是字符串面看不见的那一支（`harness open --to <人现场敲的 URL>`）。
- **机检自己也被反向验证过**（绿的机检不等于有效的机检）：临时探针文件里四个主机各判一档——
  `api.deepseek.com` 被拦、豁免内的 zhipin 与回环放行、`${host}` 插值交运行面——探针当场删除未入库。
  过程中修掉规则三自身一个缺陷：URL 正则第一版没在 `/` 处截断主机，把 `http://other-origin.example/frame`
  整段当主机名，造成 27 条误报。
- **后缀混淆是守卫的一条真实失效模式**：判定按整个主机名而不是 `startsWith`，否则
  `http://localhost.attacker.example:10222/` 就混进去了；相对地址与 `//host` 形态一律拒（判不出主机就
  无法证明它不出网）。用例里的"远端主机"全取 RFC 保留名——它们公网不可达、又能让规则三放行，
  这道机检与那条机检在这里正好互锁。
- **四闸与规模**：`typecheck` 21 包 0 失败、`lint`（eslint + 5 项机检，合规护栏扫描 243 个源码文件）全绿、
  `format:check` 全绿、`test` 21 包 / **86 文件 / 1210 例**（本切片 +3 文件 / +18 例）。
  途中两次"通过之前先红"：main 那份用例首轮带 4 个 ENOENT 未处理异常（日志写流异步开文件，
  `afterAll` 先删目录就会在收尾后炸，按 `resume-kb` 口径补 dispose→等 300ms→删目录）；
  `cdp.test.ts` 里的 `/v1/embeddings` 被 LLM 入口唯一性机检拦下（改路径而不是加豁免）。
  证据：`docs/acceptance/4.4/4.4-09-quota-and-allowlist.txt`。
- **本条没判到的**：今天没有付费网关，`llm` 动作键也不存在，所以 4.4-09 判的是"本地计算与未配置的模型腿
  都不误扣"，真花钱调用的扣费形态只在判据一里定了落点。阈值标定与界面那句"未标定"归 4.4-e2，
  4.4-01～10 的逐项复跑归 4.4-e3。本机 Windows，macOS / Linux 运行期条目 BLOCKED。

### 4.4-e2 落地记录（三个测量型阈值的标定 + 两个口径值的依据 + 界面文案与复拍，2026-10-02）

- **五个阈值只标三个，另两个写依据**（plan §4.4-e 判据三的分类）：
  `evidenceHitMinScore` / `evidencePartialMinScore` / `highlightMinScore` 是**测量型**，读同一把
  `coverageOf` 的 token 覆盖率，所以必须用标注集量；`yearsPartialRatio = 0.6` 与 `maxHighlights = 3` 是
  **口径型**——前者是"干满几成算部分够"的产品判断（年限走月区间算术，与文本阈值无关，4.4-c 判据一），
  后者是界面容量（4.4-05 的三栏一屏放得下三条候选）。把这两条也拉进"标定"等于给一个产品决策套上数据的外衣，
  所以 `gap-calibration.ts` 从头到尾没碰过它们，回归用例反向锁死：两份标定文件的非注释行里查不到这两个键。
- **标定值**（已写进 `kbGapSchema` 的 `.default()` 与 `cordis.yml` 的 `kb-gap` 段，三处由用例锁成同源）：
  `evidencePartialMinScore 0.30 → 0.33`、`evidenceHitMinScore 0.62 → 0.58`、`highlightMinScore 0.12 → 0.11`。
  选型判据是**错分最少 → 最紧余量最大 → 余量剖面逐位比**（`pickBestIndex`），不是"错分最少"一个数：
  只看错分率会奖励贴着某一条样本走（第一版真就选出过 `hit=0.51`，离 T14 的 0.5 只有 0.01，换一份 JD 就翻），
  加第二、第三判据之后 `hit` 落到可分带 [0.3333, 0.6667] 的中点 0.58，并列候选从 16 组降到 1 组。
- **判的是尺子，不是流水线**：语料直接喂 `coverageOf`，不经过 `report()`（`gap-calibration.ts` 里
  `textScoreOf` / `highlightScoreOf` 各只有一行调用）。否则读数翻脸时分不清是拆解错还是尺子错。
  零重合的样本单独归入**盲区**、不计进错分——它们量的是词面尺子的能力边界（该由 4.3 的语义腿补），
  不是选值失误；把它们算进错分率会把阈值推向"为了覆盖近邻词而放宽"的方向。
- **反循环检查不是摆设**：42 条标注里 13 条 `isBoundary`（人判与朴素 token 覆盖不一致的那类），
  用例要求其中**至少一半**在选定阈值下给出负面读数（翻脸或盲区），否则这批样本就是"为了让尺子好看"摆的棋子。
  实测：三态腿翻脸 1 条（T24）+ 盲区 6 条（T16~T21），亮点腿翻脸 1 条（H12）+ 盲区 2 条（H09/H10）。
  **一条都不剩的标定等于没标**，所以报告与用例都逐条列出这些翻脸，不给"准确率 95%"这类数字。
- **两处阈值救不回来的形状，写进配置注释而不是藏起来**：
  T15（人判部分）与 T24（人判缺失）在尺子上同为 0.3333 —— 同一读数、两个人判类别，任何阈值都分不开，
  只能把 `partial` 压在它们之下并接受 T24 翻脸；亮点腿两类别名带**真重叠**（不相关最高 0.1429 >
  相关最低 0.1111），这正是界面那一栏叫「亮点**候选**」的原因，不是命名随意。
- **顺带修掉的两处不一致**（都是"文档声称有、代码没有"或"第二份事实"）：
  `KbGapConfig` 的注释写着两条文本阈值写反会被 schema 拒掉，而 schema 里根本没有 `.refine` —— 补上
  （沿用 `outbound.throttle` 的 `min ≤ max` 同形做法，配置是用户可编辑的系统边界，在挂载前拒而不是在比对里兜底，§2.6）；
  `gap-service.test.ts` 的 `DEFAULT_CONFIG` 与 `requirements-compare.test.ts` 的 `BASE_OPTIONS` 各自手抄了一份
  出厂阈值（改标定后它们就跑在一把没人用的尺子上），两处都换成 `kbGapSchema.parse({})` 现读（§2.2 / §2.5）。
- **界面上的话跟着读数改了**：`gap.hint` 末尾那句「各阈值当前未标定」换成
  「三条文本阈值已按本地 42 条人判标注初标定（2026-10-02），年限比例与亮点条数是产品口径，
  这些值仍可在 cordis.yml 的 kb-gap 段调整。词面这把尺子只认字面重合，语义等价的另一种说法可能被判成缺失。」
  zh / en 双补（§5.5 / §5.6，`pnpm lint` 的语言包对齐机检通过）。
- **两张缺口面板图重拍**（V 类证据必须对应现状，否则 `4.4-05-*.png` 与代码不符）：
  `4.4-05-zh-three-columns.png`、`4.4-05-en-three-columns.png` 覆盖同名旧图，现场经肉眼复核，
  页面读数与 4.4-d 逐字相同——**三态计数 4 / 1 / 10 没有因阈值改动而变**（这份语料里没有落在
  [0.58, 0.62) 带内的文本行；年限行 0.59 走的是算术，色带按状态给、分数只作展示），
  所以这次改动动的是尺子的刻度，不是这份报告的结论。标定读数与选型表见
  `docs/acceptance/4.4/4.4-e-threshold-calibration.txt`。
- **如实记录的一条既有行为**（不是本片引入，也不在本片修）：切语言后"最近一次动作"的播报仍是切换前的
  语言（例：英文页上「同步：0 行已变更，列表已重读」）。播报是动作发生时翻好的快照，不是响应式文案；
  面板标题、栏头、建议句、摘要行这些**由 i18n 键现取**的都跟着翻了。
- **本片做不到的**：标注集是本地样例、单标注人，不是真实用户库也不是群体判断，所以这三条阈值是
  "有依据的初值"而不是"标定完成"；上线后的复标（多标注人 + 真实库 + 一致性统计）与 4.3-d 仍欠的
  `k1/b`、`k` 权重（要真 embedding key + 评测集）都不在这条边界内。`4.4-02` 的 `merged`/`rejected`/`failed`
  三态界面照旧要真网关，保持 `[!]`。
- **四闸（2026-10-02 复跑）**：`typecheck` 21 包 0 失败；`lint`（eslint + 5 项机检）全绿；
  `format:check` 全绿；`test` 21 包 / **87 文件 / 1223 例**全通过（本切片 +1 文件 / +13 例，
  `resume-kb` 包 15 文件 / 316 例）。

### 4.4-e3 落地记录（4.4-01～10 在新阈值下逐项复跑，2026-10-02；4.4 切片收口）

- **为什么必须复跑**：4.4-e2 换了出厂刻度，凡读这三条尺子的条目都不能再沿用旧阈值下的绿灯。
  复跑分三层，缺一层不算：**用例层**（`requirements` 11 / `requirements-compare` 26 / `gap-service` 27 /
  `gap-calibration` 13 / `gap-quota-link` 4 / `llm` 侧 14 / `cdp` 12 例，全过）、
  **机检层**（`pnpm lint` 的 5 项，含 §7.2 规则三扫 246 文件）、
  **页面层**（CDP 10222 真 app 重读缺口面板，三栏 4/1/10、11 条建议、6 个证据按钮）。
  逐项读数与命令：`docs/acceptance/4.4/4.4-e3-recheck.txt`。
- **状态位复跑后不变**：4.4-01 / 03 / 04 / 05 / 06 / 07 / 08 / 09 / 10 保持 `[x]`，
  **4.4-02 保持 `[!]`**——机制侧五态齐全（U 半边过），但 `merged` / `rejected` / `failed` 三种腿状态的
  **界面播报**必须真打对话模型端点才排得出，本机 `llm` 段没有 chat baseUrl/model/apiKey
  （4.3-d 拿到的只有 embedding 侧的 bge-m3）。现场只看到 `unavailable` 与 `disabled` 两态。
  不为凑绿把 `[!]` 改 `[x]`，这条等的是一次经用户授权的真网关调用。
- **"改了阈值而报告没变"要分开说**：本语料的文本行读数只有 1.0 / 0.6667 / 0.5 / null，没有一条落进
  [0.58,0.62) 这段被改动的带里，所以页面计数不变。标定的实际收益另测（新旧值各跑一遍标注集）：
  三态腿错分**条数不变**（都是 T24），买的是稳健性（`hit` 从贴着命中侧的 0.62 挪到带中点 0.58，
  最紧余量 -0.0333 → -0.0033）；亮点腿从错 2 条（H12、H13）降到 1 条（H12）。
  报告里不写"准确率"，只写这两组数——见同一证据文件第【3】节。
- **4.4 切片到此收口**，下一片按 `docs/00-master-plan.md` 的计划树进 **4.5 定向内容生成**
  （强制事实校验闭环，M5 判据的 P4 半边）。仍挂在后面的动作：4.4-02 的真网关三态截图、
  4.3-d 的 `k1/b` 与 `k` 权重标定、上线后的阈值复标（多标注人 + 真实库）。
  本机 Windows，macOS / Linux 运行期条目 BLOCKED。

## 4.5 定向内容生成（强制事实校验闭环）

| ID     | 验收标准                                                                                     | 方式 | 验证操作                                     | 状态 |
| ------ | -------------------------------------------------------------------------------------------- | ---- | -------------------------------------------- | ---- |
| 4.5-01 | 输入指定 JD，输出 **P3.1 文档模型 JSON**（不产 HTML/PDF），并通过 Schema 校验                | U+C  | 校验零错误；渲染交 P3 成功                   | [x]  |
| 4.5-02 | 生成内容按 JD 相关性重排区块与条目顺序，重排依据可解释（引用命中项）                         | U+V  | 顺序断言 + 界面显示依据（截图）              | [x]  |
| 4.5-03 | 描述性文字可改写润色；`facts.locked` 字段（公司/职位/时间/数字/学历/证书号）**只能原样引用** | U    | 单测：被改写即被 `fact.check` 拒绝           | [x]  |
| 4.5-04 | 事实校验为**确定性代码**实现（归一化比对），不依赖 LLM 自评                                  | C+U  | 代码走查 + 单测覆盖篡改类型                  | [x]  |
| 4.5-05 | 校验失败自动重试一次（带 RETRY_APPEND 式约束补强），仍失败则**拒绝产出**并标记需人工确认     | U+V  | 注入必失败用例 → 无产物 + 界面提示截图       | [x]  |
| 4.5-06 | 任何输出内容都能反查到知识库证据 id；无证据的句子被拦截                                      | U+C  | 断言 `evidenceRefs` 非空且有效               | [!]  |
| 4.5-07 | 不得生成未存在于库中的经历/公司/项目（零虚构保证）                                           | U    | 构造诱导 prompt 断言输出不含库外实体         | [x]  |
| 4.5-08 | 量化数字保持原值：不许把「提升 20%」改写为「大幅提升」或反之放大                             | U    | 数字比对单测                                 | [x]  |
| 4.5-09 | LLM 不可用时仍可产出「仅重排、不改写」的保守版本（功能不降级为不可用）                       | U+V  | 断网冒烟 + 截图保守版提示                    | [x]  |
| 4.5-10 | 生成结果记录 prompt 版本 + 模型 + JD id + 时间，可复盘（2.5-09 同机制）                      | C    | 查库断言字段                                 | [x]  |
| 4.5-11 | 生成结果界面预览并可逐项接受/回退，接受后才写入工作副本                                      | V    | 截图逐项操作                                 | [x]  |
| 4.5-12 | 与 P3 的接口只用文档模型，不存在私有约定字段（防双真相源）                                   | C    | 共享 Schema 单测：P3/P4 各自校验同一 JSON    | [x]  |
| 4.5-13 | **M5 判据（P4 半边）**：由指定 JD 产出定制内容，交 3.3-10 出 PDF                             | V    | 全链路留证：JD → 内容 → PDF 截图与文本层断言 | [x]  |
| 4.5-14 | 敏感字段（手机号/邮箱/身份证）不因生成流程进入日志或产物                                     | C    | 断言脱敏（对齐 4.1-09）                      | [x]  |

### 4.5-a 落地记录（4.5-03 / 04 / 07 / 08 / 14 的代码半边，2026-10-02）

- **上表五行全部保持 `[ ]`，一个没勾**。不是没做完不敢勾，是这四条判据里三条**要跨服务与界面才算达成**：
  03/04/08 的比对规则本片落地且有单测，但"生成轨真调了它、不过就无产物"是 4.5-05（归 4.5-b）；
  07 的强保证在模型腿的输出形状里（见下条），本片的词面回查只是补刀；14 的哨兵证明只覆盖"校验读数"
  这一个出口，日志与生成记录表两个出口同样在 4.5-b 才存在。零新表、零 LLM 调用、零界面改动。
- **比对实现仍然只有一份**（AGENTS.md §2.5 决定了这一片的形状）：字段级篡改复用
  `resume-doc` 的 `checkFactLock`，给它加一个**可选**第三参 `editableKeys`，语义反过来读——
  "白名单里的键允许改写，其余一律原样引用"。不传该参数时 3.1-03 的原语义逐字不变，
  旧调用点（`schema.test.ts` 前三例）行为不变。反过来的必要性：`school / degree / major` 在模型里
  **不标锁**（3.1 的 `FactKey` 只有 company/role/period/achievement），但"本科改成硕士"仍是编造；
  为它扩 `FactKey` 枚举要牵动 schema / 快照 hash / 模板 / diff 四处，而消费者只有校验这一处——
  与 4.1-08 头像那次同一条判断（不为没有消费者的形状改动付代价）。
  违规读数因此多了一个 `gate` 位：`fact-lock`（动了标锁事实）/ `editable-allowlist`（动了不该动的字段），
  界面与复盘要能分清这两种。
- **重排与校验不冲突，靠的是"按 id 对齐"**：`checkFactLock` 用 `sectionId` / `entryId` 建 Map 比对，
  4.5-02 要求的顺序调整对它**完全不可见**（`schema.test.ts` 与 `fact-check.test.ts` 各有一例锁住）。
  这条正是否决源实现的地方——那边用 `genExps[i]` 对 `baseExps[i]` 下标配对，一重排整片错位。
- **数值守恒判的是"这个数还在不在、有没有新数"，多重集而不是集合**：量级折进数值（「2 万」=「20000」）、
  千分位与小数照常读、百分号与货币量词只作限定不进比对；「五年」→「5 年」**不误报**（两种写法同一个数），
  「提升 40%」→「大幅提升」拦（少一个方向），凭空多出 12 拦（多一个方向）。
  刻意加的限定是**中文数词只有紧跟量词才算一个数**——否则「十分匹配岗位要求」里的「十」会被当成数据，
  模型把它润色成「非常匹配」就被自己的校验器打断，4.5-09 的保守路径会死在校验器手里。
- **4.5-07 的口径要读准**（防止后来者把词面回查当成零虚构的全部）：强保证是**结构面**的——
  模型腿的回答形状只有 `{entries:[{entryId,text}]}`，没有新增条目或区块的通道，所以"编出一段经历"
  在形状上就表达不出来（plan §4.5 判据六，4.5-b 落地时验证）。本片的组织名候选回查是启发式**补刀**，
  如实带漏判：不带机构后缀的裸公司名（「字节」）、人名与地名的虚构都不拦；指代词读法（本公司 / 该社区）
  已按"含指代字即放行"排除，且判"含"不判"开头"——机构名前缀正则贪婪，「在本公司」读到的前缀是「在本」。
- **4.5-14 在这一片暴露并修掉了一个真实风险**：数值守恒的读数装的正是"少了哪个数"，
  而手机号本身就是一串数。所以 `describeViolations` 的每条读数**整行再过一遍 `redactText`**
  （core 的唯一脱敏口），产出形状是 `education/d1.degree → editable-allowlist（2 → 2 字符）`——
  路径 + 判据 + 长度，不含字段原文。植入式证明：基线里种 11 位手机号 / `.invalid` 邮箱 / 18 位身份证
  三条假哨兵，断言任何一条读数里取不到原文、且含 `138****`；不加脱敏这一层该断言就红。
- **单测与门**：`fact-check.test.ts` 18 例 + `schema.test.ts` 由 9 例扩到 14 例。四道门禁实跑：
  `typecheck` 21 包全 Done、`lint`（含五条规范脚本）通过、`format:check` 首跑红 4 个文件
  （plan 追加的表 + 本片三个 .ts 未按 prettier 对齐），`--write` 后单独成提交、复跑通过、
  `pnpm test` EXIT=0 / **1246 例全绿**（上界基线 1223 + 本片 23，数目对得上）。
  证据：`docs/acceptance/4.5/4.5-a-fact-check.txt`。
- **本片留下的、4.5-b 必须接住的**：`fact-check.ts` 尚未从包出口导出、包外无人调用——它的消费者是
  `resume.generate` 服务。**§4.4 禁孤儿文件：4.5-b 若不做，这个文件连同 18 例一起删**，
  不许以"以后会用"挂着。同理 4.5-06 的"每句反查证据 id"要 4.5-b 把 `evidenceRefs` 随返回值带出来
  而不是塞进文档（`documentSchema` 是 strict，多一个键即非法——判据二），迁移号段 15 也仍空着等它。

### 4.5-b 落地记录（生成轨、双入口与生成记录表，2026-10-02）

- **勾上 03 / 04 / 07 / 08 / 10 / 14 六行，其余九行仍 `[ ]`**。勾的这六行验证操作都是 U/C 且已在用例里逐条
  对应（03「被改写即被拒绝」、04「代码走查 + 覆盖篡改类型」、07「诱导 → 输出不含库外实体」、
  08「数字比对单测」、10「查库断言字段」、14「断言脱敏」）。仍空的两类原因：
  **V 半边不在本片**（02 界面显示依据、05 拒绝产出提示、09 保守版播报、11 逐项接受、13 全链出 PDF 都要 4.5-c/d
  的真页面截图）；**01 的"渲染交 P3 成功"与 12 的"P3/P4 各自校验同一 JSON"要 4.5-d 把产物真送进导出管线**
  才算——那两行现在只完成了返回体过 P3 Schema 这一半，用推测补勾就是这条记录要防的事。
- **4.5-06 留了一个具体的、不是措辞问题的缺口**（写下来供 4.5-c 之前裁定，不许含混勾掉）：
  提议面 `generationTargetFields()` 取的是**五类区块里的全部散文键**，不按"这条目有没有命中 JD 要求"过滤；
  而 `evidenceOf()` 只对有命中的条目出证据行。于是一条落在"零命中条目"上的合法改写会进产物，
  却在那份证据表里查不到任何 `evidenceId`——正是本行"无证据的句子被拦截"的反面。
  两个候选收口：① 把提议面收窄到有命中的条目（更严，代价是"顺带润色一句自我介绍"这类合理改写没了通道）；
  ② 给每条改写补一条"来自本文档派生实体"的证据 id（更贴近"反查知识库证据"的原意，因为被改写的原文本来就
  是库里那份）。本片按原计划实现，未擅自选 ①/②。
- **闭环按 4.5-05 原文落地，不是按源仓库那份假闭环**：第一轮违规 → 带**机器可读的违规行**重试一次 →
  第二轮仍不过 → `document: null` + `receipt.outcome = 'rejected'`，而记录行、违规明细、`retried = 1` 都留下
  （复盘要能看到"拒了、为什么拒"，只留一句"失败"等于没记）。用例：`两轮都动数值：拒绝产出，但记录行、
违规明细与重试标记都留下`。
- **零改写清单时一次模型都不问**（比 plan 判据四多做一层）：`targets` 为空就不拼提示词、不出网——
  没有内容可改写还要把整份简历发一遍是纯粹的泄露面。这也是 4.5-09 保守版的一条独立路径，
  并且保守版**照样真跑一遍校验**：`保守版也真跑一遍校验，不是注释里声明"它必然通过"`。
- **两个入口的返回体故意不对称**：`resume.generate.run` 的 **agent 工具面**返回完整 `GenerationView`（含
  `document`，4.5-d 的对话入口要把产物交给导出工具）；**IPC 面**在 `shared` 里只镜像五种行视图、
  **不带 `document`**，界面按 `receipt.outcome` 判有没有产物。理由与 3.3 / 4.1 的「文档正文不过进程边界」
  一致：`shared` 在 L1、不许依赖 L2 的 `resume-doc`，镜像 P3.1 文档模型就是造第二个真相源（§2.5）。
  不对称的两半都有用例钉住（包内 `跑工具与直接调 service 的产物逐字相等`、装配层
  `过界的那一份与 shared 的镜像同形，且结构化克隆得过去`）。
- **号段 15 的撞号症状不是"表没建"而是"整个 store 起不来"**：`runMigrations` 在任何一条迁移动手之前就查
  版本重复并抛错（`store/src/migrate.ts:91`），所以这条只能在把 7 / 11～14 一起装起来的真装配里判
  （`packages/main/src/generate-link.test.ts`），包内替身装配里根本没有那几张表。
- **4.5-14 从三条出口扩到四条**（提示词 / 返回体 / 日志文件 / 生成记录表），后两条只在真 store + 真
  `LogService` 的装配里判得准。两条实测细节记在此处，因为它们都会咬到后来者：
  ① 断言按文档里**实际掩码后的串**取，不写死掩码字面量——4.1 的 `stripMarkup` 会吃掉连续星号里成对的 `**`
  （`z***@` → `z*@`），写死字面量会让用例红在解析层而不是红在脱敏；
  ② 数值守恒的读数本身就装着一串数（手机号就是数值），所以 `describeViolations` 每条读数整行再过一遍
  `redactText`。如实记下残余：模型若往散文里新增一个**不含数字**的邮箱，四条通道与三条判据都抓不到，
  它会原样进产物，由 4.5-11 的逐项人工接受兜底。
- **对 4.5-a 记录的两处更正**（裁定 A 的结果，旧文不回改，在此指过去）：可改写面不是"只有 `key === 'text'`"
  而是 `{text, achievement, description}` 三个散文键，`fact.check` 传的 `editableKeys` 即这三键；
  `fact-check.test.ts` 从 18 例扩到 22 例（新增的四例判的就是 achievement 可改写后仍受数值与具名两条约束）。
  plan §4.5 取证三已同步改成这一口径。
- **单测与门**：本片新增 / 扩充 49 例（`generate-service.test.ts` 25、`generate-model.test.ts` 15、
  `generate-reorder.test.ts` +1、`fact-check.test.ts` +4、`generate-link.test.ts` 4）。四道门禁实跑：
  `typecheck` 24 包全 Done（首跑红两处：工具面返回体是 `unknown`、`parseResumeText` 是可判别联合——都按
  显式收束修，不靠 `as any`）、`lint` 通过、`format:check` 首跑红 4 个文件、`--write` 后复跑通过、
  `pnpm test` EXIT=0 / **1306 例全绿**（上次记录的总数是 1246，其间 4.5-b 前半已入库若干例而未重记总数，
  故此处只报实测值，不硬凑差额）。
  证据：`docs/acceptance/4.5/4.5-b-generate-chain.txt`。
- **本片新造的一条机检口径**：假 `llm.chat` 从 `gap-service.test.ts` 搬进 `test-doubles.ts`（第二个消费者
  出现，§2.2），`scripts/check-llm-single-entry.ts` 的"测试替身不计入声明者"因此从按 `.test.ts` 后缀判定
  改为与 `check-compliance-redlines.ts:101` 同一条判定（`.test/.spec.ts` 或 `test-doubles.ts`）。
  端点痕迹那一断言**不豁免**，所以放宽的只是"声明者计数"，不是"测试文件能不能碰模型端点"。
- **4.5-c 必须接住的**：`GenerationView.document` 目前在渲染层没有消费者（预览面板是它的第一个），
  §4.4 禁孤儿文件同样适用；而 4.5-11 的"接受后才写入工作副本"需要一个主进程侧的提议态落点
  （按 `receipt.id` 存，正文仍然不过进程边界），这条设计不在本片里做。

### 4.5-c 落地记录（预览界面、逐项接受与四种结果态的真页面证据，2026-10-02）

- **勾上 02 / 05 / 09 / 11 四行**（都是 V 半边，此前 4.5-b 已把 U/C 半边勾过的那几行不重复动）。
  证据：`docs/acceptance/4.5/4.5-02-reorder-basis.{txt,png×2}`、`4.5-05-rejected-no-accept.{txt,png}`、
  `4.5-09-reorder-only-fallback.{txt,png}`、`4.5-11-one-of-two-accepted.{txt,png×3}`。
  四态是**在同一个真页面上跑出来的**，不是四张拼贴：改写态、保守态、拒绝态、接受后态各有 DOM 读数与
  磁盘读数两条独立证据，界面上看见的条数与工作副本里实际被改的条数逐一对上（【定制】哨兵计数 = 1）。
- **V 证据的取证手法本身是一次选型结论**（§6.1/§6.2）：给 fixture 服务加了本地 OpenAI 信封靶
  （`/v1/chat/completions` + `/api/generate-mode` 的 `rewrite`/`fabricate` 两态，提交 3c385bd），
  于是"模型腿改写过"与"模型腿编造数值"两种结果都能在**零外发、零花费**下复现（判据四：真打外部模型要
  用户单独授权；§7.2：不碰真实平台）。断网态用"把 `llm.baseUrl` 指到一个没有监听的回环端口"实现，
  症状是 `fetch failed` → `model_status=failed`，与真实断网在代码路径上同一条。
  靶端点只记条数与模式，不落正文（§8.5）。
- **接受面的落点是主进程内存里的一份提议态**，不是新表、也不是把正文递到渲染层：
  `proposals: Map<receiptId, PendingProposal>`（`MAX_PENDING_PROPOSALS = 8`，超了丢最旧），
  渲染层只回传**勾中的下标 + 是否采纳重排**。这是 4.5-b 记下的"4.5-c 必须接住的"那条的设计答案，
  理由与 3.3/4.1 的「文档正文不过进程边界」一致，且不为它加第 16 号迁移（§2.6 不做超出需求的事）。
  写盘前三道判定都实测过：提议态缺失 → `KB_GENERATION_PROPOSAL_MISSING`；基线漂移 →
  `KB_GENERATION_STALE_BASELINE`（生成之后用户自己改过简历就不写）；勾中的子集**再过一遍同一套校验**——
  跑它不是为了防模型，是防"界面回传的下标拼出一份我们没验过的组合"，写用户简历是全片唯一不可逆的动作。
- **`updatedAt` 由这次表态自己盖章**，不沿用基线那份：`docStore.save()` 存的就是文档自带的
  `updatedAt`，沿用会让"我明明一条都没勾"的那一声接受把简历标成"刚刚被改过"。连带一条早退：
  一条没勾且重排没采纳时**一次盘都不落**、提议态也不删（这次表态还没用完），返回的是零改写读数。
  界面上"区块换位 0 处 · 条目换位 0 处"就是这条早退之外的正常形态（只勾改写、不采纳重排）。
- **重排按整组接受/回退，不做单条换位**（本片裁定，写下来免得后来者以为是漏了）：单独回退一条换位
  会得到一个既不是基线、也不是产物的第三种顺序，那种状态没有解释意义。改写行是逐条的，因为每条各自守恒。
- **`entryModeled` 是 4.5-06 的播报半边，不是它的收口**（提交 7e0f64a）：`sourceEvidenceIds` 为空只有
  两种情况，界面必须分开说——① 该区块按 4.2 裁定二**不建实体行**（`summary`/`education` 类），散文按
  区块级切片索引，给不出实体 id 是设计如此；② 建了实体行、只是**这一个字段的原文**不是任何一条证据。
  把①播成"没查到出处"是谎报漏判，把②播成"库里不建实体行"是谎报设计，所以两种空态各一句文案，
  且用例锁住"要么有 id、要么 `entryModeled` 为真"这条不变量（`generate-service.test.ts`）。
- **4.5-06 改标 `[!]`（受阻，等裁定，不自行放宽也不自行勾掉）**：本行原文要求断言
  `evidenceRefs` **非空**且有效。"有效"这半边过了（每条 id 都反查得到、界面能拉正文）；"非空"这半边在
  4.2 裁定二之下对 `summary`/`education` 类区块**永远不成立**——那不是实现偷懒，是两条既定决策撞上了。
  4.5-b 记下的两个候选收口（① 提议面收窄到有命中的条目；② 给每条改写补一条"来自本文档派生实体"的
  证据 id）本片都没擅自选，因为选①会砍掉"顺带润色一句自我介绍"这条合理通道、选②等于改 4.2 的裁定。
  **需要用户裁定**；在此之前本行保持 `[!]`，界面按上面那条分叉播报，不伪装成"有依据"。
- **界面上修掉的两处读数错误**（都是亲眼看图才发现的，脚本全绿时看不见）：
  ① 零命中的重排行原先摆"相关性 0.00"，等于宣称"没理由就挪了它"，而 `orderByScore` 的真实语义是零分项
  留在原序、被前移的强项顶下去 → 改为分叉播报（提交 cfccf2a）；
  ② zh 面板提示里泄漏了 markdown 星号（`**提议态**`），页面按普通字符渲染 → 改「提议态」，
  并把两个语言包整体 grep 过一遍 `**`，无第二处。
- **三条已知限制，如实记录、不在本片修**：
  ① 区块分由其条目所引**实体**证据聚合，散文区块因此进不了重排的上行通道（只能被顶下来），见 4.5-02 证据；
  ② 面板调 `generate.run(jdText)` 不带 doc 过滤，而 `resolveDocId` 在库里 >1 份文档时返回
  `INVALID_ARGUMENT`，白名单里又没有 `resume.doc.list`，**多本文档的用户在面板里没有自救口**——
  补选择器要新增过界读数，属 §2.6 的范围外，留给后续片；
  ③ 4.1 的解析器会把散文塞进 `company`/`role` 这类具名键（解析缺陷，不是生成轨的问题），
  后果是本次 6 个候选字段里只有 2 个真上了提议面。它咬的是提议的覆盖率，不是事实安全——被锁定的键
  仍然逐字原样，数值仍然守恒。
- **单测与门**：本片界面侧不新增单测（面板的行为由 `useBridgeAction` 既有覆盖 + 真页面 DOM 断言承担），
  服务侧 `entryModeled` 一例（4.5-b 记录之外的新例）。四道门禁实跑：`typecheck` 24 包全 Done、
  `lint`（含渲染层规范/i18n 键对齐）通过、`format:check` 通过、`pnpm test` 全绿
  （`resume-kb` 398 例 / 19 文件，`main` 的 `generate-link.test.ts` 8 例）。
- **4.5-d 必须接住的**：`resume.generate.run` 的**工具面**产物（含 `document`）要真被对话入口挑中并交给
  3.3-10 的导出工具，那才是 4.5-01 的"渲染交 P3 成功"与 4.5-13 的 M5 判据；`accept` 是**人表态**的口，
  4.5-d 接对话时不许把它开放给模型自动调用，否则 4.5-11 的逐项人工接受就白做了。

### 4.5-d 落地记录（M5 判据的 P4 半边全链路，2026-10-02）

- **这一片按计划原文就是"无新实现，只做接线与取证"**，覆盖 4.5-13 与 4.5-01 的"渲染交 P3 成功"半边，
  代码侧唯一改动是 fixture 替身的哨兵后缀加了那串 ASCII（提交 d0d7332）。
  证据：`docs/acceptance/4.5/4.5-13-m5-chain.{txt,png×2}`。
- **三跳全走白名单公开入口，没有一处绕过 IPC**：`resume.generate.run`（界面上真键入那段 JD）→
  勾 1 条改写 → `resume.generate.accept` → `resume.export.toPdf`（3.3-10 的导出入口）。
  两次接受各导一份 PDF：勾 1 条那次回执 `pages 1 / bytes 43871 / hash 4b73d09a… / snapshotId 97e12de8…`，
  只采纳重排那次 `hash 07000b19… / snapshotId 2102b65d…`。
- **文本层断言读到的正是"改了什么、没改什么"**：哨兵 `JD-REWRITE-MARK` 两次都只出现 1 次
  （模型给了六条候选，落的只是用户勾的那一条），行号从 25 挪到 29；技能行
  `Java Go MySQL Redis Docker` 从第 32 行升到第 7 行 —— 这就是"JD 驱动的重排"在打印产物里的物理形状，
  而哨兵计数不变排除了"顺手又改写了一次"。手机号那一行两次都是 `138****1111`（4.5-14 的第四出口）。
- **回执里的 `hash` 是文档内容 hash，不是 PDF 字节的 sha256**（`export-service.ts:45` 的注释即此意）：
  实测同一份文件 `certutil -hashfile` 出的是 `9f0a9ed0…`，与两个回执 hash 都不同。
  这条必须写在证据里，否则后来者会拿文件哈希去核对回执。同一份内容第三次导出得到
  **同 hash、新 snapshotId**（`d0862c87…`），`snapshot.list` 三行齐全 —— 3.7 的"投出去的是哪一版"
  在这条链上顺带也被证实了。
- **4.5-01 与 4.5-12 现在才算过，过在什么上**：两条的断言自 4.5-b 起就在
  （`generate-service.test.ts:292` 起的 describe 标题即 spec 4.5-01 / 12：产物过 `validateDocument`、
  顶层键集合 === `documentSchema.shape`），本片补的是它们在真链路上的对应读数 —— P4 包内没有任何平行的
  文档 schema（`grep z.object/z.strictObject packages/resume-kb` 命中的全是自己的配置面/工具入参/备份格式），
  而 `accept()` 写盘前必经 `generate-service.ts:962` 的 `validated()` → P3 的权威校验，
  那两次"已写入工作副本"能落库就是这道关放行的。**不为此新写一例单测**（§2.6：同一件事不做第二遍）。
- **"PDF 截图"这一项在本机给不出光栅图，沿用 3.3 的取证口径**：没有 `pdftoppm`，所以是
  真实内核 `printToPDF` 产物 + `pdftotext` 纯 ASCII 哨兵文本层断言 + 两张真页面截图。
  3.3-09 当年留的同样是回执截图而非 PDF 光栅图，不是本片降级。
- **一条被本片暴露但没有偷偷修的缺口**：页面上没有"KB 工作副本 → 导出"的按钮 ——
  `ResumePanel` 的 preview/export 绑死在 `seed.docId`（`resume-demo`），而这条链的文档是
  `resume-0185fba4a2cc`，白名单里也没有 `resume.doc.list`。所以这一片的导出是**经白名单 bridge 直调**
  完成的（合规，但不是用户点得到的路径）。它与 4.5-c 记的"面板无 doc 选择器"是同一条账，
  收口要等对话入口挑中工具面产物、或补一个 doc 选择器 —— 都不在本片偷偷加。
- **取证之后环境已复位**：`llm.baseUrl` / `model` 由 `plugins.saveConfig` 改回 `null`
  （实测读数 `{baseUrl: null, model: null}`），app 现在一次模型请求都不发；fixture 仍在 `rewrite` 模式。
  另需记一笔：两次接受之后知识库的实体与检索读数已落后于工作副本（界面上那句播报就是这件事），
  下一轮比对或生成前要先按新内容重新同步。
- **四道门禁实跑**：`typecheck` 全包 Done、`lint`（eslint + 渲染层规范 + 知识包 + LLM 单入口 +
  合规红线 + 离线依赖门槛）通过、`format:check` 通过、`pnpm test` 全绿
  （`platform-boss` 130 例 / `main` 15 例，其中 `generate-link.test.ts` 8 例）。
- **4.5-e 收口时还剩的账**：4.5-06 的 `[!]` 等裁定（两个候选收口都动既定决策，见 4.5-c 记录），
  其余 4.5-01～05 / 07～14 均已有单测或真页面、真产物证据，复跑时按 `docs/acceptance/4.5/` 逐项对名。

## 4.6 话术生成器

| ID     | 验收标准                                                                              | 方式 | 验证操作                                      | 状态 |
| ------ | ------------------------------------------------------------------------------------- | ---- | --------------------------------------------- | ---- |
| 4.6-01 | 三类话术可生成：开场白（打招呼）、追问、拒绝应对；输入 JD + 证据                      | U    | 结构断言 + 长度约束                           | [ ]  |
| 4.6-02 | 输出必须显式绑定 `jdId` 与 `evidenceRefs`，无证据的句子被拦截（2.5-09 的上游）        | U+C  | 断言字段与校验                                | [ ]  |
| 4.6-03 | 平台专名与岗位名作参数注入，不同语言下语序正确（i18n 插值，非字符串拼接）             | U+V  | `en` 下截图话术卡片文案正确                   | [ ]  |
| 4.6-04 | 长度与风格受配置约束（打招呼限长、语气档位），超限自动截断为完整句                    | U    | 边界单测                                      | [ ]  |
| 4.6-05 | 不含违法/夸大/诱导承诺类表达（黑名单确定性拦截，不靠 LLM 自律）                       | U+C  | 构造诱导断言被拦                              | [ ]  |
| 4.6-06 | LLM 不可用时回落模板话术并明确标识「模板」，不冒充个性化                              | U+V  | 断网截图 + 标识可见                           | [ ]  |
| 4.6-07 | 话术候选可多条并列展示，用户选一条后进入发送流程（2.5-02 前）                         | V    | 截图候选列表与选中态                          | [ ]  |
| 4.6-08 | 生成动作计入额度（若配置为付费项），必经 `entitlement.gate`                           | C    | 断言 ledger 与拒绝路径                        | [ ]  |
| 4.6-09 | 话术库/prompt 集中注册、可版本化，业务代码内无硬编码 prompt 字符串                    | C    | 扫描规则：prompt 字面量只允许出现在注册表目录 | [ ]  |
| 4.6-10 | 复用核对：话术生成不重复实现 JD 解析、检索、事实校验（全部调用 4.4/4.5 已有 service） | C    | 依赖图核对，无平行实现                        | [ ]  |
| 4.6-11 | 与 P2 的接口定型：`script.greeting` 输出即为 2.5-01 所需结构，P2 不再二次加工         | U+C  | 契约单测（mock 消费方）                       | [ ]  |
| 4.6-12 | 不发送任何凭据/验证码类内容（对齐 2.5-10）                                            | C    | 黑名单字段校验断言                            | [ ]  |

---

## 里程碑对账（P4 结束时）

| 里程碑 | 判据                                                         | 本 spec 覆盖                             |
| ------ | ------------------------------------------------------------ | ---------------------------------------- |
| M5     | 由知识库产出一份针对指定 JD 的定制简历 PDF（4.5 + 3.3 全绿） | 4.5-13 + 3.3-10                          |
| M4     | 打招呼话术来自知识库证据且留生成来源                         | 4.6-02 / 4.6-10（供 2.5-01/2.5-09 消费） |

## P4 风险与预置应对

| 风险                             | 应对                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| LLM 编造经历（最严重后果）       | 4.5-03/04/05/06/07/08 六道确定性关卡，校验失败即拒绝产出，不由 LLM 自评     |
| 把「演示级 RAG」误当可用能力排期 | §0 已摊开取证结论；4.3-07 要求评测集上量化证明向量确有增益，否则维持纯 BM25 |
| 检索质量不足导致内容同质化       | 4.3-02/07/09 量化门槛；4.4-03 三态比对提供结构化上下文而非仅靠召回          |
| 个人信息泄露（日志/产物/网络）   | 4.1-09 / 4.3-12 / 4.2-07 / 4.5-14 四处独立断言                              |
| 依赖越界（引入向量库或原生扩展） | 4.3-05 / 4.3-06 作为 `[x]` 硬门槛，违反即回退方案                           |
