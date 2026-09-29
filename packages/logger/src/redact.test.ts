import { describe, expect, it } from 'vitest';
import { redactText, redactValue } from './redact.js';

describe('日志脱敏（spec 1.3-11）', () => {
  it('结构化字段按键名脱敏，PII 保留可读片段', () => {
    const input = {
      token: 'eyJhbGciOiJIUzI1NiIs',
      nested: { apiKey: 'sk-live-123456', level: 'info' },
      user: { name: '张三', phone: '13800001111', email: 'zhangsan@qq.com', idCard: '330106199001011234' },
      list: [{ cookie: 'sid=abc' }],
    };
    expect(redactValue(input)).toEqual({
      token: '***',
      nested: { apiKey: '***', level: 'info' },
      user: { name: '张三', phone: '138****1111', email: 'z***@qq.com', idCard: '**********1234' },
      list: [{ cookie: '***' }],
    });
  });

  it('自由文本里的 k=v 也被掩码', () => {
    expect(redactText('登录失败 token=abc123 状态 500')).toBe('登录失败 token=*** 状态 500');
    expect(redactText('headers: { "Authorization": "Bearer x.y.z" }')).toBe('headers: { "Authorization": "***" }');
    expect(redactText('联系电话：13800001111')).toContain('13800001111');
  });

  it('非敏感内容原样保留，不吞掉日志信息量', () => {
    expect(redactValue('boss 搜索页加载超时')).toBe('boss 搜索页加载超时');
    expect(redactValue(500)).toBe(500);
    const error = new Error('boom');
    expect(redactValue(error)).toBe(error);
  });
});

describe('会话 cookie 值脱敏（spec 1.8-05）', () => {
  it('Set-Cookie 表头整行只留属性，值不进日志', () => {
    expect(redactText('Set-Cookie: autocc_session=fixture-token; Path=/; Max-Age=86400')).toBe(
      'Set-Cookie: ***; Path=/; Max-Age=86400',
    );
  });

  it('下划线拼接的 cookie 名也算敏感键（\\b 会把下划线当词字符，所以不能用词边界）', () => {
    expect(redactText('写入 autocc_session=SECRET123 完成')).toBe('写入 autocc_session=*** 完成');
    expect(redactText('登录 cookie autocc_session=SECRET123 已失效')).toBe('登录 cookie autocc_session=*** 已失效');
  });

  it('JSON 形态的 cookie 字段同样收成掩码', () => {
    expect(redactText('header {"Cookie":"autocc_session=SECRET123"}')).toBe('header {"Cookie":"***"}');
  });
});
