/**
 * 用户给出的绝对路径 → 受字节上限约束的字节（AGENTS.md §2.2：这条逻辑在简历导入之后第二次被用到）。
 *
 * 为什么住在 `core` 而不是各自包内：读取者分属两个 L2 域包（`resume-kb` 的导入腿、`pdf-edit` 的编辑腿），
 * 让它们互相 import 就是同级横向引用（§4.1）；而错误码 `AppErrorCode` 与 `AppError` 本来就在这一层。
 * **只经子路径出口**（`@auto-cc/core/file-read`），不进 `src/index.ts` 门面——它带 `node:fs`，
 * 并进门面就会把 Node 能力拖进渲染层 bundle（同 `shared/src/bridge.ts` 记过的那次 `node:path` 事故）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AppError, type AppErrorCode } from './errors.js';

/** 一次受控读取的可调项。 */
export interface BoundedReadOptions {
  /** 字节上限：超过即以 `code` 失败，不把整个文件读进内存再判（那是主进程被吃掉的形状）。 */
  readonly maxBytes: number;
  /** 失败时用的错误码：由调用方决定，因为「导入简历读不出」与「打开待编辑的 PDF 读不出」在界面上是两套话术。 */
  readonly code: AppErrorCode;
}

/**
 * 按绝对路径读出文件字节，并在读之前卡住大小。
 * @param filePath 用户提供的**绝对路径**（相对路径一律拒绝：主进程的工作目录不是用户预期的那个）
 * @param options 字节上限与失败错误码
 * @returns 文件字节（新分配的副本，交给三方库前无需再复制）
 * @throws `AppError(options.code)`——非绝对路径 / 不存在 / 不是普通文件 / 超过上限，四种都收敛成这一个码
 */
export function readBoundedFile(filePath: string, options: BoundedReadOptions): Uint8Array {
  if (!isAbsolute(filePath)) {
    throw new AppError(options.code, `路径必须是绝对路径：${filePath}`);
  }
  if (!existsSync(filePath)) {
    throw new AppError(options.code, `没有找到这个文件：${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new AppError(options.code, `这不是一个文件：${filePath}`);
  }
  if (stat.size > options.maxBytes) {
    throw new AppError(
      options.code,
      `这份文件 ${String(stat.size)} 字节，超过上限 ${String(options.maxBytes)} 字节：${filePath}`,
    );
  }
  return new Uint8Array(readFileSync(filePath));
}

/**
 * 字节 → sha256 十六进制小写（来源哈希 / 产物指纹的唯一实现）。
 * @param bytes 待摘要的字节；本函数不消费它，调用方可继续把同一份字节交给别处
 * @returns 64 位十六进制串
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
