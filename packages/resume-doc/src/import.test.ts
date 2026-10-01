/**
 * 容错导入用例（spec 3.1-09 未知字段丢弃并告警，而非静默保留 / 直接判非法）。
 */
import { describe, expect, it } from 'vitest';
import { importExternal } from './import.js';
import { validateDocument } from './schema.js';

describe('3.1-09 外部/旧格式导入', () => {
  it('顶层未知字段被丢弃并产生告警，文档仍合法', () => {
    const result = importExternal({ id: 'r', name: '张三', avatar_url: 'http://x', referee: '内推码123' }, 'r', 1);
    expect(result.warnings.some((w) => w.kind === 'unknown-field-dropped' && w.path.includes('avatar_url'))).toBe(true);
    expect(result.document.sections).toEqual([]);
    expect(validateDocument(result.document).ok).toBe(true);
  });

  it('导入产出的文档不含任何被丢弃的未知字段', () => {
    const result = importExternal({ name: '张三', unknownBlock: { deep: 1 } }, 'r', 1);
    const json = JSON.stringify(result.document);
    expect(json).not.toContain('unknownBlock');
  });

  it('类型不符走兜底并记 coerced 告警', () => {
    const result = importExternal({ name: 12345, layout: { columns: 99 } }, 'r', 1);
    expect(result.warnings.some((w) => w.kind === 'coerced')).toBe(true);
    expect(result.document.layout.columns).toBeLessThanOrEqual(2);
  });

  it('能映射合法区块/条目/字段，且重新按区块种类计算事实锁定（不信外部 locked）', () => {
    const result = importExternal(
      {
        name: '张三',
        sections: [
          {
            id: 'exp',
            kind: 'experience',
            title: '经历',
            entries: [{ id: 'e1', fields: [{ key: 'company', value: '星桥', locked: false }] }],
          },
        ],
      },
      'r',
      1,
    );
    const company = result.document.sections[0]?.entries[0]?.fields.find((f) => f.key === 'company');
    // 外部谎报 locked:false，导入轨按 experience.company 重算为锁定。
    expect(company?.locked).toBe(true);
    expect(company?.factKey).toBe('company');
  });

  it('非对象输入回退为空文档，不抛异常', () => {
    const result = importExternal('garbage', 'r', 1);
    expect(validateDocument(result.document).ok).toBe(true);
    expect(result.warnings.some((w) => w.path === '(root)')).toBe(true);
  });

  it('未知区块 kind 的区块被丢弃并告警', () => {
    const result = importExternal({ sections: [{ id: 'x', kind: 'banana', title: '', entries: [] }] }, 'r', 1);
    expect(result.document.sections).toHaveLength(0);
    expect(result.warnings.some((w) => w.kind === 'coerced' && w.path.includes('kind'))).toBe(true);
  });
});
