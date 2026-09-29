# 计划一 · 搭建主体框架 — 验收 Spec

> 实施计划：`docs/plans/01-framework/plan.md`
> 验收方式：标 **V** = agent 可视化自测（打开 app、看界面、截图取证）；标 **C** = 命令行检查；
> 标 **U** = 单元脚本。**功能项不接受仅 U 通过。**
> 状态图例：`[ ]` 未验收 · `[x]` PASS · `[!]` BLOCKED（须写阻塞原因，不得静默跳过）

---

## 证据归档规则

每条 PASS 必须在 `docs/acceptance/<ID>/` 落下至少一项证据：截图（V 类必附）、命令输出片段（C 类）、
或 DOM 快照。无证据视为未验收。

---

## 1.1 工程基线

| ID | 验收标准 | 方式 | 验证命令 / 操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.1-01 | `pnpm install` 在干净 node_modules 下一步成功，无 peer 冲突 | C | `rm -rf node_modules && pnpm i` | [ ] |
| 1.1-02 | Electron 二进制在 install 后自动就位（不需手动补救） | C | `ls node_modules/electron/dist/electron.exe`（或对应平台文件）存在 | [ ] |
| 1.1-03 | 全仓统一 ESM：任一 `packages/*` 的 package.json 含 `"type":"module"` 或由 root 继承 | C | `grep -L '"type": "module"' packages/*/package.json` 为空 | [ ] |
| 1.1-04 | `pnpm typecheck` 零错误，且 `strict:true` 生效（故意写错能报错） | C | `echo 'const x:number="a"' >> probe.ts && pnpm typecheck`（应失败），删除后通过 | [ ] |
| 1.1-05 | ESLint 对违规 import（跨包 internal）报错 | C | 造一个 `import '../x/src/internal/y'` 的临时文件，`pnpm lint` 必须 error | [ ] |
| 1.1-06 | ESLint 对直接 `from 'cordis'` 报错，必须经 `@auto-cc/core` | C | 临时文件加 `import { Context } from 'cordis'`，`pnpm lint` 必须 error | [ ] |
| 1.1-07 | `pnpm format:check` 全绿 | C | `pnpm format:check` | [ ] |
| 1.1-08 | 目录结构与 plan §2 一致（缺包须显式记录原因，不得静默少建） | C | `ls packages/` 对比清单 | [ ] |
| 1.1-09 | 提交规范可用（conventional commits 校验 hook 生效） | C | 造 `git commit -m "bad msg"` 被拒 | [ ] |
| 1.1-10 | `@auto-cc/core` 复导出 Context/Service/Plugin/definePlugin 且类型可用 | C | `packages/core` 的 dts 生成 + 消费方 typecheck | [ ] |

## 1.2 Electron 壳

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.2-01 | `pnpm dev` 启动后**窗口真实出现**，显示 React 首屏（非白屏） | V | 截图，界面含可见标题文字与一个可交互元素 | [ ] |
| 1.2-02 | React 是真实挂载（非静态 HTML）：组件 state 变化能在界面上看到 | V | 点击计数器按钮，截图前后值变化 | [ ] |
| 1.2-03 | HMR 生效：改 renderer 源码后窗口自动更新，无需重启 | V | 改文案 → 截图确认新文案 | [ ] |
| 1.2-04 | `contextIsolation:true` + `sandbox:true` + `nodeIntegration:false` 实际生效 | V/C | 在渲染层执行 `typeof require` 必须 `undefined`；`window.autoCC` 存在且方法数 = 白名单数 | [ ] |
| 1.2-05 | 渲染层调用未在白名单中的 service 被拒绝并给出可读错误 | V | 界面点「非法调用」按钮，看到拒绝提示而非崩溃 | [ ] |
| 1.2-06 | 主进程崩溃/抛错不导致窗口静默死掉，有可见错误态 | V | 注入一个抛错插件，界面显示失败态 | [ ] |
| 1.2-07 | 单实例锁：第二次启动聚焦已有窗口而非开双窗 | V | 启动两次，截图确认仍只有一个窗口 | [ ] |
| 1.2-08 | 关闭主窗口不退出应用（收进托盘），托盘可再唤出 | V | 关窗 → 托盘图标 → 点回 → 截图 | [ ] |
| 1.2-09 | 外链与 `window.open` 被默认拒绝（安全底线） | C | `setWindowOpenHandler` 返回 deny 且日志有记录 | [ ] |
| 1.2-10 | `pnpm build` 产出可加载的 dist 资源，无 Vite 报错 | C | `pnpm build` exit 0 | [ ] |

