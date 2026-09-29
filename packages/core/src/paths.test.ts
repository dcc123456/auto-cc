import { describe, expect, it } from 'vitest';
import { resolveLogDir, resolveUserDataDir, type PathEnv } from './paths.js';

const base = (over: Partial<PathEnv>): PathEnv => ({ platform: 'win32', env: {}, homedir: 'C:\\Users\\u', ...over });

describe('resolveUserDataDir', () => {
  it('windows uses %APPDATA%', () => {
    expect(resolveUserDataDir('auto-cc', base({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }))).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\auto-cc',
    );
  });

  it('windows falls back to %USERPROFILE%', () => {
    expect(resolveUserDataDir('auto-cc', base({ env: { USERPROFILE: 'C:\\Users\\u' } }))).toBe('C:\\Users\\u\\auto-cc');
  });

  it('macOS uses Library/Application Support', () => {
    expect(resolveUserDataDir('auto-cc', base({ platform: 'darwin', homedir: '/Users/u' }))).toBe(
      '/Users/u/Library/Application Support/auto-cc',
    );
  });

  it('linux uses XDG_CONFIG_HOME when set', () => {
    expect(
      resolveUserDataDir(
        'auto-cc',
        base({ platform: 'linux', env: { XDG_CONFIG_HOME: '/tmp/cfg' }, homedir: '/home/u' }),
      ),
    ).toBe('/tmp/cfg/auto-cc');
  });

  it('linux defaults to ~/.config', () => {
    expect(resolveUserDataDir('auto-cc', base({ platform: 'linux', homedir: '/home/u' }))).toBe(
      '/home/u/.config/auto-cc',
    );
  });
});

describe('resolveLogDir', () => {
  it('windows prefers LOCALAPPDATA', () => {
    expect(
      resolveLogDir('auto-cc', base({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'x' } })),
    ).toBe('C:\\Users\\u\\AppData\\Local\\auto-cc\\logs');
  });

  it('macOS uses Library/Logs', () => {
    expect(resolveLogDir('auto-cc', base({ platform: 'darwin', homedir: '/Users/u' }))).toBe(
      '/Users/u/Library/Logs/auto-cc',
    );
  });

  it('linux defaults to XDG state dir', () => {
    expect(resolveLogDir('auto-cc', base({ platform: 'linux', homedir: '/home/u' }))).toBe(
      '/home/u/.local/state/auto-cc/logs',
    );
  });
});
