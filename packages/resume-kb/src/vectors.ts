/**
 * `kb_vectors` —— 检索切片的**向量派生索引**（spec 4.3-07 / 08，plan §4.3-d 实现形状 3）。
 *
 * 与 `kb_chunks` 同一个身份：派生索引而不是第二套真相（plan §4.3 口径 3）。一条向量完全由
 * `kb_chunks.text` + 当前配置的 embedding 模型现算，任何时候删掉这张表都能靠 `syncVectors()` 重建，
 * 库里没有任何别的东西依赖它——所以 4.3-08 才敢要求「向量不可用时绝不产生伪向量」：
 * 这张表**空着**就是正确的状态，而不是需要被修补的状态。
 *
 * 三条来自实测/文档的形状约束（plan §4.3-d 证据）：
 * - `vec` 存 **float32 小端** 裸字节（`Float32Array.buffer`），1024 维 = 4096 字节/条；
 *   不用 JSON 文本：同一批数据的体积是它的 3～4 倍，而 SQLite 里既没有数组类型也没有余弦函数，
 *   存文本只会让读路径多一次解析。
 * - `model` 是**失效判据**：换 embedding 模型后旧向量与新查询向量不同源，余弦毫无意义，
 *   所以取数一律按 `model = 当前配置模型` 过滤，而不是「表里有行就用」。
 * - `dim` 落库而不是从配置读：bge-m3 的 1024 只是文档读数（证据 [3]），实际维度以响应为准；
 *   代码里写死维度就等于把「换模型要改代码」埋回实现（4.3-03 的口径）。
 *
 * 相似度用**余弦**而不是内积：bge-m3 的输出未归一化，内积会把「这条切片更长」算成「更相关」。
 * 纯函数、不碰 SQLite、不认识 cordis，与 `search.ts` 同构，可离线逐条断言。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 向量表的迁移号段（spec 4.3-07，紧随倒排索引的 13）。 */
export const KB_VECTOR_MIGRATION_VERSION = 14;

export const kbVectorsMigration = {
  version: KB_VECTOR_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 主键就是 `chunk_id`：一条切片最多一份向量。重复同步走 upsert，所以「补一遍」是幂等的。
    db.exec(`CREATE TABLE IF NOT EXISTS kb_vectors (
      chunk_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // 取数与补建都以「哪些切片还没有这个模型的向量」为主查询形态，所以给 `model` 建索引而不是 `chunk_id`（后者已是主键）。
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_vectors_model ON kb_vectors (model)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS kb_vectors');
  },
};

/** 一条向量的取数行（`chunk_id` 用来回 join 主表，`vec` 是 float32 裸字节）。 */
export interface KbVectorRow {
  readonly chunkId: string;
  readonly vec: unknown;
}

/**
 * 向量 → 存进 BLOB 的字节。
 * @param vector 一组有限数字（`llm.embed` 的一条响应）
 * @returns float32 小端字节序列（Node 与 SQLite 在本机都是小端，见 AGENTS.md §9 的 node:sqlite 实测）
 */
export function encodeVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

/**
 * BLOB → 向量。
 * @param blob `node:sqlite` 读回来的 BLOB（`Uint8Array`；老版本驱动可能给 `Buffer`，两者同构）
 * @returns 与写入等长的 number 数组；字节数不是 4 的倍数（被改坏或截断）时给**空数组**，调用方据此跳过
 * @remarks 这里必须先把字节复制进一份自己的 `ArrayBuffer`：`Float32Array` 视图要求 `byteOffset`
 *          4 字节对齐，而驱动返回的切片不保证对齐，直接视图会在个别平台上抛 `RangeError`。
 */
export function decodeVector(blob: unknown): number[] {
  if (!(blob instanceof Uint8Array) || blob.byteLength % 4 !== 0) return [];
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob);
  return [...new Float32Array(bytes.buffer)];
}

/**
 * 余弦相似度。
 * @param left 向量 A（有限数字）
 * @param right 向量 B（长度必须与 A 相同）
 * @returns -1～1；任一侧为零向量时给 **0**（不是 NaN——「算不出相关性」与「相关性为 0」在排序里等价，
 *          而 NaN 会污染比较结果）
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

/** 一条向量命中的读数。 */
export interface KbVectorScore {
  readonly chunkId: string;
  /** 余弦，已按 4 位小数取整（浮点尾差会让排序断言不稳定，同 `search.ts` 的合并分口径） */
  readonly cosine: number;
}

/**
 * 用一句查询向量给全库切片排个序（线性扫描 + 截断）。
 * @param queryVector 查询侧向量（`llm.embed` 编出来的一句）
 * @param rows 当前模型下的全部向量行
 * @param limit 最多带回几条（给 RRF 用的是 `searchTopK`，多带回不会改变头部次序只是白算余弦）
 * @returns 按余弦倒序、同分按 `chunkId` 升序的命中；`limit ≤ 0` 时为空
 * @remarks 这里是**全量线性扫描**而不是近似 ANN：个人知识库的量级是几百到几千条切片
 *          （4.3-05 明确不引入外部向量库），一万维以内的暴力算在毫秒级，
 *          而 HNSW/IVF 要么带原生扩展（4.3-06 禁止）要么带第三方进程。P95 实测归 4.3-e。
 */
export function rankByCosine(
  queryVector: readonly number[],
  rows: readonly KbVectorRow[],
  limit: number,
): KbVectorScore[] {
  const scored: KbVectorScore[] = [];
  for (const row of rows) {
    const vector = decodeVector(row.vec);
    if (vector.length === 0) continue;
    scored.push({
      chunkId: row.chunkId,
      cosine: Math.round(cosineSimilarity(queryVector, vector) * 10_000) / 10_000,
    });
  }
  scored.sort((left, right) => right.cosine - left.cosine || (left.chunkId < right.chunkId ? -1 : 1));
  return limit > 0 ? scored.slice(0, limit) : [];
}
