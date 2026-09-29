# 计划一 · 搭建主体框架 — 验收 Spec

> 实施计划：`docs/plans/01-framework/plan.md`
> 验收方式：标 **V** = agent 可视化自测（打开 app、看界面、截图取证）；标 **C** = 命令行检查；
> 标 **U** = 单元脚本。**功能项不接受仅 U 通过。**
> 状态图例：`[ ]` 未验收 · `[x]` PASS · `[!]` BLOCKED（须写阻塞原因，不得静默跳过）

**证据归档规则**：每条 PASS 必须在 `docs/acceptance/<ID>/` 留下至少一项证据（V 类必附截图，
C 类附命令输出，U 类附测试报告）。无证据视为未验收。

---

## 1.1 工程基线

| ID     | 验收标准                                                                                      | 方式 | 验证操作                                                                                                                      | 状态 |
| ------ | --------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.1-01 | `pnpm install` 一步成功，无 peer 冲突                                                         | C    | `pnpm install` → `Done in 31.8s`，无 peer 错误                                                                                | [x]  |
| 1.1-02 | Electron 二进制在 install 后自动就位（不需手动补救）                                          | C    | 归属 1.2（1.1 时尚未引入 electron）；实测结论见 1.2-11：Electron 44 无 install 脚本，靠根 `postinstall` 钩子                  | [ ]  |
| 1.1-03 | 全仓统一 ESM，`"type":"module"` 覆盖 root 与所有 `packages/*`                                 | C    | core / shared / root 均为 `"type": "module"`                                                                                  | [x]  |
| 1.1-04 | `typecheck` 零错误且 `strict:true` 生效（故意写错能报错）                                     | C    | 干净树通过；注入 `const bad: number='str'` → 命中 1 条 TS2322                                                                 | [x]  |
| 1.1-05 | ESLint 对跨包 `src/internal/**` import 报错                                                   | C    | probe `import '../core/src/internal/secret.js'` → `no-restricted-imports` error                                               | [x]  |
| 1.1-06 | ESLint 对直接 `from 'cordis'` 报错（core 内豁免）                                             | C    | probe `import { Context } from 'cordis'` → error；core 包内不报                                                               | [x]  |
| 1.1-07 | `pnpm format:check` 全绿                                                                      | C    | `All matched files use Prettier code style!`                                                                                  | [x]  |
| 1.1-08 | 目录结构与 plan §2 一致（缺包须显式记录原因）                                                 | C    | 见下方「结构偏差记录」                                                                                                        | [x]  |
| 1.1-09 | 提交规范可用（conventional commits hook 生效）                                                | C    | `"bad message"` 被拒并打印规范；合规消息提交成功 `0ffe9a8`                                                                    | [x]  |
| 1.1-10 | `@auto-cc/core` 复导出 Context/Service/Plugin/definePlugin/fiberState 且类型可用              | C    | core typecheck 通过（含 cordis 类型消费）；跨包消费待 1.2 复验                                                                | [x]  |
| 1.1-11 | 三端用户数据目录 / 日志目录解析正确（不启动 Electron 即可验证）                               | U    | `packages/core/src/paths.test.ts` 8 例全绿（win APPDATA/USERPROFILE、mac Library、linux XDG、日志目录）                       | [x]  |
| 1.1-12 | 工具链不依赖被拦截的 postinstall（vitest/tsx/eslint 实测可跑）                                | C    | vitest 3.2.7 跑通 8 例；esbuild build script 被跳过但功能正常                                                                 | [x]  |
| 1.1-13 | 提交信息**描述部分必须含中文**（AGENTS.md §1.1），英文描述被拒                                | C    | 实测：`chore: update` 拒 / `docs(core): add path resolver` 拒 / `fix(ipc): 修复崩溃` 过 / `feat(browser)!: 破坏性变更说明` 过 | [x]  |
| 1.1-14 | `pnpm status:check` 能判定「工作区是否已提交、是否已推送」，未提交时 exit 1（AGENTS.md §1.6） | C    | 实测：脏区列出 13 项改动并 exit 1；无远端时输出「未配置 git 远端」警告而不失败                                                | [x]  |

### 结构偏差记录（1.1-08）

plan §2 的 16 个包中，1.1 只创建 `core` 与 `shared`。其余包**由其所属子计划创建**，非遗漏：

| 包                                  | 创建于 |
| ----------------------------------- | ------ |
| `main` `preload` `renderer` `shell` | 1.2    |
| `config` `logger` `store` `kernel`  | 1.3    |
| `ipc`                               | 1.4    |
| `plugin-manager`                    | 1.5    |
| `devtools` `testing`                | 1.6    |
| `sessions`                          | 1.8    |
| `entitlement`                       | 1.9    |

### 1.1 期间固化的两条环境事实

