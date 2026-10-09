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

---

## 7. P7 · 7.2 提供商池与模型清单（2026-10-07 立项，用户直接点名）

**用户原话的三件事，按顺序就是界面的三段**：① 先添加模型提供商（可多个）；② 添加成功后**自动获取**该提供商的模型列表，
并把自己需要的**勾进入库**；③ 之后从这份已入库的清单里分别绑定 **chat 模型**与 **embedding 模型**。
7.1 只做到了"两条腿各填一份扁平配置 + 一家一个预设模型名"，做不到 ①② —— 它的数据形状装不下"任意多提供商 × 任意多模型"。

### 7.1 参考实现的一手证据（browser-copilot，本机现读，路径 + 行号）

| 事实                                                                     | 位置                                                  | 移植判定                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| 19 家预设 `{id,label,baseUrl,defaultModel,hint,docsUrl,endpoints?[]}`    | `src/lib/providers.ts:71-271`                         | **照搬数据**（端点变体一并搬：方舟/moonshot/百炼/智谱/MiniMax 各有 2～3 条） |
| 提供商是**实例池** `ProviderProfile[]`，靠 `presetId` 记来源             | `src/lib/providers.ts:23-43`                          | 照搬形状；本项目把 `apiKey` 换成密钥库路径                                   |
| 自动获取模型：`GET {normalizeBaseUrl}/models`，Bearer，解析 `data[].id`  | `src/lib/llm.ts:549-576`                              | 照搬协议；返回解析要比它更容错（见 §7.5）                                    |
| 拉到的清单**只当 datalist 候选、不入库**（注释：便利清单，永不构成约束） | `src/lib/llm.ts:545-547`、`SettingsTab.tsx:1243-1256` | **按裁定④改掉**：勾选入库                                                    |
| 连通测试刻意不打 `/models`：打 1 次 `chat/completions`，`max_tokens:1`   | `src/lib/llm.ts:581-614`                              | 照搬（7.1-10 已经是同一条形状）                                              |
| key **明文**存 chrome.storage（注释自认 unencrypted on disk）            | `src/lib/storage.ts:9`、`fs-store.ts:602-639`         | **否决**：本项目 7.1 已有 safeStorage 密钥库，明文是倒退                     |
| **没有 embedding 通道**，第二角色是 `VisionConfig={providerId,model}`    | `src/lib/vision.ts:23-51`                             | 借它的"池 + 二级引用"模式做 chat/embed 两个角色                              |
| 无 schema 库，手写 `validateProfile` + 逐字段 `typeof` 兜底              | `providers.ts:296-323`、`366-483`                     | 本项目已有 zod，直接用（§2.1 复用）                                          |

许可证：browser-copilot 是用户本人的项目，不存在 §8.7 的非商用来源问题；它的 `hint`/`docsUrl` 文案随预设一起搬，
界面按 `zh-CN`/`en` 各自重写（§5.5）。

### 7.2 四条裁定（用户 2026-10-07 答问，冲突时以本节为准）

| #   | 裁定                                                                      | 后果                                                                                                                           |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ①   | 提供商与模型清单存 **SQLite 新表**，key 仍走 `secrets.bin`                | 新增迁移号段 **31/32**（30 已预留给 3.6 草稿表，29 是当前最高，见 §9）；界面可管任意多实例                                     |
| ②   | **同一个池里选两个角色**，embed 用所选提供商的 `baseUrl` 打 `/embeddings` | `llm.embed` 不再有自己的 baseUrl，改为"引用提供商"；预设不再声明 `legs`（哪家能配 embedding 由用户绑定说了算，见 §7.6 不做项） |
| ③   | `cordis.yml` / 环境变量的 `baseUrl`+`model` **保留为兜底**，池优先        | 解析顺序见 §7.4；老配置、现有 7.1 单测与 spec 7.1-14 那条反向验证都不破                                                        |
| ④   | 拉回的模型清单**勾选入库**                                                | `llm_models` 是"我的模型"这份人的表态，跨重启算数；未勾选的一律不落库                                                          |

### 7.3 数据模型（两张表，一个号段）

