/**
 * 「最近 5 笔 / 最近一笔」的时刻写法（QA 的 P3，2026-11-22）：
 * 当天只给时间、非当天必须带「MM-DD」——否则几天前的发送会被读成刚发的。
 */
import { describe, expect, it } from 'vitest';
import { recentStamp } from './HomePanel';

describe('recentStamp', () => {
  const now = new Date(2026, 10, 22, 15, 30, 0).getTime(); // 本地 2026-11-22 15:30

  it('当天：只给时分秒', () => {
    expect(recentStamp(new Date(2026, 10, 22, 9, 5, 7).getTime(), now)).toBe('09:05:07');
  });

  it('非当天（前一天）：带 MM-DD', () => {
    expect(recentStamp(new Date(2026, 10, 21, 11, 51, 43).getTime(), now)).toBe('11-21 11:51:43');
  });

  it('非当天（更早）：同样带 MM-DD，不会被读成今天', () => {
    expect(recentStamp(new Date(2026, 10, 19, 8, 0, 0).getTime(), now)).toBe('11-19 08:00:00');
  });

  it('跨年：仍按自然日判，跨年那天的日期照写', () => {
    const newYear = new Date(2027, 0, 1, 0, 0, 5).getTime();
    expect(recentStamp(new Date(2026, 11, 31, 23, 59, 59).getTime(), newYear)).toBe('12-31 23:59:59');
  });
});
