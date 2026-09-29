# 计划一 · 搭建主体框架 — 验收 Spec

> 实施计划：`docs/plans/01-framework/plan.md`
> 验收方式：标 **V** = agent 可视化自测（打开 app、看界面、截图取证）；标 **C** = 命令行检查；
> 标 **U** = 单元脚本。**功能项不接受仅 U 通过。**
> 状态图例：`[ ]` 未验收 · `[x]` PASS · `[!]` BLOCKED（须写阻塞原因，不得静默跳过）

**证据归档规则**：每条 PASS 必须在 `docs/acceptance/<ID>/` 留下至少一项证据（V 类必附截图，
C 类附命令输出，U 类附测试报告）。无证据视为未验收。

---

## 1.1 工程基线

| ID     | 验收标准                                                                                                                                                                                                                                     | 方式 | 验证操作                                                                                                                                                                                                                                    | 状态 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.1-01 | `pnpm install` 一步成功，无 peer 冲突                                                                                                                                                                                                        | C    | `pnpm install` → `Done in 31.8s`，无 peer 错误                                                                                                                                                                                              | [x]  |
| 1.1-02 | Electron 二进制在 install 后自动就位（不需手动补救）                                                                                                                                                                                         | C    | 归属 1.2（1.1 时尚未引入 electron）；实测结论见 1.2-11：Electron 44 无 install 脚本，靠根 `postinstall` 钩子 —— 1.2-11 因沙箱无法端到端验而 BLOCKED，本条随其一同 BLOCKED，不重复计分                                                       | [!]  |
| 1.1-03 | 全仓统一 ESM，`"type":"module"` 覆盖 root 与所有 `packages/*`                                                                                                                                                                                | C    | core / shared / root 均为 `"type": "module"`                                                                                                                                                                                                | [x]  |
| 1.1-04 | `typecheck` 零错误且 `strict:true` 生效（故意写错能报错）                                                                                                                                                                                    | C    | 干净树通过；注入 `const bad: number='str'` → 命中 1 条 TS2322                                                                                                                                                                               | [x]  |
| 1.1-05 | ESLint 对跨包 `src/internal/**` import 报错                                                                                                                                                                                                  | C    | probe `import '../core/src/internal/secret.js'` → `no-restricted-imports` error                                                                                                                                                             | [x]  |
| 1.1-06 | ESLint 对直接 `from 'cordis'` 报错（core 内豁免）                                                                                                                                                                                            | C    | probe `import { Context } from 'cordis'` → error；core 包内不报                                                                                                                                                                             | [x]  |
| 1.1-07 | `pnpm format:check` 全绿                                                                                                                                                                                                                     | C    | `All matched files use Prettier code style!`                                                                                                                                                                                                | [x]  |
| 1.1-08 | 目录结构与 plan §2 一致（缺包须显式记录原因）                                                                                                                                                                                                | C    | 见下方「结构偏差记录」                                                                                                                                                                                                                      | [x]  |
| 1.1-09 | 提交规范可用（conventional commits hook 生效）                                                                                                                                                                                               | C    | `"bad message"` 被拒并打印规范；合规消息提交成功 `0ffe9a8`                                                                                                                                                                                  | [x]  |
| 1.1-10 | `@auto-cc/core` 复导出 Context/Service/Plugin/definePlugin/fiberState 且类型可用                                                                                                                                                             | C    | core typecheck 通过（含 cordis 类型消费）；跨包消费待 1.2 复验                                                                                                                                                                              | [x]  |
| 1.1-11 | 三端用户数据目录 / 日志目录解析正确（不启动 Electron 即可验证）                                                                                                                                                                              | U    | `packages/core/src/paths.test.ts` 8 例全绿（win APPDATA/USERPROFILE、mac Library、linux XDG、日志目录）                                                                                                                                     | [x]  |
| 1.1-12 | 工具链不依赖被拦截的 postinstall（vitest/tsx/eslint 实测可跑）                                                                                                                                                                               | C    | vitest 3.2.7 跑通 8 例；esbuild build script 被跳过但功能正常                                                                                                                                                                               | [x]  |
| 1.1-13 | 提交信息**描述部分必须含中文**（AGENTS.md §1.1），英文描述被拒                                                                                                                                                                               | C    | 实测：`chore: update` 拒 / `docs(core): add path resolver` 拒 / `fix(ipc): 修复崩溃` 过 / `feat(browser)!: 破坏性变更说明` 过                                                                                                               | [x]  |
| 1.1-14 | `pnpm status:check` 能判定「工作区是否已提交、是否已推送」，未提交时 exit 1（AGENTS.md §1.6）                                                                                                                                                | C    | 实测：脏区列出 13 项改动并 exit 1；无远端时输出「未配置 git 远端」警告而不失败                                                                                                                                                              | [x]  |
| 1.1-15 | 反向验证（AGENTS.md §6.5）：**否决 husky / @commitlint / lint-staged**（其安装期钩子在本环境不可靠）没有造成规约缺口——「描述必须含中文」「测试散图不得入库」「钩子不靠 npm 生命周期装配」三项都由 `core.hooksPath` 下的纯 shell 钩子实测拦住 | C    | 真实负向提交：暂存一张散图 → `pre-commit` 打印 §7.5 白名单并 `COMMIT_EXIT=1`、HEAD 不推进；`git config core.hooksPath` → `.githooks`；`grep -n "husky\|lint-staged\|@commitlint" package.json` 零命中；全文见 `1.1-15-1x-reverse-husky.txt` | [x]  |

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