## 1.3 L0 内核插件（config / logger / store / kernel）

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.3-01 | `cordis.yml` 是插件装配的唯一入口，改它即改启用的插件集 | V | 从 yml 注掉一个插件 → 重启 → 界面插件树里确实不在 | [ ] |
| 1.3-02 | `config` service 提供分层合并（默认 < 文件 < 环境变量 < 运行时覆盖） | U+C | 三层同名 key 覆盖顺序可断言 | [ ] |
| 1.3-03 | 非法配置在**挂载期**失败并指出具体字段，而非运行时空指针 | V | 写坏一个字段 → 界面显示校验错误 + 字段路径 | [ ] |
| 1.3-04 | `logger` 提供结构化日志、级别过滤、环形缓冲（内存内可取最近 N 条） | C | 取 buffer 断言条数与级别 | [ ] |
| 1.3-05 | 日志同时落盘到用户数据目录，文件按平台落在规范位置 | V | 界面日志页能看到实时滚动的日志行；磁盘上文件存在 | [ ] |
| 1.3-06 | `store.db` 暴露统一 DB 句柄，SQLite 驱动选型有实测结论（node:sqlite 或 better-sqlite3） | C | 记录驱动名与版本号；主进程日志无 native 加载错误 | [ ] |
| 1.3-07 | migration 机制：新增一条 migration 后旧库自动升级到新版本，版本号可查 | C | 建 v0 库 → 升 v1 → `PRAGMA user_version` 断言 | [ ] |
| 1.3-08 | 重复启动不开第二个 DB 连接；退出时连接被 effect 回收 | C | 断言关闭钩子被调用 / WAL 文件正常收敛 | [ ] |
| 1.3-09 | 任一 L0 service 未挂载时，依赖它的插件进入 PENDING 而非崩溃 | V | 注掉 `store` → 依赖插件显示 waiting 状态 | [ ] |
| 1.3-10 | 插件挂载失败不阻塞其他插件启动（错误隔离） | V | 故意让一个插件抛错 → 其余插件正常 ACTIVE | [ ] |

## 1.4 IPC 网关

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.4-01 | 渲染层通过**类型化 client** 调用主进程 service 方法并拿到返回值 | V | 界面点按钮 → 显示 `system.status()` 的平台/Electron/Node 版本 | [ ] |
| 1.4-02 | 只有 `cordis:call` 与 `cordis:event` 两个通道，无插件私自注册 ipc | C | `grep -rn "ipcMain.handle" packages/ --include=*.ts` 仅出现在 plugin-ipc | [ ] |
| 1.4-03 | 主进程事件能流到渲染层并驱动界面更新（推，不是轮询） | V | 触发一次日志写入 → 界面日志条数**无刷新**自增 | [ ] |
| 1.4-04 | 调用不存在的 service/方法返回结构化错误（含 path 与原因） | V/C | 断言错误对象 shape，界面显示可读文案 | [ ] |
| 1.4-05 | 不可序列化的返回值被明确拒绝，而非静默丢字段 | C | 返回含函数值的 service，得到可诊断错误 | [ ] |
| 1.4-06 | 并发调用不错乱（含同一 service 的并发写） | C | 20 个并发 call，结果一一对应 | [ ] |
| 1.4-07 | IPC 白名单外 service 无法被渲染层访问（含直接 `ipcRenderer` 尝试） | V | 界面/CDP 注入尝试 `logger` 私有方法被拒 | [ ] |

## 1.5 插件运行时管理 + 调试面板

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.5-01 | 调试面板显示完整插件树（名称/层级/状态/依赖），与实际 registry 一致 | V | 截图对比 `ctx.registry.size` | [ ] |
| 1.5-02 | 单个插件可从界面 Stop → 变 DISPOSED，其 effect 清理被执行 | V | 停掉带定时器的插件，日志确认 dispose 且定时器停止 | [ ] |
| 1.5-03 | Stop 后可 Start 回来，service 重新可调用（热插拔闭环） | V | 界面操作前后各调一次同一方法，均成功 | [ ] |
| 1.5-04 | 卸载提供方时，依赖方自动降级为 PENDING 并在其恢复后自动重建 | V | 停 store → 观察上层状态随之变化 → 恢复 → 上层自动 ACTIVE | [ ] |
| 1.5-05 | 插件抛错只显示为该插件 FAILED，主进程与其他插件继续工作 | V | 触发错误插件 → 面板红色态 + app 仍可点 | [ ] |
| 1.5-06 | 面板能查看任一插件的配置并保存，新配置即时生效（不重启 app） | V | 改日志级别 → 立刻反映到日志输出 | [ ] |
| 1.5-07 | Error 计数/最近错误列表在面板可见，可复现（点击展开栈） | V | 截图错误详情展开 | [ ] |
| 1.5-08 | 反复启停 20 次不泄漏（registry/监听器数量回归基线） | C+V | 循环启停后断言 `registry.size` 与 listener 数回原值 | [ ] |

