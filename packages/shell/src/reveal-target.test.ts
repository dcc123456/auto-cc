/**
 * `reveal-target.ts` 的判定用例（spec 6.2-12）。
 *
 * 这一口的实参来自渲染层，形状没有任何保证，所以用例全部围着"边界"与"目标在不在"两条打；
 * `showItemInFolder` 本身不在这里验（它需要 Electron 运行期，且活体那一腿在界面上跑）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRevealTarget } from './reveal-target.js';

describe('在文件管理器中显示的目标判定', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'auto-cc-reveal-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('userData 之内且磁盘上真存在的产物被接纳，带回解析后的绝对路径', () => {
    const pdf = path.join(root, 'resume-1-classic.pdf');
    writeFileSync(pdf, 'x');
    expect(resolveRevealTarget(pdf, root)).toEqual({ isAccepted: true, resolvedPath: pdf });
    // 相对路径进不来：`path.resolve` 会按进程工作目录补全，那已经不是应用目录里的那一份。
    expect(resolveRevealTarget('resume-1-classic.pdf', root)).toMatchObject({
      isAccepted: false,
      code: 'REVEAL_OUTSIDE_USER_DATA',
    });
  });

  it('兄弟目录名以应用目录开头也不放行（`auto-cc` 不能顺带放过 `auto-cc-evil`）', () => {
    const evilRoot = `${root}-evil`;
    writeFileSync(path.join(root, 'note.txt'), 'x');
    const outside = path.join(evilRoot, 'note.txt');
    expect(resolveRevealTarget(outside, root)).toMatchObject({
      isAccepted: false,
      code: 'REVEAL_OUTSIDE_USER_DATA',
    });
  });

  it('指向根目录本身、相对路径、空串与非字符串实参都按越界拒绝', () => {
    expect(resolveRevealTarget(root, root)).toMatchObject({ code: 'REVEAL_OUTSIDE_USER_DATA' });
    expect(resolveRevealTarget('exports/x.pdf', root)).toMatchObject({ code: 'REVEAL_OUTSIDE_USER_DATA' });
    expect(resolveRevealTarget('', root)).toMatchObject({ code: 'REVEAL_OUTSIDE_USER_DATA' });
    expect(resolveRevealTarget(42, root)).toMatchObject({
      isAccepted: false,
      code: 'REVEAL_OUTSIDE_USER_DATA',
    });
  });

  it('边界内但磁盘上已经没有了，单独报 `REVEAL_TARGET_MISSING`（库返回 void，存在性只能自己判）', () => {
    expect(resolveRevealTarget(path.join(root, 'gone.pdf'), root)).toMatchObject({
      isAccepted: false,
      code: 'REVEAL_TARGET_MISSING',
    });
  });
});