| ID     | 验收标准                                                                                                                                                                                                                         | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                    | 状态 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.3-01 | `cordis.yml` 是插件装配的唯一入口，改它即改启用的插件集                                                                                                                                                                          | V    | `1.3-01-plugin-tree-baseline.png`：清单四行 → 界面插件树 config/logger/store/shell 全已就绪；`1.3-01-store-commented-out.png`：注掉 `store` 一行 → 重启 → 树里只剩 3 个。**未从其它位置硬编码插件**（装配只读清单，见 `packages/main/src/registry.ts` 提供 id→实现）                                                                        | [x]  |
| 1.3-02 | `config` 提供分层合并（默认 < 文件 < 环境变量 < 运行时覆盖）                                                                                                                                                                     | U+C  | `packages/config/src/config.test.ts`「按 default < file < env < runtime 的顺序记录来源」「白名单外的环境变量一律忽略」「运行时覆盖是补丁而不是整层替换」；`packages/kernel/src/kernel.test.ts`「运行时层覆盖文件层」                                                                                                                        | [x]  |
| 1.3-03 | 非法配置在**挂载期**失败并指出具体字段，而非运行时空指针                                                                                                                                                                         | V    | `1.3-03-config-field-error.png`：清单里 `level: verbose`（枚举外值）→ 界面插件树 logger 显示「失败 / 配置校验失败 [logger] level: Invalid option: expected one of "error"│"warn"│"info"│"debug"」，含字段路径；config/kernel 两侧单测各断言一次点名字段                                                                                     | [x]  |
| 1.3-04 | `logger` 提供结构化日志、级别过滤、环形缓冲（内存内可取最近 N 条）                                                                                                                                                               | C    | `packages/logger/src/logger.test.ts`「级别过滤生效：info 以下不进缓冲」「内存缓冲只保留最近 N 条（`buffer: 3` 写 5 条只剩后 3 条）」                                                                                                                                                                                                        | [x]  |
| 1.3-05 | 日志同时落盘到平台规范目录（由 1.1-11 的解析函数决定）                                                                                                                                                                           | V    | `1.3-05-log-tail-and-file.png` + `1.3-05-log-scroll-live.png`：界面日志区实时滚动，磁盘 `%LOCALAPPDATA%\auto-cc\logs\auto-cc.log` 存在且行内容与界面一致；单测断言缺省目录走 config 的平台规范目录                                                                                                                                          | [x]  |
| 1.3-06 | `store.db` 用 **`node:sqlite`（Electron 内）**打开数据库，无原生编译、无 electron-rebuild                                                                                                                                        | C    | `1.3-06-node-sqlite-in-electron.txt`：Electron 44.4.5 内 `require('node:sqlite')` 直用，sqlite 3.53.4、WAL 生效、`user_version` 可读写；store 单测「驱动与版本如实上报」；`pnpm install` 无 rebuild 步骤                                                                                                                                    | [x]  |
| 1.3-07 | migration 机制：新增一条 migration 后旧库自动升级，版本号可查                                                                                                                                                                    | C    | `packages/store/src/store.test.ts`「迁移把 user_version 推上去，重复 upgrade 不再执行」「关库重开：schema 版本与数据都在」「迁移失败时版本不动、半成品表不存在（回滚）」；WAL 侧车文件实测出现                                                                                                                                              | [x]  |
| 1.3-08 | 重复启动不开第二个 DB 连接；退出时连接被 effect 回收                                                                                                                                                                             | C    | `packages/store/src/store.test.ts`「卸载后连接句柄被 effect 释放，WAL 侧文件收回主库」（dispose 后 `-wal`/`-shm` 消失 = 句柄真的还掉了）+「关库重开：schema 版本与数据都在，迁移不会重复跑」；连接只在 `[Service.init]` 里 `new DatabaseSync` 一次                                                                                          | [x]  |
| 1.3-09 | 任一 L0 service 未挂载时，依赖它的插件进入 PENDING 而非崩溃                                                                                                                                                                      | V    | `1.3-09-dependency-pending.png`：界面显示 logger/store「等待依赖」、shell 仍「已就绪」、进程存活。**说明**：1.3 阶段还没有插件 `inject` store，故这里禁用的是 `config`（logger/store 同时依赖它）而非 spec 原写的 `store`；单测「依赖缺席时是 PENDING 而不是装配失败」直接断言 store 缺席场景。待 1.9 出现注入 store 的插件后按真实依赖复验 | [x]  |
| 1.3-10 | 插件挂载失败不阻塞其他插件启动（错误隔离）                                                                                                                                                                                       | V    | `1.3-10-plugin-fail-isolation.png`：清单里把 store 的库路径指向不存在的目录（`file: missing/dir/store.db`）→ 该插件「失败 / unable to open database file」，config/logger/shell 仍全部已就绪；kernel 单测「单个插件抛错只让它自己 FAILED」                                                                                                  | [x]  |
| 1.3-11 | 日志与诊断输出对 token/cookie/密码字段**脱敏**                                                                                                                                                                                   | U+C  | `1.3-11-redact-at-sink.png`：写入含 `token=…`/手机号/邮箱的日志后，界面与落盘内容均为 `token=*** / 138****1111 / z***@qq.com`；logger 单测「free text 与结构化字段一起脱敏」「Error 堆栈同样脱敏」「关闭脱敏时原样写出」                                                                                                                    | [x]  |
| 1.3-12 | 反向验证（AGENTS.md §6.5）：**否决 `better-sqlite3`**（原生编译破坏「用户只装一个 app」）没有造成能力缺口——P1 用到的七类库能力（开库/WAL/事务回滚/迁移号段/连接回收/账本写入/进程外只读并发读）全部由内置 `node:sqlite` 实测承载 | C    | 逐条对照 `1.3-12-1x-reverse-sqlite.txt` 的能力表（每行指向已有读数 ID，其中「进程外只读并发读」由 1.11-08 的 `readOnly:true` 快照补上）；`grep -ci better-sqlite3 pnpm-lock.yaml` → 0；代价与再评估条件（在线备份 API、自定义函数）写在同文件，P1 两者都用不到                                                                              | [x]  |

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
| 1.6-01 | dev 模式自动开启 CDP 端口，`/json` 能列出 app 的 page target                 | C    | `curl -s 127.0.0.1:10222/json/list` 输出含 `"title": "auto-cc"` 与 `http://127.0.0.1:5173/`；`devtools.status()` 的 `isCdpEnabled` 为 true、`cdpPort` 为 10222                                                                                                                                                | [x]  |
| 1.6-02 | agent 能通过 harness 打开 app 并**看到页面**（截图回传为图）                 | V    | `pnpm harness shot --out /tmp/…png --url 127.0.0.1:5173` 后用 Read 读图，能描述出左栏/面板/日志区实际内容（不是「期待内容」）                                                                                                                                                                                 | [x]  |
| 1.6-03 | agent 能读到真实渲染后的 DOM 快照（含 React 挂载后的节点）                   | V    | `pnpm harness dom --selector '[data-row-id]'` 列出全部插件行的 `data-row-id` 值，与主进程 registry 的 id 集合一致                                                                                                                                                                                             | [x]  |
| 1.6-04 | agent 能真实点击与输入（派发原生事件，非只改 state）                         | V    | `harness click --selector '[data-row-id="store"] [data-action="stop"]'` → 该行状态变「已卸载」；`harness click --selector '[data-row-id="logger"] [data-action="config"]'` 打开编辑器 → `harness type --selector '[data-editor="config"]' --value '{"level":"debug"}'` → 回读为新值；两次操作后各截一张图对比 | [x]  |
| 1.6-05 | agent 能在页面上下文执行 JS 断言并取回结果                                   | V    | `harness eval --expr "window.autoCC.kernel.tree()"` 取值；`harness assert --expr … --equals …` 命中时 exit 0、不命中时 exit 1（两种都要跑一次）                                                                                                                                                               | [x]  |
| 1.6-06 | harness 能同时读到主进程侧状态（fiber 树、日志尾部）与界面状态，两者一致     | V    | 同一时刻取 `devtools.status().targets` / `kernel.tree()` / `log.tail` 与 CDP `/json/list`、界面面板文本做三方对照，数量与状态一字不差                                                                                                                                                                         | [x]  |
| 1.6-07 | 存在稳定入口 `pnpm harness <action>`，agent 无需手搓 CDP                     | C    | 根目录 `pnpm harness shot` 直接出图；`pnpm harness`（无参）打印命令清单并 exit 1；命令集覆盖 §8.1 列的 12 个 action                                                                                                                                                                                           | [x]  |
| 1.6-08 | 生产模式（打包后）**不**开启 CDP，dev harness 不进入产物                     | C    | 源码审计：`grep -rn "remote-debugging\|10222" packages/` 只允许出现在 `packages/testing/`（harness 客户端）与 devtools 的只读展示里，main/preload/renderer 源码为 0 命中；`resolveCdpPort()` 纯函数单测断言 `packaged → null`；真实安装包上的复验归 1.7-06/1.7-12                                             | [x]  |
| 1.6-09 | harness 能同时驱动**内嵌内核视图**（它是独立 target）                        | V    | `harness navigate --url data: --to file:///…/fixtures/self-test-lab/index.html`（`--url` 是按 URL 子串选 target，`data:` 只会命中内核视图的占位页）→ 对该 target `shot` + `dom`，读到 fixture 里的动态节点                                                                                                    | [x]  |
| 1.6-10 | 视觉回归基线：同一场景两张截图可比对，差异可量化报告                         | V    | 先 `shot` 基线，改一处样式（fixture 背景色）再 `shot`，`harness diff --base … --head …` 报告像素差数/占比/包围盒；同一张图自比差为 0                                                                                                                                                                          | [x]  |
| 1.6-11 | 验收证据可自动归档到 `docs/acceptance/<子计划>/`                             | C    | `harness archive --id 1.6-02 --in /tmp/….png` → 出现在 `docs/acceptance/1.6/1.6-02-*.png`；文件名不合规/目标目录不在白名单时拒绝，且 `/tmp` 过程图不进 git（`git status` 干净）                                                                                                                               | [x]  |
| 1.6-12 | 网关指标（在途/已完成/拒绝）在面板可见并随调用变化（1.5 遗留第 2 条）        | V    | 面板顶部显示 `ipc.stats` 三项；连续发起 N 次调用 + 1 次白名单外调用后，已完成 +N、拒绝 +1，截图取证                                                                                                                                                                                                           | [x]  |
| 1.6-13 | 面板行与按钮有机读锚点，脚本不依赖可见文案（1.5 遗留第 3 条）                | C+V  | `data-row-id` / `data-action` 覆盖每一行每个动作；切到英文界面后同一套锚点脚本仍全部命中                                                                                                                                                                                                                      | [x]  |
| 1.6-14 | 改主进程代码触发 dev 重启，不出现端口占用或会话被带走（1.5 固化事实第 8 条） | V    | 保存一次 `packages/main/src/index.ts` 的无害改动 → 观察 `[dev]` 日志重启成功、`/json/list` 仍是同一个 app，`pnpm dev` 进程存活；重启期间无 `bind … 只允许使用一次`                                                                                                                                            | [x]  |

### 1.6 期间新增固化的环境与设计事实

1. **`Runtime.callFunctionOn` 必须有宿主对象**：Chrome 不接受裸函数声明，缺 `objectId` 时
   `harness dom/click/type` 全线报 `Either objectId or executionContextId …`（本轮之前那三条
   其实从未跑通过）。现在 `cdp.ts` 缓存 `globalThis` 的 objectId 复用，并在 `navigate()` 之后
   作废——导航会销毁执行上下文，留着旧 id 会拿到 `Cannot find context`。
2. **Windows 上「窗口被挡住」等于「截不到图」**：Chrome 的 `CalculateNativeWinOcclusion` 把被
   别的窗口覆盖的主窗口判为不可见后停止产帧，`Page.captureScreenshot` 就永远等不到那一帧
   （实测挂满 60s）。两道措施一起用：`screenshot()` 先 `Page.bringToFront`，dev 启动加
   `--disable-features=CalculateNativeWinOcclusion`。只加前者仍会在窗口最小化时卡死。
3. **多行 JS 不能经 `pnpm harness --expr` 传**：pnpm 在 Windows 走 `.cmd` 转发实参，换行处直接
   截断（实测只剩首行，报 `Unexpected end of input`）。所以 `eval`/`assert` 加了 `--expr-file`，
   成段脚本从文件读；绕过 pnpm 用 `node node_modules/tsx/dist/cli.mjs packages/testing/src/cli.ts`
   也能跑多行，但那条路不该写进验收步骤（它绕开了 spec 里的稳定入口）。
4. **页面求值失败必须把原因带回来**：`exceptionDetails.text` 恒为 `Uncaught`，真正的原因在
   `exception.description`。`cdp.ts` 统一走 `describeException()`（附行号），否则 agent 只能靠
   二分注释脚本猜哪一行坏了。
5. **白名单拒绝只在入口计数**：`ipc.probeReject` 这类「白名单内、内部再越权」的方法会把
   `NOT_IN_ALLOWLIST` 原样抛出，在 catch 分支按错误码数就是「点一次越权、面板 +2」。现在
   `Gateway.deny()` 是唯一计数出口，只在两处入站白名单检查调用，回归用例见
   `gateway.test.ts` 的「嵌套调用不会把同一次越权数两遍」。
6. **渲染层拿到的是信封，不是异常**：`window.autoCC.*` 不抛错，拒绝藏在 `{ok:false, error}` 里。
   写页面断言脚本时 try/catch 永远抓不到越权，必须读 reply（本轮实测踩过一次，误判成
   「网关没拒」）。
7. **一次归档多张图要各自占名**：`archive --in a,b` 以前后一张盖掉前一张。现在多图补
   `-1/-2` 后缀，单图仍是 `<id>-<slug>.<ext>`，与 spec 里书写的文件名一致。
8. **面板 2s 轮询会让 `completed` 被自家读数刷高**：`READ_INTERVAL_MS = 2000`（1.6-12 要求面板
   随调用变化，就得周期性重读）。实测「6 次合法调用 + 1 次越权 → completed +7」，其中含被拒
   那次内层调用，且被拒调用同样计入 completed（它是「完成」不是「成功」）。所以 `completed`
   只能按区间读，精确断言只能落在 `denied` 上；面板显示值比主进程实时值最多滞后一个周期。
9. **`data-editor-for` 刻意不复用 `data-row-id`**：编辑框渲染在 `<li>` 之外，复用会让
   `[data-row-id]` 多命中一行，与主进程 registry 的 id 集合不再相等——那正是 1.6-03/1.6-13
   的对照前提。日志行同理用 `data-log-level` 而不是行锚点。
10. **dev 主动重启不留 `[dev] electron exited` 痕迹**：`runRestart()` 先摘掉 exit 监听（否则被
    我们 kill 的旧进程会触发 `process.exit(0)`，把整个 dev 会话带走），所以日志里只剩重复的
    `DevTools listening`。1.6-14 要求「观察 `[dev]` 日志重启成功」，因此补了一行 `[dev] 主进程重启`
    作为可 grep 的痕迹。附带事实：冷启动时 esbuild watch 会立刻触发一次重启，首启动的
    `DevTools listening` 会被吞掉，属已知噪声。
11. **英文态锚点与中文态一字不差**：切到 en 后 `[data-row-id]`(7) / `[data-action]`(16) /
    `[data-stat]`(3) 三个集合与 zh 完全相同，只有 `h1` 文案变了。唯一需要按文案定位的是 header
    里的语言切换按钮本身（`--text English`）——它不在面板锚点体系内，且它的用途就是改文案。
12. **`tmp/` 与 `docs/acceptance/` 不参与 lint 与排版**：前者是过程脚本（AGENTS.md §7.5 规定不进
    git），后者是 harness 输出的字节副本，prettier 重排会让「当时读到的值」变成「prettier 喜欢
    的样子」。

### 1.6 遗留（后续子计划处理）

