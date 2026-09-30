/**
 * `node:sqlite` 读数出口处的一次收窄。
 *
 * 为什么要抽：驱动默认把 INTEGER 回成 `number`，但超过 `2^53` 或列里躺着别人写进来的
 * 大整数时会回 `bigint`，而 `bigint` 过不了 IPC 结构化克隆（渲染层会拿到一次
 * "could not be cloned"）。每张表的视图转换都要处理这件事，所以它在 core 只写一遍。
 */

/**
 * 把库里的可空整数收成 `number | null`。
 * @param value 列的原始读数（`bigint` / `number` / `null`，缺列时还会是 `undefined`）
 * @returns 可序列化整数；空值原样回 null，**不用 0 冒充「库里没有」**
 */
export function asSqlInt(value: number | bigint | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * 把库里的非空整数收成 `number`。
 * @param value 列的原始读数；`NOT NULL` 列在读出后仍可能是 `bigint`
 * @returns 可序列化整数；缺列时回 0（调用方是 `COUNT(*)` 这类必有值的读数）
 */
export function asSqlCount(value: number | bigint | null | undefined): number {
  return Number(value ?? 0);
}