```sql
-- 31：用户添加的提供商实例。preset_id 只记来源，不参与解析。
CREATE TABLE llm_providers (
  id          TEXT PRIMARY KEY,          -- 短 id；密钥库路径由它派生：llm.provider:<id>
  preset_id   TEXT NOT NULL,             -- 'deepseek' | 'ark' | ... | 'custom'
  label       TEXT NOT NULL,             -- 界面显示名，用户可改
  base_url    TEXT NOT NULL,             -- 到 /v1 为止的前缀，入库前先 normalizeBaseUrl
  endpoint_id TEXT,                      -- 端点变体（方舟标准/Coding Plan、智谱三条等）；null = 预设首条
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- 32：勾选入库的模型清单。一条模型属于且仅属于一个提供商。
CREATE TABLE llm_models (
  provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,             -- 原样存服务端给的 id，不做任何大小写加工
  origin      TEXT NOT NULL,             -- 'fetched' | 'manual'
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model)
);
```

三条口径：

- **角色绑定不进这两张表**，仍是 `llm` / `llm-embed` 各自配置格里的扁平键（`providerId` 语义从"预设 id"改为"池实例 id"，
  `model` 沿用）。7.1-05 已实测这条链跨重启算数，新开第三张表等于同一件事两个真相（§2.2）。
- **`llm_providers` 里一个字节密钥都没有**，key 只在 `secrets.bin`；删提供商必须连带 `clearKey('llm.provider:<id>')`，
  否则库里没了、密钥库里还留着（孤儿凭证）。
- 主键就是 `(provider_id, model)`：重复入库走 upsert，所以"再拉一遍并全勾上"是幂等的。

### 7.4 服务形状：扩展现有入口，不新开平行模块（§2.3 / §2.5）

硬约束（现读）：`scripts/check-llm-single-entry.ts:25-27` 写明 **`llm.settings` 一个字节都不发，import `http.js` 即红**。
所以"拉模型列表"不许新长第三条 HTTP 腿，只能经 `llm.chat` 那唯一客户端：

- `llm.chat` 内部把请求收成"显式目标"一种形状：现有绑定态（读自己的配置格）与新的探测态
  （`listModels(target)` / `complete(target)`，`target = { baseUrl, secretPath, timeoutMs }`）共用同一个客户端与同一条
  `config` 密钥读取链。`llm.embed` 复用同一个 `listModels`（`/models` 与 embedding 无关，不许为它开第三个 `llm.*` 服务）。
- `llm.settings` 增加的方法（都是"配置面"的动作，不发网络）：`presets()`、`listProviders()`、`listModels(providerId)`、
  `saveProvider(...)`、`deleteProvider(id)`、`addModels(id, names[])`、`removeModel(id, name)`、
  `fetchModels(id)`（→ 转调 `llm.chat.listModels`）、`bindRole({ leg, providerId, model })`、`checkProvider(id)`（→ 转调 `llm.chat.complete`）。
- **旧的 `apply()` 删除**，不是一个新入口 + 一个旧入口并存（§2.5）：界面的保存只剩 `saveProvider` / `addModels` / `bindRole` 三个动作；
  yml/env 那条兜底从此只是配置层本身，不再是 `llm.settings` 的方法。7.1-d 那块面板的"保存这一腿"按钮随之换成角色绑定。
- **解析顺序**（chat 与 embed 各算一遍）：
  `providerId` 有绑定 → 向池问 `{baseUrl}` + 密钥路径 `llm.provider:<id>`；
  否则 → 配置格自己的 `baseUrl` + `keyEnv` 环境变量（7.1-07 那条链原样不动）；
  两边都没有 → `missing` 里照实列出 `baseUrl / model / apiKey`，界面上的"测试连接"给锁定原因码。

### 7.5 界面：一个分区里的三段（仍挂「信任」工作台，不新开视图）

控件一律出自 `src/ui/**` 原件（§5.1/6.2-14 的第 10 节机检已落地，实测 `check-renderer-conventions.ts` 现在报
"src/ui/\*\* 之外裸原生控件 0 只"，7.1-d 那块已被迁进 `DeskField`/`DeskSelect`）：

1. **提供商**：`DeskDisclosure` 每行一个实例（label / baseUrl / 末 4 位掩码 / 已入库模型数 / 删除）；
   「添加提供商」开 `Modal`：预设 `DeskSelect` → 端点变体 `DeskSelect`（预设没有变体时这一格不出现）→ `baseUrl`
   `DeskField` → `apiKey` `DeskField`（password）→ 「测试连通」`DeskButton`（原因码沿用 7.1-13 那套）。
