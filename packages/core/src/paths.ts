import { posix, win32 } from 'node:path';

export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

/**
 * Pure resolver so the three-platform data-directory requirement (spec 1.7-10)
 * is unit-testable without launching Electron on each OS.
 */
export function resolveUserDataDir(appName: string, input: PathEnv): string {
  const { platform, env, homedir } = input;
  const path = platform === 'win32' ? win32 : posix;

  switch (platform) {
    case 'win32': {
      const root = env['APPDATA'] ?? env['USERPROFILE'];
      if (!root) throw new Error('cannot resolve %APPDATA% on windows');
      return path.join(root, appName);
    }
    case 'darwin':
      return path.join(homedir, 'Library', 'Application Support', appName);
    default: {
      // XDG Base Directory spec; Electron maps this to app.getPath('userData').
      const root = env['XDG_CONFIG_HOME'] ?? path.join(homedir, '.config');
      return path.join(root, appName);
    }
  }
}

export function resolveLogDir(appName: string, input: PathEnv): string {
  const { platform, env, homedir } = input;
  const path = platform === 'win32' ? win32 : posix;

  switch (platform) {
    case 'win32': {
      const local = env['LOCALAPPDATA'];
      return local ? path.join(local, appName, 'logs') : path.join(resolveUserDataDir(appName, input), 'logs');
    }
    case 'darwin':
      return path.join(homedir, 'Library', 'Logs', appName);
    default: {
      const data = env['XDG_STATE_HOME'] ?? path.join(homedir, '.local', 'state');
      return path.join(data, appName, 'logs');
    }
  }
}
