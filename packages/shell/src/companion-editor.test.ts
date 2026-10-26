/**
 * 伴生应用跳转的判定用例（spec 3.15-01 / 02 / 03 / 04，plan `03-resume-pdf` §21）。
 *
 * 单测不拉真进程（§7.2 那条同源的道理：CI 与开发机上都没有装好的伴生应用），
 * 所以这里钉的是**契约的形状**：argv 怎么拼、CLI 的四种回话各归哪个原因码、
 * 以及子进程那一层的三条边界（不经 shell、超时要有结局、同步抛错也要有结局）。
 * 真跳那一条是 V 类判据，见 spec 3.15-05。
 */
import type { ChildProcessByStdio, spawn as spawnType } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  COMPANION_EDITOR_DEFAULT_BIN,
  COMPANION_EDITOR_TIMEOUT_MS,
  interpretCompanionReply,
  launchCompanion,
  planCompanionOpen,
  resolveCompanionCommand,
  type CompanionRawReply,
} from './companion-editor.js';

/** 假子进程：只暴露被测代码真会碰的那四样（stdout、error/close 事件、kill）。 */
interface FakeChild {
  proc: ChildProcessByStdio<null, PassThrough, null>;
  /** 直接往 stdout 写：`--json` 的回执就是从这里进来的。 */
  write(text: string): void;
  emitError(code: string): void;
  emitClose(code: number | null): void;
  isKilled(): boolean;
}

/**
 * 造一台假子进程。
 * @returns 交给 `launchCompanion` 的 spawn 替身所需的最小形状
 */
function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  let isKilled = false;
  Object.assign(emitter, { stdout, kill: () => (isKilled = true) });
  return {
    proc: emitter as unknown as ChildProcessByStdio<null, PassThrough, null>,
    write: (text) => void stdout.write(text),
    emitError: (code) => emitter.emit('error', Object.assign(new Error(code), { code })),
    emitClose: (code) => emitter.emit('close', code),
    isKilled: () => isKilled,
  };
}

/** 一次拉起收下的 spawn 实参，用来验 argv 形状与 stdio 配置。 */
interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * 用假 spawn 跑一趟拉起。
 * @param act 起跑之后对那台假子进程做的事（不做事就是在验超时）
 * @param options `throws` 让 spawn 当场抛（模拟同步失败），`timeoutMs` 缩短等待免测试变慢
 * @returns 判读结果，以及 spawn 收到的那三个实参
 */
async function launchWith(
  act: (child: FakeChild) => void = () => {},
  options: { throws?: Error; timeoutMs?: number } = {},
): Promise<{ reply: Awaited<ReturnType<typeof launchCompanion>>; call: SpawnCall }> {
  const child = fakeChild();
  const call: Partial<SpawnCall> = {};
  // `act` 必须排在 await **之前**：这台假进程不会自己发事件，用例不喂读数就永远等不到收尾。
  const promise = launchCompanion('officecc', ['--json', 'open', '/tmp/resume.pdf'], options.timeoutMs ?? 20, ((
    command: string,
    args: string[],
    spawnOptions: Record<string, unknown>,
  ) => {
    call.command = command;
    call.args = args;
    call.options = spawnOptions;
    if (options.throws) throw options.throws;
    return child.proc;
  }) as unknown as typeof spawnType);
  act(child);
  return { reply: await promise, call: call as SpawnCall };
}