2. **模型清单**：选中一个提供商 → 「获取模型」→ 返回的 id 渲染成 `DeskCheck` 列表，**已入库的预选中** →
   「添加所选」入库。失败态（非 2xx / 空数组 / 超时）只播报一次，**绝不清空已入库清单**。
3. **角色绑定**：两个 `DeskSelect`（chat 模型 / embedding 模型），候选=已入库清单；「保存」走 `bindRole` →
   `kernel.applyConfig` 热改，并沿用 7.1 那句"配置改动会重建下游、浏览器会话需重开"的播报。
   待核（7.2-d 到货时先看原件签名，不要为它新写控件）：`DeskSelect` 能否渲染按提供商分组的候选（`optgroup`），
   不能就用 `<providerLabel> · <model>` 单行标签。

### 7.6 不做项（写明是为了防止被当成缺口）

- **不为预设声明 embedding 能力**（裁定②删掉了 `legs`，也删掉 `siliconflow-embed` 这只同址重复条目）：本项目无法在本机
  无 key 验证"某家到底提不提供 `/embeddings`"，写进目录就是拿文档转述当事实（§6.2）。界面按用户绑定走，
  绑错了就在连通测试里以可读失败回出来——那是**真读数**，不是猜测。
- 不做提供商级自定义请求头（参考实现有 `headers`，OpenRouter 归因头是它那边的用法）、不做模型元数据
  （价格/上下文长度）、不做 vision/接管角色（本项目没有这条腿）。
- 不做多 key 轮询与配额分摊；一个提供商一把 key。

### 7.7 片序（一次一片，每片自带验收）

| 片    | 内容                                                                                                                             | 依赖 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 7.2-a | `llm`：预设目录 19 家（含端点变体）+ `normalizeBaseUrl` + zod 形状 + 单测                                                        | 无   |
| 7.2-b | `llm`：迁移 31/32 与池的 CRUD（`inject=['store']`，`migrations.push` → `upgrade()`，与 resume-kb 同一模式）+ 密钥路径派生 + 单测 | a    |
| 7.2-c | `llm.chat` 收成"显式目标"客户端 + `listModels` 解析（fixture 的 `/v1/models`）+ 解析顺序与兜底链单测                             | b    |
| 7.2-d | IPC 契约（`bridge.llm` 新增动作 + `LlmProviderView`/`LlmModelView`）+ 渲染层三段 + 双语 + **删除旧 `apply()`**（从 c 接手）      | c    |
| 7.2-e | 活体验收：10225 隔离实例跑三段，截图 + DOM 读数；三面 grep 证明新密钥路径也不落明文；`AGENTS.md` §9 更新那条迁移台账读数         | d    |

