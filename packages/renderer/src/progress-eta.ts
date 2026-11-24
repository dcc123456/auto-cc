/**
 * 「还要多久」的估算（2026-11-24 萌新 P1：抓 11 条要 2 分 20 秒，界面只写进度、不写还要多久，人只能干等）。
 *
 * 只按**已经发生的推送**算速率，不猜固定倍数，也不新增定时器：节流间隔是配置项，写死一个常数就是编数字。
 * 数据不够（还没入库过、时间跨度太短）时返回 null——界面据此不显示"约剩"，而不是显示一个假的 0 秒。
 */

/** 一条 `jd/progress` 读数里与速率有关的两格。 */
export interface CaptureSample {
  /** 到这条推送为止已入库的条数 */
  stored: number;
  /** 推送时间戳（毫秒） */
  at: number;
}

/** 算速率至少要跨过的时长：短于 1 秒的两条推送算不出可信速率。 */
const MIN_SPAN_MS = 1_000;

/**
 * 按已观测到的入库速率估算剩余秒数。
 * @param samples 收到的进度读数（顺序不限，内部按时间排序）；至少两条且其中一条已入库过
 * @param target 本次运行的目标条数
 * @returns 估算的剩余整秒数；算不出（样本不够/已达目标/单位为 0）时为 null
 */
export function captureEtaSeconds(samples: readonly CaptureSample[], target: number): number | null {
  if (!Number.isFinite(target) || target <= 0) return null;
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.stored) && Number.isFinite(sample.at))
    .sort((left, right) => left.at - right.at);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (first === undefined || last === undefined) return null;
  const remaining = target - last.stored;
  if (remaining <= 0) return null;
  const spanMs = last.at - first.at;
  const grown = last.stored - first.stored;
  // 速率必须真的为正：节流期间连续两条 stored 不变时 dStored=0，此时给不出估计。
  if (spanMs < MIN_SPAN_MS || grown <= 0) return null;
  return Math.ceil((remaining * spanMs) / grown / 1000);
}
