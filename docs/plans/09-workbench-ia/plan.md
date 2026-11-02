# 计划九 · 工作台信息架构收敛（岗位 / 简历 / 运行记录 / 设置）

> 立项：2026-11-02 用户点名。目标不是加新能力，而是让**左轨每个菜单名与页面内容一一对上**。
> 交付方式按仓库纪律：一次只推进一个子计划；先 plan、再代码、再逐项验收。

## 0. 用户裁断（2026-11-02）

1. 岗位菜单 = 所有岗位相关功能的入口：搜索、库内筛选、岗位详情、按岗位打开浏览器、打招呼/投递、用这份 JD 生成简历。
2. 简历菜单保持内容方向，但要简洁：可同时上传多份、每份一张简洁表单（新开 App 内整屏子页面）、预览走弹窗、编辑统一交 Office-cc；冗余功能直接删除。
3. 「信任」显示名改为 **运行记录**。
4. 「诊断」显示名改为 **设置**；开发者实验台能删的都删。
5. 内部视图 id `trust` / `diagnostics` 与所有 `data-action` 保持不变（harness 与历史验收通道）。

## 1. 选型与证据

- **多文件选择**：沿用 Electron 既有 `dialog.showOpenDialog` 的 `multiSelections` 属性（Electron 44 本机实测可用），不引入新依赖，也不开放目录选择。
- **库内筛选**：在 `jd.store` 的服务端做参数化 SQL（`instr()` + 绑定参数），不在渲染层对已加载的 100 条做假筛选；`total` 与 `matched` 两个读数同时回传。
- **表单页 / 生成页**：复用既有 `ResumeFormPanel` / `GeneratePanel`，只加整屏页头与返回；不新造第二套表单或生成链。
- **预览弹窗**：复用既有 `ResumePaperFrame`（A4 缩放与只读 `sandbox=""`），只把容器从右栏换成 `Modal`；`MODAL_WIDTH` 增加 `960` 档。
- **Office-cc**：仍走 `handOffDocumentToCompanion` 的两步（先 `toPdf`，成功后才 `openInCompanionEditor`）。
- **删除边界**：本轮删的是**渲染层入口与页面**；`pdf.io.*` / `pdf.edit.*` / `resume.editor.*` / `resume.snapshot.*` / `kb.*` 后端服务与桥接方法保留给测试、harness 与生成链。

## 2. 切片

### 9.1 菜单与设置页

- `App.tsx`：`trust` 显示名走 `nav.trust`（运行记录），`diagnostics` 走 `nav.diagnostics`（设置）；图标改 `History` / `Settings`；`diagnostics` 仍 `primary: false`。
- `PANELS.diagnostics` 改为 `SettingsPanel` + `UpdateSection`；删除 `ShellPanel` / `LocatorLabPanel` / `WorkflowLabPanel` / `AssemblyPanel` 及专属 i18n key。
- `SettingsPanel` 只读展示应用版本 / Electron / Node / 平台，并保留更新检查。

### 9.2 岗位页

- 清单上方加库内筛选条：关键词（标题/公司）、城市、经验、只看已回复；「筛选」「清空」「加载更多」。
- `jd.store.list(limit, filter)` 新增第二参数；服务端 `buildFilter` 同时供命中计数与行查询，避免两套条件。
- 详情动作区新增「在浏览器打开」：`sessions.open(platform)` 成功后 `browser.page.navigate(sourceUrl)`；内核视图自动显示。
- 详情动作区新增「用这份 JD 生成简历」；页头新增「生成简历」总入口；两者都走既有 `advanceViewTrail`。
- 保留打招呼、投递、确认卡片、抓取进度/结局与话术面板。

### 9.3 简历页

- `ResumeDesk` 重写为简洁列表：导入（可多选）、出纸语言、生成入口、每份简历一张卡。
- 每张卡：姓名/变体标签/待确认徽标、出处、上次改动、编辑表单 / 预览 / 按 JD 生成（仅母版）/ 交给 Office-cc / 删除。
- 多文件导入：`shell.selectFile({ multiple: true })` → `filePaths`，逐份 `resume.parse.fromFile`，聚合成新入库 / 重复 / 扫描件 / 失败 / 截断计数；渲染层上限 20 份。
- 新页：`ResumeFormPage`（整屏表单）、`ResumeGeneratePage`（整屏生成）；新弹窗：`ResumePreviewModal`。
- `ResumeFormPanel`：抬头/意向短字段 `sm:grid-cols-2 xl:grid-cols-4`，条目短字段 `sm:grid-cols-2 xl:grid-cols-3`，长字段单列通栏。
- 删除：PDF 查看轨、应用内 PDF 编辑器、快照/差异抽屉、开发夹具、知识库/缺口/技能面板、右栏纸面与拖拽把手、高级绝对路径输入、4 步引导与回查页签。
- 待确认清单保留为列表上方一条紧凑披露；变体的「编辑表单」按不动并给 `RESUME_VARIANT_READ_ONLY`。