| 项                                                                                     | 归属              |
| -------------------------------------------------------------------------------------- | ----------------- |
| 安装包上「CDP 未开启」的真实复验（本轮只做了源码审计 + `resolveCdpPort()` 单测）       | 1.7-06 / 1.7-12   |
| 打包态截图是否同样需要 `--disable-features=CalculateNativeWinOcclusion`                | 1.7（截图验收时） |
| harness 尚无读 console / 网络请求的能力，页面报错只能靠 `eval` 主动取                  | P2 浏览器自动化   |
| `ipc.stats` 若要精确断言调用次数，需要给统计加「按来源」维度（区分面板轮询与人工调用） | P2 之前不阻塞     |

## 1.7 零依赖三端打包与安装

验收前置：`pnpm dist:win` 产出安装包后，**先停掉 `pnpm dev`**，所有 1.7 的 V 项一律打在安装后的
真实 exe 上。安装包自己不注入 CDP 开关（1.6-08 的结构保证），验收时由操作方在命令行外部追加
`--remote-debugging-port=10222` 让 harness 能附着——此时 `devtools.status().isCdpEnabled` 仍为 false，
两个事实同时成立正是那条保证的证据（见 §8.2 决策 5）。

| ID     | 验收标准                                                                     | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                                  | 状态 |
| ------ | ---------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.7-01 | `electron-builder` 配置声明 win / mac / linux 三端目标，无占位 TODO          | C    | 审阅 `electron-builder.yml`；`pnpm exec electron-builder --config electron-builder.yml --dir --publish never` 干跑不报 schema 错；`grep -rn "TODO" electron-builder.yml scripts/build.ts` 为 0 命中；根 `dist` 脚本不再是 `pnpm --filter @auto-cc/main dist`（该包无 dist 脚本）                                                                          | [x]  |
| 1.7-02 | Windows 产物真实产出（nsis `.exe`）                                          | C    | `pnpm dist:win` 后 `ls dist/*.exe`，文件名含版本号与架构；把产物清单与体积写进 `1.7-02-*.txt`                                                                                                                                                                                                                                                             | [x]  |
| 1.7-03 | Windows 安装包**静默安装成功并启动出界面**                                   | V    | `dist\auto-cc-<ver>-win.exe /S` 静默安装 → 启动 `%LOCALAPPDATA%\Programs\auto-cc\auto-cc.exe` → `harness shot` 读图，描述出左栏 / 面板 / 日志区实际内容                                                                                                                                                                                                   | [x]  |
| 1.7-04 | 安装后的 app 不依赖 dev server（资源来自包内）                               | V    | 先确认 5173 无监听（`netstat -ano` 无 5173）再启动安装版并截图；渲染层 URL 是 `file://…app.asar/renderer/index.html`，不是 `127.0.0.1:5173`                                                                                                                                                                                                               | [x]  |
| 1.7-05 | **零前置依赖**：在未安装 Node、未安装系统 Chrome 的干净环境下装 app 即可运行 | V    | 本机代理证明：以只保留系统目录的 `PATH` 启动安装版（`where node` 在该环境下 1 命中不到）→ 界面截图正常；mac / linux 干净机标 BLOCKED 并写清缺什么                                                                                                                                                                                                         | [x]  |
| 1.7-06 | **零首启动下载**：从安装到跑通骨架，网络请求日志中无任何依赖/内核/模型下载   | C    | 安装版带 `--log-net-log=<file>` 启动，跑通界面后解析 netlog，断言 `events` 中不存在对外的 http(s) 请求条目（把条目计数写进证据文件）；同时 `devtools.status()` 报 `isPackaged=true` 且 `isCdpEnabled=false`                                                                                                                                               | [x]  |
| 1.7-07 | 打包版 IPC/service 调用可用（不只是空壳）                                    | V    | `harness eval --expr-file` 调 `window.autoCC.shell.getStatus()`（白名单里没有 `system.status`，见 1.4 的 `RENDERER_ALLOWLIST`），版本号 = `package.json` 的 0.1.0 而非 dev 值；`harness click` 点一次插件停止按钮，界面状态真的变化                                                                                                                       | [x]  |
| 1.7-08 | 打包版插件挂载与 dev 一致（同一 `cordis.yml` 生效）                          | V    | 打包版 `kernel.tree()` 的插件 id 集合与 dev 的 7 个一字不差；`harness dom --selector '[data-row-id]'` 与 `devtools.status().targets` 一致；截图面板                                                                                                                                                                                                       | [x]  |
| 1.7-09 | macOS `dmg`（arm64+x64）可构建                                               | C    | 本机为 Windows → 预期 BLOCKED（electron-builder 拒绝在非 mac 主机产 dmg，且缺 Xcode 许可）；先跑 `pnpm dist:mac` 把真实报错与配置里的双 arch 留档，不得声称已构建                                                                                                                                                                                         | [!]  |
| 1.7-10 | Linux `AppImage` + `deb` 可构建                                              | C    | `pnpm dist:linux` 实测：deb 需要 fpm、AppImage 需要 mksquashfs；能出则记产物文件名，缺件则逐目标标 BLOCKED 并写清缺哪个二进制、镜像里有没有                                                                                                                                                                                                               | [!]  |
| 1.7-11 | 版本号 / 产物命名 / 三端图标齐备，无默认 Electron 图标                       | V    | 截图窗口标题栏与托盘图标（是 `resources/icon.png` 而非 Electron 默认蓝灰原子）；安装包属性页版本 = 0.1.0；`dist` 文件名含版本；审计 staging 里三端图标源。**本轮只做到机器可查的部分**：exe 版本元数据 + `icon.ico` 由 `resources/icon.png` 生成 + 三端图标源审计；标题栏 / 托盘的**像素**未核对（CDP 只截 web 内容，截不到原生窗口装饰），留人工一眼确认 | [x]  |
| 1.7-12 | 产物内**不含**第二套浏览器内核（体积与内容审计）                             | C    | 审计 `dist/win-unpacked` 与 `app.asar`：无 chromium / playwright / puppeteer 目录，`app.asar` 内无 `node_modules`（只有 main.cjs / preload.cjs / renderer / package.json）；记录解包体积与 asar 文件清单                                                                                                                                                  | [x]  |
| 1.7-13 | 打包版渲染层带 CSP，且不含 `unsafe-eval`                                     | C    | 从 asar 读 `renderer/index.html`，断言 `<meta http-equiv="Content-Security-Policy">` 存在、`script-src 'self'`、整串不含 `unsafe-eval`；dev 的源 `index.html` 里 CSP 命中数为 0（决策见 §8.2 第 3 条）                                                                                                                                                    | [x]  |
| 1.7-14 | CSP 生效后界面照常渲染（不是白屏）                                           | V    | 打包版 `harness eval` 断言 `document.querySelectorAll('[data-row-id]').length` 为 7 且 `document.styleSheets.length` 大于 0（CSS 被 CSP 挡掉时前者会渲染成无样式、后者为 0），并截图留证                                                                                                                                                                  | [x]  |

**1.7 收尾结论**（证据在 `docs/acceptance/1.7/`，20 个文件：5 张截图 + 15 份机读文本。P1 门禁复核时按 `ls` 重数过，此前写的 21 是手数错）：

- 两条 `[!]` 都是**宿主平台缺二进制**，不是配置缺件，且已按条目要求写清缺哪个：1.7-09 需要 macOS 主机
  （electron-builder 实测拒绝在非 mac 主机产 dmg，且 hdiutil / codesign 与 Xcode 许可只在 macOS 存在）；
  1.7-10 的 `linux-unpacked` 已真实产出，但 deb 需要系统 `fpm`、AppImage 需要 `mksquashfs` +
  `appimagetool`，三者都是 Linux 二进制，Windows 上装不到（镜像里 `fpm-1.9.3-2.3.1-linux-x86_64/` 存在，
  但那是给 Linux 宿主用的）。到 Linux 机器上按同一份配置直接重跑即可，无需改代码。
- 1.7-05 的「未装系统 Chrome」在本机是用**剥离 PATH**（只剩 Windows 系统目录 + `where node` 零命中）代理
  证明的，不是真的干净虚拟机；这条结论强度弱于原始意图，如实记在这里。
- 1.7-06 的 netlog 必须**干净退出**才会落全 `events`（`Stop-Process` 强杀只剩 `constants`），
  所以用 CDP `Browser.close` 收尾，实测 13 条事件里对外 http(s) 请求 0 条。

## 1.8 内置内核会话与登录态持久化

