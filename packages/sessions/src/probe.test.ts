import { describe, expect, it } from 'vitest';
import type { SessionAuthStatus } from '@auto-cc/core';
import { partitionFor } from '@auto-cc/shared';
import {
  judgeAuth,
  sessionExpiredReason,
  summarizeCookies,
  type AuthReason,
  type AuthSignals,
  type CookieSummary,
} from './probe.js';

/** 一秒的毫秒数（Electron 的 `expirationDate` 单位是秒，判定侧统一按毫秒比较）。 */
const SECOND = 1000;
const NOW = 1_760_000_000_000;

/** 模仿 electron 真实返回的 cookie 形状：带值与多余字段，用来证明摘要函数按白名单取字段。 */
type RawCookie = { name: string; value: string; expirationDate?: number; domain?: string; path?: string };

/** 仿站的标定：只有 `autocc_session` 一枚，由 `scripts/fixture-server.ts` 自己 `Set-Cookie` 出来。 */
const FIXTURE: AuthSignals = { authCookieNames: ['autocc_session'], guestCookieNames: [], authMinPresence: 1 };

/**
 * BOSS 的标定，逐值抄 `docs/acceptance/08-real-platform-driving/8.0-02-cookie-name-diff.txt` 的分档表。
 * `__zp_stoken__`（风控票据）与 `wbg`/`__snaker__id`/`tgw_l7_route`（语义未核实）**刻意不进任何一族**，
 * 所以它们只可能把判定推向 `unknown`，永远推不到 `active`。
 */
const BOSS: AuthSignals = {
  authCookieNames: ['wt2', 'bst', 'zp_at', '__l'],
  guestCookieNames: [
    '__a',
    '__c',
    '__g',
    'lastCity',
    'isOHPC',
    'HMACCOUNT',
    'HMACCOUNT_BFESS',
    'Hm_lvt_194df3105ad7148dcf2b98a91b5e727a',
    'Hm_lpvt_194df3105ad7148dcf2b98a91b5e727a',
  ],
  authMinPresence: 2,
};

/** 登录前的 9 枚基线（读数一，全部无期限的会话型 cookie）。 */
const PRE_LOGIN: CookieSummary[] = [
  '__a',
  '__c',
  '__g',
  'HMACCOUNT',
  'HMACCOUNT_BFESS',
  'Hm_lpvt_194df3105ad7148dcf2b98a91b5e727a',
  'Hm_lvt_194df3105ad7148dcf2b98a91b5e727a',
  'isOHPC',
  'lastCity',
].map((name) => ({ name, expiresAt: null }));

/** 登录后新增的 8 枚（读数二），与基线合起来就是现场那次 `sessions.status()` 的 cookieCount=18。 */
const POST_LOGIN: CookieSummary[] = [
  ...PRE_LOGIN,
  ...['__l', '__snaker__id', '__zp_stoken__', 'bst', 'tgw_l7_route', 'wbg', 'wt2', 'zp_at'].map((name) => ({
    name,
    expiresAt: null,
  })),
];

describe('会话分区命名（spec 1.8-01）', () => {
  it('平台 id 一一映射到 persist: 分区，不同平台不可能撞名', () => {
    expect(partitionFor('fixture')).toBe('persist:fixture');
    expect(partitionFor('boss')).toBe('persist:boss');
    expect(partitionFor('fixture')).not.toBe(partitionFor('boss'));
  });
});

