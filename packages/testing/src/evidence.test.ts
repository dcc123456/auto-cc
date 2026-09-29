/**
 * 证据归档命名规则单测（spec 1.6-11）。
 *
 * 命名不是格式问题：`.githooks/pre-commit` 只放行 `docs/acceptance/<子计划>/<spec-id>-*.png`，
 * 名字错了证据就进不了库，验收记录会缺一块。所以把钩子的形状钉在测试里。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveEvidence, evidenceName, SPEC_ID_PATTERN } from './evidence.js';

const HOOK_PATTERN =
  /^docs\/acceptance\/[^/]+\/[0-9][0-9.]*-[0-9]+[a-z]?[A-Za-z0-9._-]*\.(png|jpe?g|webp|gif|bmp|tiff)$/;

describe('evidenceName', () => {
  it('空格转连字符，缺省时用源文件名', () => {
    expect(evidenceName('1.6-04', '/tmp/x.png', 'native click')).toBe('1.6-04-native-click.png');
    expect(evidenceName('1.6-03', '/tmp/my_shot.png')).toBe('1.6-03-my-shot.png');
  });

  it('中文后缀直接拒绝——钩子只放行 ASCII 文件名', () => {
    expect(() => evidenceName('1.6-02', '/tmp/shot.png', '看到 面板')).toThrow(/ASCII/);
  });

  it('已按条目号命名的文件不再二次加前缀', () => {
    expect(evidenceName('1.6-02', '/tmp/1.6-02-sees-panel.png')).toBe('1.6-02-sees-panel.png');
  });

  it('条目号与扩展名不合规时拒绝', () => {
    expect(() => evidenceName('1.6', '/tmp/a.png')).toThrow(/条目号/);
    expect(() => evidenceName('1.6-02', '/tmp/a.exe')).toThrow(/证据类型/);
  });

  it('产出的名字逐条通过 pre-commit 钩子的放行正则', () => {
    const relative = path.posix.join('docs/acceptance/1.6', evidenceName('1.6-11', '/tmp/shot.png', 'archive'));
    expect(HOOK_PATTERN.test(relative)).toBe(true);
  });
});

describe('archiveEvidence', () => {
  it('复制到 docs/acceptance/<子计划>/，重复归档原地不动', () => {
    const repoRoot = path.join(tmpdir(), `auto-cc-evidence-${String(Date.now())}`);
    mkdirSync(repoRoot, { recursive: true });
    const source = path.join(repoRoot, 'scratch.png');
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const first = archiveEvidence(repoRoot, '1.6-01', [source], 'cdp-list');
    expect(first.dir.endsWith(path.join('acceptance', '1.6'))).toBe(true);
    expect(first.files[0]?.target.endsWith('1.6-01-cdp-list.png')).toBe(true);
    expect(first.files[0]?.isFresh).toBe(true);
    // 第二次拿归档结果再归档：路径已在证据目录里，不该复制出副本。
    const again = archiveEvidence(repoRoot, '1.6-01', [first.files[0]?.target as string]);
    expect(again.files[0]?.isFresh).toBe(false);
  });

  it('源文件不存在时点名', () => {
    expect(() => archiveEvidence(tmpdir(), '1.6-01', ['/definitely/missing.png'])).toThrow(/不存在/);
  });

  it('条目号形状与钩子一致（1.10-11a 这类也要能吃下）', () => {
    expect(SPEC_ID_PATTERN.test('1.6-01')).toBe(true);
    expect(SPEC_ID_PATTERN.test('1.10-11a')).toBe(true);
    expect(SPEC_ID_PATTERN.test('v1.6')).toBe(false);
  });
});
