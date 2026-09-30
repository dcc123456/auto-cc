/**
 * `@auto-cc/plugin-entitlement`（spec 1.9）：外发额度闸门与用量账本。
 *
 * 一个包两个 service（plan §8.4 决策「闸门与账本同包」）：`entitlement.gate` 负责判定与放行，
 * `usage.ledger` 负责落账与回看。它们必须同进同退 —— 只放行不落账的闸门等于没有闸门。
 */
export {
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  gateSchema,
  type GateConfig,
  type GateDailyLimits,
  type Performed,
} from './gate.js';
export {
  LEDGER_MIGRATION_VERSION,
  UsageLedgerService,
  dayKey,
  ledgerSchema,
  startOfDay,
  type LedgerConfig,
  type LedgerDraft,
} from './ledger.js';
export type { ActionContext } from './types.js';
