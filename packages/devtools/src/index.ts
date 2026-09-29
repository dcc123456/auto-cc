/**
 * `devtools` 服务（spec 1.6）：可视自测通道在主进程侧的**只读**对照面。
 *
 * harness 通过 CDP 看到的是「页面自己声称的状态」，这里给出的是「主进程知道的真实状态」：
 * CDP 是否真的开着、Electron 手里到底有几个 WebContents（主窗口 + 内嵌内核视图）。
 * 两边对得上，才允许把截图当作验收证据（1.6-06）。
 *
 * 本服务刻意只有读的方法——导航、注入、点击全部由 harness 经 CDP 完成，主进程不参与，
 * 否则自测通道会变成第二条跨进程入口，绕过 1.4 的白名单设计。
 */
import { app, BrowserWindow, webContents } from 'electron';
import { Service, type Context } from '@auto-cc/core';
import type { DevtoolsStatusView, DevtoolsTargetView } from '@auto-cc/shared';
import { z } from 'zod';
import { resolveCdpPort } from './cdp-port.js';

/** 暂无可选项；strict 让 cordis.yml 里写错的键在挂载期就报错。 */
export const devtoolsSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type DevtoolsConfig = z.infer<typeof devtoolsSchema>;

export class DevtoolsService extends Service {
  static provide = 'devtools';
  static Config = devtoolsSchema;

  constructor(ctx: Context, _options: DevtoolsConfig) {
    super(ctx, 'devtools');
    // 无配置项，但必须接住第二个实参：cordis 挂载时传的是校验后的配置对象，
    // 只声明一个参数会让带配置的调用点在类型检查时报 TS2345。
  }

  /**
   * 自测通道读数：打包标记、生效的 CDP 端口、主进程侧看到的页面目标清单。
   * @returns 供渲染层面板与 harness 交叉核对的快照
   */
  status = (): DevtoolsStatusView => {
    const cdpPort = resolveCdpPort(app.commandLine.getSwitchValue('remote-debugging-port'), app.isPackaged);
    const mainWindowIds = new Set(BrowserWindow.getAllWindows().map((win) => win.webContents.id));
    const targets: DevtoolsTargetView[] = webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .map((contents) => ({
        id: contents.id,
        title: contents.getTitle(),
        url: contents.getURL(),
        isMainWindow: mainWindowIds.has(contents.id),
        isFocused: contents.isFocused(),
      }))
      .sort((left, right) => Number(right.isMainWindow) - Number(left.isMainWindow) || left.id - right.id);
    return {
      isPackaged: app.isPackaged,
      isCdpEnabled: cdpPort !== null,
      cdpPort,
      targetCount: targets.length,
      targets,
    };
  };

  [Service.init](): void {
    const readout = this.status();
    this.ctx.logger.info(
      `自测通道读数就绪：CDP ${String(readout.cdpPort ?? '未开启')} · 页面目标 ${String(readout.targetCount)} 个 · 打包态 ${String(readout.isPackaged)}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    devtools: DevtoolsService;
  }
}

export { resolveCdpPort } from './cdp-port.js';
