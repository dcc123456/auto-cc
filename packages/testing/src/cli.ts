/**
 * 可视自测 harness 的命令行入口。
 *
 * 用法（仓库根目录）：
 *   pnpm harness targets
 *   pnpm harness wait --text "主进程状态"
 *   pnpm harness click --text "变更一次本地状态"
 *   pnpm harness shot --out docs/acceptance/1.2/1.2-02-after.png --url 127.0.0.1:5173
 *   pnpm harness eval --expr "typeof window.require"
 * 所有命令都对 Electron 的 CDP 端口操作，默认 9222，可用 --port 覆盖。
 */
import path from 'node:path';
import process from 'node:process';
import { CdpSession, listTargets } from './cdp.js';

/** 截图默认落在仓库根，与 spec 里书写的 `docs/acceptance/...` 相对路径保持一致。 */
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const evidenceFile = (file: string) => (path.isAbsolute(file) ? file : path.join(repoRoot, file));

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name: string, fallback = ''): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

const port = Number(flag('port', '9222'));
const urlFilter = flag('url') || undefined;

async function attach(): Promise<CdpSession> {
  return CdpSession.attach(port, urlFilter);
}

function help(): never {
  console.log(
    [
      'harness <command> [--port 9222] [--url <target 子串>]',
      '',
      '  targets            列出可连接的页面 target',
      '  wait --text <str>  等页面出现该文本（--timeout 毫秒）',
      '  click --text <str> 按可见文本点击按钮/链接',
      '  text               打印页面可见文本',
      '  shot --out <file>  截图落盘',
      '  eval --expr <js>   在页面里求值并打印结果',
    ].join('\n'),
  );
  process.exit(1);
}

try {
  switch (command) {
    case 'targets': {
      const targets = await listTargets(port);
      console.log(
        targets.map((target) => `${target.type.padEnd(6)} ${target.title} ${target.url}`).join('\n') || '(无 target)',
      );
      break;
    }
    case 'wait': {
      const session = await attach();
      await session.waitForText(flag('text'), Number(flag('timeout', '10000')));
      console.log('文本已出现');
      session.close();
      break;
    }
    case 'click': {
      const session = await attach();
      const clicked = await session.clickText(flag('text'));
      session.close();
      if (!clicked) throw new Error(`未找到可点击元素：${String(flag('text'))}`);
      console.log('已点击');
      break;
    }
    case 'text': {
      const session = await attach();
      console.log(await session.readText());
      session.close();
      break;
    }
    case 'shot': {
      const out = flag('out');
      if (!out) help();
      const session = await attach();
      const file = await session.screenshot(evidenceFile(out));
      session.close();
      console.log(file);
      break;
    }
    case 'eval': {
      const session = await attach();
      console.log(JSON.stringify(await session.evaluate(flag('expr', '1')), null, 2));
      session.close();
      break;
    }
    default:
      help();
  }
} catch (error) {
  console.error(`[harness] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
