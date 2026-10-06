# P7 · 模型设置与密钥保管（Model Settings）— 实施计划

> 版本：v1.0　状态：**进行中**
> 立项缘由：2026-10-06 用户直接点名「模型 api key 的配置模块需要补上」，并追加两条口径：
> **① 模型要由用户自己配置；② 必须支持所有 OpenAI 协议的模型提供商（DeepSeek / 火山引擎 / OpenAI 等）**。
> 计划树里原先没有一条子计划负责这件事（见 §2 缺口清单），因此单开 P7 并在
> `docs/00-master-plan.md` §4 登记。本计划**只补配置面**，不接 agent 真模型腿（那是 5.x 的射程）。

---

## 1. 目标与边界

**目标**（四件事，缺一不算收口）：

1. 用户能在 **app 界面里**填写并保存模型提供商、`baseUrl`、模型名与 API key，**重启后仍然算数**；
2. API key **不以任何明文形态**离开主进程的密钥库：不进 `cordis.yml`、不进四层合并结果、
   不进 `config.trace()` 的读数、不进日志、不回传渲染层（渲染层只见掩码）；
3. 支持任意 OpenAI 兼容端点：预设提供商只是**填表助手**，`baseUrl`/模型名一律可由用户改写，
   自定义端点与预设走完全同一条代码路径；
4. 界面对「现在到底能不能用模型」给出**不说谎的读数**：缺哪一项、key 来自哪里、是否已加密存储、
   连通性测试的实际结果，且保存后不必重启就生效。

**边界（明确不做）**：

- **不**把 `agent.loop` 从 `StubLoopModel` 换成真模型（plan 05 §F6 那条仍未解锁，本计划只让 `llm.chat` 变得可配置）。
- **不**新建包、不新建第二套配置读取、不新建第二套 LLM 客户端（AGENTS.md §2.7）：
  配置与密钥一律扩展现有 `config` 服务，模型侧的读表/写表落在 `packages/llm` 内的**第二个方法层** `llm.settings`。
- **不**新增 SQLite 迁移：密钥与设置落 userData 下的两个文件，避免与 `docs/00-master-plan.md` 里
  预留给 3.6 的 30 号段撞号（AGENTS.md §9 实测 5.3-a 那条）。
- **不**在本计划里做云同步、多 Profile、密钥轮换历史。
- agent 工具面**不**注册 `llm.settings`：让 agent 自己填 key 等于凭证的自提升，与 §1.7「不可自提升」同源，
  这是有意的偏离 §5.9 的一处，反向验证条目写在 spec 7.1-14。

---

## 2. 缺口清单（立项依据，全部为 2026-10-06 现读）

| #   | 事实                                                                                                                                                                         | 出处                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| G1  | key **只从环境变量读**，且是读变量名：`readKey = () => process.env[this.options.keyEnv]?.trim() ?? ''`                                                                       | `packages/llm/src/index.ts:107`（`embed.ts:126` 同）                             |
| G2  | 全仓**没有任何密钥落盘**：`safeStorage` / `keytar` / `dotenv` 零命中；`cordis.yml` 的 `llm` / `llm-embed` 块故意留空                                                         | 全仓 grep + `cordis.yml:27-44`                                                   |
| G3  | 配置层**没有持久层**：四层是 `default < file < env < runtime`，`setRuntime` 只写内存 Map；`kernel.runtimePatches` 同样是内存，重启即失（AGENTS.md §9 实测 5.3-b 已记过这条） | `packages/config/src/index.ts:44-52,99` / `packages/kernel/src/index.ts:137`     |
| G4  | 渲染层**没有设置页**：只有诊断屏的 `AssemblyPanel` 裸 JSON 文本域；工作台四张里「信任」= 登录态 / 额度 / 漏斗，没有模型那一格                                                | `packages/renderer/src/App.tsx:295-331`                                          |
| G5  | 语言包**没有** `settings.*` 命名空间；`BridgeCalls` **没有** `llm.*` 任何一条白名单项                                                                                        | `packages/renderer/src/locales/*.json` / `packages/shared/src/bridge.ts:171-176` |
| G6  | 设计基线早就画了这一格：08 稿「换一份 key / 看诊断」→「前者原地长出密钥输入井（**掩码**）」                                                                                  | `docs/design/ui-drafts/08-click-map.html:1310-1311`                              |