describe('伴生 CLI 的候选路径', () => {
  it('配了带目录的路径就照它，不再回头查 PATH', () => {
    const probed: string[] = [];
    const found = resolveCompanionCommand(
      '/tmp/officecc',
      { PATH: '/usr/bin', HOME: '/tmp' },
      'darwin',
      (candidate) => {
        probed.push(candidate);
        return true;
      },
    );
    expect(found).toBe('/tmp/officecc');
    expect(probed).toEqual(['/tmp/officecc']);
  });

  it('裸命令名按 PATH 找，PATH 里没有再补 `~/.local/bin`（打包态从 Dock 起来时 PATH 不含它）', () => {
    const env = { PATH: '/usr/bin', HOME: '/Users/tester' };
    expect(resolveCompanionCommand('officecc', env, 'darwin', (c) => c === '/usr/bin/officecc')).toBe(
      '/usr/bin/officecc',
    );
    expect(resolveCompanionCommand('officecc', env, 'darwin', (c) => c === '/Users/tester/.local/bin/officecc')).toBe(
      '/Users/tester/.local/bin/officecc',
    );
  });

  it('处处都找不到时把裸命令名交回系统认最后一次：ENOENT 会被接成 MISSING，两头说法一致', () => {
    expect(resolveCompanionCommand('officecc', { PATH: '', HOME: '' }, 'darwin', () => false)).toBe('officecc');
    // 空配置是"配坏了"，不是"让系统猜"，所以这里判不出来。
    expect(resolveCompanionCommand('   ', { PATH: '/usr/bin' }, 'darwin', () => true)).toBeUndefined();
  });

  it('Windows 只认 `.exe`，且 PATH 键按大小写不敏感取（那里写的是 `Path`）', () => {
    const env = { Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\tester' };
    expect(resolveCompanionCommand('officecc', env, 'win32', (c) => c === 'C:\\bin\\officecc.exe')).toBe(
      'C:\\bin\\officecc.exe',
    );
    // `.cmd` 不放行：Node 44 不带 shell 时它起不来（plan §21.5 第 4 条登记的缺口，本机无法实测）。
    // 这里落回裸名是设计如此——让系统按自己的 PATH 认最后一次，起不来时以 ENOENT 说话，两句是同一个 MISSING。
    expect(resolveCompanionCommand('officecc', env, 'win32', (c) => c === 'C:\\bin\\officecc.cmd')).toBe('officecc');
  });
});

describe('argv 构造（spec 3.15-02）', () => {
  it('绝对路径 + 正整数页号 → `--json open <绝对路径> --page n`', () => {
    expect(planCompanionOpen('/tmp/resume.pdf', 3)).toEqual({
      isAccepted: true,
      filePath: '/tmp/resume.pdf',
      args: ['--json', 'open', '/tmp/resume.pdf', '--page', '3'],
    });
  });

  it('页号缺失或非法时整支省略 `--page`：它只是"帮我翻到那一页"，不值得为它失败一次跳转', () => {
    for (const page of [undefined, 0, -2, 1.5, Number.NaN, '3']) {
      const plan = planCompanionOpen('/tmp/resume.pdf', page);
      expect(plan.isAccepted).toBe(true);
      if (plan.isAccepted) expect(plan.args).toEqual(['--json', 'open', '/tmp/resume.pdf']);
    }
  });

  it('只收绝对路径与 `.pdf`；在不在磁盘上不判（CLI 的 `file_not_found` 才是那一份事实）', () => {
    for (const filePath of ['', '   ', 'resume.pdf', '/tmp/resume.docx', '/tmp/no-extension', 42, null]) {
      expect(planCompanionOpen(filePath, 1)).toMatchObject({ isAccepted: false, code: 'INVALID_ARGUMENT' });
    }
    expect(planCompanionOpen(`${tmpdir()}/absent-file.PDF`, 1).isAccepted).toBe(true);
  });
});

describe('CLI 回话到原因码的分流（spec 3.15-03）', () => {
  /** 组一份原始读数：用例只写自己在意的那几项。 */
  const raw = (over: Partial<CompanionRawReply>): CompanionRawReply => ({
    stdout: '',
    exitCode: 0,
    isTimedOut: false,
    ...over,
  });

  it('只有「status 是 ok 且进程 0 退出」算成功', () => {
    expect(interpretCompanionReply(raw({ stdout: '{"status":"ok","command":"open"}' }))).toEqual({ isAccepted: true });
  });

  it('结构化拒绝 → REJECTED，并把 CLI 的 reason 留在 details 里作诊断', () => {
    const reply = interpretCompanionReply(
      raw({
        exitCode: 4,
        stdout: '{"status":"error","error":"outside_allowed_roots","message":"refused","suggestion":"set roots"}',
      }),
    );
    expect(reply).toMatchObject({ isAccepted: false, code: 'COMPANION_EDITOR_REJECTED' });
    if (!reply.isAccepted)
      expect(reply.details).toMatchObject({
        cliReason: 'outside_allowed_roots',
        cliSuggestion: 'set roots',
        exitCode: 4,
      });
  });

  it('三种失败分得出：等不到 / 本机没装 / 它按自己的 reason 拒了', () => {
    expect(interpretCompanionReply(raw({ isTimedOut: true, exitCode: null }))).toMatchObject({
      code: 'COMPANION_EDITOR_TIMEOUT',
    });
    expect(interpretCompanionReply(raw({ spawnErrorCode: 'ENOENT', exitCode: null }))).toMatchObject({
      code: 'COMPANION_EDITOR_MISSING',
    });
    // 这一条用的是本机 `officecc 0.11.0 --json open /tmp/does-not-exist.pdf` 的原样回话
    //（读数见 `docs/acceptance/03-resume-pdf/3.15-companion-editor-readings.txt`），不是照文档猜的形状。
    expect(
      interpretCompanionReply(
        raw({
          exitCode: 2,
          stdout:
            '{"status":"error","command":"open","code":2,"error":"file_not_found","message":"file not found: /tmp/does-not-exist.pdf"}',
        }),
      ),
    ).toMatchObject({ code: 'COMPANION_EDITOR_REJECTED' });
  });

  it('负对照：stdout 不是合法 JSON（或是 JSON 但不是对象）时不许当成功', () => {
    for (const stdout of ['', 'opened ok', '{oops', '123', '[{"status":"ok"}]', 'null']) {
      expect(interpretCompanionReply(raw({ stdout }))).toMatchObject({ code: 'COMPANION_EDITOR_FAILED' });
    }
  });

  it('`partial` 与非零退出都不是这一口的成功：跳转要么把人送到，要么说清楚没送到', () => {
    expect(interpretCompanionReply(raw({ stdout: '{"status":"partial"}' }))).toMatchObject({
      code: 'COMPANION_EDITOR_FAILED',
    });
    expect(interpretCompanionReply(raw({ exitCode: 1, stdout: '{"status":"ok"}' }))).toMatchObject({
      code: 'COMPANION_EDITOR_FAILED',
    });
  });

  it('stdout 越过读取上限时那一枚 JSON 必然残缺，按失败处理（不猜）', () => {
    expect(interpretCompanionReply(raw({ isStdoutOverflowed: true, stdout: '{"status":"ok"' }))).toMatchObject({
      code: 'COMPANION_EDITOR_FAILED',
    });
  });
});

describe('子进程那一层的边界（spec 3.15-04）', () => {
  it('argv 是数组、stdio 只有 stdout：不经 shell，所以路径里什么都不可能被拼成命令', async () => {
    const { reply, call } = await launchWith((child) => {
      child.write('{"status":"ok"}');
      child.emitClose(0);
    });
    expect(call.command).toBe('officecc');
    expect(call.args).toEqual(['--json', 'open', '/tmp/resume.pdf']);
    // 这里出现 `shell: true` 就等于把一条来自渲染层的字符串交给 shell 解释——判据钉住它不存在。
    expect(call.options).toEqual({ stdio: ['ignore', 'pipe', 'ignore'] });
    expect(reply).toEqual({ isAccepted: true });
  });

  it('一声不响的那一趟以超时收场，并且把它杀掉（不留孤儿进程冒充在跑）', async () => {
    const { reply } = await launchWith(() => {}, { timeoutMs: 30 });
    expect(reply).toMatchObject({ code: 'COMPANION_EDITOR_TIMEOUT' });
  });

  it('ENOENT 事件 = 本机没装那条命令', async () => {
    const { reply } = await launchWith((child) => child.emitError('ENOENT'));
    expect(reply).toMatchObject({ code: 'COMPANION_EDITOR_MISSING' });
  });

  it('spawn 当场抛（Windows 那条 `.cmd` 就是这一类）也必须有个结局，界面不许停在在途态', async () => {
    const { reply } = await launchWith(() => {}, {
      throws: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }),
    });
    expect(reply).toMatchObject({ code: 'COMPANION_EDITOR_FAILED' });
    if (!reply.isAccepted) expect(reply.details).toMatchObject({ spawnErrorCode: 'EINVAL' });
  });

  it('stdout 越过读取上限即被掐断并判失败：残缺的那枚 JSON 不许猜', async () => {
    let overflowed: FakeChild | undefined;
    const { reply } = await launchWith(
      (child) => {
        overflowed = child;
        child.write(`{"status":"ok","detail":"${'x'.repeat(64 * 1024)}`);
      },
      { timeoutMs: 20_000 },
    );
    expect(reply).toMatchObject({ code: 'COMPANION_EDITOR_FAILED' });
    expect(overflowed?.isKilled()).toBe(true);
  });
});

