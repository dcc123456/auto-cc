# 计划九 · 工作台信息架构收敛 — 验收 Spec

> 实施计划：`docs/plans/09-workbench-ia/plan.md`
> 方式：**V** = 可视验收（CDP harness，`--url 5173`，截图/DOM 读数必留证据）；**C** = 命令/脚本机检；**U** = 单元/集成测试。
> 状态：`[ ]` 未验 / `[x]` 通过 / `[!]` 受阻（必须写原因）。
> 证据归档：`docs/acceptance/09-workbench-ia/<条目ID>-*`。

> **条目统计**：17 条（9.1×2 / 9.2×8 / 9.3×6 / 9.4×1）。
> 当下状态：11 `[x]` / 6 `[!]` / 0 `[ ]`。受阻项分两类：
> 9.3-01 的系统文件面板多选、9.3-05 的 Office-cc 外部应用拉起是**必须用户在场**；
> 9.2-05/06/07/08 是 2026-11-02 真实 BOSS 复测暴露的适配器/额度/导航竞态缺口（见 `9.2-real-boss-flow-findings.md`）。

## 9.1 菜单与设置页

| ID     | 验收标准                                                                                                                         | 方式 | 验证操作                                                                                                                                           | 状态 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 9.1-01 | 「信任」显示名为「运行记录」，「诊断」显示名为「设置」；内部 `data-action="nav-trust"/"nav-diagnostics"` 与 `data-view` 一字不改 | C+V  | 活体 nav 读数：trust→运行记录、diagnostics→设置，其余五档不变；选择器与 data-view 原样。证据：`9.4-01-live-readings.txt` 一、`9.1-01-settings.png` | [x]  |
| 9.1-02 | 设置页只保留「关于」（版本/Electron/Node/平台 + 重读）与「更新」；桥接、定位、工作流、装配四个实验台不在 DOM                     | C+V  | `settings-panel=true`、`update-section=true`；四个旧实验台选择器与标题均 false。证据：`9.4-01-live-readings.txt` 二、`9.1-01-settings.png`         | [x]  |

## 9.2 岗位页

| ID     | 验收标准                                                                                                                          | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                                         | 状态 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 9.2-01 | 库内筛选在服务端生效：关键词（标题/公司）、城市、经验、只看已回复；`total` 是库内总数、`matched` 是命中数，同时上屏；空结果有空态 | C+V  | 三行 fixture：默认 3/3/3；关键词「前端」2/3/2；只看已回复 1/3/1（B 行）。服务端 33 例含新增筛选用例。证据：`9.2-01-jobs-filter.png`、`9.4-01-live-readings.txt` 三                                                                                                                                                                                               | [x]  |
| 9.2-02 | 「在浏览器打开」先挂载该平台会话，再导航到该行 `sourceUrl`；成功提示带落地 URL                                                    | C+V  | fixture pack 下点 A 行：notice=已打开岗位页：…/boss/detail?jobId=A；kernelViewUrl 与 activeKernelViewUrl 同值、可见=true；随后 pack 还原 real。证据：`9.4-01-live-readings.txt` 五                                                                                                                                                                               | [x]  |
| 9.2-03 | 详情动作区「用这份 JD 生成简历」与页头「生成简历」都进入简历生成子页面；带 JD 的那一路把正文填进输入框                            | C+V  | 选中 A 后点详情键：resume-generate-page=true、data-generate-seed=前端工程师、JD 输入框=负责前端页面开发与性能优化、nav-resume 已选中。证据：`9.4-01-live-readings.txt` 四                                                                                                                                                                                        | [x]  |
| 9.2-04 | 真实 BOSS：一页多卡时 `limit` 仍只入库目标条数；独立详情页正文能读进库                                                            | C+V  | 修前 limit=5 入库 12、详情 12 条全失败；修后在卡片循环内收手（单测：一页 3 卡 + limit 2 → 入库 2），并把形状 B 根改 `div.job-detail`、正文加 `div.job-sec-text`；真实复测 limit=1 → stored=1、hasDetail=true、正文 253 字。证据：`9.2-real-boss-flow-findings.md` 二、`9.2-real-boss-detail-dom.txt`                                                             | [x]  |
| 9.2-05 | 真实 BOSS：应用内「打招呼」能走通并把消息记进账本                                                                                 | V    | **受阻**。jdId 传库内自增 id 已修（改传 `jobId`），但适配器仍导航 `/web/geek/chat` 并等 `div#chat-input.chat-input`；真实入口是岗位详情页 `a.btn.btn-startchat` → 同页内联面板 `textarea.input-area` + `div.send-message`，于是 `WAIT_TIMEOUT clickable`。手动点「立即沟通」由 BOSS 发出默认问候，应用账本无 greet 行。证据：`9.2-real-boss-flow-findings.md` 三 | [!]  |
| 9.2-06 | 真实 BOSS：应用内「投递简历」能走通并把 deliver 记进账本                                                                          | V    | **受阻**。已导出真实简历 PDF（4 页 / 230225 字节），`deliver.perform` 报 `WAIT_TIMEOUT appear`；内联聊天面板无 `input[type=file]`，现有 deliver 知识包没有覆盖附件菜单 → 文件控件 → 确认发送。未投出、账本无 deliver 行。证据：`9.2-real-boss-flow-findings.md` 四                                                                                               | [!]  |
| 9.2-07 | 外发额度：search / greet / deliver 受 `dailyLimits` 约束                                                                          | C+V  | **受阻**。`gate.check` 三动作 allowed=true、remaining=null；`cordis.yml` 的 `entitlement.mode = unlimited`，search 40 / greet 20 / deliver 10 未执行。AGENTS §8.3 要求日上限，发货前需切 `daily` 或显式标成开发档。证据：`9.2-real-boss-flow-findings.md` 五                                                                                                     | [!]  |
| 9.2-08 | 抓取在会话首页仍在加载时不因导航竞态失败                                                                                          | C+V  | **受阻**。`sessions.open('boss')` 后立刻 capture 返回 `UNKNOWN (-3) loading '…/shanghai/?seoRefer=index'`；等 `readyState=complete` 后重跑成功。建议 `openSearch` 前等 ready 或对 `(-3) loading` 重试一次。证据：`9.2-real-boss-flow-findings.md` 二.3                                                                                                           | [!]  |

