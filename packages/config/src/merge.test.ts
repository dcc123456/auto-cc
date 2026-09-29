import { describe, expect, it } from 'vitest';
import { envLayer, mergeDeep, mergeLayers, parseEnvValue, setPath } from './merge.js';

describe('配置分层合并（spec 1.3-02）', () => {
  it('后写的层覆盖先写的层', () => {
    const merged = mergeLayers([
      { scope: 'default', values: { logger: { level: 'info', buffer: 100 } } },
      { scope: 'file', values: { logger: { level: 'debug' } } },
      { scope: 'env', values: { logger: { level: 'warn' } } },
      { scope: 'runtime', values: { logger: { level: 'trace' } } },
    ]);
    expect(merged).toEqual({ logger: { level: 'trace', buffer: 100 } });
  });

  it('嵌套对象逐键合并，数组整体替换', () => {
    const merged = mergeDeep({ a: { b: 1, list: [1, 2] } }, { a: { c: 3, list: [9] } });
    expect(merged).toEqual({ a: { b: 1, c: 3, list: [9] } });
  });

  it('环境变量按白名单转成配置路径，值先按 JSON 解析', () => {
    const values = envLayer(
      { AUTOCC_LOGGER_LEVEL: 'warn', AUTOCC_STORE_TIMEOUT: '5000', AUTOCC_EXTRA: '{"a":1}', UNRELATED: 'x' },
      {
        'logger.level': 'AUTOCC_LOGGER_LEVEL',
        'store.timeout': 'AUTOCC_STORE_TIMEOUT',
        'browser.extra': 'AUTOCC_EXTRA',
      },
    );
    expect(values).toEqual({ logger: { level: 'warn' }, store: { timeout: 5000 }, browser: { extra: { a: 1 } } });
  });

  it('非 JSON 的环境变量退回字符串，空串不被吃成 undefined', () => {
    expect(parseEnvValue('boss-zh')).toBe('boss-zh');
    expect(parseEnvValue('')).toBe('');
    expect(parseEnvValue('true')).toBe(true);
  });

  it('setPath 能按需补数组', () => {
    const target: Record<string, unknown> = {};
    setPath(target, 'plugins.0.id', 'config');
    expect(target).toEqual({ plugins: [{ id: 'config' }] });
  });

  it('空路径段直接报错，不会静默写出怪结构', () => {
    expect(() => setPath({}, 'a..b', 1)).toThrow(/非法配置路径/);
  });
});