| ID     | 验收标准                                                                                                                                                                                                                                          | 方式 | 验证操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 状态 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1.8-01 | 每个平台一个独立 `persist:<platform>` partition，互不共享 cookie                                                                                                                                                                                  | U+C  | 在 A partition 写 cookie，B partition 读不到                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [x]  |
| 1.8-02 | 自动化会话与主 app UI 会话隔离（app 界面访问不到站点 cookie）                                                                                                                                                                                     | V    | 渲染层 `document.cookie` 为空，fixture 站点视图有值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [x]  |
| 1.8-03 | **登录态跨重启保持**：在 fixture 站点登录后完全退出 app 再启动，仍是登录态                                                                                                                                                                        | V    | 登录 → 退出 → 重启 → 截图显示已登录（不需重登）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [x]  |
| 1.8-04 | 登录态持久化位置确认在 userData 下且随「退出登录」可清除                                                                                                                                                                                          | C+V  | 检查 partition 目录存在；点退出后 cookie 消失                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [x]  |
| 1.8-05 | 会话数据不进入日志与诊断包（脱敏）                                                                                                                                                                                                                | U    | 断言日志中无 cookie/token 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [x]  |
| 1.8-06 | 登录失效能被探测并发出 `session.auth.expired` 事件                                                                                                                                                                                                | V    | 手工清 cookie 后运行探测 → 界面出现「需重新登录」提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [x]  |
| 1.8-07 | 失效时工作流**不静默失败**，而是停在可恢复点并明确提示                                                                                                                                                                                            | V    | 触发失效 → 界面显示停在哪个步骤与原因                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [x]  |
| 1.8-08 | 视图容器对用户可见（可亲眼看到自动化在做什么），并可键盘鼠标接管                                                                                                                                                                                  | V    | 截图内嵌视图；在其中真实输入一个搜索词                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [x]  |
| 1.8-09 | 无网络/站点不可达时有明确错误态，不表现为卡死                                                                                                                                                                                                     | V    | 停掉 fixture 服务 → 界面显示可诊断错误                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [x]  |
| 1.8-10 | 反向验证（AGENTS.md §6.5）：**否决 Playwright / puppeteer / selenium**（要驱动的是 app 内置的 `WebContentsView`，不是外部浏览器）没有造成 P1 能力缺口——target 附着、页面求值、真实鼠标/键盘、截图、等待条件、会话分区、fixture 隔离七项都有承载位 | C    | 逐条对照 `1.8-10-1x-reverse-playwright.txt` 能力表（每行指向 CDP 方法名或已有证据 ID）；`grep -ci` 三个库名于 `pnpm-lock.yaml` 均为 0；Playwright 特有而 P1 未用到的（跨浏览器、route 拦截、trace viewer）与**再评估条件三条**（同类 flake ≥3、需要表达式级选择器、需 trace 复盘）写在同文件，门留给 P2                                                                                                                                                                                                                                                                                                                                                                                                                                                | [x]  |
| 1.8-11 | 反向验证（AGENTS.md §6.5）：**否决 tough-cookie 式自维护 cookie 存储**没有造成能力缺口——Chromium 原生持久化把 localStorage / IndexedDB 一起带进 `persist:<platform>` 分区，并且跨**进程重启**可读回                                               | V    | `1.8-11-1x-reverse-storage.txt`：重启前（主进程 PID 9812）在 `http://127.0.0.1:10233/` 写入同一时间戳标记到 localStorage 与 IndexedDB；`Partitions/fixture/{Local Storage,IndexedDB}` 两个 leveldb 目录落盘（795 B / 1358 B）；kill 全部 electron.exe → 端口 10222/5173/10233 释放 → `pnpm dev` 起新实例（CDP 属主 PID 25336）；只读探针 `lsMarker === idbMarker === "p1-04-2026-09-29T16:35:54.971Z"`；前后截图 `diffPixels: 0 / totalPixels: 748762`（视觉只证明"同一个分区同一个页面"，存活性以两条读数为准）。诚实记录：中途 fixture 服务被我一起 kill，视图落到 `chrome-error://chromewebdata/`（不透明源 → storage 拒绝），主进程结构化上报 `-102 ERR_CONNECTION_REFUSED`；service worker 未在本地实测（fixture 无 SW 注册），只作为推定收益记录 | [x]  |
| 1.8-12 | 反向验证（AGENTS.md §6.5）：**否决"给内核视图注入 `preload` 跑自动化脚本"**没有造成能力缺口——外部页面拿不到 app 能力面，而自动化（点击/输入/求值/截图）在主进程侧经 CDP 全部做得到                                                                | V    | `1.8-12-1x-reverse-preload.txt`：代码对照 `packages/shell/src/index.ts:168`（主窗口带 `preload.cjs`）vs `:226-234`（内核视图 webPreferences 只有 partition + 三条安全底线，无 preload）+ `packages/ipc/src/index.ts:9/:87`（事件只推主窗口）；运行期同刻双向读数——app 渲染层 `autoCC: "object"` / 14 个命名空间齐备，内核视图外部页面 `autoCC`/`require`/`process` 全 `undefined` 且 `topKeysMatched: []`（旧进程 9812 与新进程 25336 各取一次，结论一致）                                                                                                                                                                                                                                                                                             | [x]  |

**1.8 收尾结论**（证据在 `docs/acceptance/1.8/`，21 个文件：17 张截图 + 4 份机读文本——`1.8-07-*` 三件是 1.10 收口时补验的，
`1.8-10/11/12` 四件是 P1 门禁的反向验证补的；本段原写「16 个文件」是补验前的数，已重数。
被测站点一律是本地 fixture `http://127.0.0.1:10233`，未触碰真实招聘平台，见 AGENTS.md §7.2）：

- **先记一条截图口径，否则证据会被误读**：CDP 的 `Page.captureScreenshot` 只覆盖被截 target 自己的表面，
  `WebContentsView` 是原生层叠上去的，所以从渲染层 target（`--url 5173`）截图时右栏只有槽位占位说明，
  看不到站点页面。视图里的真实内容一律从视图 target（`--url 10233`）单独截，两类截图成对归档。
- **1.8-01**：单测 `packages/sessions/src/probe.test.ts` 断言 `partitionFor('fixture')` = `persist:fixture`
  且不同平台分区名互不为前缀；真机侧在分区 A 登录后，A 的视图显示「已登录」，
  切到分区 B 打开同一台 127.0.0.1、同一个 cookie 名，B 仍是「未登录」（两张视图截图）。
- **1.8-02**：`harness eval --url 5173` 读渲染层 `document.cookie` 为空串，而同一时刻视图 target 里
  `document.cookie` 是 `autocc_session=fixture-token`、服务端也判定 `loggedIn:true`。
  渲染层 `sandbox: true` + 视图独立分区，两侧不共享。
- **1.8-03**：登录后用 `taskkill //IM electron.exe //F` 强杀进程（不是关窗口——关窗口只隐藏到托盘），
  重启后视图直接是已登录态，无需重登；面板 `auth` 徽标同步为「有效」。
- **1.8-04**：`%APPDATA%\auto-cc\Partitions\fixture\Network\Cookies` 实测存在且随登录增长；
  点「退出登录」后 `cookieNames` 变空、视图回到未登录，磁盘上的 cookie 行被清掉。
- **1.8-05**：日志断言在 `packages/logger/src/redact.test.ts`（`Set-Cookie:`、`autocc_session=`
  的值一律被 `***` 替换，JSON 形态的 `Cookie` 字段也收）；`sessions` 服务只写平台名与原因，
  快照载荷里只有 cookie 的**名字**与过期时间，没有值。
- **1.8-06**：事件实现名是 **`session/expired`**，不是条目原文的 `session.auth.expired`——本仓库的事件名
  统一为 `<namespace>/<event>`（`log/line`、`plugin/error`），且要同时出现在 `core` 的 `Events` 增补与
  `RENDERER_EVENTS` 白名单里。原文的点名方式视为笔误，不改判据本身。横幅由推送出现，未点刷新即可见。
- **1.8-07**：**1.10 收口时补验通过**。接线点在 `workflow.runner` 的 `[Service.init]`：
  `ctx.on('session/expired', …)` 注册在 fiber 的 effect 作用域里（随插件卸载解订，与 1.5 的启停一致），
  处理器只在 `status === 'running'` 时动作，走的是与「用户点暂停」同一条协作式让出路径
  （`pause(message)` → `apply({type:'pause'})` + `controller.abort()`），所以不引入第二套取消语义。
  实测：运行中调 `sessions.probe('fixture')`（本地分区无会话 cookie → `reason: missing`）后，
  面板徽标变「已暂停」、`runner.current()` 是 `{ status:'paused', stepIndex:1, steps:['search=done','profile=pending',…] }`，
  播报行显示「fixture 登录态失效（missing），已停在 profile，重新登录后从当前步续跑」；
  MutationObserver 快照在失效后 4 秒内停在 6 条不再增长（既没把 profile 记成 done，也没往下跑第三步）；
  点「续跑」从 profile 重跑并跑完，`runId` 未变、`search` 的 2002 毫秒耗时一字未改 → 停在的确实是可恢复点。
  不在运行中收到失效则整条被忽略（done 的 run 仍是 done，不抛错）。
  证据：`1.8-07-expired.png`、`1.8-07-resumed.png`、`1.8-07-evidence.txt`（含读数与复现口径）。
  **一处口径**：播报里出现的是步骤 id（`profile`）而不是界面上的中文名「岗位与简历匹配」——
  这句话由主进程生成，P1 的六条占位播报（`开始 search`…）全是同一口径，P2 换成真实进度文案时一起解决。
  **2.1 已解决（2026-09-30）**：失效提示改由 `run.requiresHuman`（`{platform,reason,stepId,at}` 纯数据）
  驱动，界面用 `workflow.takeoverBody` + 复用 `session.reason.*` / `workflow.step.*` 组句，
  所以界面上显示的是「已停在「生成打招呼话术」这一步」这类中文步名，主进程不再拼句子。
  判据本身未变（停在可恢复点 + 明确提示），但**机制换了**，故 2.1-08 用新证据重跑一遍：
  `docs/acceptance/2.1/2.1-08-takeover-zh.png`。上面三件 `1.8-07-*` 记录的是被替换掉的旧机制，保留不删。
- **1.8-08**：`harness type --url 10233 --selector '[data-fixture="query"]' --value 自动化验收` 之后，
  视图 target 里该输入框回显「自动化验收」（截图为证），`eval` 读回的 `value` 也正是这五个字——
  键盘事件进了站点页面而不是被面板吃掉。面板侧截图同时显示 `persist:fixture` 与落盘路径。
- **1.8-09**：停掉 fixture 服务后点「打开」，面板即时（无需手动刷新）出现
  `内核视图加载失败：-102 ERR_CONNECTION_REFUSED（http://127.0.0.1:10233/）`；恢复 fixture 再点一次即消失。
- **1.8-10 ~ 1.8-12**（P1 门禁 §6.5 反向验证，2026-09-30 补）：三条都是**被否决路线的能力缺口检查**，
  不是新功能。1.8-10 证明自研 CDP harness 覆盖了 Playwright/puppeteer/selenium 的七项能力且 `pnpm-lock.yaml`
  里三个库名各 0 命中；1.8-11 证明 `persist:<platform>` 把 localStorage 与 IndexedDB 一起带进分区并**跨进程重启**读回同值
  （写于 PID 9812，读于 PID 25336，`lsMarker === idbMarker === "p1-04-2026-09-29T16:35:54.971Z"`），
  这正是 tough-cookie 式自维护存储会丢掉的东西；1.8-12 证明外部页面的 `window` 上 `autoCC`/`require`/`process`
  全 `undefined`、无 cordis/electron/ipc 自有键，而 app 自己的渲染层同时刻 14 个命名空间齐备 —— 注入通道是通的，
  只是**刻意**不给内核视图（AGENTS.md §8.1/§8.2 的能力不外泄）。
  **一条通用口径**（1.8-11 实测踩到）：`harness --url` 只匹配 target 的**请求 URL**，加载失败时它照样命中，
  而此刻文档已落到 `chrome-error://chromewebdata/`（不透明源），读 `localStorage`/`indexedDB` 会抛
  `SecurityError: Access is denied for this document`。凡是要读页面 storage，先断言 `location.href` 不是 chrome-error。
- **两个实测事实值得留下，否则后来者会重踩**：
  ① Chromium 在主文档加载失败时**照样**触发 `dom-ready` 与 `did-finish-load`，且那一刻 `getURL()`
  还不是 `chrome-error://`，所以「加载成功」事件不能用来复位错误态——错误位的生命周期改成「本次挂载」，
  在 `createKernelView` 开头清零。② `sessions.open` 先返回、`did-fail-load` 后到，那次快照里错误位仍是空的，
  所以错误态**必须**由 `shell/view-error` 事件推进界面（这也是内核视图地址在打开瞬间可能显示「尚未读取」的原因：
  地址只能等下一次读数才有，P1 接受这个滞后）。
