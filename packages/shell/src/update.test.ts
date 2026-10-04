import { describe, expect, it, vi } from 'vitest';
import {
  armManualOnly,
  assertManualOnly,
  UpdateChannel,
  type UpdateCheckResultLike,
  type UpdateConfig,
  type UpdateRuntime,
  type UpdaterLike,
} from './update.js';

/** 一个只记录调用的更新器替身；三条开关按真实库的默认形状全是 true。 */
const fakeUpdater = (checkResult: UpdateCheckResultLike | null = null) => {
  const calls = { setFeedURL: 0, checkForUpdates: 0, downloadUpdate: 0, quitAndInstall: 0 };
  const updater: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    forceDevUpdateConfig: false,
    setFeedURL: () => {
      calls.setFeedURL += 1;
    },
    // 返回 Promise 而不写成 async：替身没有真正要 await 的东西，async 空壳会被 lint 判成谎报。
    checkForUpdates: () => {
      calls.checkForUpdates += 1;
      return Promise.resolve(checkResult);
    },
    downloadUpdate: () => {
      calls.downloadUpdate += 1;
      return Promise.resolve(['C:/tmp/update-installer.exe']);
    },
    quitAndInstall: () => {
      calls.quitAndInstall += 1;
    },
  };
  return { updater, calls };
};

/** 配置实参：`forceDevUpdateConfig` 是 schema 输出里的必填位（带 default），`feedUrl` 按用例给不给。 */
const config = (feedUrl?: string): UpdateConfig => ({ forceDevUpdateConfig: false, ...(feedUrl ? { feedUrl } : {}) });

/** 把替身包成运行期取法。 */
const runtimeOf =
  (updater: UpdaterLike, version = '0.1.0'): (() => Promise<UpdateRuntime>) =>
  () =>
    Promise.resolve({ updater, version });

const FEED = 'https://mirror.example.test/auto-cc/';

describe('更新通道的自动开飞闸门（spec 5.9-03）', () => {
  it('armManualOnly 把库默认的三条 true 全部关成 false', () => {
    const { updater } = fakeUpdater();
    armManualOnly(updater);
    expect([updater.autoDownload, updater.autoInstallOnAppQuit, updater.autoRunAppAfterInstall]).toEqual([
      false,
      false,
      false,
    ]);
    expect(() => assertManualOnly(updater)).not.toThrow();
  });

  it('assertManualOnly 只要有一条还开着就抛，并把没关掉的开关名列出来', () => {
    const { updater } = fakeUpdater();
    updater.autoDownload = false;
    expect(() => assertManualOnly(updater)).toThrow(
      /^UPDATE_AUTOPILOT_ENABLED: autoInstallOnAppQuit, autoRunAppAfterInstall$/,
    );
  });

  it('开关关不死的更新器：一次请求都不发，只落一句失败原话（防"以后有人删掉那行 arm"）', async () => {
    const { updater, calls } = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } });
    // 模拟"arm 那行被挪走"：赋值不生效，读回来还是库默认的 true。
    Object.defineProperties(updater, {
      autoDownload: { get: () => true, set: () => undefined },
      autoInstallOnAppQuit: { get: () => true, set: () => undefined },
      autoRunAppAfterInstall: { get: () => true, set: () => undefined },
    });
    const view = await new UpdateChannel(config(FEED), runtimeOf(updater)).check();
    expect(view.state).toBe('failed');
    expect(view.detail).toContain('UPDATE_AUTOPILOT_ENABLED');
    expect(calls.checkForUpdates).toBe(0);
    expect(calls.downloadUpdate).toBe(0);
  });
});

describe('更新通道的状态机（spec 5.9-03：提示 + 用户主动触发）', () => {
  it('没有配置更新源：连更新器都不取，一条请求都不发', async () => {
    const resolver = vi.fn(runtimeOf(fakeUpdater().updater));
    const view = await new UpdateChannel(config(), resolver).check();
    expect(view.state).toBe('no-feed');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('检查只在被点时发生；命中新版只报 available，不会自己开始下载', async () => {
    const { updater, calls } = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } });
    const channel = new UpdateChannel(config(FEED), runtimeOf(updater));
    expect(channel.status().state).toBe('idle');
    const view = await channel.check();
    expect(view).toMatchObject({ state: 'available', currentVersion: '0.1.0', latestVersion: '0.2.0' });
    expect(calls).toMatchObject({ setFeedURL: 1, checkForUpdates: 1, downloadUpdate: 0 });
    expect(updater.autoDownload).toBe(false);
  });

  it('dev 且未强制更新配置时库返回 null：报 unavailable-in-dev，不报成"已是最新"', async () => {
    const { updater } = fakeUpdater(null);
    const view = await new UpdateChannel(config(FEED), runtimeOf(updater)).check();
    expect(view.state).toBe('unavailable-in-dev');
    expect(view.latestVersion).toBeNull();
  });

  it('没有新版本时报 up-to-date，不把上游版本号说成可用', async () => {
    const { updater } = fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } });
    const view = await new UpdateChannel(config(FEED), runtimeOf(updater)).check();
    expect(view.state).toBe('up-to-date');
    expect(view.latestVersion).toBeNull();
  });

  it('下载与安装各要一次表态：上一态不符就拒绝，且更新器一次都没被使唤', async () => {
    const { updater, calls } = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } });
    const channel = new UpdateChannel(config(FEED), runtimeOf(updater));

    const earlyDownload = await channel.download();
    expect(earlyDownload.state).toBe('idle');
    expect(earlyDownload.detail).toContain('UPDATE_NOT_AVAILABLE');
    const earlyInstall = await channel.install();
    expect(earlyInstall.detail).toContain('UPDATE_NOT_DOWNLOADED');
    expect(calls).toMatchObject({ downloadUpdate: 0, quitAndInstall: 0 });

    await channel.check();
    const downloaded = await channel.download();
    expect(downloaded.state).toBe('downloaded');
    expect(calls.downloadUpdate).toBe(1);
    expect(calls.quitAndInstall).toBe(0);

    await channel.install();
    expect(calls.quitAndInstall).toBe(1);
    // 走完一整条链之后三条开关仍然是关着的：安装动作只能来自这一次显式调用。
    expect([updater.autoDownload, updater.autoInstallOnAppQuit, updater.autoRunAppAfterInstall]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('上游报错只落一句原话，状态是 failed 而不是抛给渲染层', async () => {
    const { updater } = fakeUpdater();
    updater.checkForUpdates = () => Promise.reject(new Error('404 Cannot find latest.yml'));
    const view = await new UpdateChannel(config(FEED), runtimeOf(updater)).check();
    expect(view.state).toBe('failed');
    expect(view.detail).toContain('404 Cannot find latest.yml');
    expect(view.currentVersion).toBe('0.1.0');
  });
});
