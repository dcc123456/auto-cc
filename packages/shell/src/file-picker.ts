/**
 * 文件选择器的参数判定（纯函数，可单测；真正调 `dialog` 的那一半在 `index.ts`，与 `reveal-target.ts` 同一分层）。
 *
 * 为什么需要这一层：渲染层在 `contextIsolation + sandbox` 下没有任何读文件的通道（§8.1），
 * 而"导入一份本机简历""打开一份 PDF""另存为"这三条主流程都要求人**选**一个文件。
 * 过去的写法是让人在输入框里敲绝对路径——路径打不出来，按钮就一直是禁用态，
 * 于是简历轨在界面上根本走不通。这一口把"选文件"交回给操作系统，主进程只把人选中的那条路径回给渲染层。
 *
 * 安全口径与 `reveal-target.ts` 相反方向，因此同样要有判定：reveal 是"渲染层给路径、主进程开目录"，
 * 这里是"主进程问人、把人选中的路径交回去"。参数里能进主进程的只有**筛选器扩展名与标题文案**，
 * 所以扩展名必须逐个验形状（不验就等于把 `..`、`/` 这类值拼进 Electron 的 filters），
 * 且一次只允许选一个文件（`openFile` 而非 `openDirectory`/多选，避免拿到整棵目录树）。
 */

/** 渲染层递来的选择器参数（合法形状）。 */
export interface FilePickerRequest {
  /** 对话框标题（渲染层已按当前语言翻好的文案；主进程不写界面文案） */
  title: string;
  /** 筛选器，最多三组；每组一个显示名与若干扩展名（不含点） */
  filters: { name: string; extensions: string[] }[];
}

/** 另存为的补充参数。 */
export interface SaveFilePickerRequest extends FilePickerRequest {
  /** 建议的默认文件名（不含目录） */
  defaultFileName: string;
}

/** 判定结局：接纳时带回可直接交给 Electron 的选项，拒绝时带回原因与一句给人读的话。 */
export type PickerDecision<T> = { isAccepted: true; options: T } | { isAccepted: false; reason: string };

/** 合法扩展名：字母数字与 `-_`，1–10 位（PDF/DOCX/md/text 全在内，路径字符全在外）。 */
const EXTENSION_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;

/**
 * 校验渲染层递来的选择器参数。
 * @param raw IPC 进来的实参（`unknown`：网关只校验"调的是哪个方法"，不校验参数）
 * @param maxFilters 筛选器组数上限（超过即视为异常形状，直接拒）
 * @returns 接纳时带回 `title` 与已逐个验过的 `filters`
 */
export function decideOpenPicker(
  raw: unknown,
  maxFilters: number,
): PickerDecision<{ title: string; filters: { name: string; extensions: string[] }[] }> {
  const parsed = readRequest(raw, maxFilters);
  if ('reason' in parsed) return { isAccepted: false, reason: parsed.reason };
  return { isAccepted: true, options: { title: parsed.title, filters: parsed.filters } };
}

/**
 * 校验"另存为"的选择器参数（在通用校验之上再要求一个安全的默认文件名）。
 * @param raw IPC 进来的实参
 * @param maxFilters 筛选器组数上限
 * @returns 接纳时带回可直接交给 `showSaveDialog` 的选项
 */
export function decideSavePicker(
  raw: unknown,
  maxFilters: number,
): PickerDecision<{ title: string; filters: { name: string; extensions: string[] }[]; defaultPath: string }> {
  const parsed = readRequest(raw, maxFilters);
  if ('reason' in parsed) return { isAccepted: false, reason: parsed.reason };
  const fileName = (raw as SaveFilePickerRequest).defaultFileName.trim();
  // 默认名不许带路径分隔符与 `..`：它是唯一由渲染层决定的落点提示，越界就拒。
  if (fileName === '' || /[\\/:*?"<>]|\.\./.test(fileName)) {
    return { isAccepted: false, reason: `默认文件名不合法：${fileName}` };
  }
  return { isAccepted: true, options: { title: parsed.title, filters: parsed.filters, defaultPath: fileName } };
}

/**
 * 读并校验公共形状（标题长度、筛选器组数、每个扩展名）。
 * @param raw 未受信实参
 * @param maxFilters 筛选器组数上限
 * @returns 带原因码形状的成功值或 `{ reason }`
 */
function readRequest(
  raw: unknown,
  maxFilters: number,
): { title: string; filters: { name: string; extensions: string[] }[] } | { reason: string } {
  if (typeof raw !== 'object' || raw === null) return { reason: '选择器参数不是对象' };
  const request = raw as FilePickerRequest;
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  if (title === '' || title.length > 60) return { reason: '标题为空或超过 60 字' };
  if (!Array.isArray(request.filters) || request.filters.length === 0 || request.filters.length > maxFilters) {
    return { reason: `筛选器需 1–${String(maxFilters)} 组` };
  }
  const filters: { name: string; extensions: string[] }[] = [];
  for (const group of request.filters) {
    const name = typeof group?.name === 'string' ? group.name.trim() : '';
    if (name === '' || name.length > 40) return { reason: '筛选器名称为空或超过 40 字' };
    if (!Array.isArray(group.extensions) || group.extensions.length === 0 || group.extensions.length > 12) {
      return { reason: `筛选器「${name}」的扩展名数量不合法` };
    }
    for (const extension of group.extensions) {
      if (typeof extension !== 'string' || !EXTENSION_PATTERN.test(extension)) {
        return { reason: `扩展名不合法：${String(extension)}` };
      }
    }
    filters.push({ name, extensions: group.extensions.map((extension) => extension.toLowerCase()) });
  }
  return { title, filters };
}