> **7.2-a 收口补记（2026-10-08，spec 7.2-01 / 7.2-03 已 `[x]`，读数见 `7.2-01-03-catalog-readings.txt`）**：
> 这一行里的"zod 形状"按**边界**而不是按目录落：目录是仓内的静态数据，给它写一份运行时校验就是为不会发生的场景加防线（§2.6），
> 所以入仓的形状是 `LlmProviderView`（`shared`，与其余 bridge 视图同一口径），校验落在**人敲的那一格**——
> `applySettingsSchema` 的 `z.url()` 之后紧跟 `normalizeBaseUrl`，落盘与热改拿到的都是前缀。
> 池实例真正的 zod 入参（`saveProvider` 的 label / baseUrl / endpointId 与 `/models` 回包的逐项 `typeof` 判定）分别随 7.2-b、7.2-c 到货。
>
> 一条随本片撞出来的口径，写给 7.2-b/c/d：`check-compliance-redlines.ts` 规则三的射程含测试文件，**测试面出现真实域名一律 exit 1**。
> 正确处置不是加豁免，而是①与主机无关的判据改用 `*.test.invalid` / `localhost`，②与目录本身有关的判据从 `PROVIDER_PRESETS` 现取地址——
> 在测试里重敲目录字面量既是 §2.5 的第二个真相，也正是机检判出的那个形态。
>
> **7.2-b 收口补记（2026-10-08，spec 7.2-02 / 7.2-08 已 `[x]`，读数见 `7.2-02-08-pool-readings.txt`）**：
> 四条落在本片当场、写给 7.2-c/d 与后来人：
>
> 1. **`ON DELETE CASCADE` 在本项目是装饰性的**——全仓没有一处 `PRAGMA foreign_keys = ON`，删父行必须显式在同一条事务里删子表。
>    这条已从计划升级成环境事实，登记在 `AGENTS.md` §9 的迁移台账那一条里（同处并登记号段 31/32 已被占用）。
> 2. **带 `.default()` 的 zod 入参，服务方法的形参取 `z.input` 而不是 `z.output`**：output 里带缺省的键是必填，
>    于是 `addModels({ providerId, models })` 这种"省略即 `fetched`"的调用点在类型层就写不出来（编译期报缺参）。
>    校验仍然落在边界内（`safeParse` 之后读 `parsed.data`），只是对外形状要允许人少说一句。
>    与 §9 实测 1.3 那条（插件配置构造器取 output）不冲突：那一条判的是"装配递进来的配置已经补过缺省"，这里判的是"界面上的调用方还没有"。
> 3. **判"某个文件里没有明文"要写成扫目录**，不要按固定文件名读：池的 CRUD 不碰持久层，`settings.json` 在这种形态下还没被创建，
>    按名字读会 ENOENT，而 ENOENT 会被当成"测试挂了"而不是"判据写窄了"。
> 4. 行层（`provider-pool.ts`）不抛错，只回 `undefined`；`AppError` 一律由服务层抬起。
>    否则 IPC 网关拿到的是非 `AppError`，界面上就是一条没有码的失败，`deskReason` 无从分派。
>
> 本片动的面：`packages/llm/**`（新文件 `provider-pool.ts` + `settings.ts` 的方法组 + 单测 + 一条 devDependency）、
> `packages/core/src/errors.ts` 的一只新错误码、`cordis.yml` 的 `llm-settings` 一行 `dependsOn: [store]`
> （口径同 `browser-takeover`：`static inject` 必须配清单里这一行，见 §9 实测 5.1-c 的"清单顺序就是挂载顺序"）。
> `shared/src/bridge.ts` 与渲染层三段留给 7.2-d。
>
> **7.2-c 收口补记（2026-10-08，spec 7.2-07 / 12 / 13 已 `[x]`，读数见 `7.2-04-05-07-12-client-readings.txt`）**：
>
> **一条改判**：这一行里的"删除旧 `apply()`"**挪到 7.2-d**（表格下一行已接手）。原因是现读而不是偏好——
> `packages/renderer/src/ModelSettingsPanel.tsx` 的「保存这一腿」走的是 `llm.settings.apply`，而进程契约（`shared/src/bridge.ts`）
> 与界面三段都在 7.2-d 才换；在 7.2-c 删掉它，主干就会留下一段"点了没反应"的界面回归，
> 而那条回归既不属于本片要验的东西，也不会在本片里被活体取到。spec 7.2-15（反向验证"只剩一个入口"）因此仍 `[ ]`。
>
> 五条落在本片当场、写给 7.2-d/e 与后来人：
>
> 1. **测试装配里的环境变量不会在同一条用例的两次装载之间清掉**（`afterEach` 只跑在用例之间）。
>    "两处都没有 key"那类读数必须显式 `delete process.env[...]`，否则 `missing` 少一项，看着像实现缺陷、实际是取证通道脏了。
> 2. **内核换成替身之后，热改不会重建 `llm.chat`**，所以"绑定态"有两条不同的读数通道：
>    `llm.settings.read()` 现问 `kernel.effectiveConfig`（当场就能变），`llm.chat.status()` 读构造期拿到的配置格（只有重装才变）。
>    断言客户端读数要用第二次装载点名实例 id，不要把两者写成同一条期望——真实装配里它们由 `applyConfig` 的重建串成一个瞬间。
> 3. **GET 与 POST 共用骨架时，`body` 只在非 undefined 才挂**：fetch 对 GET 带 body 是直接 `TypeError`，
>    抽错的表现为清单探测全红而不是编译期报错（`requestJson` 里那条展开写的 `...(body === undefined ? {} : {…})`）。
> 4. **给已有配置格的 schema 加一个带 `.default()` 的键，会波及包外的直接调用点**：本片加 `llm.providerId` 之后，
>    `packages/outbound` 两处 `LlmConfig` 字面量当场 typecheck 红（§9 实测 1.3 那条在测试常量上同样成立——
>    output 里带缺省的键是必填）。这类跨包形状改动**先跑 typecheck 再收尾**，别指望四道门禁会替你在写的时候提醒。
> 5. **"回落到未绑定"判的是整个绑定，不是半个**：`deleteProvider` 第一版只撤 `providerId`、留着 `model`，
>    实测读数（spec 7.2-09 那句 `missing` 含 `model`）把它改成了两条键一起撤——留着那个模型名，
>    7.2-d 的候选清单里已经没有它了，界面会拿着一个选不到的值显示"当前用它"。
>    随之记一条配置层语义：持久层写 `null` 会**盖过** `cordis.yml`（`mergeDeep` 后层赢，null 是值不是删除），
>    所以"删掉一家之后 yml 的模型名不会自己回来"是当前行为，不是丢配置（yml 没动，重新绑定或保存一次即覆盖）。
>
> 本片动的面：`packages/llm/**`（新文件 `binding.ts`；`http.ts` 的 GET 半边；`index.ts` 的探测态与 `listModels`；
> `embed.ts` 换用同一条解析；`settings.ts` 的 `fetchModels`/`checkProvider`/`bindRole` 与 `deleteProvider` 的绑定回落；
> 单测 +7 条）、`packages/outbound/src/{greet,script}.test.ts` 的两条配置字面量、
> `scripts/fixture-server.ts` 的 `/v1/models`（三条失败态按 `?fail=` 开关）。
>
> **7.2-d 收口补记（2026-10-09，spec 7.2-04 / 05 / 06 / 11 / 14 / 15 的 **C 半边**已取（V 半边全留 7.2-e），
> 读数见 `7.2-d-ipc-and-ui-readings.txt`）**：
> 这一行的四件事都到货了——`bridge.llm` 的 **13 条** `llm.settings.*`（`apply` 从 `RENDERER_ALLOWLIST` 与
> `BridgeSignatures` 两份名单里同时消失）、渲染层三段、双语（`settings.model.*` 由 54 键扩到 110 键、两份包差集 0）、
> 以及旧 `apply()` 连同它的 schema 与被替换的掩码读法删净（死符号核查在读数文件第三节）。
> 四条落在本片当场、写给 7.2-e 与后来人：
>
> 1. **plan §7.5 那句「添加提供商开 `Modal`」实现成了一张内联表单**。依据是现读的遮罩预算（`ui/overlays.tsx`）：
>    `Modal` 全 app 只留给"不可逆 / 必须读完整风险"（当下只有 `ConsentModal` 与 `PrivacyNotice` 在用），
>    而换一家提供商两头都不占、随时可取消，于是落到 `settings-model-form` 那一格。附带好处：7.2-e 不必先揭遮罩再量几何。
> 2. **`static Config` 删不得**（plan §7 决策③判错了，以现读为准）：内核 `PluginConstructor`
>    （`packages/kernel/src/index.ts:35`）把 `Config` 列为必需成员，`schemaOf()`（同文件 :379）直接取 `impl.Config`，
>    没有缺席回落——删掉之后 `packages/main/src/registry.ts:81` 立刻 `TS2741`。保留的那一格形状取 **`z.object({})`**
>    而不是同类插件的 `z.strictObject({})`：7.1 期间界面**真的**往持久层写过 `providerId` / `embedProviderId` 两格，
>    而持久层是五层合并里"那台机器上已有的事实"，严格形状会让每一台装过 7.1 的机器在挂载期就变 FAILED。
>    随之两条：直接挂载点必须交 `NO_CONFIG`（复用 `@auto-cc/core` 已有的那一只，§2.2），否则 cordis 拿 schema 去解析
>    `undefined`，29 条用例一起报 `invalid config`；`z.object` 是剥离而不是报错，因为那两格已经没有任何读者。
> 3. **候选值写成扁平的 `<实例 id>::<模型名>`**（plan §7.5 那条"待核"的现读结论）：`DeskSelect` 的选项是 children，
>    原件层没有 `optgroup` 先例；而 `llm_models` 的主键是 `(provider_id, model)`，同一条模型名可以在两家各存一份，
>    只报名字挑不出"哪家的这一条"。实例 id 是 UUID、不含这串分隔符，按第一个分隔符切是唯一解，标签写「显示名 · 模型名」。
> 4. **7.1 那句"界面指着的必须是真在用的那一家"续命了，且没有换来一格新的持久化**：绑定态直接读那一行的 `preset_id`，
>    回落态用 `presetIdOfBaseUrl` 按地址反查目录（逐家逐端点变体，认不出与空地址一律回 `custom`）。
>    `LlmLegView.providerId` 的语义因此**收窄成显示用的反查**，判定通道交给新增的 `boundProviderId` 与 `origin`——
>    分两格写是为了让"回落态界面指着一家其实没配的 DeepSeek"这种读数能被 7.2-e 直接取到，而不是往持久层加一格没人读的"真值"（§2.6）。
>
> 本片动的面：`packages/shared/src/bridge.ts`（13 条动作 + 视图与入参类型单一来源）、
> `packages/llm/src/{settings,presets,provider-pool}.ts` + `settings.test.ts`、
> `packages/renderer/src/ModelSettingsPanel.tsx` 与两份语言包、根 `cordis.yml` 的 `llm-settings` 那两行注释。
> **一条都没声称做完 V**：三段的真实几何与文案、四面明文 grep 的活体半边、只用 `cordis.yml`+env 起隔离实例
> （spec 7.2-15 后半句）、以及"残留 7.1 两格 `settings.json` 的 userData 能否正常挂上 `llm-settings`"
> 全部留给 7.2-e，五条清单在 `7.2-d-ipc-and-ui-readings.txt` 末尾。

