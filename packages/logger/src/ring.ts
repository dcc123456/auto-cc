/** 定长环形缓冲（spec 1.3-04）：内存里只保留最近 N 条，写满后覆盖最旧，不随运行时长增长。 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private cursor = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`环形缓冲容量必须是正整数，收到 ${capacity}`);
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.slots[this.cursor] = item;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  /** 从最旧到最新，便于直接按时间顺序展示。 */
  toArray(): T[] {
    if (this.filled < this.capacity) return this.slots.slice(0, this.filled) as T[];
    return [...this.slots.slice(this.cursor), ...this.slots.slice(0, this.cursor)] as T[];
  }

  get length(): number {
    return this.filled;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.cursor = 0;
    this.filled = 0;
  }
}
