/**
 * 插件 id → 实现类（spec 1.3-01）。
 *
 * `cordis.yml` 只写 id、顺序与配置，不写模块路径：主进程被 esbuild 打成单文件，
 * `import(变量)` 在运行时拿不到路径。因此清单负责「装哪些」，这里负责「用哪个类装」。
 * 新增插件时同时改两处——清单漏了它就不装，注册表漏了它在插件树里显示 failed。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { IpcGatewayService } from '@auto-cc/plugin-ipc';
import type { Registry } from '@auto-cc/plugin-kernel';
import { LogService } from '@auto-cc/plugin-logger';
import { PluginsService } from '@auto-cc/plugin-plugins';
import { StoreService } from '@auto-cc/plugin-store';
import { ShellService } from '@auto-cc/shell';

export const REGISTRY: Registry = {
  config: ConfigService,
  logger: LogService,
  store: StoreService,
  ipc: IpcGatewayService,
  plugins: PluginsService,
  shell: ShellService,
};