- 顺带挖出并修掉一个从 1.3 潜伏的 L0 缺陷：内核在装配开始前一次性把清单层灌进 `config` 服务，而
  `config` 自己也在清单里、那一刻还不存在，于是**文件层与运行时层全部丢失**，插件只拿到 schema 默认值。
  五个子计划没发现它，是因为 `cordis.yml` 里写的每个值都恰好等于其默认值；`sessions.platforms`
  是第一个「必填且无默认」的键。修复见提交 `fix(kernel)`，回归测试在 `kernel.test.ts`。

## 1.9 外发额度闸门（未来付费的接线面）

| ID     | 验收标准                                                                             | 方式 | 验证操作                                                         | 状态 |
| ------ | ------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------- | ---- |
| 1.9-01 | `entitlement.gate.check(action, ctx)` 存在，返回 `{allowed, remaining, reason}`      | U    | 契约与返回 shape 断言                                            | [x]  |
| 1.9-02 | 默认本地实现返回无限（当前产品阶段不花钱、不登录）                                   | U+C  | 断言 `allowed=true`、`remaining=null`                            | [x]  |
| 1.9-03 | gate 可被配置切成「每动作每天 N 次」，超限后 `allowed=false` 且 reason 可读          | V    | 界面设 N=1，第二次外发被拒并显示原因                             | [x]  |
| 1.9-04 | 每次通过 gate 的外发在 `usage.ledger` 落一行 `(action, targetId, workflowRunId, ts)` | C+U  | 断言行数与字段完整                                               | [x]  |
| 1.9-05 | **绕过 gate 的外发在骨架测试里失败**（gate 缺席即报错，不允许静默放行）              | U    | 移除 entitlement 插件后跑外发样例 → 报错而非成功                 | [x]  |
| 1.9-06 | 上层业务代码不含「是否付费」的分支，只看 gate 结果                                   | C    | `grep -rn "quota\|entitlement\|paid" packages/` 无业务层分支判断 | [x]  |
| 1.9-07 | 账本可在界面回看（次数、按天分组、按动作分组）                                       | V    | 触发若干次后截图用量页                                           | [x]  |
| 1.9-08 | 未来接 SaaS 不需要改表：数据模型含可空 `source` / `remoteRef` 字段                   | U    | schema 断言字段存在且可空                                        | [x]  |
| 1.9-09 | 断网时 gate 走本地实现且**不阻塞**已有能力（联网校验可选、失败可降级）               | V    | 断网运行外发 → 成功                                              | [x]  |

**1.9 收尾结论**（证据在 `docs/acceptance/1.9/`，11 个文件：7 张 CDP 截图 + 2 份单测报告 + 2 份
命令行输出；外发对端一律是本地 fixture
`http://127.0.0.1:10233/api/outbound`，未触碰真实招聘平台，见 AGENTS.md §7.2）：

- **1.9-01**：`packages/entitlement/src/entitlement.test.ts` 断言 `check()` 的返回**恰好**是
  `allowed` / `remaining` / `reason` 三个键（用 `Object.keys` 排序比对，多一个键也算失败）——
  这个 shape 就是将来接 SaaS 时要替换的唯一契约面。
- **1.9-02**：默认实现是 `mode: 'local-unlimited'`，单测断言 `allowed=true`、`remaining=null`；
  真机侧用量面板两行都显示「本地无限额度（当前阶段不花钱）」（`1.9-02-unlimited.png`）。
- **1.9-03**：在装配面板把 `entitlement` 的配置改成 `greet` 每天 1 次并保存（`plugins.saveConfig`
  → `fiber.update` 热更新，不重启进程），第一次外发成功、第二次界面显示
  `外发 greet 失败：动作 greet 今日 1 次额度已用完`；同一时刻 fixture 收件箱仍是 1 条、
  账本累计没变——**被拒既不花钱也不落账**（`1.9-03-quota-denied.png`）。
  额度是**按动作**算的：`greet` 用满后 `deliver` 仍可发。
- **1.9-04**：单测断言 `perform()` 成功后账本恰好多一行且四个字段齐（`action`、`targetId`、
  `workflowRunId`、`ts`）；真机回执 `已送达：账本行 4 · 对端累计收到 2 条`，界面 recent 列表
  逐行显示 `#4 deliver → job-2 · 21:49:35` 等四行（`1.9-04-ledger-row.png`）。
  这四次记录在随后一次 Electron 重启（改 `outbound` 触发 esbuild watch）之后依然在——落盘是真的。
- **1.9-05**：停掉 `entitlement` 插件后，`outbound` 因为 `inject: ['entitlement.gate']` 依赖缺席而
  停在 PENDING（装配面板显示「等待依赖 … 依赖 entitlement」），点发送得到
  `服务未挂载：outbound`；用量面板两行显示「闸门未挂载：装配里缺 entitlement 插件」，账本数字不变
  （`1.9-05-outbound-pending.png`、`1.9-05-gate-removed.png`）。单测那一半更硬：闸门缺席时外发服务
  **根本不挂载**，一次网络请求都没发出。恢复挂载后同一次点击即回到「已送达」。
- **1.9-06**：`grep -rn "quota\|entitlement\|paid" packages/`（排除测试）的命中全部落在
  闸门与账本自身（`entitlement/src/gate.ts`、`index.ts`）、主进程装配表（`main/src/registry.ts`）、
  外发侧的一行 `inject` 与一次 `perform` 调用、IPC 白名单与只读面板。
  **没有任何一处 `if (付费) … else …` 形态的分支**——上层只看 `allowed`，这正是未来接付费时
  只需要换 `entitlement` 一个包的原因。
- **1.9-07**：用量面板显示 `账本累计 4 次 / 今日 4 次`，下面按本地自然日分组
  `2026-09-29 · 4 次 · greet × 2 · deliver × 2`（`1.9-07-ledger-groups.png`）。
  日界按本机时区而非 SQLite 的 UTC `date()`，单测用「昨天一条、今天一条」两侧都构造过。
- **1.9-08**：单测直接查 `PRAGMA table_info(usage_ledger)`，断言 `target_id`、`workflow_run_id`、
  `source`、`remote_ref` 四列存在且 `notnull=0`；不写 `source`/`remoteRef` 能插入（读回为 `null`），
  写 `source:'remote'`、`remoteRef:'bill-9'` 也能插入并原样读回——接 SaaS 时不改表。
- **1.9-09**：这条的判据是「闸门不依赖联网、失败不阻塞其他能力」，用两步证明，没有做整机断网
  （改用户机网卡属于影响共享状态的动作，不该为验收做）：
  ① **静态**——`grep -rn "fetch\|http\|axios\|socket" packages/entitlement/src/` 只命中测试文件里
  那个用来计数的 `fetch` 存根，闸门与账本**一行网络代码都没有**，所以断网不可能改变它的判定；
  ② **实测**——停掉 fixture 进程后点发送，界面得到结构化错误
  `外发 greet 失败：对端不可达：fetch failed`，同一时刻额度读数照常、装配面板 11 行照常枚举、
  账本不增长，应用不崩（`1.9-09-peer-down.png`）。
- **验收过程中挖出并修掉的三个真缺陷**（都是"脚本绿了但页面是错的"那一类，正是 §7.1 要防的）：
  ① fixture 的请求体解析用 `Buffer.from(缓冲数组)`，Node 按字节数组解释，分片全变 `0x00`，
  于是**每一次外发都被 400 拒回**，界面上只有一句"失败"；改成 `Buffer.concat` 后通。
  ② `t('action.failed')` 漏传 `{{action}}` 实参，界面把占位符原样显示出来；
  已把这类错误变成 `[机检]`——`scripts/check-renderer-conventions.ts` 现在会比对 zh-CN 文案里的
  `{{x}}` 与调用点实参名，缺一个就 `pnpm lint` 失败（先确认渲染层既有的全部 `t()` 调用点都在新校验下
  全绿，再把 ② 改回去，确认它确实精确报出这一条，而不是靠放宽规则蒙过去）。
  ③ 内核视图地址是 percent-encoded 长串且无断行点，把整页撑出横向滚动条，**此后每张截图都被裁**；
  补 `break-all` 后重拍。
- 顺带记一条 harness 口径：`shot --reveal <css>` 用真实 `mouseWheel` 事件把目标滚进视口
  （每步 ≤300px、等 100ms + 2 帧），判据是"元素完整落在视口内 ±2px"，滚到边界仍不满足就直接抛错——
  宁可拍不到也不拍一张裁错的证据。1.9 的 5 张可视证据全部走的这条路。

## 1.10 工作流面板（第二视图）

| ID      | 验收标准                                                                                                                                                   | 方式 | 验证操作                                                                              | 状态 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- | ---- |
| 1.10-01 | 工作流面板作为**第二视图**存在，从对话主界面一次点击即可切换到达，且保留上次滚动位置                                                                       | V    | chat → 面板 → chat 往返截图                                                           | [x]  |
| 1.10-02 | 面板呈现六个主线步骤槽位（搜索/建档/话术/打招呼/定制简历/投递）                                                                                            | V    | 截图并逐个读出步骤名                                                                  | [x]  |
| 1.10-03 | 存在 `workflow.runner` 挂载点与状态机骨架（idle/running/paused/failed/done 可迁移）                                                                        | U+C  | 空 runner 走完一轮状态迁移                                                            | [x]  |
| 1.10-04 | 「运行」在 P1 可跑一个占位工作流（无业务），但界面进度是真实的流式更新                                                                                     | V    | 点运行 → 连续截图看到进度推进                                                         | [x]  |
| 1.10-05 | 可中断、可从当前步续跑（不从头再来）                                                                                                                       | V    | 运行中暂停 → 恢复 → 截图确认步骤号继续                                                | [x]  |
| 1.10-06 | 每个步骤槽位能显示状态与耗时；失败步可单独重试                                                                                                             | V    | 注入失败步 → 截图 → 点重试 → 成功                                                     | [x]  |
| 1.10-07 | 调试面板与插件树是**次级入口**，层级低于对话与工作流                                                                                                       | V    | 截图导航层级                                                                          | [x]  |
| 1.10-08 | 面板与 1.11 的对话界面驱动**同一个** `workflow.runner` 实例，不各自持有运行状态                                                                            | C+U  | 静态查引用 + 断言两侧状态镜像一致                                                     | [x]  |
| 1.10-09 | 反向验证（AGENTS.md §6.5）：**不引入 XState / 不引入任何状态机库**没有造成 P1 能力缺口——六步线性流水线的全部迁移都可由自研迁移表表达，且非法迁移被拒而不崩 | U+C  | 迁移表单测穷举合法/非法迁移；`grep xstate package.json pnpm-lock.yaml` 确认零新增依赖 | [x]  |

**1.10 收尾结论**（证据在 `docs/acceptance/1.10/`，27 个文件：21 张 CDP 截图 + 6 份机读文本；
其中 6 个文件是 1.11 收口时补拍的往返/镜像证据，见下面两条；本行原写「23 个文件：18 张 + 5 份」是手数错，
`git log --diff-filter=D` 证实该目录从未删过文件，已在 P1 门禁复核时按 `ls` 重数）：
全程走 CDP **10222** 驱动真实窗口，占位步骤不含任何网络请求，未触碰真实招聘平台，见 AGENTS.md §7.2）：

