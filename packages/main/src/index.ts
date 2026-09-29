/**
 * Electron 主进程入口：薄壳。
 *
 * 只做三件事——单实例锁、创建 cordis 上下文、挂载 L1 壳服务。
 * 窗口/托盘/桥接都在 `@auto-cc/shell`，招聘业务更不允许出现在这里（P1 plan §2 目录纪律）。
 */
import { app } from 'electron';
import { Context } from '@auto-cc/core';
import { ShellService } from '@auto-cc/shell';

// 必须在 app ready 之前判定：拿不到锁说明已有实例，直接退出。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void mount();
}

async function mount() {
  const ctx = new Context();
  await ctx.plugin(ShellService);
}
