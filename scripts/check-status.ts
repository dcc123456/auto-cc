// AGENTS.md §1.6 收尾自检：改动必须已提交、已配置远端、且无未推送提交。
// 任一硬性条件不满足即退出码 1；未配置远端时只提示（本机允许跳过推送）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
/**
 * 执行 git 命令并返回去掉首尾空白的标准输出。
 * @param args git 参数数组（不含 `git` 本身），例如 ['status', '--porcelain']
 * @returns 命令输出文本；git 报错时由 execFile 抛出异常
 */
const git = async (args: string[]) => {
  const { stdout } = await run('git', args, { encoding: 'utf8' });
  return stdout.trim();
};

const status = await git(['status', '--porcelain']);
const remotes = await git(['remote']);
// 未推送提交数；git 报错通常意味着当前分支没有上游，用 null 区分「无上游」与「0 个待推送」。
const unpushedCount = await git(['rev-list', '--count', '@{u}..HEAD'])
  .then((count) => Number.parseInt(count, 10))
  .catch(() => null);

if (status) {
  console.error('✖ 存在未提交的改动（AGENTS.md §1.6 要求每次修改完即提交）：');
  console.error(status);
  process.exit(1);
}

if (!remotes) {
  console.warn('⚠ 未配置 git 远端，无法推送。提交已完成，推送步骤跳过（AGENTS.md §1.6 例外）。');
  process.exit(0);
}
if (unpushedCount === null) {
  console.error('✖ 当前分支没有上游分支，请用 git push -u origin <branch> 建立跟踪。');
  process.exit(1);
}
if (unpushedCount > 0) {
  console.error(`✖ 本地有 ${unpushedCount} 个提交未推送，请 git push。`);
  process.exit(1);
}
console.log('✔ 工作区干净，提交已推送');
