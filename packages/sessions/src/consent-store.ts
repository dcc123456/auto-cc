/**
 * 首次启用自动化的风险签字（spec 2.7-06）的落库那一层。
 *
 * 表放在 `packages/sessions` 而不是新包：签字记录是**平台级、跨重启的状态**，而这个归属
 * 已经由本包持有（分区、登录态快照、平台清单都在这）。另开一个 `consent` 包会把「这个平台现在
 * 是什么状况」拆到两处，界面就要问两个服务才能说清一句话（AGENTS.md §2.3）。
 *
 * 键的形状是 `automation:<platform>` 而不是任意字符串：写入口只接受平台名（`sessions.grantConsent`），
 * 于是这张表不可能长出一个没登记过的 scope 来冒充「用户签过字」——一条主键就是一个风险主体。
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * 签字表的迁移号段：**6**。号段全局唯一（1 账本、2 agent 会话、3 JD、4 工作流 run、5 会话消息），
 * 撞号不是编译期错误而是运行期抛「迁移版本重复」，所以只能在这里定一次（plan §8.4 决策 5）。
 */
export const CONSENT_MIGRATION_VERSION = 6;

/** scope 前缀；界面与日志里出现的 scope 都由它拼出来，不散落字符串。 */
export const CONSENT_SCOPE_PREFIX = 'automation:';

/**
 * 一个平台对应的签字 scope。
 * @param platform 平台标识（`sessions.platforms[].id`）
 * @returns 形如 `automation:boss` 的主键值
 */
export const consentScope = (platform: string): string => `${CONSENT_SCOPE_PREFIX}${platform}`;

/**
 * 建表与回滚。
 *
 * 只有两列：scope 与首次确认时刻。「签了哪些条款」不在这里——本片只登记「用户承过这个风险」
 * 这一件事（plan §14.5：不做 ToS 文本的法律审校，因此没有版本号可对）。
 * 导出给用例装配用：单测要验收「重挂同一份库仍然读得到」，只需要 DDL 本身。
 */
export const consentMigration = {
  version: CONSENT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS automation_consents (
      scope TEXT PRIMARY KEY,
      acknowledged_at INTEGER NOT NULL
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS automation_consents');
  },
};

/**
 * 读一个平台的签字时刻。
 * @param db store 的连接
 * @param platform 平台标识
 * @returns 首次确认的毫秒时间戳；没签过时为 null（不抛，界面按 null 画确认卡片）
 */
export function readConsentAt(db: DatabaseSync, platform: string): number | null {
  const row = db
    .prepare('SELECT acknowledged_at FROM automation_consents WHERE scope = ?')
    .get(consentScope(platform)) as { acknowledged_at?: number | bigint } | undefined;
  if (!row) return null;
  return Number(row.acknowledged_at);
}

/**
 * 写一次签字。
 *
 * 用 `INSERT ... ON CONFLICT DO NOTHING` 而不是 upsert：第二条验收语义就是「出现一次」，
 * 而「用户又点了一次确认」不该把首次确认时刻刷新掉——审计要回答的是「风险是从哪一刻被承担的」。
 * @param db store 的连接
 * @param platform 平台标识
 * @param atMs 确认时刻（毫秒）
 */
export function writeConsent(db: DatabaseSync, platform: string, atMs: number): void {
  db.prepare('INSERT INTO automation_consents (scope, acknowledged_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(
    consentScope(platform),
    atMs,
  );
}
