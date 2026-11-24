/**
 * 第 16 片真站开场前置：**只读**核指纹与三个基线数（spec 10.7-01 / 10.7-04，plan §14.34）。
 *
 * 纪律（写进代码，不只写注释）：
 * - 本脚本**不导航、不点击、不发任何外发**，只打只读白名单口；
 * - 若发现内核视图已经在真站上（`kernelViewUrl` 含 zhipin），**直接拒绝开局**——先把视图关掉再来；
 * - 判据锚在**二进制指纹**而不是 commit（docs 提交会把 HEAD 推走，代码还是同一份）；
 * - 任何一条不成立即非零退出，现场以退出码为准，不看"看着差不多"。
 *
 * 跑法：`pnpm verify:real-preflight --cdp-port 10440 --dmg dist/auto-cc-0.1.0-mac-arm64.dmg`
 * 自测（本地仿站）：加 `--allow-loopback`。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { CdpSession, listTargets } from '../packages/testing/src/cdp.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 读 `--key value` 参数。
 * @param name 参数名（不含前导 `--`）
 * @param fallback 缺省值
 * @returns 参数字符串
 */
const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const cdpPort = Number(flag('cdp-port', '10440'));
const dmgPath = path.resolve(repoRoot, flag('dmg', path.join('dist', 'auto-cc-0.1.0-mac-arm64.dmg')));
const expectDmg = flag('expect-dmg', '');
const expectAsar = flag('expect-asar', '');
const allowLoopback = process.argv.includes('--allow-loopback');
/**
 * `store.db` 路径（应用 userData 下）。给了它就**直读表行数**当基线——
 * 这是 QA 对读法的要求：`funnel.query` 的 deliver 计数是推导值、`recentAttempts(100)` 会封顶，
 * 拿它们当「+1」的基准等于把风险带进对账。**只读打开、只跑 COUNT、用完即关**，
 * 不进产品运行时、不是第二套连接池（进程结束就没了）。
 */
const dbPath = flag('db', '');

/** 失败原因清单；全空即通过。 */
const failures: string[] = [];

/**
 * 记一条判据。
 * @param ok 是否成立
 * @param label 判据原文
 * @param detail 读数原文（缺省为空）
 */
