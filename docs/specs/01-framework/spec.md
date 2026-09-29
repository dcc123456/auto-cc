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
   （**1.4 已完成迁移**，见下面「1.4 遗留」第 1 条。）

## 1.4 IPC 网关

| ID     | 验收标准                                                          | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                                                                                        | 状态 |
| ------ | ----------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.4-01 | 渲染层通过**类型化 client** 调用主进程 service 并拿到返回值       | V    | `1.4-01-typed-client-status.png`：点「读取主进程状态」→ 应用版本 44.4.5 / Electron 44.4.5 / Node 24.21.0 / 平台 win32 / 窗口可见 true / 内核视图 451x737，全部来自 `shell.getStatus` 的一次跨进程调用；CDP 里 `window.autoCC.shell.probeRedact()` 返回 `{ok:true,value:{written:true}}`。界面自检行「渲染层可见方法 8 个 · 白名单 8 个」= preload 生成的代理数与网关允许的能力数同源                            | [x]  |
| 1.4-02 | 只有 `cordis:call` 与 `cordis:event` 两个通道，无插件私自注册 ipc | C    | `grep -rn "ipcMain.handle" packages/` 唯一命中 `packages/ipc/src/index.ts:49`；通道名只在 `packages/shared/src/ipc.ts` 定义一次。启动日志实测 `IPC 网关就绪：cordis:call / cordis:event（能力 8 项，事件 1 项）`（见 `1.4-03-event-push-no-refresh.png` 日志区）                                                                                                                                                | [x]  |
| 1.4-03 | 主进程事件能流到渲染层并驱动界面更新（推，不是轮询）              | V    | `1.4-03-event-push-no-refresh.png`：点「写入一条含敏感字段的日志」后，`log/line` 把 15:44:27 那条推进列表末尾，「本次会话收到事件」从 4 → 5 → 6 自增，期间页面**没有刷新**（同一实例的 `performance.now()` 已走到 774s 仍在继续计数）。事件是订阅来的：面板里没有针对日志的定时器                                                                                                                               | [x]  |
| 1.4-04 | 调用不存在的 service/方法返回结构化错误（含 path 与原因）         | V/C  | `1.4-04-not-in-allowlist-structured-error.png`：界面显示「主进程已拒绝：NOT_IN_ALLOWLIST · shell.readFile · 能力未在白名单中：shell.readFile」，code/path/message 三段齐全。`packages/ipc/src/resolve.test.ts`「服务没挂载与服务在但方法不存在分别报错」断言 `SERVICE_NOT_FOUND` / `METHOD_NOT_FOUND` 两条不同结论；`gateway.test.ts` 断言 Error 的 message 跨进程不丢                                          | [x]  |
| 1.4-05 | 不可序列化的返回值被明确拒绝，而非静默丢字段                      | C    | `packages/ipc/src/gateway.test.ts`「返回值无法序列化时点名 path 与原因」：service 返回含函数的对象 → `NOT_SERIALIZABLE`，错误里带 `path`，界面上能直接指出是哪个能力炸了。网关用 `structuredClone` 探一次而不是等 Electron 自己丢字段                                                                                                                                                                           | [x]  |
| 1.4-06 | 并发调用不错乱（含同一 service 的并发写）                         | C    | `packages/ipc/src/gateway.test.ts`「并发调用结果一一对应」：3 个耗时不同的调用同时在途，各自拿到自己的参数与返回值，`stats.inFlight` 峰值 = 3、结束后归零。实测在同一窗口并发 20 个 `log.tail(1..20)`：20 个全 `ok:true`，串位 0（limit 1/2/3 分别回 1/2/3 条），5ms 内完成                                                                                                                                     | [x]  |
| 1.4-07 | 白名单外 service 无法被渲染层访问（含直接 `ipcRenderer` 尝试）    | V    | `1.4-07-bridge-surface-audit.png` + CDP 注入审计：`Object.keys(window.autoCC)` 只有 `shell/kernel/log/ipc/on`；`log.write`、`ipc.gateway`、`ipc.lookupService`、`shell.dispatch`、`ipc.stats` 在桥接对象上全是 undefined（私有成员不出构造器）；`require`/`module`/`process` 在渲染层均为 undefined，sandbox 下拿不到 `ipcRenderer`，也就绕不过白名单；请主进程代调 `ipc.lookupService` 得到 `NOT_IN_ALLOWLIST` | [x]  |

