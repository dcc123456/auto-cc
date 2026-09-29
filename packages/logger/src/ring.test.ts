import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring.js';

describe('环形缓冲（spec 1.3-04）', () => {
  it('未满时按插入顺序返回', () => {
    const buffer = new RingBuffer<number>(5);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.toArray()).toEqual([1, 2]);
    expect(buffer.length).toBe(2);
  });

  it('写满后覆盖最旧且长度不超容量', () => {
    const buffer = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([3, 4, 5]);
  });

  it('clear 之后可继续写入', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
    buffer.push(7);
    expect(buffer.toArray()).toEqual([7]);
  });

  it('容量非法直接报错', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(/正整数/);
    expect(() => new RingBuffer<number>(1.5)).toThrow(/正整数/);
  });
});