describe('默认配置下的候选（零配置那条路，spec 3.15-01）', () => {
  it('不配任何东西时，本机装了伴生 CLI 就必须能由默认路径跳出去', () => {
    // 装机版从 Dock 起来时拿到的是瘦 PATH，所以缺省探测必须覆盖到 CLI 常装的那几处。
    const found = resolveCompanionCommand(
      COMPANION_EDITOR_DEFAULT_BIN,
      { PATH: '/usr/bin', HOME: process.env.HOME ?? '' },
      process.platform,
      existsSync,
    );
    expect(typeof found).toBe('string');
    if (typeof found === 'string') expect(found).toContain(COMPANION_EDITOR_DEFAULT_BIN);
  });

  it('默认超时比伴生 CLI 自己等 control endpoint 的 45s 长：冷启动那一条正常路径不许被掐成超时', () => {
    expect(COMPANION_EDITOR_TIMEOUT_MS).toBeGreaterThan(45_000);
  });

  it('argv 的三条判据（spec 3.15-02）：`--json` 在最前、路径是绝对路径、页号跟在 `--page` 后', () => {
    const plan = planCompanionOpen(path.join(tmpdir(), 'resume.PDF'), 12);
    if (!plan.isAccepted) throw new Error('用例前提不成立：绝对 .pdf 路径应被接纳');
    const [, , absolutePath] = plan.args;
    expect(plan.args.slice(0, 2)).toEqual(['--json', 'open']);
    expect(typeof absolutePath).toBe('string');
    expect(path.isAbsolute(absolutePath ?? '')).toBe(true);
    expect(plan.args.slice(3)).toEqual(['--page', '12']);
  });
});
