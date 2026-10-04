/**
 * 本地 generic 更新源的 fixture 服务（spec 5.9-03 的证据工具，plan §7.7.2.1 第 2 条的路径 ①）。
 *
 * 为什么需要它：判据要证明"更新只在被点时发生、且失败不阻塞使用"，而这两条都要**看得见请求**。
 * 真 feed 不能用（§8 不外连、§9 网络事实），所以在本机起一个静态目录服务，
 * 由 app 侧的 `update.feedUrl` 指过来——它同时充当请求日志：每一条到达这里的请求都带时间戳落盘，
 * 于是"启动后 0 条 / 点检查后 1 条 latest.yml / 点下载后 1 条安装包"是可核对的读数而不是断言。
 *
 * 安装包是假的：一段确定字节 + 与 latest.yml 对得上的 sha512/size，只够走完下载与校验，
 * 不是可执行的 NSIS 包——所以这条链**故意只跑到 downloaded 为止**，装启动作不在活体上点。
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** 命令行读数：`--flag value` 形态，缺省值都是本片实测用的那组。 */
const flag = (name: string, fallback = ''): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const port = Number(flag('port', '10244'));
const version = flag('version', '9.9.9');
const feedDir = path.resolve(repoRoot, flag('out', 'tmp/update-feed'));
const logFile = path.resolve(repoRoot, flag('log', 'tmp/update-feed/requests.log'));
/** 假安装包大小：够触发一次真实的分块写盘，又不至于让证据跑几十秒。 */
const installerBytes = Number(flag('installer-bytes', String(2 * 1024 * 1024)));

const installerName = `auto-cc-${version}-win-x64-setup.exe`;
/** 固定内容而非随机：同一版本重跑时 sha512 不变，latest.yml 与日志可复现比对。 */
const installerPayload = Buffer.alloc(installerBytes, 'auto-cc update channel fixture');
const sha512Base64 = createHash('sha512').update(installerPayload).digest('base64');

mkdirSync(feedDir, { recursive: true });
writeFileSync(path.join(feedDir, installerName), installerPayload);
// generic provider 在 win 上读的就是这一份 `latest.yml`（实测：electron-builder 的 win 产物同名）。
writeFileSync(
  path.join(feedDir, 'latest.yml'),
  [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512Base64}`,
    `    size: ${installerBytes}`,
    `path: ${installerName}`,
    `sha512: ${sha512Base64}`,
    `size: ${installerBytes}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  logFile,
  `# fixture feed 起于 ${new Date().toISOString()} · version=${version} · dir=${feedDir}\n`,
  'utf8',
);

const server = createServer((request, response) => {
  const requestAt = new Date().toISOString();
  appendFileSync(logFile, `${requestAt} ${request.method} ${request.url}\n`, 'utf8');
  const name = path.basename(request.url ?? '/');
  const file = path.join(feedDir, name);
  if (name === 'latest.yml' || name === installerName) {
    const body = readFileSync(file);
    response.writeHead(200, { 'content-type': name === 'latest.yml' ? 'text/yaml' : 'application/octet-stream' });
    response.end(body);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[update-feed] http://127.0.0.1:${String(port)}/ · ${installerName} · sha512=${sha512Base64}`);
  console.log(`[update-feed] 请求日志：${logFile}`);
});