const check = (ok: boolean, label: string, detail = ''): void => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} · ${label}${detail === '' ? '' : ` —— ${detail}`}\n`);
  if (!ok) failures.push(label);
};

/**
 * 算文件 sha256。
 * @param file 绝对路径
 * @returns 十六进制摘要
 */
const sha256Of = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message?: string } };

/**
 * 打一条只读桥接口。
 * @param session CDP 会话
 * @param apiPath 完整 path（命名空间按第一个点切）
 * @param args 位置实参
 * @returns 原始回包
 */
async function callBridge<T>(session: CdpSession, apiPath: string, args: unknown[] = []): Promise<Reply<T>> {
  const dot = apiPath.indexOf('.');
  return session.evaluate<Reply<T>>(
    `(window.autoCC[${JSON.stringify(apiPath.slice(0, dot))}][${JSON.stringify(apiPath.slice(dot + 1))}](...${JSON.stringify(args)}))`,
  );
}

const main = async (): Promise<void> => {
  // ① 二进制指纹（不锚 commit：docs 提交会把 HEAD 推走，包还是同一份）
  const asarPath = path.join(repoRoot, 'dist', 'mac-arm64', 'auto-cc.app', 'Contents', 'Resources', 'app.asar');
  const dmgSha = sha256Of(dmgPath);
  const asarSha = sha256Of(asarPath);
  process.stdout.write(
    `· dmg  ${String(dmgPath)} · ${String(readFileSync(dmgPath).length)} B · ${dmgSha.slice(0, 16)}\n`,
  );
  process.stdout.write(`· asar ${asarPath} · ${asarSha.slice(0, 16)}\n`);
  if (expectDmg !== '')
    check(dmgSha.startsWith(expectDmg), `dmg 指纹与放行值一致（${expectDmg}）`, dmgSha.slice(0, 16));
  if (expectAsar !== '')
    check(asarSha.startsWith(expectAsar), `asar 指纹与放行值一致（${expectAsar}）`, asarSha.slice(0, 16));

  // ② 树与远端（只报告，不阻断：本片判据锚指纹，树里可能还有别人的 docs 改动）
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
  // 远端只报告、不阻断：本片判据锚二进制指纹（docs 提交会把 HEAD 推走，网络抖一下也不该拦住开局）。
  const remote = (() => {
    try {
      return execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: repoRoot })
        .toString()
        .trim()
        .split('\t')[0];
    } catch {
      return '（读不到：网络或权限）';
    }
  })();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString().trim();
  process.stdout.write(
    `· HEAD=${head.slice(0, 12)} · origin/main=${String(remote).slice(0, 12)} · 工作树${dirty === '' ? '干净' : '有未提交改动'}\n`,
  );

  // ③ 连实例，只读核三条基线
  const session = await CdpSession.attach(cdpPort, 'app.asar').catch(() => undefined);
  if (session === undefined) {
    const targets = await listTargets(cdpPort).catch(() => []);
    throw new Error(
      `CDP ${String(cdpPort)} 上没找到产物渲染层（当前 targets：${targets.map((item) => item.url).join(' / ') || '无'}）`,
    );
  }

  const status = await callBridge<{
    kernelViewUrl: string;
    kernelViewVisible: boolean;
    kernelViewPageVisible: boolean;
  }>(session, 'shell.getStatus');
  const kernelUrl = status.ok ? status.value.kernelViewUrl : '';
  const onRealSite = kernelUrl.includes('zhipin.com');
  check(
    allowLoopback || !onRealSite,
    '开跑前内核视图不在真站上（先把视图关掉再来，避免带着页面状态开局）',
    kernelUrl === '' ? '（空）' : kernelUrl,
  );
  if (allowLoopback)
    // 自测模式只要求「不是真站」：占位页（`data:`）其实才是最理想的未开局状态。
    check(
      kernelUrl.startsWith('data:') || kernelUrl === '' || kernelUrl.includes('127.0.0.1'),
      '自测模式：内核视图是占位页 / 回环 / 空',
      kernelUrl.slice(0, 40),
    );

  const auth = await callBridge<{ status?: string } | null>(session, 'outbound.authorization.current');
  check(
    auth.ok && auth.value === null,
    '授权位为空（开局没有半张授权单）',
    JSON.stringify(auth.ok ? auth.value : auth.error),
  );

  const control = await callBridge<{ stopped: boolean }>(session, 'entitlement.gate.outboundStatus');
  check(
    control.ok && control.value.stopped === false,
    '外发总开关未被停用',
    JSON.stringify(control.ok ? control.value : control.error),
  );

  const summary = await callBridge<{ total: number; today: number }>(session, 'usage.ledger.summary', [1]);
  const attempts = await callBridge<unknown[]>(session, 'usage.ledger.recentAttempts', [100]);
  const funnel = await callBridge<{ levels: { level: string; count: number | null }[] }>(session, 'funnel.query', [
    { fromMs: 0, toMs: Date.now() },
  ]);
  /** 直读三张表的行数（只读打开、COUNT 后立刻关）；读不到时为 null。 */
  const exactCounts = ((): { ledger: number; attempts: number; deliveries: number } | null => {
    if (dbPath === '') return null;
    try {
      const db = new DatabaseSync(path.resolve(repoRoot, dbPath), { readOnly: true });
      const countOf = (table: string): number => {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | bigint };
        return Number(row?.n ?? 0);
      };
      const counts = {
        ledger: countOf('usage_ledger'),
        attempts: countOf('outbound_attempts'),
        deliveries: countOf('delivery_records'),
      };
      db.close();
      return counts;
    } catch (error) {
      process.stdout.write(
        `· 直读 ${dbPath} 失败（回退到推导值）：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return null;
    }
  })();
  const deliverRows =
    exactCounts?.deliveries ??
    (funnel.ok ? (funnel.value.levels.find((row) => row.level === 'deliver')?.count ?? null) : null);
  const ledgerTotal = exactCounts?.ledger ?? (summary.ok ? summary.value.total : null);
  const attemptTotal = exactCounts?.attempts ?? (attempts.ok ? attempts.value.length : null);
  process.stdout.write(
    `· 基线三数${exactCounts === null ? '（推导值：funnel / recentAttempts 封顶，建议补 --db 直读）' : '（直读表 COUNT）'}：` +
      `usage_ledger ${String(ledgerTotal ?? '?')}（今日 ${String(summary.ok ? summary.value.today : '?')}）` +
      ` · outbound_attempts ${String(attemptTotal ?? '?')}` +
      ` · delivery_records ${deliverRows === null ? '?' : String(deliverRows)}\n`,
  );
  check(summary.ok && attempts.ok && funnel.ok, '三个基线数都读到了（读不到就不许开跑）');

  const sessions = await callBridge<{ platforms: { id: string; auth: string }[] }>(session, 'sessions.status');
  const boss = sessions.ok ? sessions.value.platforms.find((row) => row.id === 'boss') : undefined;
  process.stdout.write(`· boss 登录态：${boss === undefined ? '（还没有这条会话）' : boss.auth}\n`);

  session.close?.();
  process.stdout.write(
    `\n开场前置结论：${failures.length === 0 ? '可以开跑' : `不许开跑（${String(failures.length)} 条不成立）`}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`前置检查失败：${error instanceof Error ? (error.message ?? String(error)) : String(error)}\n`);
  process.exitCode = 1;
});