## 9.3 简历页

| ID     | 验收标准                                                                                                             | 方式 | 验证操作                                                                                                                                                                                                                                                                                                | 状态 |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 9.3-01 | 一次可选择多份文件；逐份导入并聚合新入库/重复/扫描件/失败/截断计数；全部失败走结构化错误，部分失败仍保留回执         | U+V  | 选择器：`file-picker.test.ts` 19 例（multiple 合法/非法/省略）；服务路径：两份临时文本简历各 `parse.fromFile` 均 imported/isNew；列表刷新为 4 张卡。**系统文件面板的真实多选与 UI 聚合回执未在无人值守下点击**（原生 dialog 不可由 CDP 驱动），留 `[!]` 等用户在场。证据：`9.4-01-live-readings.txt` 六 | [!]  |
| 9.3-02 | 每份简历可从卡片进入整屏表单页；页头有返回/预览/交给 Office-cc；变体不可编辑并给原因码                               | V    | resume-demo：resume-form-page=true、docId=resume-demo、四键齐；变体卡 edit `aria-disabled=true`、`data-disabled-reason=RESUME_VARIANT_READ_ONLY`。证据：`9.3-02-resume-form-page.png`、`9.4-01-live-readings.txt` 六                                                                                    | [x]  |
| 9.3-03 | 表单短字段一行多列、长字段单列；窄窗降为单列                                                                         | C+V  | 1200 窗：抬头 2 列、意向 2 列、条目短字段 2 列；620 窗：抬头 1 列。类名 `sm:grid-cols-2 xl:grid-cols-4` / 条目 `sm:grid-cols-2 xl:grid-cols-3`，长字段不裹网格。证据：`9.3-02-resume-form-page.png`、`9.4-01-live-readings.txt` 六                                                                      | [x]  |
| 9.3-04 | 预览是弹窗；内容与 `resume.export.preview` 同一份；弹窗内可换出纸语言、关闭；Office-cc 交接入口在页脚                | V    | modal=true、frame=true、srcDocLength=38085、status=已是最新、slotHeight=565；关闭后 modal 消失；locale 与 handoff 键在。证据：`9.3-04-resume-preview-modal.png`、`9.4-01-live-readings.txt` 六                                                                                                          | [x]  |
| 9.3-05 | 简历页不再有 PDF 查看/应用内 PDF 编辑器/快照对照/开发夹具/知识库/缺口/技能入口；编辑统一交 Office-cc（外部应用拉起） | C+V  | 列表页旧入口 `open-pdf-edit` / `snapshots` / `desk-fixtures` 均 false；相关渲染层文件已删除；Office-cc 两步顺序由 `companion-handoff.test.ts` 覆盖。**外部应用真实拉起需用户在场**，本轮未点，留 `[!]`。证据：`9.4-01-live-readings.txt` 六、`9.4-01-gates.txt` 二                                      | [!]  |
| 9.3-06 | 变体只读：卡片不出「按 JD 生成」，编辑按不动并说明回母版；预览/Office-cc/删除仍可用                                  | V    | resume-demo-variant：parent=resume-demo、jdLabel=前端工程师 · 甲公司、edit disabled + reason、无生成键、其余三键在。证据：`9.4-01-live-readings.txt` 六                                                                                                                                                 | [x]  |

## 9.4 门禁与残留

| ID     | 验收标准                                                                                                    | 方式 | 验证操作                                                                                                                                                          | 状态 |
| ------ | ----------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 9.4-01 | `pnpm typecheck` / `lint` / `format:check` / `test` 全绿；渲染层对已删组件零引用；i18n 双语同步、无缺失 key | C    | 四道门禁 EXIT 全 0；renderer build EXIT 0；renderer 规范检查（2 语言包 / 76 源文件）通过；删除清单与 grep 结果、resume-kb 时间炸弹修复记录见 `9.4-01-gates.txt`。 | [x]  |

---

**反向验证（§6.5）**

- 后端 `pdf.io.*` / `pdf.edit.*` / `resume.editor.*` / `resume.snapshot.*` / `kb.*` 服务与桥接方法保留；渲染层 grep 零引用，相关后端测试全绿——删界面没有删掉测试/harness/生成链仍在用的能力。
- 预览只消费 `resume.export.preview`；Office-cc 仍先 `toPdf` 再 `openInCompanionEditor`，没有出现第二条导出或第二条外部编辑通道。
- 筛选不在渲染层对已加载行做假筛：`total` 与 `matched` 都由服务端返回并同时上屏。
