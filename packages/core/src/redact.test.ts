import { describe, expect, it } from 'vitest';
import { PII_VALUE_PATTERNS, redactText, redactValue } from './redact.js';

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

/**
 * 2.7-07 补的值形态判据。
 *
 * 1.3 那份只认 `key: value`，而 JD 页面上的联系方式是**裸值**（中文冒号、没有英文键名），
 * 对页面正文的命中数是 0——这条正是当初 `redactText('联系电话：13800001111')` 原样返回的原因，
 * 那次断言写的是「现状」，现在把它翻成「应当」，并在 spec 记录里留了这个反转。
 */
describe('正文裸值脱敏（spec 2.7-07）', () => {
  it('页面正文里的裸手机 / 邮箱 / 证件号被掩码', () => {
    expect(redactText('联系人手机：13800138000（工作日 9-19 点可联系）')).toBe(
      '联系人手机：138****8000（工作日 9-19 点可联系）',
    );
    expect(redactText('投递邮箱：zhaopin.huang@example.com.cn')).toBe('投递邮箱：z***@example.com.cn');
    expect(redactText('证件号码：330106199001011234')).toBe('证件号码：**********1234');
  });

  it('薪资 / 编号 / 年份这类同形数字串不误伤——遮错了等于把证据废掉', () => {
    const readable = '薪资 15000-25000，经验 3-5 年，编号 123456，成立于 2019，共 20 个项目';
    expect(redactText(readable)).toBe(readable);
  });

  it('18 位证件号不被手机号规则咬成半截（判据顺序：长的先跑）', () => {
    expect(redactText('330106199001011234')).toBe('**********1234');
    expect(redactText('33010619900101123X')).toBe('**********123X');
  });

  it('键值形态先跑，键名语义不丢', () => {
    expect(redactText('phone=13800138000')).toBe('phone=138****8000');
  });

  it('脱敏幂等：掩码结果再过一遍不二次变形', () => {
    const once = redactText('手机 13800138000 邮箱 a@b.com 证号 330106199001011234');
    expect(redactText(once)).toBe(once);
  });

  it('判据以源码形式导出，注入页面的遮罩脚本能直接带过去', () => {
    expect(PII_VALUE_PATTERNS.map((item) => item.kind)).toEqual(['id', 'phone', 'email']);
    for (const pattern of PII_VALUE_PATTERNS) {
      expect(() => new RegExp(pattern.source, pattern.flags)).not.toThrow();
    }
  });
});
