/**
 * 批量抽取的注入脚本（spec 2.3-01 / 2.3-02）：一次调用读回「N 个容器 × M 个字段」。
 *
 * 为什么不用 `browser.locate` 逐字段定位：一页 12 张卡片、每张 6 个字段就是 72 次跨进程求值，
 * 每次都要重新扫一遍 DOM，还得逐次处理帧归属。抽取把这件事收成**一趟**：容器按声明顺序取
 * 第一条命中的候选，字段在**容器子树内**解析，于是同一份 DOM 只走一遍。
 *
 * 抽取**不打分、不自愈、不 fail-closed**（plan §10.3 规则 2）：命不中就把 `matched:false` 如实带回，
 * 由调用方决定这条要不要留。打分与歧义拒绝是「要动手」时的保护，读字段读漏一条不是事故。
 */
import type { ExtractFieldReading, ExtractFieldSpec, ExtractRowReading, LocateSpec } from '@auto-cc/shared';

/** 抽取脚本的取回上限（由 `browser.page` 的配置钳制后传入）。 */
export type ExtractLimits = {
  /** 单个字段正文上限（字符） */
  textLimit: number;
  /** 单次最多回传多少个容器 */
  rowLimit: number;
};

/**
 * 单个帧的抽取读数（行还没补帧地址——帧归属是主进程的事，页面不知道自己在哪一帧）。
 * 行形状复用 `shared` 的 `ExtractRowReading`，只是此处 `frameUrl` 恒为空串。
 */
export type ExtractFrameReading = {
  containers: number;
  truncated: boolean;
  rows: ExtractRowReading[];
};

/** 把候选列表序列化成脚本里的字面量（数据进脚本的唯一通道，不做字符串拼接）。 */
const literals = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * 生成「在本帧里按容器+字段批量读取」的表达式源码。
 * @param container 容器定位声明（`candidates` 声明顺序即优先级）
 * @param fields 字段声明列表（候选在容器子树内解析）
 * @param limits 正文与行数上限
 * @returns 单个表达式源码，求值得到 `ExtractFrameReading`
 */
export function buildExtractScript(
  container: Pick<LocateSpec, 'candidates'>,
  fields: ExtractFieldSpec[],
  limits: ExtractLimits,
): string {
  const textLimit = String(Math.trunc(limits.textLimit));
  const rowLimit = String(Math.trunc(limits.rowLimit));
  return `(() => {
    const candidates = ${literals(container.candidates)};
    const fields = ${literals(fields)};
    const TEXT_LIMIT = ${textLimit};
    const ROW_LIMIT = ${rowLimit};
    const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const quoted = (value) => JSON.stringify(String(value == null ? '' : value));
    const selectorFor = (candidate) => {
      if (candidate.strategy === 'css') return candidate.value;
      if (candidate.strategy === 'id') return '#' + CSS.escape(candidate.value);
      if (candidate.strategy === 'testId') {
        return '[' + (candidate.attribute || 'data-testid') + '=' + quoted(candidate.value) + ']';
      }
      if (candidate.strategy === 'name') return '[name=' + quoted(candidate.value) + ']';
      return null;
    };
    const scan = (root, list) => {
      if (!root || !Array.isArray(list)) return [];
      for (const candidate of list) {
        if (!candidate || typeof candidate !== 'object') continue;
        try {
          const selector = selectorFor(candidate);
          if (selector) {
            const hit = Array.from(root.querySelectorAll(selector));
            if (hit.length > 0) return hit;
            continue;
          }
          if (candidate.strategy === 'xpath') {
            const raw = String(candidate.value || '');
            // 知识包里的 XPath 是为整页写的（形如 //li[...]），容器内必须相对化，否则又跳回文档根。
            const expression = raw.startsWith('//') ? '.' + raw : raw;
            const result = document.evaluate(expression, root, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
            const hit = [];
            let node = result.iterateNext();
            while (node && hit.length < 200) {
              hit.push(node);
              node = result.iterateNext();
            }
            if (hit.length > 0) return hit;
            continue;
          }
          const descendants = Array.from(root.querySelectorAll('*'));
          if (candidate.strategy === 'text') {
            const wanted = norm(candidate.value);
            const hit = descendants.filter((element) => {
              const own = norm(element.innerText || element.textContent);
              return candidate.exact ? own === wanted : own.includes(wanted);
            });
            if (hit.length > 0) return hit;
            continue;
          }
          if (candidate.strategy === 'role') {
            const wantedRole = norm(candidate.role).toLowerCase();
            const wantedName = norm(candidate.name);
            const hit = descendants.filter((element) => {
              const role = norm(element.getAttribute('role') || element.tagName).toLowerCase();
              if (role !== wantedRole) return false;
              if (!wantedName) return true;
              return norm(element.innerText || element.textContent).includes(wantedName);
            });
            if (hit.length > 0) return hit;
          }
        } catch (error) {
          // 一条候选写坏（非法选择器 / 非法 XPath）只让这一条失效，下一条候选继续试。
          continue;
        }
      }
      return [];
    };
    const containers = scan(document, candidates);
    const keep = containers.slice(0, Math.max(0, ROW_LIMIT));
    const rows = [];
    for (let index = 0; index < keep.length; index += 1) {
      const scope = keep[index];
      const readings = [];
      for (const field of fields) {
        // scope 为 self 时读容器自身：一条消息的 id / 方向 / 正文就挂在那个节点上，
        // 而子树查找永远不会返回容器本身（spec 2.5-07 的读法）。
        const match = field.scope === 'self' ? scope : scan(scope, field.candidates)[0] || null;
        if (!match) {
          readings.push({ name: String(field.name), matched: false, text: '', attribute: null });
          continue;
        }
        const text = norm(match.innerText || match.textContent).slice(0, TEXT_LIMIT);
        const attribute = field.attribute
          ? match.getAttribute(String(field.attribute)) || ''
          : null;
        readings.push({ name: String(field.name), matched: true, text, attribute });
      }
      rows.push({ containerIndex: index, fields: readings });
    }
    return { containers: containers.length, truncated: containers.length > keep.length, rows };
  })()`;
}

/** 未知值 → 字符串（非字符串一律归空，页面回读不可信）。 */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 未知值 → 数字（非有限数用回退值）。 */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * 把一个帧的抽取返回值钳成 `ExtractFrameReading`。
 *
 * 站点可以回传任何形状（包括把 `fields` 写成字符串、把 `containerIndex` 写成 `NaN`），
 * 所以这里逐字段收窄类型而不是断言一次就信任（AGENTS.md §8：外部页面读数不可信）。
 * @param raw `executeJavaScript` 的返回值
 * @returns 字段齐全、数量与上限一致的抽取读数
 */
export function toExtractFrameReading(raw: unknown): ExtractFrameReading {
  const value = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(value.rows) ? value.rows : [];
  return {
    containers: asNumber(value.containers, 0),
    truncated: value.truncated === true,
    rows: rows.map((item, position) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const fields = Array.isArray(row.fields) ? row.fields : [];
      return {
        containerIndex: asNumber(row.containerIndex, position),
        // 帧地址在页面里无从得知，占位空串；主进程按求值来源逐行覆盖。
        frameUrl: '',
        fields: fields.map((field) => {
          const reading = (field ?? {}) as Record<string, unknown>;
          return {
            name: asText(reading.name),
            matched: reading.matched === true,
            text: asText(reading.text),
            attribute: typeof reading.attribute === 'string' ? reading.attribute : null,
          } satisfies ExtractFieldReading;
        }),
      } satisfies ExtractRowReading;
    }),
  };
}
