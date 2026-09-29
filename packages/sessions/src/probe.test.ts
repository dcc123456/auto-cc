import { describe, expect, it } from 'vitest';
import { partitionFor } from '@auto-cc/shared';
import { judgeAuth, summarizeCookies } from './probe.js';

/** 一秒的毫秒数（Electron 的 `expirationDate` 单位是秒，判定侧统一按毫秒比较）。 */
const SECOND = 1000;
const NOW = 1_760_000_000_000;

/** 模仿 electron 真实返回的 cookie 形状：带值与多余字段，用来证明摘要函数按白名单取字段。 */
type RawCookie = { name: string; value: string; expirationDate?: number; domain?: string; path?: string };

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

describe('登录态判定（spec 1.8-06）', () => {
  const cookies = [{ name: 'autocc_session', expiresAt: NOW + 10 * SECOND }];

  it('没有会话 cookie 判为失效，原因 missing', () => {
    expect(judgeAuth([], 'autocc_session', NOW)).toEqual({ auth: 'expired', reason: 'missing', expiresAt: null });
  });

  it('会话 cookie 过期判为失效，原因 expired，并回传过期时间', () => {
    const stale = [{ name: 'autocc_session', expiresAt: NOW - SECOND }];
    expect(judgeAuth(stale, 'autocc_session', NOW)).toEqual({
      auth: 'expired',
      reason: 'expired',
      expiresAt: NOW - SECOND,
    });
  });

  it('未过期判为有效；会话型 cookie（无过期时间）也算有效', () => {
    expect(judgeAuth(cookies, 'autocc_session', NOW).auth).toBe('active');
    expect(judgeAuth([{ name: 'autocc_session', expiresAt: null }], 'autocc_session', NOW).auth).toBe('active');
  });

  it('只认配置指定的那个 cookie 名，别的 cookie 再多也不算登录', () => {
    expect(judgeAuth([{ name: 'analytics', expiresAt: NOW + SECOND }], 'autocc_session', NOW).reason).toBe('missing');
  });
});
