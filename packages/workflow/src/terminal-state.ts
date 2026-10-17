/**
 * 终态跳过的**纯判断层**（spec 5.11-03 / 5.11-04）。
 *
 * 这一层不碰数据库、不碰页面、不碰时钟：输入是一份判据声明加一份只读快照，输出是一个布尔。
 * 之所以单独成文件而不是塞进 runner：`enterNode` 要在**派执行器之前**问一句「这一步是不是
 * 早就做过了」，而那个问题一旦掺进 I/O 就再也测不动「守卫本身拒不拒绝某一行」——
 * 5.11-04 的判据正是要这一层无 I/O、可单测（browser-copilot 的 `provesLandedEffect` 同一个理由）。
 *
 * 守卫的来历：browser-copilot `lib/workflow/repair-verification.ts:85` 有一条硬边界——
 * **地址栏说明「run 在哪」，不说明「它做了什么」**。模型给「发布页上的那个按钮」写
 * `urlContains /publish/`，而发布页在标题有没有存下来之前都带着 `/publish/`，
 * 拿它当「已生效」的证据就等于把整条修复梯子一次关掉：每种策略都「通过」而什么都没做。
 *
 * 与对方的一处**刻意分歧**：那边终态判据保留 URL 豁免（跑到**另一个**地址正是动作落地留下的痕迹），
 * 本仓不给。理由是能力面：本仓的节点参数是标量、runner 没有地址栏读数通道，
 * 那一类行在这里**永远观测不到**（见 `WorkflowCondition` 的注释），
 * 放它过守卫只会写出一条永远不成立的声明。守卫按「宁可少跳一次，不许静默漏做」收紧。
 */
import type { WorkflowCondition } from '@auto-cc/core';

/** 地址栏那一族判据的 kind：读数只说明位置，不说明动作。 */
const URL_CONDITION_KINDS: readonly WorkflowCondition['kind'][] = ['urlContains'];

/**
 * 这一行判据能不能证明「失败那一步的落地效果已经成立」。
 *
 * 纯形状判定：只看 kind，不看取值、不读任何现场。拒绝的这一族正是 F41 点名的
 * 「地址栏在 `/publish/` 上」——它在动作之前就为真，所以它证明不了任何事。
 * @param condition 一条判据声明
 * @returns true 表示这一行可以当作「已生效」的证据
 */
export function provesLandedEffect(condition: WorkflowCondition): boolean {
  return !URL_CONDITION_KINDS.includes(condition.kind);
}

/**
 * 终态判断要读的那份**只读快照**（全部来自 run store，不含任何现场读数）。
 *
 * 刻意不带 `url` 之类的页面读数：本仓没有那个通道，带上就等于把「观测」这件事说成可选项。
 */
export type TerminalStateReading = {
  /** 这一格自己的相位里有没有 `sideEffectObserved`（外发落地被观察到）。 */
  effectObserved: boolean;
  /** 同一份计划里已经落定的格子 id（`done` 或 `skipped`）。 */
  committedNodeIds: readonly string[];
};

/**
 * 判「这个位置的终态是不是已经成立」——成立就不该再派一次执行器。
 *
 * 三条口径逐条对应 browser-copilot `repair-verification.ts:164-171` 记下的坑：
 * ① **空列表不是成立**：没有终态判据的节点照旧走 `needs-human`，不因「没说要跳过」而放行；
 * ② **守卫先于观测**：证明不了落地效果的那一行直接出局，哪怕它恰好「看起来满足」；
 * ③ **没观测到就是不成立**：判据种类不认识、或快照里没有对应读数，都返回 false——
 *    把「没查」读成「成立」就是把证据的缺席当成功，那正是这一整套守卫要防的事。
 * @param conditions 节点声明的终态判据；省略或空数组即不成立
 * @param reading run store 给出的只读快照
 * @returns true 表示终态已成立，可以不重放
 */
export function terminalStateHolds(
  conditions: readonly WorkflowCondition[] | undefined,
  reading: TerminalStateReading,
): boolean {
  if (!conditions || conditions.length === 0) return false;
  return conditions.every((condition) => {
    if (!provesLandedEffect(condition)) return false;
    if (condition.kind === 'effectObserved') return reading.effectObserved;
    if (condition.kind === 'nodeCommitted') {
      // 没指名格子的一行直接判不成立，而不是拿空串去比：空串在快照里唯一可能来自一条畸形读数，
      // 拿它匹配等于把「缺省」读成「匹配到了计划里第一个空格子的节点」。
      const named = condition.nodeId;
      return named !== undefined && named !== '' && reading.committedNodeIds.includes(named);
    }
    // 走到这里只可能是 `urlContains`：守卫已经放过它（今天不可能），而本仓没有地址栏读数可观测，
    // 所以它落在「没观测到」那一档——宁可这一格继续停在接管点上，也不静默跳过一次外发。
    return false;
  });
}