---

## 3. 选型与证据（AGENTS.md §6.1 / §6.2）

### 3.1 密钥存在哪：safeStorage 密文文件，回退 0600 明文

- **候选**：① Electron `safeStorage` 加密后写 `userData/secrets.bin`；② 明文 JSON（0600）写 userData；
  ③ 新建 SQLite 迁移存 key；④ 继续只走环境变量。
- **否决 ④**：这正是缺口本身——命令行赋值只对那个进程有效，装机用户不会 export，验收记录里
  `AUTO_CC_LLM_API_KEY` 长期未设置（`docs/acceptance/4.4/4.4-02-model-leg-fallback.txt:56,140`），
  模型腿因此一直走模板回落。
- **否决 ③**：key 进 WAL 数据库意味着日志、备份、失败证据三处都要重新脱敏；且加表必须另起迁移号段
  （§9 实测 5.3-a），30 已预留给 3.6，为一个文件级别的事实占一支迁移不值。
- **否决「只用 ②」**：AGENTS.md §8.6 的措辞是「系统安全存储**或**本地配置文件」，两条都合法，但 macOS/Windows
  上有更好的选择却不使用，等于把明文密钥长期摊在 `%APPDATA%\auto-cc\` 里。
- **采用**：① 为主、② 为回退。`isEncryptionAvailable()` 为 false（Linux 无 secret service、
  或 `--password-store=basic` 的场合）时退回 0600 明文，并且**这个事实要在界面上说出来**（状态行显示"未加密存储"），
  不做静默降级。
- **本机实测（2026-10-06，spike 在 `.research-repos/p7-model-settings/`，不进仓库）**：
  以 `--user-data-dir` 起独立 Electron 44.4.5、**不开可见窗口**，结果
  `isEncryptionAvailable=true` / `encryptString` 35 字节（头 8 字节 `763130231a3dc56f`，即 `v10` + Keychain 包装）/
  **往返解密成功**。同一份 `result.txt` 另记两条：`fs.writeFileSync` 默认落 **0644**，因此密钥文件必须由我们自己
  `chmod 0600`；`getSelectedStorageBackend()` 仅 Linux 有意义。
- **同一次 spike 的第二条实测（决定单测怎么写）**：纯 Node 里 `require('electron')` 返回的是**二进制路径字符串**，
  `.safeStorage` 是 `undefined`。所以密钥库用「特性探测」而不是 try/catch 包 import——
  vitest 下必然走明文回退分支（确定性、可断言），加密分支由注入的假加密器覆盖。
- **补记（2026-10-06，7.1-d 收口时活体取证撞出来的，两处都已修）**：上面那条 spike 用 `require` 量到的
  `isEncryptionAvailable=true` 是对的，错的是 app 里那段探测代码本身：
  ① `safeStorage` 是 `import('electron')` 返回值上的**成员**，对模块对象直接解构那三个方法永远拿到 undefined，
  于是加密分支静默失效、每个平台都走明文回退（界面倒是如实说"未加密存储"，所以从界面上看不出是缺陷）；
  ② 同一台机器同一份 Electron 44.4.5，`isEncryptionAvailable()` 在 `app.whenReady()` **之前一律回 false**
  （before-ready=false / after-ready=true，换两个目录各跑一次结论一致），而密钥库是在装配期装载的——
  所以 `resolveCipher()` 现在先 `await app.whenReady()` 再问可用性。
  **这条补记要留下的教训**：假加密器是直接塞进 `SecretStore` 构造器的，绕过了真正出问题的 `resolveCipher()`，
  所以四道门禁全绿也拦不住它；探测类代码的可测面必须自己露出一半——现已抽出纯函数 `cipherFromElectronModule(mod)`，
  两种互操作落点（`mod.safeStorage` / `mod.default.safeStorage`）与"摊在模块本身"的错形状各有断言。
  完整来龙去脉见 `docs/acceptance/07-model-settings/7.1-02-ciphertext.txt`。

### 3.2 设置怎么持久：给四层合并插进第五层 `persisted`

- **位置**：`default < file(cordis.yml) < **persisted** < env < runtime`。
- **为什么在 `file` 之上**：cordis.yml 是入库的基线清单，装机后的用户表态必须盖过它。
- **为什么在 `env` 之下**：环境变量是本项目验收与 CI 的覆盖口子（`docs/plans/04-resume-kb/plan.md:644-646`
  的复跑步骤就是"导出 key → 改清单"），让界面里存下的值盖过 env，等于把 QA 的口子焊死。
- **落点**：`userData/settings.json`，形状与 runtime patch 同构（`{ "<插件id>": {…} }`），只写被白名单放开的键
  （见 3.5），模式 0600。
- **为什么不复用 `plugins.saveConfig`**：它通向 `kernel.applyConfig` → `patchRuntime`，**纯内存**
  （§9 实测 5.3-b 原文）。本片不动它的热改语义，而是在其后接一步"同时写盘"，
  于是既有调用点行为不变，新增的是持久化。

### 3.3 支持哪些提供商：预设是目录数据，不是代码分支

用户口径是"所有 OpenAI 协议的模型"，因此**能力上不做限制**：`baseUrl` 与模型名是自由文本，
`z.url()` + 非空校验；预设目录 `PROVIDER_CATALOG` 只是 `{id, baseUrl, models[], docsUrl}` 的数据，
选预设=填三个格子，与手填自定义端点殊途同归（同一条 `apply` 路径、同一条 `joinEndpoint`）。

- **端点实测（2026-10-06 本机，无 key 直连，看状态码判断"路径对不对"）**：
  | 提供商       | 试探地址                                                    | 结果                                                                           |
  | ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
  | DeepSeek     | `https://api.deepseek.com/chat/completions`                 | **401**（到达了鉴权层，路径正确）                                              |
  | DeepSeek     | `https://api.deepseek.com/v1/chat/completions`              | **401**（两种写法都通，与本仓既有实测一致）                                    |
  | 火山方舟 Ark | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | **401**                                                                        |
  | 硅基流动     | `https://api.siliconflow.cn/v1/chat/completions`            | **401**（与 `docs/plans/04-resume-kb/plan.md:605` 的 embeddings 实测同一口径） |
  | OpenAI       | `https://api.openai.com/v1/chat/completions`                | **000 = 本机网络不可达**，不是端点缺陷；写进预设但标注"需网络可达"             |
  - 结论：`http.ts` 的 `joinEndpoint` 已经处理带/不带 `/v1` 与尾斜杠，四种形态都不需要特例代码。
  - 一手来源：DeepSeek 官方 API 文档 <https://api-docs.deepseek.com/zh-cn/>（`create-chat-completion`）、
    火山方舟官方文档 <https://www.volcengine.com/docs/82379/1298454>（OpenAI SDK 兼容与 base_url）。
    本项目的纪律是**以实测为准**（§6.2），上表的 401 读数才是路径判据，文档只是出处记账。