### 1.4 期间新增固化的环境与设计事实

1. **跨进程只能有一层错误信封**。开发过程中真实踩过：`ipc.probeReject` 原先把 `gateway.invoke()` 的
   `BridgeReply` 当作业务返回值返回，于是渲染层收到 `{ok:true, value:{ok:false, error}}`——界面读的是
   外层，把「网关拒了」显示成「白名单失守」（spec 1.4-04 首次验收就是红的）。现在的写法是探针**抛
   `AppError`**，由外层网关收成唯一一层信封；`BridgeSignatures['ipc.probeReject'].returns` 也从
   `BridgeReply<unknown>` 改成 `unknown`，类型上不再允许套娃。
2. **preload 拆 `service.method` 只能按第一个点**，而网关解析必须按**最长服务名前缀**：两者方向相反。
   服务名本身可带点（`store.db`），网关若按第一个点切就会把「方法找不到」误报成「服务不存在」；
   反过来 preload 若按最后一个点切，`store.db.prepare` 就生成了错误的代理键。`pathCandidates` 单测锁住这一点。
3. **事件白名单是结构性的**：网关只遍历 `RENDERER_EVENTS` 去 `ctx.on`，没登记的名字根本不会被订阅，
   所以「未登记事件不出进程」不依赖运行期过滤；preload 侧再对渲染层传入的字符串做一次真实校验
   （`isAllowedEvent`），因为运行时没有类型可兜底。
4. **通道注册放在构造器、摘除放在 effect disposer**：窗口由后装的 `shell` 创建（`inject:['ipc']`），
   所以渲染层能发起调用时处理器必然已在位；1.5 做启停时也不会撞「重复注册」。
5. **harness 的多 target 陷阱**：Electron 的 CDP 端口同时暴露主窗口和内嵌 `WebContentsView` 两个 page，
   不带 `--url` 时选中哪个不确定，会出现「明明按钮在页面上却 click 不到」。验收命令一律加
   `--url 127.0.0.1:5173`。
6. **左栏是内部滚动容器**（`overflow-y-auto`），`window.scrollY` 恒为 0，`scrollIntoView` 截不到下半屏；
   要给日志区取证得先把那个容器的 `scrollTop` 推下去。

### 1.4 遗留（后续子计划处理）

1. 1.3 遗留第 2 条（`shell.getPluginTree` / `shell.getLogTail` 两个开发态桥接方法）已在本计划清掉：
   插件树走 `kernel.tree`，日志走 `log.tail` + `log.status` + `log/line` 事件，白名单里不再有 shell 的代理项。