### 7.8 测试与取证口径（§7.2 / §7.1 的硬边界）

- **`/models` 与连通测试在自动化里只打本地 fixture**：`scripts/fixture-server.ts` 现在只有 `/v1/chat/completions`
  （现读 `:1289`），本片加 `/v1/models`（OpenAI 信封 `{"object":"list","data":[{"id":...}]}`）并留三条失败态：非 2xx、空 `data`、超时。
- 19 家真实端点只在**用户在场**时手动验证；无 key 探测的 401/000 只作为"能否到达鉴权层"的读数留档，
  **不得**据此在目录里写"支持/不支持"（§6.2 已两次因文档转述翻车）。
- 明文永不可见那条（spec 7.1-06）在本片要按新路径重取一遍：`trace()` / `settings.json` / 日志 / 渲染层回包 四面 grep
  `llm.provider:<id>` 对应的探针 key。
- V 类按 §9 的既有口径：先 `privacy-acknowledge`，注入禁动画再量几何，`shot`/`eval`/`click` 全带 `--url 5173`，
  收图前整批 `md5 -q | sort | uniq -c`。

### 7.9 风险与对策

| 风险                                                                                 | 对策                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 各家 `/models` 返回形状不一（`data[]` / `models[]` / 夹带非 OpenAI 字段）            | 解析函数对两种键都试、逐项判 `typeof id === 'string'` 且非空，拉不到就报"这一家没给可解析的清单"，不猜 |
| 拉取失败被误当成"用户没有模型了"                                                     | 清单是**已入库的那份**，fetch 只读远端不写本地；入库只发生在用户点「添加所选」之后                     |
| 换 embedding 模型后旧向量与新查询不同源                                              | 4.3-d 已按 `model` 过滤（`kb_vectors.model`），本片只多一个"角色可以改绑"的入口，不改那条失效判据      |
| 删提供商留下孤儿（密钥、清单、仍在引用它的角色绑定）                                 | 删除是一条事务：`llm_models` 连带清（外键 CASCADE）+ `clearKey` + 角色绑定回落到"未绑定"并播报缺哪一格 |
| `llm` 在 `cordis.yml` 里排 `store` 之后才拿得到连接（§9 实测 5.1-c：顺序即挂载顺序） | 现读 `cordis.yml:21` 的 store 已在 `:35` 的 llm 之前；本片不动顺序，若动则同片补一条顺序机检           |
| 一次绑定改两格 → 下游插件重建两次（§9 实测 2.5）                                     | `bindRole` 一次 `applyConfig` 只写受影响的那条腿，界面把两腿合并成一次保存动作，保存后只播报一句       |
