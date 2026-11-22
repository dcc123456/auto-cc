/**
 * 机检：意图路由层**碰不到外发**（spec 10.11-16 / 2026-11-22 裁定④）。
 *
 * 路由只分类、处理器只读既有读数；「执行动作」这一类必须交回既有 `/tool` 那条带审批的路。
 * 判法是结构性的，不看行为：
 * ① 两份文件不许出现**发得出去**的那两只（`outbound.greet` / `outbound.deliver`），也不许出现授权单的写口
 *   （`grant` / `revoke` / `reconfirm`）；授权单的**读**（`authorization.current`）是「值守提醒」需要的，
 *   它不改状态、发不出任何东西，所以放行；
 * ② 两份文件不许 import `outbound`/`entitlement`/`platform-*` 任何包——它们连那些类型都不认识；
 * ③ 处理器里不许出现 `agent.loop.confirm` / `confirm(`：计划只许起草，不许在路由里替人确认。
 * 三条都是为了同一条：路由若自己能把动作发出去，「先分类再执行」就成了绕过审批的第二条通道。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const files = ['packages/agent/src/router.ts', 'packages/agent/src/route-handlers.ts'];
const failures: string[] = [];

for (const rel of files) {
  const code = readFileSync(path.join(repoRoot, rel), 'utf8');
  const lines = code.split('\n');
  lines.forEach((line, index) => {
    const at = `${rel}:${String(index + 1)}`;
    if (/\boutbound\.(greet|deliver)\b/.test(line)) {
      failures.push(`${at} 路由层出现了外发服务名：动作必须交回既有 /tool 那条带审批的路`);
    }
    if (
      /from\s+['"][^'"]*outbound[^'"]*['"]/.test(line) ||
      /from\s+['"]@auto-cc\/plugin-(entitlement|outbound)/.test(line)
    ) {
      failures.push(`${at} 路由层 import 了外发包：它不该认识外发的类型`);
    }
    if (/\bauthorization\.(grant|revoke|reconfirm)\b/.test(line)) {
      failures.push(`${at} 路由层出现了授权单的写口：路由只许读授权状态，不许自开/自改`);
    }
    if (/\bconfirm\s*\(|agent\.loop\.confirm/.test(line)) {
      failures.push(`${at} 路由层出现了确认：计划只许起草，不许在路由里替人 confirm`);
    }
  });
}

if (failures.length > 0) {
  console.error('✖ 路由层外发机检未通过（spec 10.11-16）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('✔ 路由层外发机检通过（router.ts / route-handlers.ts 无外发服务名、无外发包 import、无 confirm）');
