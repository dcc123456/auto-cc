/**
 * 可视自测 harness 的命令行入口。
 *
 * 用法（仓库根目录）：
 *   pnpm harness targets
 *   pnpm harness wait --text "主进程状态"
 *   pnpm harness click --selector '[data-row-id="store"] [data-action="stop"]'
 *   pnpm harness type --text "日志级别" --value debug
 *   pnpm harness dom --selector '[data-row-id]' --attrs data-row-id
 *   pnpm harness eval --expr "await window.autoCC.kernel.tree()"
 *   pnpm harness eval --expr-file tmp/probe.js   # 多行脚本走文件，见 expression() 的说明
 *   pnpm harness assert --expr "document.title" --equals '"auto-cc"'
 *   pnpm harness navigate --to file:///…/fixtures/self-test-lab/index.html --url data:text/html
 *   pnpm harness shot --out /tmp/shot.png --url 127.0.0.1:5173
 *   pnpm harness diff --base /tmp/a.png --head /tmp/b.png
 *   pnpm harness archive --id 1.6-02 --in /tmp/shot.png --slug sees-panel
 *
 * 所有页面命令都对 Electron 的 CDP 端口操作，默认 10222，可用 --port 覆盖；
 * Electron 会同时暴露主窗口与内嵌内核视图两个 page target，所以用 --url 子串选边。
 * `assert` 与 `diff` 判定不通过时以 exit 1 结束，让脚本能串成真断言而不是读日志。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CdpSession, listTargets, type TargetSpec } from './cdp.js';
import { diffPng } from './diff.js';
import { archiveEvidence } from './evidence.js';

/** 截图默认落在仓库根，与 spec 里书写的 `docs/acceptance/...` 相对路径保持一致。 */
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const evidenceFile = (file: string) => (path.isAbsolute(file) ? file : path.join(repoRoot, file));

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name: string, fallback = ''): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

/** 逗号分隔的列表型参数（`--attrs a,b` / `--in x.png,y.png`）。 */
function listFlag(name: string): string[] {
  return flag(name)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const port = Number(flag('port', '10222'));
const urlFilter = flag('url') || undefined;

/** 从 `--selector` / `--text` 组装元素定位描述；两个都没给就无从定位。 */
function spec(): TargetSpec {
  const selector = flag('selector');
  const text = flag('text');
  if (!selector && !text) throw new Error('缺少定位方式：给 --selector 或 --text 之一');
  return { selector: selector || undefined, text: text || undefined };
}

async function attach(): Promise<CdpSession> {
  return CdpSession.attach(port, urlFilter);
}

/**
 * 取要执行的 JS 源码：`--expr` 给字面量，`--expr-file` 给仓库内文件路径。
 *
 * Windows 上 `pnpm harness` 经 `.cmd` 转发实参，命令行里的换行会被截断（实测多行表达式
 * 只剩第一行，报 `Unexpected end of input`），所以成段的断言脚本必须能从文件读入。
 */
function expression(fallback: string): string {
  const file = flag('expr-file');
  return file ? readFileSync(evidenceFile(file), 'utf8') : flag('expr', fallback);
}

const COMMANDS = [
  'targets            列出可连接的页面 target',
  'wait --text <str>  等页面出现该文本（--timeout 毫秒）',
  'click [--selector <css>] [--text <str>]  中心点派发原生鼠标事件',
  'type [--selector <css>] [--text <str>] --value <str>  聚焦后走 Input.insertText',
  'text               打印页面可见文本',
  'dom --selector <css> [--attrs a,b]  打印匹配节点的机读快照',
  'eval [--expr <js> | --expr-file <path>]  在页面里求值并打印结果',
  'assert [--expr <js> | --expr-file <path>] [--equals <json>]  断言，失败 exit 1',
  'navigate --to <url>  导航当前 target 并等 load 事件',
  'shot --out <file>  截图落盘',
  'diff --base <a.png> --head <b.png> [--threshold n]  像素比对，有差异 exit 1',
  'archive --id <spec-id> --in <file[,file]> [--slug <s>]  证据归档到 docs/acceptance/',
];

function help(): never {
  console.log([`harness <command> [--port 10222] [--url <target 子串>]`, '', ...COMMANDS].join('\n'));
  process.exit(1);
}

/** 深比较用：JSON 归一化后再比，避免 `undefined` 与缺键被当成差异。 */
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

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
      const tag = await session.click(spec());
      session.close();
      console.log(`已点击 <${tag}>（原生鼠标事件）`);
      break;
    }
    case 'type': {
      const session = await attach();
      const readout = await session.type(spec(), flag('value'));
      session.close();
      console.log(JSON.stringify(readout, null, 2));
      break;
    }
    case 'text': {
      const session = await attach();
      console.log(await session.readText());
      session.close();
      break;
    }
    case 'dom': {
      const session = await attach();
      const snapshot = await session.snapshot(flag('selector', '[data-row-id]'), listFlag('attrs'));
      session.close();
      console.log(JSON.stringify(snapshot, null, 2));
      break;
    }
    case 'navigate': {
      const session = await attach();
      await session.navigate(flag('to'));
      console.log(JSON.stringify(await session.evaluate('({ title: document.title, url: location.href })'), null, 2));
      session.close();
      break;
    }
    case 'eval': {
      const session = await attach();
      console.log(JSON.stringify(await session.evaluate(expression('1')), null, 2));
      session.close();
      break;
    }
    case 'assert': {
      const session = await attach();
      const actual = await session.evaluate(expression('false'));
      session.close();
      const expected = flag('equals');
      const isPassed = expected ? sameJson(actual, JSON.parse(expected) as unknown) : Boolean(actual);
      console.log(JSON.stringify({ isPassed, actual }, null, 2));
      if (!isPassed) process.exit(1);
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
    case 'diff': {
      const report = diffPng(evidenceFile(flag('base')), evidenceFile(flag('head')), Number(flag('threshold', '0')));
      const text = JSON.stringify(report, null, 2);
      // 报告本身也要能当证据归档，所以支持落盘而不只是打印。
      const out = flag('out');
      if (out) writeFileSync(evidenceFile(out), `${text}\n`, 'utf8');
      console.log(text);
      if (!report.isIdentical) process.exitCode = 1;
      break;
    }
    case 'archive': {
      const result = archiveEvidence(repoRoot, flag('id'), listFlag('in').map(evidenceFile), flag('slug') || undefined);
      console.log(
        [
          `归档目录：${path.relative(repoRoot, result.dir)}`,
          ...result.files.map(
            (item) => `${item.isFresh ? '已复制' : '原地不动'} ${path.relative(repoRoot, item.target)}`,
          ),
        ].join('\n'),
      );
      break;
    }
    default:
      help();
  }
} catch (error) {
  console.error(`[harness] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
