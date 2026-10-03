/**
 * 等人应答的共用通道（机制从 2.6-c 的投递确认单抽出，判据由 spec 5.3-08 / 09 / 10 钉住）。
 *
 * 它只做「开一张在等的单 → 由 id 路由回它 → 三种定局之一 → 只生效一次」这一件事，
 * 不认识投递也不认识 agent 的对话循环：
 * 为什么只留一份（AGENTS.md §2.2 / §2.5）——「超时 = 未确认 = 不执行」与「后到的表态不算数」
 * 这两条是安全性质而不是实现细节，两处各写一遍迟早有一处漏掉，而漏掉的那一处看起来都是绿的。
 *
 * 三条定局的分工是刻意留给调用方的：通道只报「人给了值 / 到点了 / 这一等不再有人接」，
 * 至于到点在投递侧是 `OUTBOUND_APPROVAL_DENIED`、在循环侧是一行 `refused` 步行与一个 `stopReason`，
 * 那是领域的事，抽到这里来就会变成第二个判定口（§2.5）。
 */
import { randomUUID } from 'node:crypto';

/**
 * 一张单子的三种定局。
 *
 * `timed-out` 与 `cancelled` 都不带值——它们**不是**一种表态：前者是没人表态，
 * 后者是等待方自己消失（让出、服务被重建），两者都不能被读成「同意了」。
 */
export type PendingOutcome<TAnswer> =
  { kind: 'answered'; answer: TAnswer } | { kind: 'timed-out' } | { kind: 'cancelled' };

/**
 * 通道给单号与时刻这三位的宿主形状：调用方的 view 只写自己那几格，其余由通道补齐。
 * @template TView 调用方的展示载荷（必须是不含函数的纯数据，它要跨 IPC 递给界面）
 */
export type PendingRequest<TView> = {
  /** 单号（spec 5.3-09 的 requestId）：应答只按它路由，不按「最近开的那张」猜 */
  requestId: string;
  /** 开单时刻（毫秒），界面算「等了多久」用 */
  requestedAt: number;
  /** 到点时刻（毫秒）= `requestedAt + timeoutMs`，是读数不是判据，判据在通道里的定时器上 */
  expiresAt: number;
} & TView;

/** `open()` 的返回：一句「这张单子现在在等」与一个会定局的 Promise。 */
export type PendingTicket<TView, TAnswer> = {
  request: PendingRequest<TView>;
  outcome: Promise<PendingOutcome<TAnswer>>;
};

/** 一张在等的单子：`settle` 由 `answer` / 超时定时器 / abort / `cancelAll` 四方之一调用，且只生效一次。 */
type PendingEntry<TView, TAnswer> = {
  request: PendingRequest<TView>;
  settle: (outcome: PendingOutcome<TAnswer>) => void;
};

/**
 * 在等的单子的登记表：内存 Map，不是库里一张表。
 *
 * 理由与 `deliver.ts` 头注释里那条一模一样（2.6-c 的实测判断，本片原样沿用）：
 * 这是**等待状态**而不是事实记录——经过永远落在调用方自己的账上（投递落在 `usage_ledger`，
 * 循环落在 `agent_step`）。做成表就要回答「进程死了谁把 in-flight 的单子收掉」，
 * 而「超时按未确认」这条性质本来就把所有悬挂兜住了。
 * @template TView 展示载荷（见 `PendingRequest`）
 * @template TAnswer 人给回的值（投递是 `boolean`，循环的补充信息是一段待再校验的文本）
 */
export class PendingChannel<TView, TAnswer> {
  private readonly entries = new Map<string, PendingEntry<TView, TAnswer>>();