### 9.4 文档与门禁

- 新增本 plan 与 `docs/specs/09-workbench-ia/spec.md`，验收证据放 `docs/acceptance/09-workbench-ia/`。
- `docs/00-master-plan.md` §4 增加 P9。
- 既有 spec 只加退场注记，不改历史 ID：06（6.3-02/03、6.2-06 诊断读数）、03（3.5/3.12 PDF 界面、3.16 Office-cc 保留）、04（4.2/4.9 界面退场、服务保留）、01（1.5/1.6 诊断界面取证改由 harness 承担）。

## 3. 关键接口

```ts
FilePickerRequestView.multiple?: boolean;
'shell.selectFile' returns { filePath: string | null; filePaths: string[] };

JobListFilterView { keyword?, city?, experience?, platform?, replied? }
JobListResultView { total, matched, rows }
'jd.store.list' args: [limit?: number, filter?: JobListFilterView]
```

## 4. 验证

- 门禁：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 全绿（逐包退出码与日志见验收记录）。
- 活体（10222 / 5173）：导航名与 id、设置页实验台缺席、岗位筛选三档、岗位打开浏览器（fixture pack 临时切换后还原）、两个简历生成入口、简历表单页宽/窄列数、预览弹窗、变体只读、旧入口缺席。
- 多文件系统面板属用户在场项：文件选择器参数与多选分支由 `file-picker.test.ts` 覆盖；UI 聚合回执在用户在场时手动验一次，未取到就如实 `[!]`。
- 截图一律 `harness shot --url 5173`，同批 `md5 -q | sort | uniq -c` 去重；含真实简历个人信息的列表不入库，只用逐字读数。

## 5. 反向验证（§6.5）

- 界面退场不等于服务删除：`pdf.io.*` / `pdf.edit.*` / `resume.editor.*` / `resume.snapshot.*` / `kb.*` 仍被测试、harness 或生成链使用；渲染层 grep 零引用，后端测试全绿。
- 预览与导出同源：弹窗只消费 `resume.export.preview`；Office-cc 仍先 `toPdf` 再 `openInCompanionEditor`，两步顺序由 `companion-handoff.test.ts` 守住。
- 筛选不在渲染层作假：服务端返回 `total/matched`，界面两条读数同时上屏。

## 6. 2026-11-02 真实 BOSS 复测补记

用用户已登录的真实 BOSS 账号跑了一轮最小规模流程（搜「前端开发」/上海 → 入库 → 打开岗位页 → 打招呼 → 投递）。
本轮直接修掉五处：`script.jdId` 误用库内自增 id（改传平台 `jobId`）、`limit` 被一整页卡片吞掉（卡片循环内收手）、
独立详情页正文选择器失配（根 `div.job-detail`、正文 `div.job-sec-text`）、已有会话的打招呼入口
（`chatStartButton` → 详情页「继续沟通」→ `/web/geek/chat`）、发送凭据改看消息列表里是否出现刚发正文。
另外把 `entitlement.mode` 从 `unlimited` 改为 `daily`（用户裁定）。

仍走不通、已登记在 spec `9.2-05…08` 的：

- 已有会话的适配器已补，但真实复测两次都在话术生成、导航到 `/web/geek/chat` 之后被 CDP 输入挂住：
  页面无新消息、账本无 greet 行；窗口已 AppleScript 置前仍挂。新会话的内联聊天面板
  （`textarea.input-area` + `div.send-message`）尚未实现，避免应用没发出话却由站点先发默认问候；
- 真实投递的附件上传路径未进知识包，`deliver.perform` 会 `WAIT_TIMEOUT appear`；聊天页「发简历」
  当前还是 `.unable` 态；
- 会话首页仍在加载时立刻抓取会撞 `(-3) loading`，需等 ready 或重试。

完整读数、账实差异（手动点「立即沟通」由 BOSS 发出默认问候、应用账本无 greet 行）与优化建议见
`docs/acceptance/09-workbench-ia/9.2-real-boss-flow-findings.md`。