1. `node_modules/cordis` 把 `FiberState` 声明为 **ambient const enum**，在 `verbatimModuleSyntax`
   下无法复导出（TS2748）。已在 `@auto-cc/core` 用 `fiberState(state: number): PluginState` 自行映射；
   插件层禁止直接依赖该枚举。这是「cordis 变动只改 core 一处」设计的第一次兑现。
2. pnpm 在本环境跳过 `esbuild` 的 build script，但 vitest / tsx 实测可用（esbuild 走平台专属可选包，
   不依赖 postinstall），故 `onlyBuiltDependencies` 保留 `esbuild` 与平台包。
   **Electron 那一行是 1.2 期间才发现的空转**：Electron 44 已删除 install 脚本，改为暴露
   `install-electron` bin，构建脚本白名单对它不起作用，二进制改由根 `postinstall` 钩子显式
   调用 `install.js`（详见 `docs/acceptance/1.2/1.2-11-electron-binary.txt`）。

## 1.2 Electron 壳

证据目录：`docs/acceptance/1.2/`（截图由 `pnpm harness` 通过 CDP 自采，命令输出存同名 `.txt`）。

| ID     | 验收标准                                                                                                    | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                           | 状态 |
| ------ | ----------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.2-01 | `pnpm dev` 启动后**窗口真实出现**，显示 React 首屏（非白屏）                                                | V    | `1.2-01-first-screen.png`：标题 + 三张卡片 + 可点按钮                                                                                                                                                                                                                                                                              | [x]  |
| 1.2-02 | React 是真实挂载（非静态 HTML）：state 变化能在界面上看到                                                   | V    | `1.2-02-after-state-and-status.png`：本地状态 0 次 → 1 次，并读到 44.4.5/24.21.0                                                                                                                                                                                                                                                   | [x]  |
| 1.2-03 | HMR 生效：改 renderer 源码后窗口自动更新，无需重启                                                          | V    | 改 `subtitle` → `1.2-03-hmr-updated-copy.png`；`.tsx` 走 `hmr update`，`.json` 走 page reload，Electron 未重启                                                                                                                                                                                                                     | [x]  |
| 1.2-04 | `contextIsolation:true` + `sandbox:true` + `nodeIntegration:false` 实际生效                                 | V/C  | `1.2-04-renderer-isolation.txt`：`require/process/module` 全 undefined，方法数 4 = 白名单 4                                                                                                                                                                                                                                        | [x]  |
| 1.2-05 | 渲染层调用未在白名单中的 service 被拒绝并给出可读错误                                                       | V    | `1.2-05-illegal-call-rejected.png`：「能力未在白名单中：shell.thisCapabilityDoesNotExist」                                                                                                                                                                                                                                         | [x]  |
| 1.2-06 | 主进程抛错不导致窗口静默死掉，有可见错误态                                                                  | V    | `1.2-06-main-error-captured.png`：开发态探针 `shell.probeMainCrash` 抛错 → 界面显示错误、`windowVisible=true`、`lastError` 同步展示                                                                                                                                                                                                | [x]  |
| 1.2-07 | 单实例锁：第二次启动聚焦已有窗口而非开双窗                                                                  | V    | `1.2-07-single-instance.txt`：第二实例 exit 0，page target 仍为 2，第一实例窗口未变多                                                                                                                                                                                                                                              | [x]  |
| 1.2-08 | 关闭主窗口不退出应用（收进托盘），托盘可再唤出                                                              | V    | `1.2-08-tray-notes.txt` + `1.2-08-reopened-after-tray.png`：`WM_CLOSE` → `windowVisible=false` 且进程存活 → 二次启动唤回；`1.2-08b-window-recreated-after-close.png`：`window.close()` 销毁后由 `closed` 分支重建（`windowVisible=true`、内核视图 bounds 正常）。**托盘图标的鼠标点击未自动化**（原生区不在 CDP 范围），需人工补验 | [!]  |
| 1.2-09 | 外链与 `window.open` 被默认拒绝（安全底线）                                                                 | C    | `1.2-09-window-open-deny.txt`：`window.open` 返回 null、target 数不变、主进程留 deny 日志                                                                                                                                                                                                                                          | [x]  |
| 1.2-10 | `pnpm build` 产出可加载的 dist 资源，无 Vite 报错                                                           | C    | `1.2-10-built-dist.txt` + `1.2-10-built-dist-loaded.png`：`file://` 直装 dist 后界面完整                                                                                                                                                                                                                                           | [x]  |
| 1.2-11 | Electron 二进制由 install 自动就位（不需手动 `node install.js`）                                            | C    | `1.2-11-electron-binary.txt`：**Electron 44 已删除 install 脚本**，改为 `install-electron` bin（`onlyBuiltDependencies` 对它空转）；已补根 `postinstall` 钩子显式跑 `install.js` 达成同等自动就位，但本沙箱无法端到端验（SHASUMS 拉取失败），待有网环境复验                                                                        | [!]  |
| 1.2-12 | 内嵌内核视图容器存在且可挂载（P1 用空白/fixture 页占位）                                                    | V    | `1.2-12-kernel-view-notes.txt` + `1.2-12-kernel-view-rendered.png`：bounds `451x737`（=38.0%），占位页文本可读                                                                                                                                                                                                                     | [x]  |
| 1.2-13 | 渲染层样式**只用 Tailwind CSS**：无 `.module.css`、无 CSS-in-JS、布局不靠内联 style（AGENTS.md §5.1）       | C    | `1.2-13-14-15-16-lint-gates.txt`：探针文件触发「不允许内联 style」+「样式文件只允许 globals.css」                                                                                                                                                                                                                                  | [x]  |
| 1.2-14 | 图标**只用 lucide-react 现有图标**，无自绘 SVG、无 emoji 当图标（AGENTS.md §5.3）                           | C    | 同上：探针 `<svg />` 被拦；首屏截图复核图标均来自 lucide                                                                                                                                                                                                                                                                           | [x]  |
| 1.2-15 | 页面**全部文案走 i18n**（至少 `zh-CN` + `en`，本地 JSON，不依赖网络）；JSX 无裸中文字符串（AGENTS.md §5.5） | C/V  | 同上：探针裸中文被拦；`1.2-15-english-locale.png` 整站切到英文                                                                                                                                                                                                                                                                     | [x]  |
| 1.2-16 | 缺失翻译即构建失败：新增 key 未补齐所有 locale 时 `pnpm lint` 报错（AGENTS.md §5.6）                        | C    | 同上：删 `en.shell.status.none` → `pnpm lint` exit 1「en.json 缺少 key」，恢复后通过                                                                                                                                                                                                                                               | [x]  |