describe('cookie 摘要（spec 1.8-05）', () => {
  it('只留名字与过期时间：值压根不在返回的形状里', () => {
    const rawCookies: RawCookie[] = [
      { name: 'zz_session', value: 'SECRET-DO-NOT-LOG', expirationDate: NOW / SECOND + 60, domain: 'x' },
      { name: 'csrf', value: 'ALSO-SECRET', expirationDate: -1, path: '/' },
    ];
    const summaries = summarizeCookies(rawCookies);
    expect(summaries).toEqual([
      { name: 'csrf', expiresAt: null },
      { name: 'zz_session', expiresAt: NOW + 60 * SECOND },
    ]);
    expect(JSON.stringify(summaries)).not.toContain('SECRET');
  });

  it('会话 cookie 的 expirationDate 缺失时也算不出过期，收成 null 而不是 NaN', () => {
    expect(summarizeCookies([{ name: 'a' }, { name: 'b', expirationDate: undefined }])).toEqual([
      { name: 'a', expiresAt: null },
      { name: 'b', expiresAt: null },
    ]);
  });

  it('按名字排序，读数在 dev 与打包版之间可比', () => {
    const unordered: RawCookie[] = [
      { name: 'b', value: 'x', expirationDate: -1 },
      { name: 'a', value: 'y', expirationDate: -1 },
    ];
    expect(summarizeCookies(unordered).map((item) => item.name)).toEqual(['a', 'b']);
  });
});

/**
 * 登录态判定的表驱动矩阵（spec 8.2-01 / 8.2-02）。
 *
 * 每一行都写「cookie 形状 + 标定 + 期望三态与依据」，把这条判定变成一张可查的表而不是一个 if 塔：
 * 站点改版后新增的行也是照这个形状加，不需要读实现。`expiresAt` 一栏期望 null 的行**不写**，
 * 因为那些态没有可报的期限——把它们写成相等会逼实现为"没意义的那个数"编一个值。
 */
const MATRIX: {
  /** 用例名：读名字就知道这一行蹲的是哪种现场 */
  name: string;
  cookies: CookieSummary[];
  signals: AuthSignals;
  expect: { auth: SessionAuthStatus; reasons: AuthReason[]; expiresAt?: number | null };
}[] = [
  {
    name: '仿站登录后一枚会话型 cookie ⇒ active，无期限可报',
    cookies: [{ name: 'autocc_session', expiresAt: null }],
    signals: FIXTURE,
    expect: { auth: 'active', reasons: ['auth_present'] },
  },
  {
    name: '仿站会话 cookie 过期 ⇒ expired，并把过期时间原样报回去',
    cookies: [{ name: 'autocc_session', expiresAt: NOW - SECOND }],
    signals: FIXTURE,
    expect: { auth: 'expired', reasons: ['expired'], expiresAt: NOW - SECOND },
  },
  {
    name: '仿站空分区 ⇒ expired / missing（还没登录过，不是掉了）',
    cookies: [],
    signals: FIXTURE,
    expect: { auth: 'expired', reasons: ['missing'] },
  },
  {
    name: '仿站标定下冒出一族都不沾的 cookie ⇒ unknown / unmapped（旧口径在这里报 missing，等于替站点编一个"没登录"的结论）',
    cookies: [{ name: 'analytics', expiresAt: NOW + SECOND }],
    signals: FIXTURE,
    expect: { auth: 'unknown', reasons: ['unmapped'] },
  },
  {
    name: '真站登录前 9 枚基线 ⇒ expired / guest_only（8.0-01 读数四的形状：旧口径在这一行谎报 missing）',
    cookies: PRE_LOGIN,
    signals: BOSS,
    expect: { auth: 'expired', reasons: ['guest_only'] },
  },
  {
    name: '真站登录后 18 枚 ⇒ active（旧口径只认 autocc_session，这一行恒判 expired，正是接管循环的成因）',
    cookies: POST_LOGIN,
    signals: BOSS,
    expect: { auth: 'active', reasons: ['auth_present'] },
  },
  {
    name: '未标定平台（没有登录族名单）拿到登录后 18 枚 ⇒ unknown，不许凭 cookie 数量谎报 active',
    cookies: POST_LOGIN,
    signals: { ...BOSS, authCookieNames: [] },
    expect: { auth: 'unknown', reasons: ['not_calibrated'] },
  },
  {
    name: '只命中一枚登录族而 min=2 ⇒ unknown / below_presence（单枚只算候选）',
    cookies: [{ name: 'wt2', expiresAt: null }],
    signals: BOSS,
    expect: { auth: 'unknown', reasons: ['below_presence'] },
  },
  {
    name: '同一枚票据挂在两个域 ⇒ 仍按名字去重，凑不满 min（否则"至少两枚独立信号"形同虚设）',
    cookies: [
      { name: 'wt2', expiresAt: null },
      { name: 'wt2', expiresAt: NOW + 60 * SECOND },
    ],
    signals: BOSS,
    expect: { auth: 'unknown', reasons: ['below_presence'] },
  },
  {
    name: '登录族两枚都在场 ⇒ active；会话型那枚在场时期限报 null 而不是拿有期限那枚冒充',
    cookies: [
      { name: 'wt2', expiresAt: null },
      { name: 'bst', expiresAt: NOW + 60 * SECOND },
    ],
    signals: BOSS,
    expect: { auth: 'active', reasons: ['auth_present'], expiresAt: null },
  },
  {
    name: '两枚都有期限 ⇒ expiresAt 取最早过期的那一枚（绑定约束，不是最晚那个）',
    cookies: [
      { name: 'wt2', expiresAt: NOW + 30 * SECOND },
      { name: 'bst', expiresAt: NOW + 600 * SECOND },
    ],
    signals: BOSS,
    expect: { auth: 'active', reasons: ['auth_present'], expiresAt: NOW + 30 * SECOND },
  },
  {
    name: '登录族两枚但全部过期 ⇒ expired / expired，报最近失效那一枚的时刻',
    cookies: [
      { name: 'wt2', expiresAt: NOW - 600 * SECOND },
      { name: 'bst', expiresAt: NOW - 60 * SECOND },
    ],
    signals: BOSS,
    expect: { auth: 'expired', reasons: ['expired'], expiresAt: NOW - 60 * SECOND },
  },
  {
    name: 'cookie 两族都不沾 ⇒ unknown / unmapped（站点改版的样子：既不敢说登录着，也不敢催重登）',
    cookies: [{ name: '__snaker__id', expiresAt: null }],
    signals: BOSS,
    expect: { auth: 'unknown', reasons: ['unmapped'] },
  },
  {
    name: '游客族 + 一个没登记的名字 ⇒ unknown / unmapped（有游客 cookie 不足以判"明确未登录"）',
    cookies: [...PRE_LOGIN, { name: 'brand_new_token', expiresAt: null }],
    signals: BOSS,
    expect: { auth: 'unknown', reasons: ['unmapped'] },
  },
];

