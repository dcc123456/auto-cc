/**
 * 文件选择器参数判定的单测（spec 4.1-01 / 3.5-01 的入口半边）。
 *
 * 判的是"渲染层递来的选择器参数能不能进 Electron"：这一口把系统面板开在人面前，
 * 参数只有标题与筛选器，但筛选器扩展名会被拼进 Electron 的 filters，所以越界形状必须被拒。
 */
import { describe, expect, it } from 'vitest';
import { decideOpenPicker, decideSavePicker } from './file-picker.js';

/** 一份合法参数（其余用例在它上面各改一处）。 */
function validRequest() {
  return { title: '选择要导入的简历文件', filters: [{ name: '简历文件', extensions: ['pdf', 'docx', 'md', 'txt'] }] };
}

describe('打开面板的参数判定', () => {
  it('合法参数被接纳，扩展名统一转小写', () => {
    const decision = decideOpenPicker({ title: ' 选择文件 ', filters: [{ name: 'PDF', extensions: ['PDF'] }] }, 3);
    expect(decision.isAccepted).toBe(true);
    if (decision.isAccepted) expect(decision.options.filters[0]?.extensions).toEqual(['pdf']);
  });

  // 这一条照的是 `ResumeDesk.pickAndImport` 的真实形状（两组筛选器，第二组是界面上明写的「所有文件」）。
  // 上一条夹具只有一组，所以"星号被拒 → 原生面板从不弹出来"这个断裂在四道门禁里全绿躲过了整整一轮。
  it('渲染层真实发的两组形状（含「所有文件」那一组）被接纳', () => {
    const decision = decideOpenPicker(
      {
        title: '选择要导入的简历文件',
        filters: [
          { name: '简历文件', extensions: ['pdf', 'docx', 'md', 'txt'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      },
      3,
    );
    expect(decision.isAccepted).toBe(true);
    if (decision.isAccepted) {
      expect(decision.options.filters).toHaveLength(2);
      expect(decision.options.filters[1]?.extensions).toEqual(['*']);
    }
  });

  it.each([
    ['不是对象', null],
    ['标题为空', { ...validRequest(), title: '  ' }],
    ['标题超长', { ...validRequest(), title: 'x'.repeat(61) }],
    ['筛选器为空', { ...validRequest(), filters: [] }],
    [
      '筛选器组数越界',
      {
        ...validRequest(),
        filters: [
          validRequest().filters[0]!,
          validRequest().filters[0]!,
          validRequest().filters[0]!,
          validRequest().filters[0]!,
        ],
      },
    ],
    ['扩展名带路径分隔符', { ...validRequest(), filters: [{ name: '简历文件', extensions: ['../etc/passwd'] }] }],
    ['扩展名带点', { ...validRequest(), filters: [{ name: '简历文件', extensions: ['.pdf'] }] }],
    ['扩展名不是字符串', { ...validRequest(), filters: [{ name: '简历文件', extensions: [1] }] }],
    [
      '星号与别的扩展名混写（自相矛盾的一组）',
      { ...validRequest(), filters: [{ name: '简历文件', extensions: ['*', 'pdf'] }] },
    ],
  ])('%s 被拒并带回原因', (_label: string, raw: unknown) => {
    const decision = decideOpenPicker(raw, 3);
    expect(decision.isAccepted).toBe(false);
  });
});

describe('另存为的参数判定', () => {
  it('合法参数带上 defaultPath（渲染层给的建议名）', () => {
    const decision = decideSavePicker({ ...validRequest(), defaultFileName: 'resume-edit.pdf' }, 3);
    expect(decision.isAccepted).toBe(true);
    if (decision.isAccepted) expect(decision.options.defaultPath).toBe('resume-edit.pdf');
  });

  it.each([
    ['空名', ''],
    ['带目录分隔符', 'a/b.pdf'],
    ['带 Windows 分隔符', 'a\\b.pdf'],
    ['含 ..', '..evil.pdf'],
  ])('%s 的默认文件名被拒', (_label: string, name: string) => {
    expect(decideSavePicker({ ...validRequest(), defaultFileName: name }, 3).isAccepted).toBe(false);
  });
});
