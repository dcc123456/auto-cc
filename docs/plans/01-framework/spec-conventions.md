# auto-cc 项目规范（全文）

> 主文档 `docs/00-master-plan.md` §7 的展开。规范条目都是**可机检**的：能用 lint / hook / 脚本判定的，
> 不写进「约定」而写进工具。工具管不到的才留作文档。

## 1. 提交规范

```
<type>(<scope>): <subject>            # subject ≤ 120 字符
```

- `type` ∈ `feat fix chore docs refactor test perf build ci style`
- `scope` 可选，kebab-case，取包名或区域名：`ipc` `kernel` `renderer` `store` `packaging` …
- `!` 表示破坏性变更：`feat(ipc)!: allowlist is now mandatory`
- Merge / Revert / fixup! / amend! 自动放行。
- 由 `.githooks/commit-msg` 强制（`git config core.hooksPath .githooks` 安装）。
  **不用 commitlint/husky**：本机 npm/pnpm 策略会拦截 install 脚本，依赖 postinstall 的工具链不可靠。
- 一个子计划一段原子提交串；每完成一条 spec 验收标准，允许一次 `docs(acceptance)` 提交落证据。

## 2. 代码规范

| 条目 | 规则 | 强制方式 |
| --- | --- | --- |
| 模块系统 | 全仓 ESM，`"type": "module"` | `package.json` |
| 类型 | TS `strict`，禁 `any` 外溢，禁非空断言（`!`）绕过 | tsc + lint |
| 导入 | `import type` 用于纯类型引用 | `consistent-type-imports` |
| 格式化 | Prettier，120 列，单引号，尾逗号，LF | `format:check` |
| 注释 | 默认不写；只写「为什么」。站点选择器、频控阈值、风控判据的**来源**必须注释 | code review |
| 魔法数 | 平台适配参数（等待时长、重试次数、字号）必须来自 `config`，不得内联 | code review |
| 错误 | 跨进程边界只传 `AppErrorPayload` 纯数据，不传 Error 实例 | 类型 + lint |

## 3. Cordis 插件规范

1. **一插件一包**，`packages/<name>/src/index.ts` 用 `definePlugin` 导出默认插件。
2. `name` 与包名一致（去掉 `@auto-cc/plugin-` 前缀）。
3. service 命名 `域.能力`；事件命名 `域.动作`，全部小写点分（`jd.store`、`plugin.state.changed`）。
4. 必须显式声明 `inject`；未声明的 service 取不到（cordis 默认隔离，已实测）。
5. 需要被兄弟/上层 inject 的 service，插件必须声明 `provide`。
6. 资源分配（DB 句柄、浏览器实例、定时器、子进程、文件 watcher）**只能**在 `ctx.effect` 中做。
   手写 cleanup 钩子视为缺陷。
7. 插件不得 `process.exit`、不得直接 `ipcMain.handle`、不得 `import 'cordis'`（一律经 `@auto-cc/core`）。
8. 配置用 standard-schema（zod）声明在 `Config`，让挂载期就失败，而不是运行时空值。

## 4. 包边界

```
allowed:  plugin(L_n)  ──inject──►  plugin(L_<n)      仅向下
          any          ──import──►  @auto-cc/core, @auto-cc/shared, 自己包内
banned:   同层互相 inject
          跨包 import '**/src/internal/**'
          直接 import 'cordis'（core 除外）
          renderer import main-only 依赖（electron 主进程 API、sqlite driver）
```

前两条由 `no-restricted-imports` 强制；第三条由 core 覆盖层强制。

## 5. 测试规范

- 功能验收 = agent 可视化自测（打开 app、截图、真实点击、断言），证据进 `docs/acceptance/<ID>/`。
- 单测只覆盖纯逻辑（路径解析、schema、migration、选择器解析、分页度量）。
- 禁止「脚本绿了就宣称做完」。每条 V 类标准必须有界面截图支撑。
- 测试不得访问真实招聘平台；P2 起使用本地 fixture 页面。
- 涉及外发的用例一律走 mock adapter。

## 6. 文档与 spec

- 计划：`docs/plans/<NN>-<name>/plan.md`；验收：`docs/specs/<NN>-<name>/spec.md`。
- spec 条目 ID 一经发布不得复用或改义；作废用 `[~]` 并注明原因。
- BLOCKED 必须写「缺什么、谁能补、何时复查」，不允许静默跳过。

## 7. 目录与命名

- kebab-case 文件名；组件文件 PascalCase 仅当默认导出是该组件。
- `packages/` 新增包必须同时出现在 `docs/00-master-plan.md` 结构图与本文件检查清单里。

## 8. 安全底线（不可协商）

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，`webSecurity` 不得关闭。
- 渲染层只能经 `cordis:call` / `cordis:event` 两个通道访问主进程，且 service 需在 shared 白名单声明。
- 外链 `setWindowOpenHandler` 默认 deny；`will-navigate` 默认拒绝。
- 凭证（LLM key、账号态）存本地用户数据目录，不进仓库、不进日志。
- 不做验证码绕过、不做指纹伪装、不做多账号池（master plan §8）。