### 3.4 热改与重建：key 不进配置层，所以不会因保存而重建下游

- `llm.chat` 的 `readKey()` 改成**用的时候现问**密钥库（§9 实测 2.5 那条："不要在本地存第二份事实"），
  `baseUrl`/`model` 仍来自配置层。
- 因此保存 key 走的是纯文件写，**不触发** `plugins.saveConfig` 的连锁重建；只有改 `baseUrl`/`model` 才走
  `kernel.applyConfig`（会重建注入 `llm.chat` 的下游服务，§9 实测 5.3 已记）。这条差别要在验收里被读到。

### 3.5 允许落盘的键（白名单，防止界面变成任意配置的写入口）

`persisted` 层只接受：`llm.{baseUrl,model}`、`llm-embed.{baseUrl,model}`、`llm-settings.{providerId,embedProviderId}`。
白名单由 `llm.settings` 自己声明（它是唯一调用方），`config.setPersisted` 只接受**已在挂载期登记过 schema 的插件 id**，
其余路径一律 `AppError('SETTING_NOT_ALLOWED')`。

---

## 4. 改动清单（按包，一个包一件事）

| 包                             | 改动                                                                                                                                                                                                                               | 说明                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/config`              | 新增 `secret.ts`（纯函数 + 特性探测的加密器端口）与 `persist.ts`（settings.json 读写）；`ConfigService` 增 `getSecret/setSecret/clearSecret/listSecrets`（只回掩码）与 `setPersisted/persisted()`；`traceConfig` 插 `persisted` 层 | 唯一一处配置/密钥基础设施，不做第二套                                                              |
| `packages/llm`                 | 新增 `settings.ts` → `LlmSettingsService`（`llm.settings`）：`catalog()/read()/apply()/check()/clearKey()`；`index.ts` 与 `embed.ts` 的 `readKey()` 换成"密钥库优先 → `keyEnv` 兜底"，`LlmStatus` 增 `keySource`/`encrypted`       | `check()` 复用 `llm.chat.complete()`，不新开 fetch（`scripts/check-llm-single-entry.ts` 必须仍绿） |
| `packages/shared`              | `BridgeCalls` 增 5 条 + `llm.settings.*` 白名单条目与类型                                                                                                                                                                          | 渲染层不碰 Node（§5.8）                                                                            |
| `packages/main` / `cordis.yml` | 注册 `llm-settings`；清单里排在 `config`、`llm`、`llm-embed` **之后**（§9 实测 5.1-c：清单顺序=挂载顺序）                                                                                                                          |                                                                                                    |
| `packages/renderer`            | 新增 `ModelSettingsPanel.tsx`，挂进 `App.tsx` 的 `PANELS.trust`；`settings.model.*` 双语键补齐                                                                                                                                     | Tailwind + lucide + i18n 三项硬要求（§5）                                                          |
| `scripts`                      | `fixture-server.ts` 增一条 OpenAI 兼容 `/v1/chat/completions` 本地路由                                                                                                                                                             | §7.2：自动化测试不得打真实平台，连通性验收打本地 fixture                                           |

---

## 5. 片序（每片自带验收，一次一片）

| 片    | 内容                                                                                                                | 依赖 |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ---- |
| 7.1-a | `config`：secret 存储 + persisted 层 + 单测（注入假加密器、覆盖 0600、掩码、回退播报）                              | 无   |
| 7.1-b | `llm`：`readKey` 换链 + `llm.settings` 服务 + 单测（catalog/read/apply/check/clearKey、白名单拒绝、key 不落 trace） | a    |
| 7.1-c | IPC 契约 + `fixture-server` 的 chat 路由 + 重启存活集成断言                                                         | b    |
| 7.1-d | 渲染层「信任」工作台的模型分区 + 双语 + harness 活体截图（深浅两主题、掩码态、保存后读数变化、连通性成功/失败两态） | c    |

---

## 6. 风险与对策

| 风险                                                                         | 对策                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Linux 无 secret service → 明文回退被当成加密存储宣传                         | `read()` 返回 `encrypted` 布尔，界面必须把它说出来；spec 7.1-05 有专门条目                                     |
| Keychain 里已有的 `v10` 密钥在换机/重装后解不开                              | 解密失败**不静默清空**：报 `SECRET_UNREADABLE` 并保持原文件，让用户重填一次；spec 7.1-06                       |
| 保存 baseUrl/model 触发下游重建，进而关掉已开的浏览器会话视图（§9 实测 2.5） | 界面对此播报一句，且验收顺序固定为"改配置 → 重开会话 → 跑"                                                     |
| 渲染层把明文 key 带回来显示                                                  | `read()` 永不回明文，只回 `present` + 末 4 位指纹；`listSecrets` 同样；spec 7.1-09 用 trace/日志/grep 三面取证 |
| 预设目录让人以为只支持这四家                                                 | 提供商选择必有「自定义」项，且 `baseUrl` 输入框始终可编辑；spec 7.1-13                                         |