### 1.2 期间固化的环境与设计事实

1. ~~**cordis 服务类的构造签名必须是 `(ctx: Context, name = 'x')`**~~ —— **1.2 时的这条结论已被
   1.3 推翻**：真正的原因是第一个参数不能收窄成 `Context & AppServices`（会让条件类型推不出重载），
   而配置**必须**作为第二个参数声明；只写 `(ctx, name?)` 会让 `ctx.plugin(X, {…})` 报 TS2345。
   正确签名见 §1.3 固化事实第 1 条。类型仍由 `declare module '@auto-cc/core'` 的 `AppServices`
   增补提供，不靠构造参数收窄。
2. **`Context` 没有 `start()` / `stop()`**；对象式插件写 `provide:'x'` 后直接赋值会抛
   `cannot set property "x" without provide`，要用 `ctx.provide(name, value)`。
3. **新建的 `WebContentsView` bounds 默认 `0x0`**，不显式 `setBounds` 就永远看不见——只在 `resize`
   里摆位的写法会让内核视图在启动后静默消失（实测 `getStatus` 报 `0x0`）。
4. **渲染层 `window.close()` 不受 `close` 事件 `preventDefault()` 约束**，窗口会被真销毁；
   「关窗收进托盘」必须再加 `closed` 重建分支，否则 X 按钮路径与页面自关闭路径行为不一致。
5. CSP 有意推迟到 1.7：开发态 `@vitejs/plugin-react` 注入内联 preamble，先加 CSP 会逼出一份只服务
   开发态的放宽策略，等打包态（`loadFile` + 无 dev server）一次配到位。

## 1.3 L0 内核插件（config / logger / store / kernel）

