# 计划七 · 模型设置与密钥保管 — 验收 Spec（7.1）

> 实施计划：`docs/plans/07-model-settings/plan.md`
> 方式：**V** = 可视验收（CDP harness 打开 app、截图、读 DOM 断言，一律带 `--url 5173`，须留证据）；
> **C** = 命令/脚本机检；**U** = 单元/集成测试。状态：`[ ]` 未验 / `[x]` PASS / `[!]` BLOCKED（必须写原因）。
> 证据归档：`docs/acceptance/07-model-settings/<条目ID>-*`；V 项无截图不得置 `[x]`（AGENTS.md §7.1/§7.4②），
> 收图前整批跑 `md5 -q | sort | uniq -c` 去重（§9 实测 5.10-18 / 3.6-c ⑭）。

> **条目统计**：14 条。
> **本计划总基调**：验收的是"用户的凭证有没有被好好对待"——
> 存下来要真能重启还在，显示出来要真的看不见明文，说"已加密"要真的加密了，
> 说"连接成功"要真的有一次请求回来。

## 7.1 模型设置与密钥保管

| ID     | 验收标准                                                                                                                                                    | 方式 | 验证操作                                                                                                                                                                                                           | 状态 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 7.1-01 | API key 可经界面/IPC 写入并**落盘**，密钥文件只有一份、位于 userData 下、模式 0600                                                                          | U+C  | `packages/config/src/config.test.ts`（注入假加密器 + 临时目录）断言 `statSync().mode & 0o777 === 0o600`；活体读数见 `7.1-01-secret-file.txt`                                                                       | [x]  |
| 7.1-02 | 在 `safeStorage` 可用的平台上密钥以**密文**落盘：文件里 grep 不到写入的明文                                                                                 | U+V  | 单测：真加密器（macOS 本机 `isEncryptionAvailable=true` 已实测）写入后 `buffer.includes(plain)` 必须为 false；活体：填一个探针 key → `grep -c <探针> userData/secrets.bin` 为 0                                    | [x]  |
| 7.1-03 | `safeStorage` 不可用时回退 0600 明文，且 `read()` 如实回报 `encrypted:false`（**不静默降级**）                                                              | U    | 注入 `isEncryptionAvailable: () => false` 的假端口：写入成功、`encrypted` 为 false、渲染层读数带出这句                                                                                                             | [x]  |
| 7.1-04 | 解密失败（换机/Keychain 变、文件损坏）时报 `SECRET_UNREADABLE` 并**保留原文件**，不清空、不崩主进程                                                         | U    | 破坏 blob 后重新装载：`listSecrets` 回该错误码、文件仍在、`llm.chat.status()` 判 `missing` 含 `apiKey`                                                                                                             | [x]  |
| 7.1-05 | 重启后一切仍然算数：`baseUrl`/模型名来自 `userData/settings.json` 的 `persisted` 层，key 来自密钥库                                                         | U+V  | 集成：装载 → 写入 → 重新 `new Context()` 装载第二次，断言 `trace()` 里 `persisted` 层含该值；活体：重启 app 后信任工作台读数不变（`7.1-05-restart-{before,after}.png`）                                            | [x]  |
| 7.1-06 | key **永不**出现在明文可见的四个面：`config.trace()` 返回值、`settings.json` 内容、日志文件、渲染层回包                                                     | C+U  | 脚本三面 grep（写入探针 key 后 grep `userData` 目录 + `logs` + `trace()` JSON dump）+ 单测断言 `read()` 返回体里没有 key 字段、只有 `tail` 末 4 位                                                                 | [x]  |
| 7.1-07 | `llm.chat` / `llm.embed` 的 key 读取链为「密钥库优先 → `keyEnv` 环境变量兜底」，且 `status()` 能说出来源                                                    | U    | 三个用例：只有密钥库 / 只有 env / 两者都有（前者胜），`status().keySource` 分别为 `secret` / `env` / `secret`；`LLM_UNAVAILABLE` 的错误文案随之更新                                                                | [x]  |
| 7.1-08 | 保存 `baseUrl`/模型名后**无需重启即生效**（经 `kernel.applyConfig` 热改，下游 `llm.chat` 读到新值）                                                         | U+V  | 活体：改模型名 → 立刻 `llm.chat.status().model` 为新值（截图 + 读数 `7.1-08-hot-apply-readings.txt`）；顺带记录"配置改动会重建下游"这句播报                                                                        | [x]  |
| 7.1-09 | 支持任意 OpenAI 兼容端点：`providerId` 为 `custom` 时可保存任意合法 URL + 模型名，与预设走同一条代码路径                                                    | U+V  | 单测：任意合法地址（本机取 RFC 保留域 `https://custom.test.invalid/v1`，§7.2 的 allowlist 口径）保存成功、拼出的地址是 `<baseUrl>/chat/completions`；活体：自定义项指向本地 fixture（`http://127.0.0.1:10233/v1`） | [x]  |
| 7.1-10 | 连通性测试 `check()` 只发**一次**最小请求，成功/失败都回结构化结果，且失败原因可读（超时 / 非 2xx / 空回复 / 未配置）                                       | U+C  | 打本地 fixture 路由（§7.2 不许打真实平台）；`scripts/check-llm-single-entry.ts` 仍绿 = 未新开第二套 fetch                                                                                                          | [x]  |
| 7.1-11 | 「信任」工作台有模型设置分区：提供商、`baseUrl`、模型名、掩码 key 四格 + 保存 + 测试连接两颗动作键，均带 `data-action`；禁用态必须带 `data-disabled-reason` | V    | `--url 5173` 深浅两主题各一张（`7.1-11-model-settings-{light,dark}.png`）+ 读数文件；按 AGENTS.md §9 口径先冻结动画再量几何                                                                                        | [x]  |
| 7.1-12 | 分区内**每一条**页面文案走 i18n，`settings.model.*` 在 `zh-CN` 与 `en` 两份语言包键对齐；动态值用插值参数                                                   | C    | `pnpm lint`（裸文案 + 键对齐 + 占位符实参齐备）通过                                                                                                                                                                | [x]  |
| 7.1-13 | 界面不说谎：未配置时"测试连接"禁用并给出原因码；key 保存后输入框显示掩码且**不回填**明文；`encrypted:false` 时状态行明写"未加密存储"                        | V    | 三态活体读数 + `7.1-13-key-masked.png`（DOM 里 `input[type=password]` 的 `value` 长度与末 4 位指纹对得上，页面文本不含明文 key）                                                                                   | [x]  |
| 7.1-14 | 反向验证（§6.5）：`llm.settings` **不**注册为 agent 工具，且这条偏离没有造成能力缺口——脚本化配置路径（env / cordis.yml）仍然可用，装机用户不需要终端        | C+V  | grep `registerAgentTools` 射程内无 `llm.settings`；`cordis.yml` 的 `llm` 块与 `keyEnv` 未被删除；活体：全程只用界面完成一次从"无 key"到"连通成功"                                                                  | [x]  |