- **1.10-01 `[x]`（1.11 收口时补拍才过）**：滚动位置与一次点击可达两半都过了——诊断视图滚到底
  （`scrollTop = 2067.333251953125`）→ 切到工作流 → 再切回来，读数一字不差，
  两张截图 `harness diff` 得 `diffPixels: 0 / isIdentical: true`
  （`1.10-01-scroll-before.png`、`1.10-01-scroll-after-return.png`）。
  实现方式是两个视图各自成一个 `[data-view-scroll]` 滚动容器、切换只改 `display` 不卸载。
  但 spec 写的判据是「chat → 面板 → chat 往返」，对话界面要到 1.11 才存在，所以本轮先记 `[!]`；
  1.11 收口时用**真实对话界面**重跑了一遍才置 `[x]`：会话里两条长消息（739 + 834 字）把
  `[data-testid="chat-scroll"]` 撑到 `scrollHeight 647 / clientHeight 389`，置 `scrollTop = 142`
  → 点「工作流」→ 点「对话」→ 仍是 142，往返两张截图 `diffPixels = 0 / totalPixels = 1967574 /
isIdentical: true`（`1.10-01-10-11-before-1.png`、`1.10-01-10-11-wf-2.png`、
  `1.10-01-10-11-after-3.png`、读数与一次读错节点的坑记在 `1.10-01-10-11-roundtrip-4.txt`）。
  顺带确认：切视图**不会**触发 `ChatPanel` 的自动贴底 effect（它只订 `[snapshot, liveStream]`），
  所以用户往上翻历史时被弹回底部这件事，在切视图这条路径上不存在。
- **1.10-02**：挂载即有六个槽位，逐个可读（`1 · 搜索合适的 JD`…`6 · 发送简历`），
  全部「待执行」且状态徽标是 `未开始 · <runId>`（`1.10-02-slots-idle.png`）。
  这一条在实现上改过一版：原先 `current()` 在没有跑过时返回 `null`，界面首轮什么都画不出来，
  只能显示一句「正在读取…」——那既违背本条也违背 1.10-03 的 `idle` 态。
  现在执行器**构造即持有一个 idle run**（`createRun` 出六个 pending 槽位），
  `current()` 永不为 null，界面不必为空态另写一套分支。
- **1.10-03**：`static provide = 'workflow.runner'` 全仓唯一；`pnpm --filter @auto-cc/plugin-workflow test`
  25 条全绿（machine 16 + runner 9），五态迁移与 10 条非法迁移矩阵逐条点名，
  清单见 `1.10-03-runner-tests.txt`。
- **1.10-04**：把 `stepDelayMs` 热改成 2000 后连拍，DOM 侧用 `MutationObserver` 记下 13 个快照、
  12 次播报，六步严格按 search→profile→pitch→greet→tune→deliver 各自经历 pending→running→done
  （`1.10-04-dom-trace.txt`）；像素侧 idle / mid1 / mid2 / done 四张两两 `isIdentical: false`
  （239731 / 200248 / 155406 px）。
  **这里抓到第二个真缺陷**：界面一度在 `start()` 返回后 2ms 闪回「全部待执行」——
  主进程在 `start()` 返回之前就把 `step-started` 推了出去，把 IPC 返回值再写回镜像必然旧一帧。
  修法是动作口**不**回写状态，镜像只认事件流（见 `WorkflowPanel.act()` 的注释）。
  顺带把提示文案从「工作流当前：X」改成「本次动作返回：X」——它记的是一次动作的返回值，
  不是当前状态，旧措辞在 run 已经跑完或实例已重建时会与徽标自相矛盾（截图里拍到过）。
- **1.10-05**：运行中点暂停 → 徽标 `已暂停`、runId 不变、前两步的 2012/2006 毫秒保留、
  第三步退回「待执行」（`1.10-05-paused.png`）；点续跑 → **同一个 runId** 从第三步重跑再往下走完
  （`1.10-05-resumed.png`，第三步重新计时 2018 毫秒、第四步执行中）。
  暂停是协作让出（`AbortController`）不是强杀：单测断言 abort 之后不再有任何进度事件，
  也不许把让出那一步记成 done。
- **1.10-06**：把 `failStep` 配成 `profile` → 第二步整行变红、带自己的耗时（2013 毫秒）、
  错误原文与「重试」按钮，其余槽位不受影响（`1.10-06-failed.png`）；
  点重试 → 同一条 run 继续跑到 `已完成`，错误文案消失（`1.10-06-retried.png`、`1.10-06-retried-done.png`）。
  注入**只作用一次**是刻意的：改配置会重建实例并丢掉当前 run，若重试仍必然失败就永远拍不到「重试→成功」。
- **1.10-07**：导航两档——主视图是带边框的 `text-xs text-slate-100`，诊断入口是
  `text-[11px] text-slate-500` + 一条左分隔线，两种选中态下都低一档
  （`1.10-07-nav-workflow-view.png`、`1.10-07-nav-diagnostics-view.png`）。
- **1.10-08 `[x]`（同上，1.11 收口时补齐后半句）**：静态那一半已固化（`1.10-08-single-runner.txt`）：
  provider 1 处、渲染层 `useState<WorkflowRunView>` 1 处、五个动作口全在白名单里，界面没有任何本地推进逻辑。
  「两侧镜像一致」这一半等对话界面存在后测：一次采样同时读三处
  （`start` → 1.3s 后 `pause`，表达式与读数在 `1.10-08-10-08-mirror-3.txt`）——
  `bridgeRunId = panelRunId = 5d48d8e5…`、`bridgeStatus = paused`、
  `panelState = 已暂停 · 5d48d8e5-…`、`chatMirror = 同一个 runner：已暂停`，
  六步向量 `search:done,profile:done,pitch:pending,greet:pending,tune:pending,deliver:pending`
  在 bridge / panel 两侧逐位相同；运行中（未暂停）的同形采样也逐位相同（`pitch:running`）。
  聊天视图当时是 `hidden` 的那一侧照样收到 `workflow/progress` 并更新了徽章，
  证明它不是"切过去才拉一次"的第二份状态。两侧共用 `packages/renderer/src/useWorkflowRun.ts`
  （订阅 `workflow/progress` + 挂载时 `runner.current()`），`WorkflowPanel` 与 `ChatPanel` 各调一次；
  像素侧 `1.10-08-10-08-1-chat-mirror-paused-1.png` 与 `1.10-08-10-08-2-workflow-paused-2.png` 是同一 run。
- **1.10-09**：`grep -rn "xstate" package.json pnpm-lock.yaml packages/*/package.json` 无输出、exit=1，
  状态机是 `packages/workflow/src/machine.ts` 的 132 行纯函数；非法迁移 10 条矩阵断言
  「返回 reason、不抛异常、不就地改动入参」。被否决路线的代价与再评估条件写在
  `1.10-09-zero-dep.txt` §D（真出现多平台并行汇合时再谈引库）。
- **连带补验的 1.8-07 已过**（判据与读数记在 1.8 收尾结论同一条，证据在 `docs/acceptance/1.8/1.8-07-*`）：
  `workflow.runner` 在 `[Service.init]` 里订 `session/expired`，运行中收到失效就走与「点暂停」同一条
  协作式让出路径并带上一句原因。这条能白捡，正因为 1.10-05 的暂停本来就是可恢复的——
  没有新增第二套取消语义，只在 `pause()` 上加了一个可选的播报参数。
- **harness 口径（两条会咬人的）**：① `cli.ts` 取 `args[0]` 当子命令，所以 `--url` / `--port`
  **必须写在子命令之后**，写在最前面会掉进 `help()` 并以 exit 1 结束——排查这个花了很久，
  因为现象是「dom 命令返回空数组」而不是报参数错。② Windows 上多行/带双引号的表达式经 `.cmd` 转发会被截断，
  成段脚本一律 `--expr-file`。③ 截图节奏：每次 `harness` 调用有约 2 秒进程启动开销，
  600ms 的步长会让连拍落在同一步里（拍到 `isIdentical: true`），要拍进度先把 `stepDelayMs` 热调大。
- **`plugins.saveConfig` 只改运行期**（重建实例、不写 `cordis.yml`），所以验收里改过的
  `stepDelayMs` / `failStep` 在收尾时都改回了默认值，仓库配置零漂移。

## 1.11 对话式主界面骨架（首页第一入口）

| ID      | 验收标准                                                                                                                                                                                                           | 方式 | 验证操作                                                        | 状态 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------- | ---- |
| 1.11-01 | app 冷启动**首屏即聊天窗口**，不是设置页、功能目录页或工作流面板                                                                                                                                                   | V    | 冷启动截图                                                      | [x]  |
| 1.11-02 | 聊天界面具备三块最小结构：消息流、输入区（可回车发送/Shift+Enter 换行）、运行中指示                                                                                                                                | V    | 发一条消息 → 截图三块区域                                       | [x]  |
| 1.11-03 | 消息流区分用户/助手两类气泡，助手回复**流式增量**渲染而非整块跳出                                                                                                                                                  | V    | 长回复过程中连续截图，可见字数递增                              | [x]  |
| 1.11-04 | 存在 `agent.tools` 注册表且 P1 为**空表**；注册表是 service 白名单，不含任何业务实现                                                                                                                               | C+U  | 单测：注册空工具 → 列举 → 调用不存在工具被拒                    | [x]  |
| 1.11-05 | 工具调用协议定型（`toolId` + zod 入参 schema + 结果/错误联合类型），P5 只注册工具不改协议                                                                                                                          | C    | 读 `agent.tools` 类型定义并断言 schema 校验生效                 | [x]  |
| 1.11-06 | 工具卡片以**占位组件**形式渲染（标题/参数摘要/状态），图标取自 lucide-react                                                                                                                                        | V    | 触发占位调用 → 截图卡片                                         | [x]  |
| 1.11-07 | 自治档位（建议/半自动/全自动）在界面上可见可切换，P1 仅存档位、不产生行为差异                                                                                                                                      | V    | 切换三档 → 三张截图显示当前档位文案                             | [x]  |
| 1.11-08 | 会话持久化：重启 app 后历史消息与档位保留；新建会话不影响旧会话                                                                                                                                                    | V    | 发消息 → 重启 → 截图仍在 → 新建会话 → 截图为空                  | [x]  |
| 1.11-09 | P1 的对话链路**不得**触达任何外发能力（打招呼/投递/发送简历），调不到的工具即报错                                                                                                                                  | U    | 断言在 P1 调用外发类工具返回「未注册」                          | [x]  |
| 1.11-10 | 聊天界面全部文案走 i18n（`chat.*` / `agent.*`），`zh-CN` 与 `en` 同时齐全，切换后无缺 key                                                                                                                          | C+V  | 切到 en → 截图；缺翻译校验脚本通过                              | [x]  |
| 1.11-11 | 样式仅 Tailwind、图标仅 lucide-react，无裸 JSX 中文文案，通过 eslint 机检                                                                                                                                          | C    | `pnpm lint` 在 renderer 包零告警                                | [x]  |
| 1.11-12 | 渲染层经 `window.autoCC` 白名单访问主进程，未开 `nodeIntegration`，`contextIsolation` 为 true                                                                                                                      | C+U  | 复用 1.2-04 类断言                                              | [x]  |
| 1.11-13 | 输入区在 agent 运行中仍可用（可输入"停一下"），不因执行阻塞而冻结界面                                                                                                                                              | V    | 运行占位任务时输入并截图显示已接受                              | [x]  |
| 1.11-14 | 骨架不含任何抓取/发送/简历业务逻辑，P2~P4 能力只能作为工具注册进来                                                                                                                                                 | C    | 静态检查：`agent.*` 模块无 import `platform.*`/`resume.*`       | [x]  |
| 1.11-15 | 反向验证：否决 `@ai-sdk/react`（plan §8.6）未造成能力缺口——流式增量、工具卡片状态、批准前执行三件事在自研协议里各有承载位（`chat/delta` 事件、`parts[].state`、`requiresConfirmation`），P5 换真模型时不改界面结构 | C    | 读消息模型与 `agent.tools` 类型定义，逐条指出这三个字段确实存在 | [x]  |