| ID     | 验收标准                                                                                  | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                    | 状态 |
| ------ | ----------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.3-01 | `cordis.yml` 是插件装配的唯一入口，改它即改启用的插件集                                   | V    | `1.3-01-plugin-tree-baseline.png`：清单四行 → 界面插件树 config/logger/store/shell 全已就绪；`1.3-01-store-commented-out.png`：注掉 `store` 一行 → 重启 → 树里只剩 3 个。**未从其它位置硬编码插件**（装配只读清单，见 `packages/main/src/registry.ts` 提供 id→实现）                                                                        | [x]  |
| 1.3-02 | `config` 提供分层合并（默认 < 文件 < 环境变量 < 运行时覆盖）                              | U+C  | `packages/config/src/config.test.ts`「按 default < file < env < runtime 的顺序记录来源」「白名单外的环境变量一律忽略」「运行时覆盖是补丁而不是整层替换」；`packages/kernel/src/kernel.test.ts`「运行时层覆盖文件层」                                                                                                                        | [x]  |
| 1.3-03 | 非法配置在**挂载期**失败并指出具体字段，而非运行时空指针                                  | V    | `1.3-03-config-field-error.png`：清单里 `level: verbose`（枚举外值）→ 界面插件树 logger 显示「失败 / 配置校验失败 [logger] level: Invalid option: expected one of "error"│"warn"│"info"│"debug"」，含字段路径；config/kernel 两侧单测各断言一次点名字段                                                                                     | [x]  |
| 1.3-04 | `logger` 提供结构化日志、级别过滤、环形缓冲（内存内可取最近 N 条）                        | C    | `packages/logger/src/logger.test.ts`「级别过滤生效：info 以下不进缓冲」「内存缓冲只保留最近 N 条（`buffer: 3` 写 5 条只剩后 3 条）」                                                                                                                                                                                                        | [x]  |
| 1.3-05 | 日志同时落盘到平台规范目录（由 1.1-11 的解析函数决定）                                    | V    | `1.3-05-log-tail-and-file.png` + `1.3-05-log-scroll-live.png`：界面日志区实时滚动，磁盘 `%LOCALAPPDATA%\auto-cc\logs\auto-cc.log` 存在且行内容与界面一致；单测断言缺省目录走 config 的平台规范目录                                                                                                                                          | [x]  |
| 1.3-06 | `store.db` 用 **`node:sqlite`（Electron 内）**打开数据库，无原生编译、无 electron-rebuild | C    | `1.3-06-node-sqlite-in-electron.txt`：Electron 44.4.5 内 `require('node:sqlite')` 直用，sqlite 3.53.4、WAL 生效、`user_version` 可读写；store 单测「驱动与版本如实上报」；`pnpm install` 无 rebuild 步骤                                                                                                                                    | [x]  |
| 1.3-07 | migration 机制：新增一条 migration 后旧库自动升级，版本号可查                             | C    | `packages/store/src/store.test.ts`「迁移把 user_version 推上去，重复 upgrade 不再执行」「关库重开：schema 版本与数据都在」「迁移失败时版本不动、半成品表不存在（回滚）」；WAL 侧车文件实测出现                                                                                                                                              | [x]  |
| 1.3-08 | 重复启动不开第二个 DB 连接；退出时连接被 effect 回收                                      | C    | `packages/store/src/store.test.ts`「卸载后连接句柄被 effect 释放，WAL 侧文件收回主库」（dispose 后 `-wal`/`-shm` 消失 = 句柄真的还掉了）+「关库重开：schema 版本与数据都在，迁移不会重复跑」；连接只在 `[Service.init]` 里 `new DatabaseSync` 一次                                                                                          | [x]  |
| 1.3-09 | 任一 L0 service 未挂载时，依赖它的插件进入 PENDING 而非崩溃                               | V    | `1.3-09-dependency-pending.png`：界面显示 logger/store「等待依赖」、shell 仍「已就绪」、进程存活。**说明**：1.3 阶段还没有插件 `inject` store，故这里禁用的是 `config`（logger/store 同时依赖它）而非 spec 原写的 `store`；单测「依赖缺席时是 PENDING 而不是装配失败」直接断言 store 缺席场景。待 1.9 出现注入 store 的插件后按真实依赖复验 | [x]  |
| 1.3-10 | 插件挂载失败不阻塞其他插件启动（错误隔离）                                                | V    | `1.3-10-plugin-fail-isolation.png`：清单里把 store 的库路径指向不存在的目录（`file: missing/dir/store.db`）→ 该插件「失败 / unable to open database file」，config/logger/shell 仍全部已就绪；kernel 单测「单个插件抛错只让它自己 FAILED」                                                                                                  | [x]  |
| 1.3-11 | 日志与诊断输出对 token/cookie/密码字段**脱敏**                                            | U+C  | `1.3-11-redact-at-sink.png`：写入含 `token=…`/手机号/邮箱的日志后，界面与落盘内容均为 `token=*** / 138****1111 / z***@qq.com`；logger 单测「free text 与结构化字段一起脱敏」「Error 堆栈同样脱敏」「关闭脱敏时原样写出」                                                                                                                    | [x]  |

### 1.3 期间新增固化的环境与设计事实

1. **cordis 插件的配置来自构造器第二个参数，调用点类型也从它推导**（`registry.d.ts` 的
   `GetPluginConfig` 取 `ctx` 之后的实参）。因此单参构造器会让 `ctx.plugin(X, {…})` 直接 TS2345，
   而两参构造器必须传**校验后的输出类型**（`.default()` 已生效的形状），直连调用点要把带默认值的
   键写全。内核注册表把实现擦成 `new (ctx, config: any)`——写成具体类型会因参数逆变让整个
   `Registry` 不再兼容。各包统一导出 `XxxConfig = z.infer<typeof xxxSchema>` 供调用点与测试引用。
2. **配置校验发生在挂载期、且失败可恢复**：`index.js` 在 fiber 的 effect 内跑
   `resolveConfig`，抛错只把该 fiber 置为 FAILED；`fiber.update(config)` 会重跑校验并**清掉
   `_error`** 再重启，所以「修好配置后点重试」必须走 update，不能重新 `ctx.plugin`。
   `update()` 返回 `Awaitable<void>`，不 `Promise.resolve(...).catch(...)` 就是未处理的拒绝。