2. 1.3 遗留第 1 条仍未处理：开发态 `store.db` 落在 `%APPDATA%\Roaming\Electron\`（本轮实测日志行
   `store 就绪：C:\Users\ragfl\AppData\Roaming\Electron\store.db`），而日志在 `%LOCALAPPDATA%\auto-cc\logs\`。
   与本计划的 IPC 无关，改到 1.5 一并补 `app.setName('auto-cc')` / `setPath('userData', …)`。
3. `ipc.stats`（在途/已完成计数）目前只在主进程可读，没有进白名单；1.5 调试面板要展示网关指标时再登记。

## 1.5 插件运行时管理 + 调试面板

| ID     | 验收标准                                                            | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 状态 |
| ------ | ------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.5-01 | 调试面板显示完整插件树（名称/层级/状态/依赖），与实际 registry 一致 | V    | `1.5-01-tree-vs-registry.png`：面板 6 行（config/logger/store/ipc/plugins/shell）逐行带状态徽章、依赖、配置键、每插件 effect 数；指标行 `registry 7 项 · 挂载序号 30 · effect 合计 15 项 · 活动句柄 0 个 · 卸载闸门 kernel, ipc, plugins`。**7 = 清单 6 个插件 + 内核自己**，与 `kernel.metrics().registrySize` 同源；`packages/plugins/src/plugins.test.ts` 断言面板拿到的 `guarded` 恰为 `kernel/ipc/plugins`                                                                       | [x]  |
| 1.5-02 | 单个插件可从界面 Stop → 变 DISPOSED，其 effect 清理被执行           | V    | `1.5-02-store-disposed.png`：点 store 行「卸载」→ 徽章变「已卸载」、按钮换成「挂载」，主进程日志落下 `插件 store 已卸载：回收 2 项 effect，剩余 0 项`，指标 `registrySize 7→6`、`effectTotal` 同步减。内核侧 `packages/kernel/src/lifecycle.test.ts`「Stop → DISPOSED，effect 回收器被调用且定时器停走」用可观察的 tick 计数证明旧定时器真的停了（卸载后 ticks 不再增长）                                                                                                             | [x]  |
| 1.5-03 | Stop 后可 Start 回来，service 重新可调用（热插拔闭环）              | V    | `1.5-03-store-remounted.png` + `1.5-03-hotplug-calls.txt`：对 logger 做闭环——操作前 `log.status` 返回 ok，卸载后同一调用得到 `SERVICE_NOT_FOUND · 服务未挂载：log`，重新「挂载」后再次 ok，且 `ctx.get('logger')` 拿到的是**新实例**（单测断言 `second !== first`）。面板每轮动作后都会重读快照，界面显示的是主进程的真实状态而不是猜测                                                                                                                                               | [x]  |
| 1.5-04 | 卸载提供方时依赖方自动降级为 PENDING，恢复后自动重建                | V    | `1.5-04-provider-stopped.png`：停掉 config（提供方）→ 树里 `logger:pending`、`store:pending`，而无依赖关系的 ipc/plugins/shell 不受牵连；`1.5-04-provider-restored.png`：重新挂载 config → 两个下级由 cordis 自动回到 active，`registrySize` 回基线。单测「停掉提供方 → 依赖方 PENDING；恢复后自动 ACTIVE」以轮询 `waitFor` 锁定同一条链路                                                                                                                                            | [x]  |
| 1.5-05 | 插件抛错只显示为该插件 FAILED，主进程与其他插件继续工作             | V    | `1.5-05-store-failed-isolated.png`：面板把 store 的 `dir` 改成 `bad:name` 并保存 → store 行红色「失败」+ 行内 `ENOENT: no such file or directory, mkdir '…\bad:name'`，其余 5 行仍「已就绪」，提示行如实写「调用成功，但插件 store 处于失败态：…」；同一时刻 `shell.getStatus().windowVisible === true`、点日志探针按钮仍能推进日志（脱敏照常）。`1.5-05-store-recovered.png`：把 `dir` 改回合法值 → 行回到绿色且**不再挂着上一条红字**，提示回到「保存配置：成功」                   | [x]  |
| 1.5-06 | 面板可查看并保存任一插件配置，新配置即时生效（不重启 app）          | V    | `1.5-06-config-level-applied.png` + `1.5-06-hot-config.txt`：面板「配置」预填当前生效值（`{level:info,buffer:500,file:auto-cc.log,redact:true}`），改成 `level:"error"` 保存后 `log.status().level` 立刻是 `error`，此时 `shell.probeRedact()`（写一条 warn）在 `log.tail(500)` 里**一条都不增加**（0 → 0）；再存 `level:"debug"` 后同一探针立刻产出日志行。全程没有重启进程，也没有改 cordis.yml。非法字段走另一条分支：预校验抛 `CONFIG_INVALID` 并点名是哪个键，坏值不会进运行时层 | [x]  |
| 1.5-07 | 错误计数/最近错误列表在面板可见，可展开栈                           | V    | `1.5-07-error-history-expanded.png`：「插件错误历史（1 条）」展开后是完整 14 行栈（`at mkdirSync (node:fs:1410:26)` → `[cordis.init]` → `Fiber.execute` → `Gateway.invoke`），带时间戳 16:40:05；同一错误在日志区以 ERROR 级别出现但只带 message，栈不污染可读日志（栈走 `plugin/error` 事件单独送达）。历史上限由配置 `history`（默认 20，最大 200）控制，单测断言新记录排在最前且不越界                                                                                             | [x]  |
| 1.5-08 | 反复启停 20 次不泄漏（registry/监听器数量回归基线）                 | C+V  | `1.5-08-cycle-zero-drift.png` + `1.5-08-cycle-report.txt`：面板点 store 行「巡检」（20 轮）两批。第一批 `registry 7→7 · 漂移 尺寸 0 / effect 1 / 句柄 0`，第二批 `漂移 尺寸 0 / effect 0 / 句柄 0`。effect 的 +1 与轮数无关（3/5/20 轮都只 +1）且第二批起一动不动，判定为 cordis 的结构收敛而非泄漏；判据因此写成**两批对照**（`packages/plugins/src/plugins.test.ts`），而不是拿巡检前的基线比                                                                                       | [x]  |

### 1.5 期间新增固化的环境与设计事实

1. **DISPOSED 的 fiber 是永久死的**：在它上面 `restart()` / `update()` 都会在创建 effect 时抛
   `INACTIVE_EFFECT`（读 cordis 源码 + 实测一致）。所以「重新启动」一律是再挂一次 `ctx.plugin`，
   拿到的是**新 fiber**；`kernel.start()` 因此不试图复活旧实例，而是先 dispose 残留再重挂。
2. **`fiber.update(config)` 是唯一会清 `_error` 的重启方式**，并且会把新配置存进 fiber——之后依赖变化
   引发的自动重建用的是新值而不是挂载时的旧值。改配置顺带重试失败插件就靠这一点，所以
   `applyConfig` 走 `update` 而不是 `restart`。
3. **构造失败不是异常，是状态**。`applyConfig` 只在**预校验**失败时抛 `CONFIG_INVALID`；插件构造器
   自己炸了会被 catch 成 `FAILED` 节点 + `plugin/error` 事件，IPC 调用本身仍然 `ok:true`。
   面板因此不能只看信封：`run()` 加了 `describe` 回调，读返回节点的 `state`，否则会出现
   「保存配置：成功」配一行红色 FAILED 的自相矛盾画面（本轮实测就是这么发现的）。
4. **恢复成功后必须清掉快照里的旧 error**：cordis 的状态回调只更新 `state`，`node.error` 会留在原地，
   界面就显示成一个「已就绪但在报错」的插件。现在 `internal/status` 观察到 `active` 时把
   `error`/`stack` 置空，错误只留在历史列表里。
5. **巡检的句柄读数要留 settle 窗口**：`process.getActiveResourcesInfo()` 在最后一轮 dispose/create
   之后会稳定多 1，几百毫秒后自己归零——那是还在事件循环排队的句柄，不是泄漏。`plugins.cycle`
   收尾前加 300 ms（`SETTLE_MS`）。单测对句柄只断言「不许变多」（实测出现过 -3 的负漂移，
   因为它是全进程指标，别的用例的定时器也在进出）。
6. **第一批启停会让兄弟 fiber 补一条内部 effect**（实测 plugins 3→4，之后不再增长）。判泄漏要看
   第二批，不能拿巡检前的基线比——否则每次都会误报 +1。
7. **运行时配置补丁不落盘**：`runtimePatches` 只在主进程内存里，`@auto-cc/plugin-config` 不会写回
   cordis.yml。这既是好事（验收实验随进程消失，不污染仓库与用户配置），也意味着**重启即回滚**——
   真正要持久化的配置得等 1.9 之后的用户配置层。
8. **`dev` 脚本的主进程重启有竞态**：改 `packages/*/src` 会让 esbuild 重打 `main.cjs` 并重启 Electron，
   但旧实例还占着单例锁与 10222 端口，新实例报 `Lock file can not be created` / `bind() … 只允许使用
一次` 后退出，`pnpm dev` 整个结束。本轮验收撞上两次，只能手工重启。归到 1.6 自测通道处理。

### 1.5 遗留（后续子计划处理）

1. 1.4 遗留第 2 条（开发态 `store.db` 落在 `%APPDATA%\Roaming\Electron\`）**已在本计划修掉**：
   主进程装配时把 `app.getPath('userData')` 作为运行时层覆盖写进 `store.dir`
   （`packages/main/src/index.ts`），本轮实测 store 落在 `C:\Users\ragfl\AppData\Roaming\auto-cc\store.db`
   （Electron 的应用名已是 auto-cc，不再是 Electron），与日志目录 `%LOCALAPPDATA%\auto-cc\logs\` 同前缀。
   注意这条覆盖只在主进程装配时发生：直接用 `pnpm vitest` 跑 store 单测时仍是 `config` 插件自己算的路径。
2. 1.4 遗留第 3 条仍未处理：`ipc.stats`（在途/已完成计数）没进白名单，面板看不到网关指标。
   1.6 自测通道要把「调用成功率」当核心读数，届时一并登记。
3. 面板的插件行**没有稳定的测试选择器**，本轮验收靠可见文本（`store` + 按钮「配置/卸载/挂载/巡检」）
   在 DOM 里定位，改文案就会打断脚本。1.6 需要 `data-row-id` 一类机读锚点。
4. 巡检目前只覆盖「启停」这一种反复动作。1.8 内置内核会话上线后要把「反复开/关会话」也纳入同一
   个漂移判据，因为那才是真正会漏句柄的地方。

## 1.6 可视化自测通道（agent 自测能力）

| ID     | 验收标准                                                                     | 方式 | 验证操作                                                                                                                                                                                                                                                                                                      | 状态 |
| ------ | ---------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.6-01 | dev 模式自动开启 CDP 端口，`/json` 能列出 app 的 page target                 | C    | `curl -s 127.0.0.1:10222/json/list` 输出含 `"title": "auto-cc"` 与 `http://127.0.0.1:5173/`；`devtools.status()` 的 `isCdpEnabled` 为 true、`cdpPort` 为 10222                                                                                                                                                | [ ]  |
| 1.6-02 | agent 能通过 harness 打开 app 并**看到页面**（截图回传为图）                 | V    | `pnpm harness shot --out /tmp/…png --url 127.0.0.1:5173` 后用 Read 读图，能描述出左栏/面板/日志区实际内容（不是「期待内容」）                                                                                                                                                                                 | [ ]  |
| 1.6-03 | agent 能读到真实渲染后的 DOM 快照（含 React 挂载后的节点）                   | V    | `pnpm harness dom --selector '[data-row-id]'` 列出全部插件行的 `data-row-id` 值，与主进程 registry 的 id 集合一致                                                                                                                                                                                             | [ ]  |
| 1.6-04 | agent 能真实点击与输入（派发原生事件，非只改 state）                         | V    | `harness click --selector '[data-row-id="store"] [data-action="stop"]'` → 该行状态变「已卸载」；`harness click --selector '[data-row-id="logger"] [data-action="config"]'` 打开编辑器 → `harness type --selector '[data-editor="config"]' --value '{"level":"debug"}'` → 回读为新值；两次操作后各截一张图对比 | [ ]  |
| 1.6-05 | agent 能在页面上下文执行 JS 断言并取回结果                                   | V    | `harness eval --expr "window.autoCC.kernel.tree()"` 取值；`harness assert --expr … --equals …` 命中时 exit 0、不命中时 exit 1（两种都要跑一次）                                                                                                                                                               | [ ]  |
| 1.6-06 | harness 能同时读到主进程侧状态（fiber 树、日志尾部）与界面状态，两者一致     | V    | 同一时刻取 `devtools.status().targets` / `kernel.tree()` / `log.tail` 与 CDP `/json/list`、界面面板文本做三方对照，数量与状态一字不差                                                                                                                                                                         | [ ]  |
| 1.6-07 | 存在稳定入口 `pnpm harness <action>`，agent 无需手搓 CDP                     | C    | 根目录 `pnpm harness shot` 直接出图；`pnpm harness`（无参）打印命令清单并 exit 1；命令集覆盖 §8.1 列的 12 个 action                                                                                                                                                                                           | [ ]  |
| 1.6-08 | 生产模式（打包后）**不**开启 CDP，dev harness 不进入产物                     | C    | 源码审计：`grep -rn "remote-debugging\|10222" packages/` 只允许出现在 `packages/testing/`（harness 客户端）与 devtools 的只读展示里，main/preload/renderer 源码为 0 命中；`resolveCdpPort()` 纯函数单测断言 `packaged → null`；真实安装包上的复验归 1.7-06/1.7-12                                             | [ ]  |
| 1.6-09 | harness 能同时驱动**内嵌内核视图**（它是独立 target）                        | V    | `harness navigate --url data: --to file:///…/fixtures/self-test-lab/index.html`（`--url` 是按 URL 子串选 target，`data:` 只会命中内核视图的占位页）→ 对该 target `shot` + `dom`，读到 fixture 里的动态节点                                                                                                    | [ ]  |
| 1.6-10 | 视觉回归基线：同一场景两张截图可比对，差异可量化报告                         | V    | 先 `shot` 基线，改一处样式（fixture 背景色）再 `shot`，`harness diff --base … --head …` 报告像素差数/占比/包围盒；同一张图自比差为 0                                                                                                                                                                          | [ ]  |
| 1.6-11 | 验收证据可自动归档到 `docs/acceptance/<子计划>/`                             | C    | `harness archive --id 1.6-02 --in /tmp/….png` → 出现在 `docs/acceptance/1.6/1.6-02-*.png`；文件名不合规/目标目录不在白名单时拒绝，且 `/tmp` 过程图不进 git（`git status` 干净）                                                                                                                               | [ ]  |
| 1.6-12 | 网关指标（在途/已完成/拒绝）在面板可见并随调用变化（1.5 遗留第 2 条）        | V    | 面板顶部显示 `ipc.stats` 三项；连续发起 N 次调用 + 1 次白名单外调用后，已完成 +N、拒绝 +1，截图取证                                                                                                                                                                                                           | [ ]  |
| 1.6-13 | 面板行与按钮有机读锚点，脚本不依赖可见文案（1.5 遗留第 3 条）                | C+V  | `data-row-id` / `data-action` 覆盖每一行每个动作；切到英文界面后同一套锚点脚本仍全部命中                                                                                                                                                                                                                      | [ ]  |
| 1.6-14 | 改主进程代码触发 dev 重启，不出现端口占用或会话被带走（1.5 固化事实第 8 条） | V    | 保存一次 `packages/main/src/index.ts` 的无害改动 → 观察 `[dev]` 日志重启成功、`/json/list` 仍是同一个 app，`pnpm dev` 进程存活；重启期间无 `bind … 只允许使用一次`                                                                                                                                            | [ ]  |

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