**1.11 收尾结论**（证据在 `docs/acceptance/1.11/`，24 个文件：12 张 CDP 截图 + 12 份机读文本；
全程走 CDP **10222** 驱动真实窗口。助手回复是主进程里的确定性模板、工具卡片走 `/tool` 前缀的本地短路，
**零网络请求**，未触碰真实招聘平台，见 AGENTS.md §7.2）：

- **1.11-01**：冷启动首屏只有 `[data-view-scroll="chat"]` 可见（`visibleViews=["chat"]`），
  两次真实重启（`taskkill` 掉旧 dev 树 → `pnpm dev` 重新拉起主进程）都是聊天，
  不是设置页/功能目录/工作流面板。第一次落在旧会话（`ebd81d70`，8 条消息、档位 `auto`），
  第二次落在新建空会话（`b91e3ea7`，0 条）——两张都是聊天。
  **一次凑数风险如实记在这里**：首张截图截在第一次绘制之前（纯色帧，文件只有 8 KB），
  已改成「先 `harness wait --text 对话` 再截、并校验体积 >50 KB」重取（`1.11-01-11-01-cold-start-2.txt`）。
- **1.11-02**：三块各有稳定抓手——消息流 `[data-testid="chat-messages"]` + 每条
  `[data-message-id][data-message-role]`；输入区 `[data-testid="chat-input"]`（textarea）+
  `[data-action="send"]`，回车发送 / Shift+Enter 换行在 `ChatPanel.onKeyDown` 里；
  运行中指示 `[data-testid="chat-running"]` + `[data-testid="chat-streaming-message"]`
  （`1.11-02-11-02-structure-2.txt`）。验收中途补了一个 `[data-testid="chat-scroll"]`：
  真正会滚的是消息流外面那层 `overflow-y-auto`，外层 `[data-view-scroll]` 因为 section 是 `h-full`
  永不溢出——首拍读错了节点、把「不能滚」当成了缺陷，补 testid 是为了让这条路可被再次点名。
- **1.11-03**：同一条助手消息的可见字数单调递增 **720 → 828 → 930 → 1494**
  （输入 1760 字，分片 6 字 / 120ms；采样表达式与时间戳在 `1.11-03-11-03-timeline-4.txt`），
  三张连拍 `1.11-03-11-03-t{1,2,3}-*.png` 里第二张的句子停在「…验证片段」中间，
  不是整块跳出；`[data-testid="chat-streaming-message"]` 全程存在，按「停止」后为 `null`、
  部分回复照常落库。
- **1.11-04**：live 读数 `toolsListOk=true / registeredCount=0 / registeredIds=[]`
  （`1.11-04-11-04-registry.txt`）；装配上 `cordis.yml:97-98` 的 `agent` 只 `dependsOn: [ipc]`，
  注册表是纯白名单、不含业务实现。
- **1.11-05**：协议字段带行号点名（`1.11-05-11-types.txt`）——`packages/core/src/events.ts:224`
  `effect: ToolEffect`、`:225` `requiresConfirmation: boolean`、`:234` `ToolCallReply` 联合，
  `packages/agent/src/tools.ts:138` `call(toolId, rawInput, signal)` 用 zod 校验入参。
- **1.11-06**：`/tool` 前缀触发一次调用，卡片画出标题、`toolId`、参数摘要、状态、1 毫秒耗时与错误原文
  （`1.11-06-11-06-tool-card.png`，失败态 `border-rose-900`），图标是 `Wrench`（lucide）。
  **抓到一条 envelope 语义**：`agent.tools.call` 的返回是
  `{ok:true, value:{ok:false, code:'TOOL_NOT_REGISTERED', …}}`——Bridge 信封把工具结果联合包了一层，
  探针按 `greet.error.code` 读是 null，必须读 `value`。首拍因此差点误判成"没有结构化错误码"。
- **1.11-07**：三档逐个点过去，`[data-testid="chat-autonomy-current"]` 的文案跟变成
  建议模式 / 半自动 / 全自动（三张截图 `1.11-07-11-07-autonomy-{suggest,semi,auto}-*.png`），
  P1 只存档位不改行为——行为差异是 P5 的事。
- **1.11-08**：真重启后 `ebd81d70` 与它的 8 条消息、非默认档位 `auto` 都还在（DOM 侧 `domBubbles=8`），
  点「新建会话」切到 `b91e3ea7` 是 0 条；用 `node:sqlite` **只读**打开
  `%APPDATA%/auto-cc/store.db` 复核：两条 session 行、`chat_message` 只有 `ebd81d70` 挂 8 行、
  `PRAGMA user_version = 2`（`1.11-08-11-08-sqlite-2.txt`）。新建会话没有动旧会话的行数。
- **1.11-09**：`tools.call('boss.greet', …)` 返回
  `{ok:false, code:'TOOL_NOT_REGISTERED', message:'工具 boss.greet 未注册（P1 的 agent 工具面是空表）'}`
  （原始返回在 `1.11-09-11-09-outbound-unreachable.txt`）；单测同断言。P1 的对话链路调不到外发能力。
- **1.11-10**：切到 en 后 `unresolvedPlaceholders=[]`、`keyLeaks=[]`，页面上
  `heading="Chat"`、三档 `["Suggest","Semi-auto","Full-auto"]`、徽章 `Same runner: paused`
  （`1.11-10-11-10-i18n-2.txt` + `1.11-10-11-10-en-1.png`）。
  **这一条抓到一个真缺陷**：`index.html` 里的 `<html lang>` 写死 `zh-CN`，而实际语种由
  `detectLanguage()` 决定、切语言也不动它——读屏软件与翻译插件都以这个属性判断页面语种。
  已修在 `packages/renderer/src/i18n.ts`（初始化后同步 + 订阅 `languageChanged`），
  实测 `en` 下 `lang="en"`、切回 `zh-CN` 也跟着回。
- **1.11-11 / 1.11-14**：`pnpm lint` 零告警且 `✔ 渲染层规范检查通过（2 个语言包，12 个源文件）`
  （Tailwind-only / lucide-only / 裸文案 / 语言包键对齐四项都在这一条里）；
  import 审计显示 `packages/agent/src` 只引 `@auto-cc/core`、`@auto-cc/plugin-store`、
  `node:crypto`、`node:sqlite`、`zod`（逐行清单在 `1.11-11-11-c-checks.txt`）。
- **1.11-12**：live 探针 `require/process/ipcRenderer` 全 undefined、**没有万能 `invoke`**
  （`genericInvoke="undefined"`），`window.autoCC` 上 14 个命名空间里相对 1.10 只多了 `agent`/`chat`
  （`1.11-12-11-12-isolation.txt`）；主进程侧 `packages/shell/src/index.ts:169-171` 与 `:230-232`
  两处窗口创建都是 `contextIsolation:true / sandbox:true / nodeIntegration:false`，复用 1.2-04 的断言。
- **1.11-13**：流式进行中（`streamingChars=1494`）输入区照样接受 3 个字「停一下」，
  截图 `1.11-13-11-13-typing-while-running.png` 里输入框有内容、`停止` 可点、`发送` 禁用——
  界面没有因为执行而冻结。
- **1.11-15**：三件事各有承载位且都在源码里点名了：流式增量 → `chat/delta`（`events.ts:267` +
  `bridge.ts:434` 事件白名单 + `:445` 签名表，三处齐全）；工具卡片状态 → `ChatToolPart.state`
  （`events.ts:135` `'running' | 'done' | 'failed'`，`:154`）；批准前执行 → `requiresConfirmation`
  （`events.ts:225`）。P5 换真模型改的是主进程的生成函数与工具注册，界面结构不动。
- **本轮有意不修的两处**（越界，留给后续子计划决定）：① 档位三个按钮没有 `aria-pressed`，
  读数 `active: []`——选中态只靠配色传达，是无障碍缺口，但它属于「档位」这一控件本身，
  1.11 的判据只要求"可见可切换"；② 主进程来的错误原文（`TOOL_NOT_REGISTERED：工具 … 未注册`）
  在英文界面上仍是中文。它是 `agent` 侧的边界消息、不是 JSX 里的裸文案（§5.5 拦不到），
  要修得先在 core 里给错误码配 key，属于 P5 接真模型时一起做。
- **一条环境坑（会咬人，记在这里省后来的人）**：Git Bash 会把以 `/` 开头的实参当路径转换，
  `harness type --value "/tool …"` 实际送到页面的是 `D:/daiwenchi/Git/tool …`，
  于是 `startsWith('/tool')` 永不命中、卡片一张不画（`dom` 返回空数组、`wait` 超时）。
  解法是在同一条命令里 `export MSYS2_ARG_CONV_EXCL='*'`（shell 状态不跨调用，每次都得带上）。

## 1.X 里程碑门禁（P1 收口）