3. **`Fiber.uid` 是 `number | null`**（只有根 fiber 为 null），用 uid 建索引要先判空。
4. **`await fiber` 在 FAILED 时拒绝，但 `fiber.error` 仍是 undefined**——快照要读 `fiber.state`，
   不要靠 catch 到的错误对象判断插件状态。

### 1.3 遗留（后续子计划处理）

1. 开发态 `store.db` 落在 `%APPDATA%\Electron\`（Electron 未设产品名时的默认 `userData`），而日志
   已正确落在 `%LOCALAPPDATA%\auto-cc\logs\`。打包态由 electron-builder 写产品名后自然收敛；开发态
   需在 1.4 前补 `app.setName('auto-cc')` / `setPath('userData', …)`，否则两目录长期不一致。
2. 插件树与日志尾当前通过 `shell.getPluginTree` / `shell.getLogTail` 两个开发态桥接方法暴露，只为
   验收可见性存在；1.4 IPC 网关落地后必须迁到 `kernel.*` / `log.*` 并从白名单里删掉 shell 的这两项。

## 1.4 IPC 网关

| ID     | 验收标准                                                          | 方式 | 验证操作                                                  | 状态 |
| ------ | ----------------------------------------------------------------- | ---- | --------------------------------------------------------- | ---- |
| 1.4-01 | 渲染层通过**类型化 client** 调用主进程 service 并拿到返回值       | V    | 点按钮 → 显示 `system.status()` 的平台/Electron/Node 版本 | [ ]  |
| 1.4-02 | 只有 `cordis:call` 与 `cordis:event` 两个通道，无插件私自注册 ipc | C    | `grep -rn "ipcMain.handle" packages/` 仅出现在 plugin-ipc | [ ]  |
| 1.4-03 | 主进程事件能流到渲染层并驱动界面更新（推，不是轮询）              | V    | 触发一次日志写入 → 界面日志条数**无刷新**自增             | [ ]  |
| 1.4-04 | 调用不存在的 service/方法返回结构化错误（含 path 与原因）         | V/C  | 断言错误对象 shape，界面显示可读文案                      | [ ]  |
| 1.4-05 | 不可序列化的返回值被明确拒绝，而非静默丢字段                      | C    | 返回含函数值的 service，得到可诊断错误                    | [ ]  |
| 1.4-06 | 并发调用不错乱（含同一 service 的并发写）                         | C    | 20 个并发 call，结果一一对应                              | [ ]  |
| 1.4-07 | 白名单外 service 无法被渲染层访问（含直接 `ipcRenderer` 尝试）    | V    | CDP 注入尝试访问 `logger` 私有方法被拒                    | [ ]  |

## 1.5 插件运行时管理 + 调试面板

| ID     | 验收标准                                                            | 方式 | 验证操作                                             | 状态 |
| ------ | ------------------------------------------------------------------- | ---- | ---------------------------------------------------- | ---- |
| 1.5-01 | 调试面板显示完整插件树（名称/层级/状态/依赖），与实际 registry 一致 | V    | 截图对比 `ctx.registry.size`                         | [ ]  |
| 1.5-02 | 单个插件可从界面 Stop → 变 DISPOSED，其 effect 清理被执行           | V    | 停掉带定时器的插件，日志确认 dispose 且定时器停止    | [ ]  |
| 1.5-03 | Stop 后可 Start 回来，service 重新可调用（热插拔闭环）              | V    | 操作前后各调一次同一方法，均成功                     | [ ]  |
| 1.5-04 | 卸载提供方时依赖方自动降级为 PENDING，恢复后自动重建                | V    | 停 store → 上层状态随之变化 → 恢复 → 上层自动 ACTIVE | [ ]  |
| 1.5-05 | 插件抛错只显示为该插件 FAILED，主进程与其他插件继续工作             | V    | 触发错误插件 → 面板红色态 + app 仍可点               | [ ]  |
| 1.5-06 | 面板可查看并保存任一插件配置，新配置即时生效（不重启 app）          | V    | 改日志级别 → 立刻反映到日志输出                      | [ ]  |
| 1.5-07 | 错误计数/最近错误列表在面板可见，可展开栈                           | V    | 截图错误详情展开                                     | [ ]  |
| 1.5-08 | 反复启停 20 次不泄漏（registry/监听器数量回归基线）                 | C+V  | 循环启停后断言 `registry.size` 与 listener 数回原值  | [ ]  |

## 1.6 可视化自测通道（agent 自测能力）

| ID     | 验收标准                                                                 | 方式 | 验证操作                                          | 状态 |
| ------ | ------------------------------------------------------------------------ | ---- | ------------------------------------------------- | ---- |
| 1.6-01 | dev 模式自动开启 CDP 端口，`/json` 能列出 app 的 page target             | C    | `curl 127.0.0.1:10222/json` 含本项目 title        | [ ]  |
| 1.6-02 | agent 能通过 harness 打开 app 并**看到页面**（截图回传为图）             | V    | harness 截图 → agent 读图并描述界面内容           | [ ]  |
| 1.6-03 | agent 能读到真实渲染后的 DOM 快照（含 React 挂载后的节点）               | V    | 断言存在某动态 id 文本                            | [ ]  |
| 1.6-04 | agent 能真实点击与输入（派发原生事件，非只改 state）                     | V    | 点击后界面变化被再次截图确认                      | [ ]  |
| 1.6-05 | agent 能在页面上下文执行 JS 断言并取回结果                               | V    | 求值 `document.title` / store 状态                | [ ]  |
| 1.6-06 | harness 能同时读到主进程侧状态（fiber 树、日志尾部）与界面状态，两者一致 | V    | 同一时刻对照 registry 与面板显示                  | [ ]  |
| 1.6-07 | 存在稳定入口 `pnpm harness <action>`，agent 无需手搓 CDP                 | C    | `pnpm harness shot` 出图                          | [ ]  |
| 1.6-08 | 生产模式（打包后）**不**开启 CDP，dev harness 不进入产物                 | C    | builder files 排除 devtools；产物内 grep 无 10222 | [ ]  |
| 1.6-09 | harness 能同时驱动**内嵌内核视图**（它是独立 target）                    | V    | 对 fixture 站点 target 截图 + 读 DOM              | [ ]  |
| 1.6-10 | 视觉回归基线：同一场景两张截图可比对，差异可量化报告                     | V    | 故意改样式 → diff 报告标记差异区域                | [ ]  |
| 1.6-11 | 验收证据可自动归档到 `docs/acceptance/<spec-id>/`                        | C    | 跑归档命令，目录内出现截图+日志                   | [ ]  |

## 1.7 零依赖三端打包与安装

| ID     | 验收标准                                                                     | 方式 | 验证操作                                                          | 状态 |
| ------ | ---------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------- | ---- |
| 1.7-01 | `electron-builder` 配置声明 win / mac / linux 三端目标，无占位 TODO          | C    | 审阅配置；`--publish never` 干跑不报 schema 错                    | [ ]  |
| 1.7-02 | Windows 产物真实产出（nsis `.exe`）                                          | C    | `dist/*.exe` 存在                                                 | [ ]  |
| 1.7-03 | Windows 安装包**静默安装成功并启动出界面**                                   | V    | 安装后启动 → harness 截图确认界面                                 | [ ]  |
| 1.7-04 | 安装后的 app 不依赖 dev server（资源来自包内）                               | V    | 关闭 vite 后仍能看到界面                                          | [ ]  |
| 1.7-05 | **零前置依赖**：在未安装 Node、未安装系统 Chrome 的干净环境下装 app 即可运行 | V    | 干净机器（或隔离用户环境）安装启动截图；`which node` 不存在仍可用 | [ ]  |
| 1.7-06 | **零首启动下载**：从安装到跑通骨架，网络请求日志中无任何依赖/内核/模型下载   | C    | 抓包或代理日志断言目标域名集合为空                                | [ ]  |
| 1.7-07 | 打包版 IPC/service 调用可用（不只是空壳）                                    | V    | 点按钮拿到 `system.status`，显示版本号非 dev 值                   | [ ]  |
| 1.7-08 | 打包版插件挂载与 dev 一致（同一 `cordis.yml` 生效）                          | V    | 打包版打开调试面板，插件树与 dev 相同                             | [ ]  |
| 1.7-09 | macOS `dmg`（arm64+x64）可构建                                               | C    | `pnpm dist:mac` 结果；本机为 Windows 时标 BLOCKED 并写清缺什么    | [ ]  |
| 1.7-10 | Linux `AppImage` + `deb` 可构建                                              | C    | `pnpm dist:linux` 结果；受 fpm/GitHub 限制时标 BLOCKED            | [ ]  |
| 1.7-11 | 版本号 / 产物命名 / 三端图标齐备，无默认 Electron 图标                       | V    | 截图安装包属性与标题栏图标                                        | [ ]  |
| 1.7-12 | 产物内**不含**第二套浏览器内核（体积与内容审计）                             | C    | 审计 `dist` 内容，无 chromium/playwright 下载物                   | [ ]  |

## 1.8 内置内核会话与登录态持久化

| ID     | 验收标准                                                                   | 方式 | 验证操作                                              | 状态 |
| ------ | -------------------------------------------------------------------------- | ---- | ----------------------------------------------------- | ---- |
| 1.8-01 | 每个平台一个独立 `persist:<platform>` partition，互不共享 cookie           | U+C  | 在 A partition 写 cookie，B partition 读不到          | [ ]  |
| 1.8-02 | 自动化会话与主 app UI 会话隔离（app 界面访问不到站点 cookie）              | V    | 渲染层 `document.cookie` 为空，fixture 站点视图有值   | [ ]  |
| 1.8-03 | **登录态跨重启保持**：在 fixture 站点登录后完全退出 app 再启动，仍是登录态 | V    | 登录 → 退出 → 重启 → 截图显示已登录（不需重登）       | [ ]  |
| 1.8-04 | 登录态持久化位置确认在 userData 下且随「退出登录」可清除                   | C+V  | 检查 partition 目录存在；点退出后 cookie 消失         | [ ]  |
| 1.8-05 | 会话数据不进入日志与诊断包（脱敏）                                         | U    | 断言日志中无 cookie/token 值                          | [ ]  |
| 1.8-06 | 登录失效能被探测并发出 `session.auth.expired` 事件                         | V    | 手工清 cookie 后运行探测 → 界面出现「需重新登录」提示 | [ ]  |
| 1.8-07 | 失效时工作流**不静默失败**，而是停在可恢复点并明确提示                     | V    | 触发失效 → 界面显示停在哪个步骤与原因                 | [ ]  |
| 1.8-08 | 视图容器对用户可见（可亲眼看到自动化在做什么），并可键盘鼠标接管           | V    | 截图内嵌视图；在其中真实输入一个搜索词                | [ ]  |
| 1.8-09 | 无网络/站点不可达时有明确错误态，不表现为卡死                              | V    | 停掉 fixture 服务 → 界面显示可诊断错误                | [ ]  |

## 1.9 外发额度闸门（未来付费的接线面）

| ID     | 验收标准                                                                             | 方式 | 验证操作                                                         | 状态 |
| ------ | ------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------- | ---- |
| 1.9-01 | `entitlement.gate.check(action, ctx)` 存在，返回 `{allowed, remaining, reason}`      | U    | 契约与返回 shape 断言                                            | [ ]  |
| 1.9-02 | 默认本地实现返回无限（当前产品阶段不花钱、不登录）                                   | U+C  | 断言 `allowed=true`、`remaining=null`                            | [ ]  |
| 1.9-03 | gate 可被配置切成「每动作每天 N 次」，超限后 `allowed=false` 且 reason 可读          | V    | 界面设 N=1，第二次外发被拒并显示原因                             | [ ]  |
| 1.9-04 | 每次通过 gate 的外发在 `usage.ledger` 落一行 `(action, targetId, workflowRunId, ts)` | C+U  | 断言行数与字段完整                                               | [ ]  |
| 1.9-05 | **绕过 gate 的外发在骨架测试里失败**（gate 缺席即报错，不允许静默放行）              | U    | 移除 entitlement 插件后跑外发样例 → 报错而非成功                 | [ ]  |
| 1.9-06 | 上层业务代码不含「是否付费」的分支，只看 gate 结果                                   | C    | `grep -rn "quota\|entitlement\|paid" packages/` 无业务层分支判断 | [ ]  |
| 1.9-07 | 账本可在界面回看（次数、按天分组、按动作分组）                                       | V    | 触发若干次后截图用量页                                           | [ ]  |
| 1.9-08 | 未来接 SaaS 不需要改表：数据模型含可空 `source` / `remoteRef` 字段                   | U    | schema 断言字段存在且可空                                        | [ ]  |
| 1.9-09 | 断网时 gate 走本地实现且**不阻塞**已有能力（联网校验可选、失败可降级）               | V    | 断网运行外发 → 成功                                              | [ ]  |

## 1.10 工作流面板（第二视图）

| ID      | 验收标准                                                                             | 方式 | 验证操作                               | 状态 |
| ------- | ------------------------------------------------------------------------------------ | ---- | -------------------------------------- | ---- |
| 1.10-01 | 工作流面板作为**第二视图**存在，从对话主界面一次点击即可切换到达，且保留上次滚动位置 | V    | chat → 面板 → chat 往返截图            | [ ]  |
| 1.10-02 | 面板呈现六个主线步骤槽位（搜索/建档/话术/打招呼/定制简历/投递）                      | V    | 截图并逐个读出步骤名                   | [ ]  |
| 1.10-03 | 存在 `workflow.runner` 挂载点与状态机骨架（idle/running/paused/failed/done 可迁移）  | U+C  | 空 runner 走完一轮状态迁移             | [ ]  |
| 1.10-04 | 「运行」在 P1 可跑一个占位工作流（无业务），但界面进度是真实的流式更新               | V    | 点运行 → 连续截图看到进度推进          | [ ]  |
| 1.10-05 | 可中断、可从当前步续跑（不从头再来）                                                 | V    | 运行中暂停 → 恢复 → 截图确认步骤号继续 | [ ]  |
| 1.10-06 | 每个步骤槽位能显示状态与耗时；失败步可单独重试                                       | V    | 注入失败步 → 截图 → 点重试 → 成功      | [ ]  |
| 1.10-07 | 调试面板与插件树是**次级入口**，层级低于对话与工作流                                 | V    | 截图导航层级                           | [ ]  |
| 1.10-08 | 面板与 1.11 的对话界面驱动**同一个** `workflow.runner` 实例，不各自持有运行状态      | C+U  | 静态查引用 + 断言两侧状态镜像一致      | [ ]  |

## 1.11 对话式主界面骨架（首页第一入口）

| ID      | 验收标准                                                                                      | 方式 | 验证操作                                                  | 状态 |
| ------- | --------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------- | ---- |
| 1.11-01 | app 冷启动**首屏即聊天窗口**，不是设置页、功能目录页或工作流面板                              | V    | 冷启动截图                                                | [ ]  |
| 1.11-02 | 聊天界面具备三块最小结构：消息流、输入区（可回车发送/Shift+Enter 换行）、运行中指示           | V    | 发一条消息 → 截图三块区域                                 | [ ]  |
| 1.11-03 | 消息流区分用户/助手两类气泡，助手回复**流式增量**渲染而非整块跳出                             | V    | 长回复过程中连续截图，可见字数递增                        | [ ]  |
| 1.11-04 | 存在 `agent.tools` 注册表且 P1 为**空表**；注册表是 service 白名单，不含任何业务实现          | C+U  | 单测：注册空工具 → 列举 → 调用不存在工具被拒              | [ ]  |
| 1.11-05 | 工具调用协议定型（`toolId` + zod 入参 schema + 结果/错误联合类型），P5 只注册工具不改协议     | C    | 读 `agent.tools` 类型定义并断言 schema 校验生效           | [ ]  |
| 1.11-06 | 工具卡片以**占位组件**形式渲染（标题/参数摘要/状态），图标取自 lucide-react                   | V    | 触发占位调用 → 截图卡片                                   | [ ]  |
| 1.11-07 | 自治档位（建议/半自动/全自动）在界面上可见可切换，P1 仅存档位、不产生行为差异                 | V    | 切换三档 → 三张截图显示当前档位文案                       | [ ]  |
| 1.11-08 | 会话持久化：重启 app 后历史消息与档位保留；新建会话不影响旧会话                               | V    | 发消息 → 重启 → 截图仍在 → 新建会话 → 截图为空            | [ ]  |
| 1.11-09 | P1 的对话链路**不得**触达任何外发能力（打招呼/投递/发送简历），调不到的工具即报错             | U    | 断言在 P1 调用外发类工具返回「未注册」                    | [ ]  |
| 1.11-10 | 聊天界面全部文案走 i18n（`chat.*` / `agent.*`），`zh-CN` 与 `en` 同时齐全，切换后无缺 key     | C+V  | 切到 en → 截图；缺翻译校验脚本通过                        | [ ]  |
| 1.11-11 | 样式仅 Tailwind、图标仅 lucide-react，无裸 JSX 中文文案，通过 eslint 机检                     | C    | `pnpm lint` 在 renderer 包零告警                          | [ ]  |
| 1.11-12 | 渲染层经 `window.autoCC` 白名单访问主进程，未开 `nodeIntegration`，`contextIsolation` 为 true | C+U  | 复用 1.2-04 类断言                                        | [ ]  |
| 1.11-13 | 输入区在 agent 运行中仍可用（可输入"停一下"），不因执行阻塞而冻结界面                         | V    | 运行占位任务时输入并截图显示已接受                        | [ ]  |
| 1.11-14 | 骨架不含任何抓取/发送/简历业务逻辑，P2~P4 能力只能作为工具注册进来                            | C    | 静态检查：`agent.*` 模块无 import `platform.*`/`resume.*` | [ ]  |

## 1.X 里程碑门禁（P1 收口）

| ID     | 验收标准                                                                                      | 状态 |
| ------ | --------------------------------------------------------------------------------------------- | ---- |
| M1-01  | 三端安装包可安装可启动，空 React 界面可见（本机受限时明确 BLOCKED 范围）                      | [ ]  |
| M2-01  | agent 能自主完成「打开 app → 截图 → 点击 → 断言 → 复述结果」闭环，过程不需人工代跑            | [ ]  |
| M2b-01 | 全新机器只装 app（无 Node / 无系统 Chrome）即可运行，重启后 fixture 站点登录态仍在            | [ ]  |
| P1-01  | 上述所有条目为 PASS 或有记录在案的 BLOCKED                                                    | [ ]  |
| P1-02  | `docs/research/source-repos-analysis.md` 完成（P2/P3/P4 抽取决策依据到位）                    | [ ]  |
| P1-03  | 无任何 P2/P3/P4 业务代码泄漏进骨架                                                            | [ ]  |
| P1-04  | 计划文档中每条被否决的技术路线（Playwright/better-sqlite3/husky）都在 spec 有对应反向验证条目 | [ ]  |
