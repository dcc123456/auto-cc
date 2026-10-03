/**
 * 静态检查：调度器**只能**进程内运行，不写系统计划任务（spec 5.7-10）。
 *
 * 这条判据是 C 类（静态检查产物），不是跑出来的行为——因为"没写 crontab"这件事在运行期
 * 没有可观察的正面信号（正常运行时本来就不会有任何外部进程出现），只能从代码形状上钉：
 * ① 调度包不碰 `node:child_process`（没有 `crontab` / `schtasks` / `systemd` 的写入通道）；
 * ② 表达式与关键字里不出现外部计划任务的名字；
 * ③ 整个包**只有一个** `setInterval`，即"同一时刻只有一套运行时在驱动"的那条口径（§2.7）。
 * 命令：`pnpm lint` 里最后一条，或单独 `tsx scripts/check-scheduler-no-external-cron.ts`。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'packages/scheduler/src';
/** 禁止出现的外部计划任务通道与关键字（大小写不敏感）。 */
const FORBIDDEN = [
  { pattern: /node:child_process/, why: '子进程是写系统计划任务的唯一途径' },
  { pattern: /\bcrontab\b/i, why: '不允许写用户的 cron 表' },
  { pattern: /schtasks/i, why: '不允许注册 Windows 任务计划程序' },
  { pattern: /\bsystemd\b|systemctl|\.timer\b/i, why: '不允许装 systemd 单元' },
  { pattern: /\blaunchctl\b|LaunchAgents/i, why: '不允许写 macOS 启动项' },
];

/**
 * 递归列出目录里全部 `.ts` 源文件。
 * @param dir 起点目录（相对仓库根）
 * @returns 文件路径列表（相对仓库根，便于报错时直接点开）
 */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const problems: string[] = [];
let timers = 0;
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(line)) problems.push(`${file}:${String(index + 1)} 命中 ${pattern}（${why}）`);
    }
    // 只数真实调用，注释里提一句"不写 setIntervalX"不算（本包的注释会说这个词）。
    if (/\bsetInterval\s*\(/.test(line)) {
      const isComment = line.trimStart().startsWith('*') || line.trimStart().startsWith('//');
      if (!isComment) timers += 1;
    }
  });
}

if (timers !== 1) {
  problems.push(`调度包里的 setInterval 数量是 ${String(timers)}，判据要求"进程内单一定时器"= 恰好 1 处`);
}

if (problems.length) {
  console.error('调度器越界（spec 5.7-10）：\n' + problems.map((problem) => `  - ${problem}`).join('\n'));
  process.exit(1);
}
console.log(
  `调度器保持进程内：扫描 ${String(walk(ROOT).length)} 个文件，0 处外部计划任务写入，恰好 1 处 setInterval（spec 5.7-10）`,
);