## 收尾自检（AGENTS.md §7.4）

- [x] ① 四条门禁全绿（2026-10-06 本机 macOS，结论重定向到文件再看 `EXIT=`）：
      `pnpm typecheck` EXIT=0 / `pnpm lint` EXIT=0 / `pnpm format:check` EXIT=0 / `pnpm test` EXIT=0（2048 条通过，逐包核对无 failed）
      收口后再跑一遍 `format:check` 时唯一告警是另一窗口当时正在写的 `packages/renderer/src/ui/controls.tsx`（本切片未碰它）；
      本片的文件单独 `prettier --check` 仍 EXIT=0
- [x] ② V 类条目逐条对应截图或 DOM 读数，本目录归档：
      01→`7.1-01-secret-file.txt`；02→`7.1-02-ciphertext.txt`；05→`7.1-05-restart-{before,after}.png` + `7.1-05-restart-readings.txt`；
      06→`7.1-06-no-plaintext-readings.txt`；08→`7.1-08-hot-apply-readings.txt`；09/10→`7.1-09-10-check-and-legs.txt`；
      11→`7.1-11-model-settings-{light,dark}.png` + `7.1-11-panel-inventory.txt`；13→`7.1-13-key-masked.png` + `7.1-13-no-lie-readings.txt`。
      同批 5 张图 `md5 -q | sort | uniq -c` 全为 1（§9 5.10-18 / 3.6-c ⑭ 的硬步骤）