  /**
   * 开一张在等的单子：登记 → 补齐单号与时刻 → 交回票据。
   *
   * 登记的时机在返回之前，所以调用方「先拿到 request 再发事件」这条路天然满足
   * spec 2.6-01 定下的那条顺序：界面收到提醒后立刻 `pending()` 也必须读得到这张单子。
   * @param view 调用方的展示载荷
   * @param options.timeoutMs 多久没人应答就按 `timed-out` 定局（毫秒）；0 表示「下一拍就超时」，
   *   与投递配置里 `approveTimeoutMs` 的既有语义一致（到点按拒绝，绝不因为 0 就放行）
   * @param options.signal 让出信号：abort 时以 `cancelled` 定局，不等超时也不接受应答
   * @returns 单子读数与定局 Promise；本函数自己永不抛（抛不出「没有对应的人」这种错，那是 `answer` 的事）
   */
  open(view: TView, options: { timeoutMs: number; signal?: AbortSignal }): PendingTicket<TView, TAnswer> {
    const requestId = randomUUID();
    const requestedAt = Date.now();
    const entries = this.entries;
    const request = { requestId, requestedAt, expiresAt: requestedAt + options.timeoutMs, ...view };
    const outcome = new Promise<PendingOutcome<TAnswer>>((resolve) => {
      // `settle` / `onAbort` 写成函数声明而不是 const 箭头：函数声明会提升，
      // 于是定时器能在它们尚未写出来之前就建出来，`timer` 因此可以是个 const。
      // 定时器与定局函数互相引用是这台机器的固有形状（定局要摘定时器，超时要点定局）。
      const timer = setTimeout(() => settle({ kind: 'timed-out' }), options.timeoutMs);
      function settle(next: PendingOutcome<TAnswer>): void {
        if (!entries.has(requestId)) return; // 已经定局过一次（应答 / 超时 / 让出 / 重复点击）：后到的不算数
        clearTimeout(timer);
        entries.delete(requestId);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(next);
      }
      function onAbort(): void {
        settle({ kind: 'cancelled' });
      }
      entries.set(requestId, { request, settle });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // 让出可能在这之前就已经发生了（暂停与开单撞在同一拍），与投递侧的既有处置一致。
      if (options.signal?.aborted) settle({ kind: 'cancelled' });
    });
    return { request, outcome };
  }

  /**
   * 当前在等的单子（「刷新界面不丢」那半边：事件只负责此刻提醒，这份读数负责错过了也还在）。
   * @returns 按开单顺序；一张都没有是空数组
   */
  pending(): PendingRequest<TView>[] {
    return [...this.entries.values()].map((entry) => entry.request);
  }

  /**
   * 把一句应答按 id 路由回那张单子。
   * @param requestId 单号，来自 `pending()` 或调用方发的「有人在等」事件
   * @param answer 人给回的值（通道不校验它合不合法——校验是领域的判据，留在调用方）
   * @returns 是否落到了某张在等的单子上。false 覆盖三种情形且**都不产生副作用**：
   *   单号不存在、已经定局过（重复点击 / 迟到的应答）、或它是一张陈旧的单（服务被重建过）；
   *   spec 5.3-09 要的「错 id / 重复 id 被忽略」就是这一个返回值 + 那格 `entries.has` 判据
   */
  answer(requestId: string, answer: TAnswer): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    entry.settle({ kind: 'answered', answer });
    return true;
  }

  /**
   * 收掉全部在等的单子（等待方即将消失时调：让出、服务销毁、配置热改重建下游）。
   *
   * 一律定成 `cancelled` 而**绝不**定成 `answered`：「我这边不等了」不是任何人同意了，
   * 把它写成放行就是 AGENTS.md §8 第 3 条禁的那种默认放行。
   * @returns 收掉的张数（调用方可打进日志，别让这条清理静默）
   */
  cancelAll(): number {
    const requests = this.pending();
    for (const request of requests) this.entries.get(request.requestId)?.settle({ kind: 'cancelled' });
    return requests.length;
  }

  /**
   * 当前在等的单号（调用方要把「查无此单」的错误说得可核对时用，比如附上还等着哪几张）。
   * @returns 与 `pending()` 同顺序的 id 列表
   */
  pendingIds(): string[] {
    return [...this.entries.keys()];
  }
}
