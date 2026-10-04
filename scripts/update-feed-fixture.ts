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
/**
 * 假安装包的字节内容。
 *
 * 确定性 + **随版本变**：同一版本重跑时 sha512 不变（latest.yml 与日志可复现比对），
 * 但不同版本必须算出不同的 sha512——实测 `DownloadedUpdateHelper` 是按 sha512 认缓存的，
 * 内容相同的两个版本会被判成"Update has already been downloaded"，
 * 于是"点下载 → 真的发一条安装包请求"这一条读数取不到（`%LOCALAPPDATA%\auto-cc-updater\pending` 里那份 9.9.9 就是这个原因命中的）。
 */
const installerPayload = Buffer.alloc(installerBytes, `auto-cc update channel fixture ${version}`);
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

/**
 * 从请求行里取出文件名。
 *
 * 必须先把查询串剥掉：electron-updater 的 GenericProvider 每次都请求 `latest.yml?noCache=<随机数>`
 * （实测：请求日志里是 `/latest.yml?noCache=1k42l17sb`），直接把 `request.url` 交给 `path.basename`
 * 会得到带问号的整串，于是自家 fixture 回 404，活体上表现为
 * `Cannot find channel "latest.yml" update info: HttpError: 404 Not Found`——那是证据工具的 bug，不是产品 bug。
 * @param rawUrl 请求行里的原始 URL，可能是 `/latest.yml?x=1` 也可能是 `*`
 * @returns 目录里的文件名；解析不出时回空串，由调用方按 404 处理
 */
const nameFromRequest = (rawUrl: string | undefined): string => {
  const pathname = new URL(rawUrl ?? '/', `http://127.0.0.1:${String(port)}`).pathname;
  return path.basename(pathname);
};

const server = createServer((request, response) => {
  const requestAt = new Date().toISOString();
  appendFileSync(logFile, `${requestAt} ${request.method} ${request.url}\n`, 'utf8');
  const name = nameFromRequest(request.url);
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