describe('登录态判定：信号族三态（spec 8.2-01）', () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      const verdict = judgeAuth(row.cookies, row.signals, NOW);
      expect(verdict.auth).toBe(row.expect.auth);
      // 决定性依据在首位：事件取的就是它，所以顺序也是判据的一部分，不能只比集合。
      expect(verdict.reasons).toEqual(row.expect.reasons);
      if ('expiresAt' in row.expect) expect(verdict.expiresAt).toBe(row.expect.expiresAt);
    });
  }

  it('unknown 的每一条都不会带着 active 出去（一切动作判据写的是 === active）', () => {
    for (const row of MATRIX.filter((item) => item.expect.auth !== 'active')) {
      expect(judgeAuth(row.cookies, row.signals, NOW).auth).not.toBe('active');
    }
  });
});

describe('失效事件的原因码收口（spec 8.2-01：界面只认两个码）', () => {
  it('guest_only 与 missing 都归成 missing：分区里确实没有会话 cookie，接管文案不必长第三个码', () => {
    expect(sessionExpiredReason(judgeAuth(PRE_LOGIN, BOSS, NOW))).toBe('missing');
    expect(sessionExpiredReason(judgeAuth([], FIXTURE, NOW))).toBe('missing');
  });

  it('登录族确实过期过 ⇒ 报 expired（这条要说的是"去重登"，与"还没登录过"是两句不同的话）', () => {
    expect(sessionExpiredReason(judgeAuth([{ name: 'autocc_session', expiresAt: NOW - SECOND }], FIXTURE, NOW))).toBe(
      'expired',
    );
  });
});
