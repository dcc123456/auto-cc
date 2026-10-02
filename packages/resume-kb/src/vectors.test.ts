/**
 * 向量派生索引的纯函数用例（spec 4.3-07 / 4.3-08 的判定半边）。
 *
 * 与 `search.ts` 的用份文件同一个理由：**不开数据库**。`vectors.ts` 里全是
 * 「一串字节 → 一个余弦」的算式，离线断言才能把每条边界（字节数不是 4 的倍数、零向量、
 * 维度对不上）单独钉住；`kb_vectors` 的建表、按模型取数、失效清理在
 * `profile-service.test.ts` 的 4.3-d 小节判。
 *
 * 这里的向量全部自造（两三维的小样），真实模型是 bge-m3 的 1024 维，但算式与维度无关。
 */
import { describe, expect, it } from 'vitest';
import { type KbVectorRow, cosineSimilarity, decodeVector, encodeVector, rankByCosine } from './vectors.js';

describe('float32 字节的写入与读回（`vec` 列的唯一编解码口）', () => {
  it('整批能精确落在 float32 上的数字原样往返，字节数等于维度乘 4', () => {
    const vector = [1, -2, 0.5, 0.25, 1024, 0];
    const blob = encodeVector(vector);
    expect(blob).toBeInstanceOf(Uint8Array);
    // 「1024 维 = 4096 字节/条」这条体积口径（plan §4.3-d 证据 [3]）在这里等价可验：每维 4 字节。
    expect(blob.byteLength).toBe(vector.length * 4);
    expect(decodeVector(blob)).toEqual(vector);
  });

  it('float32 存不下的尾数按 float32 的精度丢掉，而不是解码报错', () => {
    // 这条不是缺陷而是**约定**：余弦比较用的是取整到 4 位小数的读数，float32 的相对误差约 1e-7，
    // 远小于取整步长，所以落库精度不会改变任何一条名次。写测试是为了防止有人把它改成存 JSON 文本。
    const faded = decodeVector(encodeVector([0.1]));
    expect(faded).toHaveLength(1);
    expect(faded[0]).toBeCloseTo(0.1, 7);
  });

  it('字节数不是 4 的倍数（被改坏或截断）给空数组，调用方据此跳过', () => {
    expect(decodeVector(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(decodeVector(new Uint8Array([]))).toEqual([]);
    expect(decodeVector(null)).toEqual([]);
    expect(decodeVector('不是字节')).toEqual([]);
  });

  it('驱动给的是错位的字节切片也能解码：先复制进自己的缓冲区再建视图', () => {
    // `Float32Array` 视图要求 `byteOffset` 4 字节对齐，而 SQLite 驱动返回的切片不保证对齐，
    // 直接视图在部分平台上抛 `RangeError`。这条用例就是那个防御动作的存在理由。
    const backing = new Uint8Array(1 + encodeVector([1, 2, 3, 4]).byteLength);
    backing.set(encodeVector([1, 2, 3, 4]), 1);
    expect(decodeVector(backing.subarray(1))).toEqual([1, 2, 3, 4]);
  });

  it('Buffer 形态的 BLOB 同样可解（老版本驱动的返回类型）', () => {
    expect(decodeVector(Buffer.from(encodeVector([3, -4])))).toEqual([3, -4]);
  });
});

describe('余弦相似度（为什么用余弦而不是内积）', () => {
  it('方向相同给 1、垂直给 0、方向相反给 -1', () => {
    expect(cosineSimilarity([1, 0], [3, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it('只看方向不看长短：未归一化的模型输出不会因为切片更长就被算成更相关', () => {
    // 这条是选型判据（文件头注释）：bge-m3 的输出未归一化，内积会给 `[100,0]` 一万分而余弦给 1，
    // 于是「一条把同一个词重复三遍的长经历」会稳定压过「一句正好说到点子上的短经历」。
    const short = [1, 1];
    const long = [100, 100];
    expect(cosineSimilarity(short, long)).toBeCloseTo(1, 10);
    const probe = [2, 0];
    expect(cosineSimilarity(short, probe)).toBeLessThan(cosineSimilarity(short, short));
  });

  it('零向量与长度不匹配都给 0 而不是 NaN', () => {
    // NaN 参与排序比较时两边都不成立，会让整个次序变成「取决于引擎 sort 实现」；0 是「算不出相关性」，
    // 在按余弦倒序的名单里等价于垫底，被 `vectorMinCosine` 挡掉就是它该有的下场。
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('按余弦给全库切片排序（`rankByCosine`）', () => {
  /** 造一条取数行：`vector` 按落库时那个编码写进去，读路径才能拿到与生产一致的 BLOB。 */
  function row(chunkId: string, vector: readonly number[]): KbVectorRow {
    return { chunkId, vec: encodeVector(vector) };
  }

  it('按余弦倒序，同分按 chunkId 升序（不依赖行的来序）', () => {
    const rows = [row('b-same', [1, 0]), row('a-same', [1, 0]), row('c-weak', [1, 3])];
    const ranked = rankByCosine([1, 0], rows, 10);
    expect(ranked.map((item) => item.chunkId)).toEqual(['a-same', 'b-same', 'c-weak']);
  });

  it('余弦取整到 4 位小数，让排序断言不受浮点尾差摆布', () => {
    // 1/√2 = 0.70710678…；不取整的话两侧差 1e-17 的同分切片，次序就会随平台与引擎版本漂。
    expect(rankByCosine([1, 1], [row('e', [1, 0])], 10)[0]?.cosine).toBe(0.7071);
  });

  it('limit 截断在排序之后，limit ≤ 0 给空名单', () => {
    const rows = [row('a', [0, 1]), row('b', [1, 0]), row('c', [1, 1])];
    expect(rankByCosine([1, 0], rows, 2).map((item) => item.chunkId)).toEqual(['b', 'c']);
    expect(rankByCosine([1, 0], rows, 1)).toEqual([{ chunkId: 'b', cosine: 1 }]);
    expect(rankByCosine([1, 0], rows, 0)).toEqual([]);
    expect(rankByCosine([1, 0], rows, -1)).toEqual([]);
  });

  it('解码不出向量的行直接跳过，而不是带一条 0 分混进名单', () => {
    // 真实来路是迁移或写入把 BLOB 截断了；留一条 0 分意味着「这条切片被算过且不相关」，
    // 而实际上它根本没被算——两者在 `vectorMinCosine` 之上与之下是两种播报。
    const rows: KbVectorRow[] = [
      { chunkId: 'broken', vec: new Uint8Array([1, 2, 3]) },
      { chunkId: 'null-ish', vec: null },
      row('good', [1, 0]),
    ];
    expect(rankByCosine([1, 0], rows, 10)).toEqual([{ chunkId: 'good', cosine: 1 }]);
  });

  it('空名单给空结果（库里还没有当前模型的向量 = 4.3-08 的正确状态）', () => {
    expect(rankByCosine([1, 0], [], 10)).toEqual([]);
  });
});
