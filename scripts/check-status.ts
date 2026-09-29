// AGENTS.md §1.6 收尾自检：改动必须已提交，且远端已配置。
// 有未提交改动时退出码为 1；没有远端时只提示，不算失败（当前仓库尚未配远端）。
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
const ahead = await git(['rev-list', '--count', '@{u}..HEAD']).catch(() => '');
const remotes = await git(['remote']);

if (status) {
  console.error('✖ 存在未提交的改动（AGENTS.md §1.6 要求每次修改完即提交）：');
  console.error(status);
  process.exit(1);
}

if (!remotes) {
  console.warn('⚠ 未配置 git 远端，无法推送。提交已完成，推送步骤跳过。');
} else if (ahead) {
  console.error(`✖ 本地有 ${ahead} 个提交未推送，请 git push。`);
  process.exit(1);
}

console.log('✔ 工作区干净，提交已推送');