| ID     | 验收标准                                                                                      | 状态 |
| ------ | --------------------------------------------------------------------------------------------- | ---- |
| M1-01  | 三端安装包可安装可启动，空 React 界面可见（本机受限时明确 BLOCKED 范围）                      | [!]  |
| M2-01  | agent 能自主完成「打开 app → 截图 → 点击 → 断言 → 复述结果」闭环，过程不需人工代跑            | [x]  |
| M2b-01 | 全新机器只装 app（无 Node / 无系统 Chrome）即可运行，重启后 fixture 站点登录态仍在            | [x]  |
| P1-01  | 上述所有条目为 PASS 或有记录在案的 BLOCKED                                                    | [x]  |
| P1-02  | `docs/research/source-repos-analysis.md` 完成（P2/P3/P4 抽取决策依据到位）                    | [x]  |
| P1-03  | 无任何 P2/P3/P4 业务代码泄漏进骨架                                                            | [x]  |
| P1-04  | 计划文档中每条被否决的技术路线（Playwright/better-sqlite3/husky）都在 spec 有对应反向验证条目 | [x]  |

### P1 门禁收尾结论（2026-09-30 复核）

**状态汇总**：本 spec 的表格条目共 138 行 = **132 `[x]` + 6 `[!]` + 0 `[ ]`**，
所以 P1-01（「所有条目为 PASS 或有记录在案的 BLOCKED」）判 PASS。六条 `[!]` 按原因分三组：

| 组                  | 条目                    | 阻塞原因（都已写在行内）                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主平台缺二进制    | 1.7-09 / 1.7-10 / M1-01 | 本机 Windows：macOS 的 dmg 需要 hdiutil + codesign + Xcode 许可；Linux 的 deb 需要 `fpm`、AppImage 需要 `mksquashfs`（`linux-unpacked` 已真实产出）。M1-01 的**Windows 半边已 PASS**（1.7-03 安装版界面 + 1.7-04 无 dev server + 本轮 M2b-01 的新产物运行），只有 mac / linux 两栏记 BLOCKED |
| 沙箱网络            | 1.2-11 / 1.1-02         | `install.js` 拉 SHASUMS 在本沙箱失败，`postinstall` 的端到端自动就位待有网环境复验；1.1-02 是同一件事在 1.1 的占位行，随其一同 BLOCKED，不重复计分                                                                                                                                           |
| 原生区不可 CDP 驱动 | 1.2-08                  | 托盘图标的**鼠标点击**唤出无法自动化（CDP 只覆盖 web 内容），隐藏/唤回两条分支已由 `WM_CLOSE` 与 `window.close()` 实测，剩人工一眼确认                                                                                                                                                       |

- **M2-01 → `[x]`**：`docs/acceptance/P1-gate/M2-01-self-driven-loop.txt`。九步 harness 调用（targets → shot →
  click 工作流 → assert → shot → click 对话 → assert → eval 读数 → 退出码）全部由 agent 自己发起，
  两次断言 `isPassed:true`，读数 `{"view":true,"msgs":2,"autonomy":"建议模式","tabs":3}`，
  并对截图做了像素级复述（工作流卡片六步「待执行」、导航选中态在内核视图占位文本之上）。
- **M2b-01 → `[x]`**：`docs/acceptance/P1-gate/M2b-01-packaged-login-survival.txt`。用 **00:54 重新打包**的
  `dist/win-unpacked/auto-cc.exe`（不是 1.7 那份过期产物），以剥离 PATH（`node`/`chrome`/`npx` 均不存在）+
  隔离 `--user-data-dir` 启动，渲染层 URL 是 `file://…app.asar/renderer/index.html`；真实点击「诊断 → 打开站点」
  进 `persist:fixture` 分区写标记，CDP `Browser.close` 干净退出，同目录重启后
  `lsMarker` 与 `idbMarker` **都读回 `p1-04-2026-09-29T16:58:02.965Z`**。全程只打本地 fixture（§7.2）。
- **P1-03 → `[x]`**：`docs/acceptance/P1-gate/P1-03-no-business-leak.txt`。19 个包全是框架层、
  第三方运行时依赖只有 9 个（PDF / 知识库 / 浏览器驱动相关的一个都没有）、
  `packages/*/src` 里除 127.0.0.1 外零 URL、三源仓库标识符零命中、仓库内无 vendor 副本，
  另有 3 条单测把「调不到外发能力」钉住。
- **P1-02 → `[x]`**：取证文档已具备判据要求的四件套（`[实测]` 标记的许可表、三条由许可推导的硬约束、
  逐仓库能力内核、抽取决策映射表 + 对既有计划的修订）。原先悬空的**版权方身份确认**已由用户在
  2026-09-30 直接答复「是我本人，可自由改授」，`docs/research/source-repos-analysis.md` §1.2 据此改写为
  **许可豁免记录**：P2 允许直接移植 `browser-copilot` 的算法与 prompt。两点没有随之放松——
  AGPL 的 `pdfjs-dist` / `mupdf` 是第三方许可，版权方无权豁免；豁免本身还要落成仓库内的书面授权文件
  （补 LICENSE 或提交一份授权说明），在那之前**搬运动作不开始**。

**两条必须带走的环境事实**：

1. `pnpm dist` 本轮在**图标资源**步骤连续失败两次（`icon-tool.js` 先报 `WebAssembly.Memory(): could not
allocate memory`，再报子进程退出码 134 / EINVAL），失败点位于 `asar integrity` 之后，所以 exe 与 app.asar
   完整、只是最后一次 rcedit 的图标/版本元数据没写进去。M2b-01 验的是运行期行为，不受影响；
   但**下一次出安装包前要在内存正常的环境重跑 `pnpm dist`**，否则 1.7-11 的图标结论对新产物不成立。
2. 1.6-08 的口径要在文档里说准：**app 自己不会开 CDP**（打包态 `resolveCdpPort → null`、
   `devtools.status()` 报 `isCdpEnabled=false`、`cdpPort=null`），但**外部追加** `--remote-debugging-port`
   时 Chromium 照样监听 10222（本轮 `curl /json/version` 返回 `Chrome/152.0.7977.130`，UA 含 `auto-cc/0.1.0`）。
   这是所有 Chromium 产品的固有行为，不是闸门漏了；`packages/devtools/src/cdp-port.ts` 里那句
   「产物里就算被塞进开关也不会开出端口」的注释与事实不符，本轮已改成准确表述。

**有意留给后续计划的两处**（1.11 收尾时已记，不属于 P1 阻塞）：自治档位三个按钮缺 `aria-pressed`；
主进程错误原文（如 `TOOL_NOT_REGISTERED`）在英文界面仍是中文。

### P1-04 收尾结论（AGENTS.md §6.5 反向验证总表）

判据是「plan 里每一条**否决**都能在 spec 找到承载它的反向验证条目或已通过的实测条目」。
逐条对照 `docs/plans/01-framework/plan.md`（行号是 2026-09-30 版本）：

| 被否决的路线（plan 行）                                                | spec 承载位                                                                                                | 实测读数所在证据                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `BrowserView`（:335，Electron 44 已弃用）                              | 1.8-01 / 1.8-03 / 1.8-08 —— 视图由 `WebContentsView` 承载，能摆位、能输入、能显示分区                      | `docs/acceptance/1.8/1.8-08-*`（视图与面板同时显示 `persist:fixture`）     |
| 给内核视图注入 `preload`（:336）                                       | **1.8-12**（本轮新增）                                                                                     | `docs/acceptance/1.8/1.8-12-1x-reverse-preload.txt`                        |
| Playwright / Puppeteer 自带内核（:337）                                | **1.8-10** + 1.7-12（产物内无第二内核）                                                                    | `1.8-10-1x-reverse-playwright.txt`、`1.7-12-asar-audit.txt`                |
| 自维护 cookie 存储 `tough-cookie`（:338）                              | **1.8-11**（本轮新增）                                                                                     | `1.8-11-1x-reverse-storage.txt`（含 PID 9812 写 / PID 25336 读的同值标记） |
| `better-sqlite3`（§1.3 选型表）                                        | **1.3-12** + 1.3-06（Electron 内 `node:sqlite` 实测 WAL / `user_version`）                                 | `1.3-12-1x-reverse-sqlite.txt`、`1.3-06-node-sqlite-in-electron.txt`       |
| husky / commitlint / lint-staged 钩子（§1.1 选型表）                   | **1.1-15**                                                                                                 | `1.1-15-1x-reverse-husky.txt`（含 `core.hooksPath` 与一次真实拒绝提交）    |
| XState v5（:463）                                                      | 1.10-09（零新依赖 + 自研迁移表单测覆盖 pause/resume/retry）                                                | `1.10-09-zero-dep.txt`、`1.10-03-runner-tests.txt`                         |
| 复用 Cordis 自带任务作用域（:464，**实测否决**：rc.10 无公开 `Scope`） | 1.10-03 / 1.10-05 —— 协作式取消由 `AbortController` + `pause()` 实现，且 1.8-07 的失效续跑走同一条让出路径 | `1.10-03-runner-tests.txt`、`1.8-07-evidence.txt`                          |
| Vercel AI SDK 装包（:509，采纳其 parts 形状）                          | 1.11-15（`parts` 判别式与状态命名对齐官方 `UIMessage`，零装包）                                            | `docs/acceptance/1.11/` 内 1.11-15 读数与 `pnpm-lock.yaml` 计数 0          |
| MCP tool 定义作为 P1 协议（:510）                                      | 1.11-06 / 1.9-05 —— 副作用等级由自有必填字段承载并经 `entitlement.gate`，不依赖可被伪造的 `annotations`    | `1.9-05-outbound-vitest.txt`、`1.11-06-*`                                  |
| 纯文本消息 + 工具调用另存一条（:511）                                  | 1.11-06（一张卡片是**一条消息的一部分**：`parts[]` 内按序渲染文本段与工具段）                              | `docs/acceptance/1.11/1.11-06-*`                                           |

- **为什么这轮才算过**：门禁原文点名三条（Playwright / better-sqlite3 / husky），1.11 收口时只有 XState
  与 AI SDK 两条有专门的反向验证行；把 plan 的否决行**全量**拉出来核对后，缺的是 tough-cookie 与
  preload 注入两条 —— 它们恰好对应「持久化」和「安全边界」两条本项目最硬的约束，所以补成 1.8-11 / 1.8-12
  并各自做了实测，而不是只在文档里声明"没问题"。
- **未覆盖的诚实项**：1.8-11 只实测了 localStorage 与 IndexedDB；否决理由里提到的 **service worker**
  在本机 fixture 上没有注册位可测，因此它在 spec 里明确写作「推定收益，不作为验收依据」，没有计成 PASS。
- **顺带修掉的读数**：1.7 / 1.8 / 1.10 三条收尾结论里的证据文件计数与目录实况不符（分别写成 21/16/23，
  实为 20/21/27）。`git log --diff-filter=D` 证明三个目录从未删过文件，所以是**手数错**而不是后来变少；
  已在 P1 复核时用 `ls` 重数并逐条改正。证据计数是验收文档里最容易被当成"格式问题"而放过的错，
  但它直接决定下一个人按目录点文件时能不能对上，因此按 §7.4 的"不许留模糊项"处理。