- [x] ③ 上表状态位更新：14 条全部 `[x]`，无 `[!]`。
      原先准备标 `[!]` 的 7.1-02（"本机 safeStorage 不可用"）在取证过程中被查明是**实现缺陷**而非环境限制——
      `resolveCipher()` 读错了 `safeStorage` 的挂载点、又在 `app.whenReady()` 之前问可用性，两处都已修掉，
      来龙去脉与"为什么四道门禁拦不住它"写在 `7.1-02-ciphertext.txt` 末尾
- [x] ④ 复用检查：密钥存储全仓一处（`packages/config/src/secret.ts`）；LLM 出口仍只有 `llm.chat`/`llm.embed`，
      `check()` 复用 `llm.chat.complete()`，由 `scripts/check-llm-single-entry.ts` 机检（禁 `llm.settings` import `./http.js`）；
      配置读取仍只有 `config` 那一套，新增的是它的 `persisted` 层；渲染层复用 `useBridgeAction` / `DeskButton` / `deskReason` / `Banner`，
      未新开提示与忙碌态
- [x] ⑤ 死代码检查：`pnpm lint`（no-unused-vars / no-explicit-any，`--max-warnings 0`）EXIT=0；
      取证过程中删掉了 fixture 里重复的 `/v1/chat/completions` 路由与 `chatCompletionsReply` 辅助函数（59c109b）
- [x] ⑥ Tailwind / lucide / i18n：分区只用 utility 与既有 `FIELD_CLASS`；图标全取 lucide 现有（Save/Plug/KeyRound/…）；
      41 条文案全走 `shell.settings.model.*`，`zh-CN` 与 `en` 键对齐、占位符实参齐备（`pnpm lint` 的裸文案 + 键对齐校验 EXIT=0）
- [x] ⑦ 提交 + 推送（§1.6）：两个提交按 pathspec 分开提——`3b3857c`（config 的两处形状缺陷 + AGENTS.md 实测）、
      `2fcb171`（7.1-d 渲染层分区与全部验收证据）。推 `git push origin main` 成功（`be76a88..2fcb171`），
      复核 `git ls-remote origin main` 与 `git rev-parse HEAD` / `refs/remotes/origin/main` 三处 sha 一致
      （均为 `2fcb171681104387a0cbf4e4c01efff539cfdf6e`）；同一工作树里另一窗口正在写的四个渲染层文件未被吞进提交
- [x] ⑧ 暂存区无测试临时产物：探针脚本与原始日志留在 `tmp/71d/`（gitignored），
      入库图片只有 `docs/acceptance/07-model-settings/**` 且文件名逐条对应 spec ID；
      密钥文件与那份明文备份（`tmp/71d-plaintext-secrets.bin.bak`）都在 tmp 下，不进仓库

## 与本计划相邻但**不属于**本片的两件事（避免被误记成已完成）

- `ModelSettingsPanel` 目前仍用本片的 `FIELD_CLASS` + 裸 `<select>`/`<input>`；6.2-14 那只正在把各面板迁到
  `DeskField`/`DeskSelect`/`DeskTextarea`（同一窗口在改 `KbPanel` 等），到货后按它的口径替换，本片不预支。
- 向量腿（`llm.embed`）的连通性测试明确回 `CHECK_NOT_SUPPORTED`（按钮禁用并给同一原因码），
  不是"做了一半"，是这一按不发任何请求的如实读数；要真做属于 4.3 那条线。
