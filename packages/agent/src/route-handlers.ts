/**
 * 路由的六个处理器（spec 10.11-16 / 2026-11-22 裁定）：每个只读既有读数、只出「回执片段」。
 *
 * 返回的是 `ChatNoticePart` / `ChatNavigatePart`——**文案 key 与参数，不是句子**：
 * 主进程不写界面文案（§5.5），渲染层按自己的语言包组句。
 * 处理器绝不发起外发：执行类（act）不在这里，它沿用既有的 `/tool` 解析器与审批门禁。
 */
import type { ChatNoticePart, ChatNavigatePart } from '@auto-cc/core';
import type { RouteReading } from './router.js';

/** 处理器要用的既有读数口（全是只读；没有外发口）。 */
export interface RoutePorts {
  /** 今日额度与区间漏斗（`funnel.query`）。 */
  funnelQuery: () => Promise<{ quota: { used: number; limit: number | null }; delivered: number }>;
  /** 账本汇总（`usage.ledger.summary`）。 */
  ledgerSummary: () => Promise<{ total: number; lastSendAt: number | null }>;
  /** 知识库检索（`kb.profile.search`）。 */
  kbSearch: (query: string) => Promise<{ hits: number }>;
  /** 岗位追踪现况（`journey.tracking.current`）。 */
  trackingCurrent: () => Promise<{ jobId: string | null; state: string | null }>;
  /** 待表态单（`agent.pause.pending`）。 */
  pausePending: () => Promise<number>;
  /** 执行器现况（`journey.unattended.view`）。 */
  unattendedView: () => Promise<{ status: string; pending: number }>;
  /** 授权单现况（`outbound.authorization.current`）。 */
  authorizationCurrent: () => Promise<{ status: string } | null>;
  /** 起草计划（`agent.loop.propose`）——只起草，**不确认**。 */
  propose: (goal: string) => Promise<{ runId: string; steps: number }>;
}

/** 处理器产出：一组回执片段。 */
export type RouteParts = (ChatNoticePart | ChatNavigatePart)[];

/**
 * 按分类结果跑对应处理器。
 * @param reading 分类结果
 * @param text 用户原文（explain/subject 用）
 * @param ports 读端口
 * @returns 回执片段；`act` 返回 null 表示「交给既有 /tool 那条路」
 * @throws 处理器自身的结构化错误（调用方包成 `route_refused` 并原样透出 code）
 */
export async function runRoute(reading: RouteReading, text: string, ports: RoutePorts): Promise<RouteParts | null> {
  switch (reading.intent) {
    case 'navigate':
      return [{ kind: 'navigate', view: reading.target?.view ?? 'chat' }];
    case 'summary': {
      const [funnel, ledger] = await Promise.all([ports.funnelQuery(), ports.ledgerSummary()]);
      return [
        {
          kind: 'notice',
          code: 'summary',
          params: {
            used: funnel.quota.used,
            limit: funnel.quota.limit ?? '—',
            delivered: funnel.delivered,
            lastSend: ledger.lastSendAt === null ? '—' : new Date(ledger.lastSendAt).toLocaleTimeString(),
          },
        },
      ];
    }
    case 'explain': {
      const subject = reading.target?.subject ?? text;
      const [kb, tracking] = await Promise.all([ports.kbSearch(subject), ports.trackingCurrent()]);
      return [
        {
          kind: 'notice',
          code: 'explain',
          params: {
            hits: kb.hits,
            jobId: tracking.jobId ?? '—',
            state: tracking.state ?? '—',
          },
        },
      ];
    }
    case 'draft_plan': {
      const plan = await ports.propose(text);
      return [{ kind: 'notice', code: 'plan_drafted', params: { runId: plan.runId, steps: plan.steps } }];
    }
    case 'reminder': {
      const [pauses, run, auth] = await Promise.all([
        ports.pausePending(),
        ports.unattendedView(),
        ports.authorizationCurrent(),
      ]);
      return [
        {
          kind: 'notice',
          code: 'reminder',
          params: {
            pauses,
            runStatus: run.status,
            pending: run.pending,
            authorization: auth?.status ?? 'none',
          },
        },
      ];
    }
    case 'act':
      // 执行类不在处理器里做：交给既有 `/tool` 解析器（走注册表与审批门禁）。
      return null;
    case 'unknown':
    default:
      // 分类不出来时不在这里出回执：调用方会回落到原有的本地回复（同一句「没听懂」的口径）。
      return [];
  }
}