## 1.6 可视化自测通道（agent 自测能力）

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.6-01 | dev 模式自动开启 CDP 端口，`/json` 能列出 app 的 page target | C | `curl 127.0.0.1:9222/json` 含本项目 title | [ ] |
| 1.6-02 | agent 能通过 harness 打开 app 并**看到页面**（截图回传为图） | V | harness 截图 → agent 读图并描述界面内容 | [ ] |
| 1.6-03 | agent 能读到真实渲染后的 DOM 快照（含 React 挂载后的节点） | V | 断言存在某动态 id 文本 | [ ] |
| 1.6-04 | agent 能真实点击与输入（派发原生事件，非只改 state） | V | 点击后界面变化被再次截图确认 | [ ] |
| 1.6-05 | agent 能在页面上下文执行 JS 断言并取回结果 | V | 求值 `document.title` / store 状态 | [ ] |
| 1.6-06 | harness 能同时读到主进程侧状态（fiber 树、日志尾部）与界面状态，两者一致 | V | 同一时刻对照 registry 与面板显示 | [ ] |
| 1.6-07 | 存在一条稳定脚本入口 `pnpm harness <action>`，agent 无需手搓 CDP 即可复用 | C | `pnpm harness shot` 出图 | [ ] |
| 1.6-08 | 生产模式（打包后）**不**开启 CDP，dev harness 不进入产物 | C | 检查 builder files 排除 devtools 插件；打包产物内 grep 无 9222 | [ ] |
| 1.6-09 | 视觉回归基线：同一场景两张截图可比对，差异可量化报告 | V | 故意改样式 → diff 报告标记出差异区域 | [ ] |
| 1.6-10 | 验收证据可自动归档到 `docs/acceptance/<spec-id>/` | C | 跑一次归档命令，目录内出现截图+日志 | [ ] |

## 1.7 三端打包与安装

| ID | 验收标准 | 方式 | 验证操作 | 状态 |
| --- | --- | --- | --- | --- |
| 1.7-01 | `electron-builder` 配置声明 win / mac / linux 三端目标，无占位 TODO | C | 审阅配置；`--publish never` 干跑不报 schema 错 | [ ] |
| 1.7-02 | Windows 产物真实产出（nsis `.exe`），文件体积与目录结构合理 | C | `dist/*.exe` 存在 | [ ] |
| 1.7-03 | Windows 安装包**静默安装成功并启动出界面** | V | 安装后启动 → harness 截图确认界面 | [ ] |
| 1.7-04 | 安装后的 app 不再依赖 dev server（资源来自包内） | V | 关闭 vite 后仍能看到界面 | [ ] |
| 1.7-05 | 打包版 IPC/service 调用可用（不只是空壳） | V | 打包版点按钮拿到 `system.status`，显示版本号非 dev 值 | [ ] |
| 1.7-06 | 打包版插件挂载与 dev 一致（同一 cordis.yml 生效） | V | 打包版打开调试面板，插件树与 dev 相同 | [ ] |
| 1.7-07 | macOS `dmg` 目标可构建（arm64+x64）；本机不可构建时标记 BLOCKED 并写清缺什么 | C | `pnpm dist:mac` 结果或阻塞记录 | [ ] |
| 1.7-08 | Linux `AppImage` + `deb` 目标可构建；不可构建时同上标记 BLOCKED | C | `pnpm dist:linux` 结果或阻塞记录 | [ ] |
| 1.7-09 | 版本号 / 产物命名 / 图标（三端）齐备，无默认 Electron 图标 | V | 截图安装包属性与界面标题栏图标 | [ ] |
| 1.7-10 | 三端各自的**用户数据目录**使用平台规范路径（win `%APPDATA%`、mac `~/Library/Application Support`、linux `~/.config`） | C | 单测断言路径解析函数在三平台 mock 下的输出 | [ ] |

## 1.X 里程碑门禁（P1 收口）

| ID | 验收标准 | 状态 |
| --- | --- | --- |
| M1-01 | 三端安装包可安装可启动，空 React 界面可见（本机受限时明确 BLOCKED 范围） | [ ] |
| M2-01 | agent 能自主完成「打开 app → 截图 → 点击 → 断言 → 复述结果」闭环，且过程不需要人工代跑 | [ ] |
| P1-01 | 上述所有条目为 PASS 或有记录在案的 BLOCKED | [ ] |
| P1-02 | `docs/research/source-repos-analysis.md` 完成（P2/P3/P4 抽取决策依据到位） | [ ] |
| P1-03 | 无任何 P2/P3/P4 业务代码泄漏进骨架 | [ ] |
