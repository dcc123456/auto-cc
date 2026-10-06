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

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 7.1-01 | API key 可经界面/IPC 写入并**落盘**，密钥文件只有一份、位于 userData 下、模式 0600 | U+C | `packages/config/src/config.test.ts`（注入假加密器 + 临时目录）断言 `statSync().mode & 0o777 === 0o600`；活体读数见 `7.1-01-secret-file.txt` | [ ] |
| 7.1-02 | 在 `safeStorage` 可用的平台上密钥以**密文**落盘：文件里 grep 不到写入的明文 | U+V | 单测：真加密器（macOS 本机 `isEncryptionAvailable=true` 已实测）写入后 `buffer.includes(plain)` 必须为 false；活体：填一个探针 key → `grep -c <探针> userData/secrets.bin` 为 0 | [ ] |
| 7.1-03 | `safeStorage` 不可用时回退 0600 明文，且 `read()` 如实回报 `encrypted:false`（**不静默降级**） | U | 注入 `isEncryptionAvailable: () => false` 的假端口：写入成功、`encrypted` 为 false、渲染层读数带出这句 | [ ] |
| 7.1-04 | 解密失败（换机/Keychain 变、文件损坏）时报 `SECRET_UNREADABLE` 并**保留原文件**，不清空、不崩主进程 | U | 破坏 blob 后重新装载：`listSecrets` 回该错误码、文件仍在、`llm.chat.status()` 判 `missing` 含 `apiKey` | [ ] |
| 7.1-05 | 重启后一切仍然算数：`baseUrl`/模型名来自 `userData/settings.json` 的 `persisted` 层，key 来自密钥库 | U+V | 集成：装载 → 写入 → 重新 `new Context()` 装载第二次，断言 `trace()` 里 `persisted` 层含该值；活体：重启 app 后信任工作台读数不变（`7.1-05-restart-{before,after}.png`） | [ ] |
| 7.1-06 | key **永不**出现在明文可见的四个面：`config.trace()` 返回值、`settings.json` 内容、日志文件、渲染层回包 | C+U | 脚本三面 grep（写入探针 key 后 grep `userData` 目录 + `logs` + `trace()` JSON dump）+ 单测断言 `read()` 返回体里没有 key 字段、只有 `tail` 末 4 位 | [ ] |
| 7.1-07 | `llm.chat` / `llm.embed` 的 key 读取链为「密钥库优先 → `keyEnv` 环境变量兜底」，且 `status()` 能说出来源 | U | 三个用例：只有密钥库 / 只有 env / 两者都有（前者胜），`status().keySource` 分别为 `secret` / `env` / `secret`；`LLM_UNAVAILABLE` 的错误文案随之更新 | [ ] |
| 7.1-08 | 保存 `baseUrl`/模型名后**无需重启即生效**（经 `kernel.applyConfig` 热改，下游 `llm.chat` 读到新值） | U+V | 活体：改模型名 → 立刻 `llm.chat.status().model` 为新值（截图 + 读数 `7.1-08-hot-apply-readings.txt`）；顺带记录"配置改动会重建下游"这句播报 | [ ] |
| 7.1-09 | 支持任意 OpenAI 兼容端点：`providerId` 为 `custom` 时可保存任意合法 URL + 模型名，与预设走同一条代码路径 | U+V | 单测：`https://example.test/v1` 保存成功、拼出的地址是 `https://example.test/v1/chat/completions`；活体：自定义项指向本地 fixture（`http://127.0.0.1:10233/v1`） | [ ] |
| 7.1-10 | 连通性测试 `check()` 只发**一次**最小请求，成功/失败都回结构化结果，且失败原因可读（超时 / 非 2xx / 空回复 / 未配置） | U+C | 打本地 fixture 路由（§7.2 不许打真实平台）；`scripts/check-llm-single-entry.ts` 仍绿 = 未新开第二套 fetch | [ ] |
| 7.1-11 | 「信任」工作台有模型设置分区：提供商、`baseUrl`、模型名、掩码 key 四格 + 保存 + 测试连接两颗动作键，均带 `data-action`；禁用态必须带 `data-disabled-reason` | V | `--url 5173` 深浅两主题各一张（`7.1-11-model-settings-{light,dark}.png`）+ 读数文件；按 AGENTS.md §9 口径先冻结动画再量几何 | [ ] |
| 7.1-12 | 分区内**每一条**页面文案走 i18n，`settings.model.*` 在 `zh-CN` 与 `en` 两份语言包键对齐；动态值用插值参数 | C | `pnpm lint`（裸文案 + 键对齐 + 占位符实参齐备）通过 | [ ] |
| 7.1-13 | 界面不说谎：未配置时"测试连接"禁用并给出原因码；key 保存后输入框显示掩码且**不回填**明文；`encrypted:false` 时状态行明写"未加密存储" | V | 三态活体读数 + `7.1-13-key-masked.png`（DOM 里 `input[type=password]` 的 `value` 长度与末 4 位指纹对得上，页面文本不含明文 key） | [ ] |
| 7.1-14 | 反向验证（§6.5）：`llm.settings` **不**注册为 agent 工具，且这条偏离没有造成能力缺口——脚本化配置路径（env / cordis.yml）仍然可用，装机用户不需要终端 | C+V | grep `registerAgentTools` 射程内无 `llm.settings`；`cordis.yml` 的 `llm` 块与 `keyEnv` 未被删除；活体：全程只用界面完成一次从"无 key"到"连通成功" | [ ] |

## 收尾自检（AGENTS.md §7.4）

- [ ] ① `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 全绿（结论重定向到文件再看 `EXIT=`，不许管道接 `tail`）
- [ ] ② V 类条目逐条对应截图或 DOM 读数，本目录归档
- [ ] ③ 上表状态位更新，`[!]` 必须写原因（例：Windows/Linux 的 safeStorage 行为在本机 macOS 无法验证）
- [ ] ④ 复用检查：未新增第二套配置读取 / 第二套 LLM 客户端 / 第二个密钥存储
- [ ] ⑤ 死代码检查
- [ ] ⑥ Tailwind / lucide / i18n 三项
- [ ] ⑦ 提交 + 推送（§1.6；本机无远端时如实报告未推送）
- [ ] ⑧ 暂存区无测试临时产物（截图只允许 `docs/acceptance/07-model-settings/**`）
