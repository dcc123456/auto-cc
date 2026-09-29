/**
 * Electron 主进程入口：薄壳。
 *
 * 只做三件事——定应用名、单实例锁、挂载内核。装哪些插件、以什么顺序、带什么配置，全部由仓库根的
 * `cordis.yml` 决定（spec 1.3-01）；这里出现的不该再有具体业务服务，否则清单就不是唯一入口了。
 */
import path from 'node:path';
import { app } from 'electron';
import { Context } from '@auto-cc/core';
import { KernelService } from '@auto-cc/plugin-kernel';
import { REGISTRY } from './registry.js';

// 应用名决定平台规范目录的落点（Windows 上即 `%APPDATA%\auto-cc`）。必须排在单实例锁与任何
// `getPath()` 之前：默认名是 "Electron"，晚了数据就会散在 `%APPDATA%\Electron\` 里
// （spec 1.3 遗留第 1 条，1.5 收口）。
app.name = 'auto-cc';

// 必须在 app ready 之前判定：拿不到锁说明已有实例，直接退出。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void mount();
}

/** 清单所在目录：开发态从 `dist/main.cjs` 上溯到仓库根，打包态是 electron-builder 的 resources。 */
function manifestRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..');
}

async function mount() {
  const ctx = new Context();
  // zod 的 `.default()` 会出现在 Config 的输出类型里，因此这些键在调用点上必须显式给出。
  await ctx.plugin(KernelService, {
    manifest: 'cordis.yml',
    rootDir: manifestRoot(),
    runtime: { store: { dir: app.getPath('userData') } },
    registry: REGISTRY,
  });
}
