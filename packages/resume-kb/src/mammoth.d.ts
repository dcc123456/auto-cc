/**
 * `mammoth` 未随包发布类型声明（实测 `package.json` 无 `types` / `exports` 字段，registry 上也没有
 * `@types/mammoth`），这里只声明本包实际用到的那一个函数，其余能力不臆造。
 * 运行时形态已由 spike 实测：`extractRawText({ buffer })` → `{ value, messages }`。
 */
declare module 'mammoth' {
  /** mammoth 对文档里未识别元素给出的告警项。 */
  export interface MammothMessage {
    readonly type: string;
    readonly message: string;
  }

  /** `extractRawText` 的返回：段落之间以空行分隔的纯文本 + 告警列表。 */
  export interface MammothRawTextResult {
    readonly value: string;
    readonly messages: readonly MammothMessage[];
  }

  /**
   * 从 DOCX 字节抽纯文本。
   * @param input `buffer` 为整个 .docx 文件的字节（zip 容器）
   * @returns 抽出的文本；输入不是合法 docx 时 reject
   */
  export function extractRawText(input: { readonly buffer: Uint8Array }): Promise<MammothRawTextResult>;
}
