/**
 * 测试用的日志落盘等待（4.3-12 起是两份装配用例共用的读数前置）。
 *
 * 为什么需要等而不是直接读：`plugin-logger` 用 `createWriteStream(file, { flags: 'a' })`，
 * `write()` 只保证**入队顺序**、不保证同步可见；固定 sleep 则在慢机器上会截到半截日志，
 * 让「查不到原文哨兵」这种负向断言变成假通过。等到最后一行出现之后再读全文，
 * 顺序保证它之前的所有行都已刷完，负向断言覆盖的才是整条链路。
 * 抽成一份而不是在两个测试文件各写一遍（AGENTS.md §2.2）：4.3-e 的检索脱敏用例与 4.4-a 的拆解脱敏用例
 * 判的是同一件事——日志里有计数、没有正文。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 轮询次数与间隔：40 × 50ms = 2 秒，比一次冷启动写盘的抖动宽，又不至于让挂掉的用例吊死整轮测试。 */
const MAX_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 50;

/**
 * 轮询等待日志文件里出现指定子串，并返回当时的完整日志文本。
 * @param file 日志文件绝对路径（取 `asApp(ctx).log.filePath`）
 * @param needle 期待出现的标记（本用例传最后一次操作的日志行关键词）
 * @returns 落盘后的完整日志文本
 * @throws 2 秒内没等到时抛错——宁可用例红，不要给出「查不到所以干净」的假通过
 */
export async function waitForLogLine(file: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(needle)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`日志里 2 秒内没出现「${needle}」一行，脱敏断言失去了前提`);
}
