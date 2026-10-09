/**
 * 注入到内核视图里执行的**定位读取脚本**（spec 2.2-01 / 2.2-03 / 2.2-12）。
 *
 * 与 `page-script.ts` 同一个原则：页面脚本只把元素**长成数据**（角色、可读名、指纹字段、
 * 可见性判据），一条都不做判定——打分、去重、歧义与自愈全在 `locator-spec.ts`。
 * 这样「为什么这条候选赢」可以不开窗口就单测，而这段源码本身也能被单测直接求值跑起来。
 *
 * 帧内身份号（`nodeIndex`）挂在该帧 `globalThis` 的一个 WeakMap 上：跨多次求值必须稳定，
 * 否则「定位到 3 号节点，然后点它」这两步就接不上。它是帧内局部量，与 `frameUrl` 一起才唯一。
 */
import type { ElementRect, LocatedReading, LocateStrategy } from '@auto-cc/shared';
import { GENERATED_VALUE, SAFE_ATTRIBUTE_NAME } from './locator-spec.js';

/** 页面侧脚本的取回上限。 */
export type ScriptLimits = {
  /** 单个文本字段（指纹里的 text / accessibleName / 属性值）的归一化长度上限（字符） */
  textLimit: number;
  /** 每条候选最多回读几个命中元素（`siblingCount` 仍是总数，不受此上限影响） */
  hitsPerCandidate: number;
  /** 单次求值最多扫描多少个元素：页面上线可能有几万个节点，扫满就停，宁可少读不能卡住渲染进程 */
  nodeScanCap: number;
  /** 祖先角色链最多取几层 */
  ancestorRoleLimit: number;
  /** 周围文本锚点最多取几条 */
  nearbyTextLimit: number;
  /** 做「去掉祖先命中」的集合比较时，最多参与比较的元素个数（O(n²) 保护） */
  deepFilterCap: number;
};

/** 默认上限；`textLimit` 与 plan §9.3 的 `textNormalizationLimit` 同源。 */
export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  textLimit: 80,
  hitsPerCandidate: 5,
  nodeScanCap: 4000,
  ancestorRoleLimit: 6,
  nearbyTextLimit: 4,
  deepFilterCap: 60,
};

/** 参与文本匹配的标签：容器一律被 `withoutMatchedAncestors` 去掉，这里只是枚举起点。 */
const TEXT_TAGS = [
  'a',
  'button',
  'span',
  'div',
  'p',
  'li',
  'td',
  'th',
  'label',
  'legend',
  'option',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'input',
  'textarea',
  'select',
];

/** 可读名取自身文本的标签（按钮、链接、标题）——输入框的名字来自 label / placeholder，不来自正文。 */
const NAMED_BY_TEXT_TAGS = ['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'label', 'option'];

/** 指纹里允许留存的属性键（`data-*` 另计）。class 永不入选：改版最常改的就是 class。 */
const STABLE_ATTRIBUTE_KEYS = ['id', 'name', 'type', 'placeholder', 'href', 'aria-label', 'role'];

/** 一次 DOM 兜底动作的结局读数。 */
export type DomActionReading = { ok: boolean; valueAfter: string; error: string };

/** 一次等待的结局读数。 */
export type WaitReading = { satisfied: boolean; waitedMs: number; readings: LocatedReading[] };

/**
 * 生成注入脚本的公共段落（辅助函数集合）。
 *
 * 它不是一段自足的程序，而是被三个 builder 拼进同一个 IIFE 作用域里，
 * 于是「角色怎么算」「可读名怎么算」「指纹字段怎么取」在定位、等待、DOM 兜底三条路径上**只有一份实现**。
 * @param limits 取回上限
 * @returns IIFE 内部的函数定义源码
 */
function buildPrelude(limits: ScriptLimits): string {
  return `    const LIMITS = ${JSON.stringify(limits)};
    const TEXT_TAGS = ${JSON.stringify(TEXT_TAGS)};
    const NAMED_BY_TEXT_TAGS = ${JSON.stringify(NAMED_BY_TEXT_TAGS)};
    const STABLE_ATTRIBUTE_KEYS = ${JSON.stringify(STABLE_ATTRIBUTE_KEYS)};
    const generatedPattern = new RegExp(${JSON.stringify(GENERATED_VALUE.source)}, 'i');
    const safeAttributeNamePattern = new RegExp(${JSON.stringify(SAFE_ATTRIBUTE_NAME.source)}, '');
    const flatten = (raw) => String(raw === null || raw === undefined ? '' : raw).replace(/\\s+/g, ' ').trim();
    const finite = (value) => (typeof value === 'number' && isFinite(value) ? value : 0);
    const registry = (globalThis.__autoCcLocator = globalThis.__autoCcLocator || { ids: new WeakMap(), next: 0 });
    const nodeIdOf = (node) => {
      const known = registry.ids.get(node);
      if (known !== undefined) return known;
      registry.next += 1;
      registry.ids.set(node, registry.next);
      return registry.next;
    };
    const baseNodes = () => {
      const all = document.querySelectorAll('*');
      const cap = Math.min(all.length, LIMITS.nodeScanCap);
      const nodes = [];
      for (let index = 0; index < cap; index += 1) nodes.push(all[index]);
      return nodes;
    };
    const tagOf = (node) => String(node && node.tagName ? node.tagName : '').toLowerCase();
    const roleOf = (node) => {
      const explicit = flatten(node.getAttribute('role')).toLowerCase();
      if (explicit) return explicit;
      const tag = tagOf(node);
      if (tag === 'input') {
        const type = flatten(node.getAttribute('type')).toLowerCase() || 'text';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
        return 'textbox';
      }
      if (tag === 'button') return 'button';
      if (tag === 'select') return node.getAttribute('multiple') !== null ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'a') return node.getAttribute('href') ? 'link' : '';
      if (tag === 'img') return flatten(node.getAttribute('alt')) ? 'img' : '';
      if (tag === 'li') return 'listitem';
      if (tag === 'ul' || tag === 'ol') return 'list';
      if (tag === 'nav') return 'navigation';
      if (tag === 'main') return 'main';
      if (tag === 'header') return 'banner';
      if (tag === 'footer') return 'contentinfo';
      if (tag === 'form') return 'form';
      if (tag === 'table') return 'table';
      if (tag === 'article') return 'article';
      if (tag === 'aside') return 'complementary';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return '';
    };
    const textOf = (node) => {
      const tag = tagOf(node);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return flatten(node.value).slice(0, LIMITS.textLimit);
      const own = node.innerText === undefined || node.innerText === null ? node.textContent : node.innerText;
      return flatten(own).slice(0, LIMITS.textLimit);
    };
    const labelTextOf = (node) => {
      const labels = node.labels;
      if (!labels || !labels.length) return '';
      const parts = [];
      for (let index = 0; index < labels.length; index += 1) parts.push(flatten(labels[index].textContent));
      return parts.filter(Boolean).join(' ').slice(0, LIMITS.textLimit);
    };
    const nameByIdsOf = (rawIds) => {
      const parts = [];
      const ids = flatten(rawIds).split(' ');
      for (let index = 0; index < ids.length; index += 1) {
        const referenced = document.getElementById ? document.getElementById(ids[index]) : null;
        if (referenced) parts.push(flatten(referenced.textContent));
      }
      return parts.filter(Boolean).join(' ').slice(0, LIMITS.textLimit);
    };
    /** 简化版 accessible name 级联：aria-labelledby > aria-label > label > (输入框)placeholder > alt > 自身文本 > title。 */
    const nameOf = (node) => {
      const labelled = nameByIdsOf(node.getAttribute('aria-labelledby'));
      if (labelled) return labelled;
      const ariaLabel = flatten(node.getAttribute('aria-label'));
      if (ariaLabel) return ariaLabel.slice(0, LIMITS.textLimit);
      const labelText = labelTextOf(node);
      if (labelText) return labelText;
      const tag = tagOf(node);
      const type = flatten(node.getAttribute('type')).toLowerCase();
      if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
        const value = flatten(node.value);
        if (value) return value.slice(0, LIMITS.textLimit);
      }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return flatten(node.getAttribute('placeholder')).slice(0, LIMITS.textLimit);
      }
      const alt = flatten(node.getAttribute('alt'));
      if (alt) return alt.slice(0, LIMITS.textLimit);
      if (NAMED_BY_TEXT_TAGS.indexOf(tag) >= 0) {
        const own = flatten(node.textContent);
        if (own) return own.slice(0, LIMITS.textLimit);
      }
      return flatten(node.getAttribute('title')).slice(0, LIMITS.textLimit);
    };
    const attributesOf = (node) => {
      const collected = {};
      for (let index = 0; index < STABLE_ATTRIBUTE_KEYS.length; index += 1) {
        const key = STABLE_ATTRIBUTE_KEYS[index];
        const value = flatten(node.getAttribute(key));
        if (value && value.length <= LIMITS.textLimit && !generatedPattern.test(value)) collected[key] = value;
      }
      const dataset = node.dataset || {};
      const dataKeys = Object.keys(dataset);
      for (let index = 0; index < dataKeys.length; index += 1) {
        const value = flatten(dataset[dataKeys[index]]);
        const key = 'data-' + dataKeys[index].toLowerCase();
        if (value && value.length <= LIMITS.textLimit && !generatedPattern.test(value)) collected[key] = value;
      }
      return collected;
    };
    const ancestorRolesOf = (node) => {
      const chain = [];
      let parent = node.parentElement;
      while (parent && chain.length < LIMITS.ancestorRoleLimit) {
        const role = roleOf(parent);
        if (role) chain.unshift(role);
        parent = parent.parentElement;
      }
      return chain;
    };
    const nearbyTextsOf = (node) => {
      const texts = [];
      const push = (raw) => {
        const text = flatten(raw);
        if (text && text.length <= LIMITS.textLimit && texts.indexOf(text) < 0) texts.push(text);
      };
      let sibling = node.previousElementSibling;
      while (sibling && texts.length < LIMITS.nearbyTextLimit) {
        push(sibling.textContent);
        sibling = sibling.previousElementSibling;
      }
      const children = (node.parentElement && node.parentElement.children) || [];
      for (let index = 0; index < children.length && texts.length < LIMITS.nearbyTextLimit; index += 1) {
        if (children[index] !== node) push(children[index].textContent);
      }
      return texts;
    };
    const rectOf = (node) => {
      const box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      if (!box) return { x: 0, y: 0, width: 0, height: 0 };
      return { x: finite(box.x), y: finite(box.y), width: finite(box.width), height: finite(box.height) };
    };
    const visibleOf = (node, rect) => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const enabledOf = (node) => {
      if (node.disabled === true) return false;
      return flatten(node.getAttribute('aria-disabled')).toLowerCase() !== 'true';
    };
    const unobstructedOf = (node, rect) => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (typeof document.elementFromPoint !== 'function') return true;
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      /**
       * 命中测试答不上来有两种，必须分开：视口尺寸读不到（0）时按「不知道」处理，退回原来的命中测试。
       */
      const viewportWidth = finite(globalThis.innerWidth);
      const viewportHeight = finite(globalThis.innerHeight);
      if (
        viewportWidth > 0 &&
        viewportHeight > 0 &&
        (centerX < 0 || centerY < 0 || centerX > viewportWidth || centerY > viewportHeight)
      ) {
        // 这一点压根不在视口里 = 「还没滚进来」，不是「被盖住」：留给动作层滚进画面那一步，
        // 滚不进会以 ACT_OUT_OF_VIEWPORT 停手且一条命令都不发（spec 8.4-06，证据 8.4-01 第一节）。
        return true;
      }
      const point = document.elementFromPoint(centerX, centerY);
      if (!point) return false;
      return point === node || node.contains(point);
    };
    const readingOf = (node, candidateIndex, strategy, siblingCount, hitIndex) => {
      const rect = rectOf(node);
      return {
        frameUrl: location.href,
        candidateIndex: candidateIndex,
        strategy: strategy,
        siblingCount: siblingCount,
        nodeIndex: nodeIdOf(node),
        hitIndex: hitIndex,
        visible: visibleOf(node, rect),
        enabled: enabledOf(node),
        unobstructed: unobstructedOf(node, rect),
        tagName: tagOf(node),
        role: roleOf(node),
        accessibleName: nameOf(node),
        text: textOf(node),
        attributes: attributesOf(node),
        ancestorRoles: ancestorRolesOf(node),
        nearbyTexts: nearbyTextsOf(node),
        rect: rect,
      };
    };
    /** 文本类候选会连容器一起命中，去掉那些「自己的子孙也命中了」的祖先，只留最深的一层。 */
    const withoutMatchedAncestors = (nodes) => {
      const shortlist = nodes.slice(0, LIMITS.deepFilterCap);
      return shortlist.filter((node) => {
        for (let index = 0; index < shortlist.length; index += 1) {
          if (shortlist[index] !== node && node.contains(shortlist[index])) return false;
        }
        return true;
      });
    };
    const predicateFor = (candidate) => {
      const wanted = flatten(candidate.value);
      if (candidate.strategy === 'testId') {
        const attribute = flatten(candidate.attribute) || 'data-testid';
        if (!safeAttributeNamePattern.test(attribute) || !wanted) return null;
        return (node) => flatten(node.getAttribute(attribute)) === wanted;
      }
      if (candidate.strategy === 'id') return wanted ? (node) => flatten(node.getAttribute('id')) === wanted : null;
      if (candidate.strategy === 'name') return wanted ? (node) => flatten(node.getAttribute('name')) === wanted : null;
      if (candidate.strategy === 'role') {
        const role = flatten(candidate.role).toLowerCase();
        const name = flatten(candidate.name).toLowerCase();
        if (!role) return null;
        return (node) => {
          if (roleOf(node) !== role) return false;
          if (!name) return true;
          const own = nameOf(node).toLowerCase();
          return candidate.exact === true ? own === name : own.indexOf(name) >= 0;
        };
      }
      if (candidate.strategy === 'text') {
        const needle = wanted.toLowerCase();
        if (!needle) return null;
        return (node) => {
          const own = textOf(node).toLowerCase();
          if (!own) return false;
          if (candidate.exact === true) return own === needle;
          return TEXT_TAGS.indexOf(tagOf(node)) >= 0 && own.indexOf(needle) >= 0;
        };
      }
      return null;
    };
    const collectBySelector = (nodes, selector) => {
      const matched = [];
      for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index].matches(selector)) matched.push(nodes[index]);
      }
      return matched;
    };
    const collectByXPath = (expression) => {
      if (typeof document.evaluate !== 'function') return [];
      const result = document.evaluate(expression, document, null, 7, null);
      const nodes = [];
      for (let index = 0; index < result.snapshotLength && nodes.length < LIMITS.nodeScanCap; index += 1) {
        const node = result.snapshotItem(index);
        if (node) nodes.push(node);
      }
      return nodes;
    };
    /** 一条候选在本帧里的全部命中（不截断，siblingCount 必须是真实总数）。 */
    const collectHits = (candidate, nodes) => {
      if (candidate.strategy === 'css') {
        if (!flatten(candidate.value)) return [];
        try {
          return collectBySelector(nodes, candidate.value);
        } catch {
          return [];
        }
      }
      if (candidate.strategy === 'xpath') {
        if (!flatten(candidate.value)) return [];
        try {
          return collectByXPath(candidate.value);
        } catch {
          return [];
        }
      }
      const predicate = predicateFor(candidate);
      if (!predicate) return [];
      const hits = [];
      for (let index = 0; index < nodes.length; index += 1) {
        if (predicate(nodes[index])) hits.push(nodes[index]);
      }
      return hits;
    };
    /**
     * 一条候选在本帧里的命中列表，**与读数的顺序完全一致**：文本类先去祖先，再按文档顺序排。
     * 扫描读数与「按序号找回节点」两条路径共用它，否则序号会对不上。
     */
    const hitsOf = (candidate, nodes) => {
      const hits = collectHits(candidate, nodes);
      return candidate.strategy === 'text' ? withoutMatchedAncestors(hits) : hits;
    };
    const scanCandidates = (candidates) => {
      const nodes = baseNodes();
      const readings = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const hits = hitsOf(candidate, nodes);
        for (let hit = 0; hit < hits.length && hit < LIMITS.hitsPerCandidate; hit += 1) {
          readings.push(readingOf(hits[hit], index, candidate.strategy, hits.length, hit));
        }
      }
      return readings;
    };
    /** 按「候选下标 + 帧内身份号」找回定位时的那一个节点——两条路径共用同一份注册表，所以不需要跨进程传 DOM 引用。 */
    const findNode = (candidates, wanted) => {
      const candidate = candidates[wanted.candidateIndex];
      if (!candidate) return null;
      const hits = collectHits(candidate, baseNodes());
      for (let index = 0; index < hits.length; index += 1) {
        if (nodeIdOf(hits[index]) === wanted.nodeIndex) return hits[index];
      }
      return null;
    };
    /** 控件的「当前值」：输入类读 value，其余读正文——回读校验与动作结局里的 valueAfter 都从这里取。 */
    const valueOf = (node) => {
      const tag = tagOf(node);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return flatten(node.value);
      return textOf(node);
    };`;
}

/**
 * 生成「按 spec 扫描本帧」的注入脚本源码（spec 2.2-01）。
 * @param candidates 声明里的候选数组，会被序列化进脚本；调用方须先过 `validateSpec`
 * @param limits 取回上限
 * @returns 单个表达式源码，求值得到 `LocatedReading[]`
 */
export function buildLocateScript(candidates: unknown[], limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS): string {
  return `(() => {
${buildPrelude(limits)}
    return scanCandidates(${JSON.stringify(candidates)});
  })()`;
}

/**
 * 生成「按标签名扫描本帧」的注入脚本源码，供指纹自愈逐条比对（spec 2.2-05）。
 *
 * 按标签名预筛是有意的：标签名不同就已经不是同一个控件，没必要把整页读回来。
 * @param tagName 目标指纹的标签名
 * @param limits 取回上限
 * @returns 单个表达式源码，求值得到 `LocatedReading[]`（`strategy` 一律为 `fingerprint`）
 */
export function buildFingerprintScanScript(tagName: string, limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS): string {
  return `(() => {
${buildPrelude(limits)}
    const nodes = [];
    const found = document.querySelectorAll(${JSON.stringify(String(tagName || '').toLowerCase())});
    for (let index = 0; index < found.length && nodes.length < LIMITS.nodeScanCap; index += 1) nodes.push(found[index]);
    const readings = [];
    for (let index = 0; index < nodes.length && readings.length < LIMITS.hitsPerCandidate * 4; index += 1) {
      readings.push(readingOf(nodes[index], -1, 'fingerprint', 1, index));
    }
    return readings;
  })()`;
}

/**
 * 生成等待脚本源码（spec 2.2-03 的五类谓词）。
 *
 * 走 MutationObserver 而不是纯轮询：页面上线时 DOM 变更才是「等到了」的时机，
 * 轮询只作为补充——样式与位置变化（遮挡消失、滚动进入视口）不产生 mutation，
 * 所以两条通道都要有，且都只回调同一个检查函数。
 * @param kind 谓词类型
 * @param candidates 被等待元素的候选声明
 * @param timeoutMs 等待上限（毫秒）
 * @param checkMs 轮询补充间隔（毫秒）
 * @param limits 取回上限
 * @param stableSamples 「可点击」谓词要求连续多少个采样帧的几何（位置与尺寸）保持一致——
 *   页面刚插入的元素常常还在被布局往下推，此刻点下去会点到空白处（spec 2.2-03）
 * @returns 单个表达式源码，求值得到一个 Promise，兑现为 `{ satisfied, waitedMs, readings }`
 */
export function buildWaitScript(
  kind: string,
  candidates: unknown[],
  timeoutMs: number,
  checkMs: number,
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
  stableSamples = 1,
): string {
  return `(() => {
${buildPrelude(limits)}
    const candidates = ${JSON.stringify(candidates)};
    const kind = ${JSON.stringify(kind)};
    const stableSamples = ${String(Math.max(1, Math.trunc(stableSamples)))};
    const timeoutMs = ${String(timeoutMs)};
    const startedAt = Date.now();
    const baseline = (kind === 'textChanges' ? scanCandidates(candidates) : []).map((item) => item.text).join('|');
    // 几何稳定只认「连续」：中间断一次就把计数打回 1，所以页面抖动永远不会攒够样本。
    let streakKey = '';
    let streakCount = 0;
    const clickableStable = (readings) => {
      const ready = readings.find((item) => item.visible && item.enabled && item.unobstructed);
      if (!ready) return false;
      const key = ready.frameUrl + '#' + String(ready.nodeIndex) + '#' + [ready.rect.x, ready.rect.y, ready.rect.width, ready.rect.height].join(',');
      streakCount = key === streakKey ? streakCount + 1 : 1;
      streakKey = key;
      return streakCount >= stableSamples;
    };
    const satisfiedFor = (readings) => {
      if (kind === 'appear') return readings.length > 0;
      if (kind === 'disappear') return readings.length === 0;
      if (kind === 'visible') return readings.some((item) => item.visible);
      if (kind === 'clickable') return clickableStable(readings);
      if (kind === 'textChanges') return readings.map((item) => item.text).join('|') !== baseline;
      return false;
    };
    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timer = null;
      const finish = (readings, elapsedMs) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve({ satisfied: satisfiedFor(readings), waitedMs: elapsedMs, readings: readings });
      };
      const check = () => {
        const readings = scanCandidates(candidates);
        if (settled) return;
        if (satisfiedFor(readings) || Date.now() - startedAt >= timeoutMs) {
          finish(readings, Math.min(Date.now() - startedAt, timeoutMs));
          return;
        }
        timer = setTimeout(check, ${String(checkMs)});
      };
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {
          const readings = scanCandidates(candidates);
          if (!settled && satisfiedFor(readings)) finish(readings, Math.min(Date.now() - startedAt, timeoutMs));
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      check();
    });
  })()`;
}

/**
 * 生成 DOM 兜底动作脚本源码（spec 2.2-12 的 `channel:'dom'` 分支与之后的值回读）。
 *
 * 它按 `candidateIndex` + `nodeIndex` 重新找回同一个节点——这两个键与定位时用的是同一套
 * 身份号注册表，所以「定位到 7 号节点」和「点这里」之间不需要跨进程传 DOM 引用。
 * @param action 动作类型
 * @param candidates 定位时的候选声明（找回节点要用）
 * @param chosen 胜出候选的 `candidateIndex` 与 `nodeIndex`
 * @param payload 输入文本或选项值（点击时为 undefined）
 * @param limits 取回上限
 * @returns 单个表达式源码，求值得到 `{ ok, valueAfter, error }`
 */
export function buildDomActionScript(
  action: 'click' | 'type' | 'select',
  candidates: unknown[],
  chosen: { candidateIndex: number; nodeIndex: number },
  payload?: string,
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
): string {
  return `(() => {
${buildPrelude(limits)}
    const candidates = ${JSON.stringify(candidates)};
    const wanted = ${JSON.stringify(chosen)};
    const action = ${JSON.stringify(action)};
    const payload = ${JSON.stringify(payload ?? '')};
    const target = findNode(candidates, wanted);
    if (!target) return { ok: false, valueAfter: '', error: '目标节点已不在当前帧里，需要重新定位' };
    const dispatch = (node, name) => {
      if (typeof node.dispatchEvent !== 'function' || typeof Event !== 'function') return;
      node.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }));
    };
    try {
      if (action === 'click') {
        if (typeof target.click === 'function') target.click();
        else dispatch(target, 'click');
      } else if (action === 'type') {
        if (target.isContentEditable) target.textContent = payload;
        else target.value = payload;
        dispatch(target, 'input');
        dispatch(target, 'change');
      } else {
        target.value = payload;
        dispatch(target, 'change');
      }
      return { ok: true, valueAfter: valueOf(target), error: '' };
    } catch (actionError) {
      return { ok: false, valueAfter: valueOf(target), error: String(actionError && actionError.message ? actionError.message : actionError) };
    }
  })()`;
}

/**
 * 生成「回读某个节点当前值」的注入脚本源码（spec 2.2-13 的中文回显要拿页面里的真值来判，
 * 不能拿我们发出去的那个字符串自证）。
 * @param candidates 定位时的候选声明（找回节点要用）
 * @param chosen 胜出候选的 `candidateIndex` 与 `nodeIndex`
 * @param limits 取回上限
 * @returns 单个表达式源码，求值得到 `{ ok, valueAfter, error }`（与 DOM 兜底同形，调用方不必分支）
 */
export function buildValueReadScript(
  candidates: unknown[],
  chosen: { candidateIndex: number; nodeIndex: number },
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
): string {
  return `(() => {
${buildPrelude(limits)}
    const target = findNode(${JSON.stringify(candidates)}, ${JSON.stringify(chosen)});
    if (!target) return { ok: false, valueAfter: '', error: '目标节点已不在当前帧里' };
    return { ok: true, valueAfter: valueOf(target), error: '' };
  })()`;
}

/**
 * 点击回执探针挂在页面 `globalThis` 上的键（挂表与读表两段脚本共用，必须只有一个名字）。
 *
 * 它是裁定⑰的落点：`click` 的 `done` 从此要求页面自己承认收到过这一次事件，
 * 而不是「命令没报错」（plan §16.1）。
 */
export const CLICK_RECEIPT_KEY = '__autoCcClickReceipt';

/**
 * 生成「在胜出节点上挂一次 capture 阶段点击回执」的脚本源码（plan §16.1 第一段，派发之前跑）。
 *
 * 挂的是**目标节点自己**而不是 `document`：真实站点常在整个页面上转发 `click`，
 * 挂在 document 上会把「事件落到别处」也报成回执，那正是这条判据要防的假阳性。
 * 计数只增不减、基准在挂表时抄一份，所以同一页面连点多次不会互相盖掉读数。
 * @param candidates 定位时的候选声明（找回节点要用，与 `buildValueReadScript` 同一套身份号）
 * @param chosen 胜出候选的 `candidateIndex` 与 `nodeIndex`
 * @param limits 取回上限
 * @returns 单个表达式源码，求值得到 `{ ok, url, count, error }`；`url` 是挂表那一刻的文档地址，导航出口要用
 */
export function buildClickArmScript(
  candidates: unknown[],
  chosen: { candidateIndex: number; nodeIndex: number },
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
): string {
  return `(() => {
${buildPrelude(limits)}
    const receiptKind = 'arm';
    const target = findNode(${JSON.stringify(candidates)}, ${JSON.stringify(chosen)});
    if (!target) return { ok: false, url: '', count: 0, error: '目标节点已不在当前帧里，回执挂不上' };
    const state = globalThis.${CLICK_RECEIPT_KEY} || (globalThis.${CLICK_RECEIPT_KEY} = { count: 0, baseline: 0, node: null, handler: null, url: '' });
    if (state.node && state.handler) state.node.removeEventListener('click', state.handler, true);
    state.baseline = state.count;
    state.url = document.URL;
    state.node = target;
    state.handler = () => { state.count += 1; };
    target.addEventListener('click', state.handler, true);
    return { ok: true, url: state.url, count: state.count, error: '' };
  })()`;
}

/**
 * 生成「读一次点击回执并把监听摘掉」的脚本源码（plan §16.1 第三段，派发之后轮）。
 *
 * 两条确认出口缺一不可，而且第二条不是可选项：点击把页面导航走时，挂表的那个 JS world 会整个销毁，
 * 探针随之读不到——只有「文档地址变了」这条出口能让这种点击仍然算确认。
 * 反过来，探针还在、计数没涨、地址也没变，就是那一次实测抓到的场景（窗口不在前台，
 * 合成器把 CDP 的鼠标事件丢掉），必须判未确认。
 * @param armedUrl 挂表那一刻的文档地址
 * @returns 单个表达式源码，求值得到 `{ available, received, url, error }`；`available` 为 false 表示页面答不上来
 */
export function buildClickReceiptReadScript(armedUrl: string): string {
  return `(() => {
    const receiptKind = 'read';
    const url = document.URL;
    const navigated = url !== ${JSON.stringify(armedUrl)};
    const state = globalThis.${CLICK_RECEIPT_KEY};
    if (!state) return { available: false, received: navigated, url, error: '探针不在了（页面已跳转或世界被重建）' };
    if (state.node && state.handler) { state.node.removeEventListener('click', state.handler, true); state.handler = null; }
    return { available: true, received: state.count > state.baseline || navigated, url, error: '' };
  })()`;
}

/**
 * 把回执脚本的原始求值结果收成判定用的形状。
 *
 * 脏值与 `undefined`（替身帧没供这一类脚本时就是它）一律归为「页面答不上来」，
 * **不当成失败**——这条判据只在页面能回答时才是决定性的（plan §16.1 的放软取舍）。
 * @param raw 页面回来的未知值
 * @returns `{ available, received, url }`
 */
export function toClickReceiptReading(raw: unknown): { available: boolean; received: boolean; url: string } {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    available: record.available === true,
    received: record.received === true,
    url: typeof record.url === 'string' ? record.url : '',
  };
}

/** 一次「把目标滚进本帧视口」的页面读数（spec 8.4-05）。 */
export type RevealReading = {
  /** 胜出节点还在这一帧里；为 false 时 `rect` 不可信，调用方按定位时那份读数继续走 */
  found: boolean;
  /** 是否真的动了页面：本来就在视口里时**不动**，免得每点一下就把人看着的画面推一次 */
  moved: boolean;
  /** 复读到的矩形中心是否落在本帧视口里——CDP 的鼠标坐标只有在这个前提下才点得到东西 */
  inside: boolean;
  /** 滚完并复读之后的帧内矩形（CSS 像素） */
  rect: ElementRect;
  /** 本帧视口宽（CSS 像素）；越界时界面要说「差多少」靠它 */
  viewportWidth: number;
  /** 本帧视口高（CSS 像素） */
  viewportHeight: number;
  /** 为什么没能进画面（`found` 为 true 且 `inside` 为 false 时才有内容） */
  error: string;
};

/**
 * 生成「把定位胜出的那一个节点滚进本帧视口，并**复读**一次矩形」的脚本源码（spec 8.4-05）。
 *
 * 为什么需要这一步：CDP 的鼠标事件是按**坐标**命中测试的，坐标在本帧视口之外就没有可命中的像素，
 * 而派发那侧对此毫无察觉——实测真 BOSS 的会话页把整块版面撑到 `scrollWidth` 1224，
 * 视图只有 863 宽时发送键长在裁掉的那 361px 里，`act.click` 照样回 `done`（证据 8.4-05 第一节）。
 *
 * 找回节点用的是与 `buildClickArmScript` 同一套 `candidateIndex + nodeIndex`，所以「读到的那一格」
 * 与「滚进画面的那一格」在类型上就是同一个节点。矩形必须**复读**：平滑滚动容器里
 * `scrollIntoView` 是一段动画，同一帧读回来还是旧位置（AGENTS.md §9 的 5.10-13 ⑪）。
 * @param candidates 定位时的候选数组（找回节点要用，与 `locate.find` 那一次同一份）
 * @param chosen 胜出候选的 `candidateIndex` 与 `nodeIndex`
 * @param settleMs 复读的上限（毫秒）：到点就把当前读数交出去，不无限等
 * @param stepMs 复读的步长（毫秒）
 * @param limits 取回上限
 * @returns 单个表达式源码，求值得到 `Promise<RevealReading 的页面形状>`（调用方必须按 Promise 求值）
 */
export function buildRevealScript(
  candidates: unknown[],
  chosen: { candidateIndex: number; nodeIndex: number },
  settleMs: number,
  stepMs: number,
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
): string {
  return `(() => {
${buildPrelude(limits)}
    const revealKind = 'reveal';
    const settleMs = ${JSON.stringify(settleMs)};
    const stepMs = ${JSON.stringify(stepMs)};
    const viewportWidth = finite(globalThis.innerWidth);
    const viewportHeight = finite(globalThis.innerHeight);
    const insideOf = (box) => {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      return cx >= 0 && cx <= viewportWidth && cy >= 0 && cy <= viewportHeight;
    };
    const answer = (found, moved, inside, rect, why) => ({
      found: found, moved: moved, inside: inside, rect: rect,
      viewportWidth: viewportWidth, viewportHeight: viewportHeight, error: flatten(why),
    });
    const node = findNode(${JSON.stringify(candidates)}, ${JSON.stringify(chosen)});
    if (!node) {
      return Promise.resolve(answer(false, false, false, { x: 0, y: 0, width: 0, height: 0 }, '胜出节点已不在这一帧里'));
    }
    const before = rectOf(node);
    if (insideOf(before)) return Promise.resolve(answer(true, false, true, before, ''));
    if (typeof node.scrollIntoView !== 'function') {
      return Promise.resolve(answer(true, false, false, before, '这一帧里的节点没有 scrollIntoView'));
    }
    node.scrollIntoView({ block: 'center', inline: 'center' });
    return new Promise((resolve) => {
      let last = rectOf(node);
      let stable = 0;
      let waited = 0;
      const tick = () => {
        const next = rectOf(node);
        if (next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height) {
          stable += 1;
        } else {
          stable = 0;
          last = next;
        }
        if (insideOf(last)) return resolve(answer(true, true, true, last, ''));
        if (stable >= 2) return resolve(answer(true, true, false, last, '滚动已经停了，但目标仍在视口外'));
        if (waited >= settleMs) return resolve(answer(true, true, false, last, '等滚动落定到了上限，目标位置还没稳'));
        waited += stepMs;
        setTimeout(tick, stepMs);
      };
      setTimeout(tick, stepMs);
    });
  })()`;
}

/**
 * 钳制滚进画面脚本的原始求值结果。
 *
 * `undefined`（替身帧没供这一类脚本、或那一帧拒绝了脚本）归为 `found: false`——
 * 这**不是**「目标在视口外」，调用方据此保留定位时的读数，不能拿零矩形去算派发点。
 * @param raw 页面回来的未知值
 * @returns 判定用的读数
 */
export function toRevealReading(raw: unknown): RevealReading {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const box = (record.rect && typeof record.rect === 'object' ? record.rect : {}) as Record<string, unknown>;
  const number = (value: unknown): number => (typeof value === 'number' && isFinite(value) ? value : 0);
  return {
    found: record.found === true,
    moved: record.moved === true,
    inside: record.inside === true,
    rect: { x: number(box.x), y: number(box.y), width: number(box.width), height: number(box.height) },
    viewportWidth: number(record.viewportWidth),
    viewportHeight: number(record.viewportHeight),
    error: typeof record.error === 'string' ? record.error : '',
  };
}

/** 注入探针挂在隔离世界 `globalThis` 上的键（取节点与回读两段脚本共用，必须只有一个名字）。 */
export const UPLOAD_PROBE_KEY = '__autoCcUploadProbe';

/**
 * 生成「把定位胜出的那一个节点**本身**交出来」的脚本源码（spec 2.6-04 / plan §13.3 第 4 条）。
 *
 * 与 `buildLocateScript` 用的是同一份候选、同一个 `hitsOf`，所以「打分选出的那一个」与
 * 「CDP 拿到的那一个」不会是两个节点。寻址用 `hitIndex` 而不是 `nodeIndex`：后者是 WeakMap
 * 在**单个 JS world 内部**发的号，而这段脚本跑在 CDP 新建的隔离世界里，那张表是空的。
 * 序号只依赖文档顺序，两个 world 里算出来是同一个数；DOM 中途变化会让它漂到邻居身上，
 * 所以再比对一次定位时看到的标签名与几何——对不上就返回 null，让上层拒绝动手，
 * 而不是把文件塞进一个只是恰好排在上次的位子上的控件。
 * @param candidates 定位时的候选数组（与 `locate.find` 那一次同一份）
 * @param address 胜出候选的 `candidateIndex` 与 `hitIndex`
 * @param expected 定位时看到的形状：标签名 + 帧内矩形（CSS 像素），用作漂移校验的基准
 * @param limits 取回上限
 * @returns 单个表达式源码；求值结果为该节点（`returnByValue:false` 时即 CDP 的 objectId），认不出来时为 null
 */
export function buildNodeHandleScript(
  candidates: unknown[],
  address: { candidateIndex: number; hitIndex: number },
  expected: { tagName: string; rect: ElementRect },
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
): string {
  return `(() => {
${buildPrelude(limits)}
    const address = ${JSON.stringify(address)};
    const expected = ${JSON.stringify(expected)};
    const candidate = ${JSON.stringify(candidates)}[address.candidateIndex];
    if (!candidate) return null;
    const target = hitsOf(candidate, baseNodes())[address.hitIndex];
    if (!target) return null;
    if (tagOf(target) !== 'input') return null;
    if (flatten(target.getAttribute('type')).toLowerCase() !== 'file') return null;
    const shape = rectOf(target);
    if (tagOf(target) !== expected.tagName) return null;
    if (shape.x !== expected.rect.x || shape.y !== expected.rect.y) return null;
    if (shape.width !== expected.rect.width || shape.height !== expected.rect.height) return null;
    // 探针记「页面真的收到过 change」以及它受不受信：这两条只能问页面，不能由我们代替它宣称。
    const probe = (globalThis.${UPLOAD_PROBE_KEY} = globalThis.${UPLOAD_PROBE_KEY} || new WeakMap());
    let record = probe.get(target);
    if (!record) {
      record = { changeCount: 0, isTrusted: false };
      probe.set(target, record);
      target.addEventListener('change', (event) => {
        record.changeCount += 1;
        record.isTrusted = event && event.isTrusted === true;
      });
    }
    record.changeCount = 0;
    record.isTrusted = false;
    return target;
  })()`;
}

/** 一次文件注入之后，页面自己报上来的读数。 */
export type UploadReading = {
  /** 注入之后这个控件收到过几次 `change`；0 表示文件根本没进控件（spec 2.6-04 不接受「调用没报错」） */
  changeCount: number;
  /** 那一次 `change` 的 `isTrusted`，由页面自己回答，不在这里猜（spec 2.2-12 的口径延伸到 2.6） */
  isTrusted: boolean;
  /** 控件里当前的文件个数 */
  filesCount: number;
  fileName: string;
  /** 文件大小（字节） */
  fileSize: number;
  fileType: string;
};

/**
 * 生成「回读这个控件里到底进了什么文件」的函数声明源码，交给 `Runtime.callFunctionOn` 执行。
 *
 * 它读的是**注入时拿到的那一个 objectId**，所以不重新选节点——回读与注入指向同一个对象，
 * 才是「文件确实进了我们选中的控件」的证据。轮询是因为 `setFileInputFiles` 回包时
 * `change` 未必已经派发完（spike 里要等几百毫秒才看到回显，plan §13.2 第 3 条）。
 * @param timeoutMs 回读上限（毫秒），超时就把当时的读数如实交出去；由 `browser.act` 的配置给，不写死在这里（spec 2.7-04）
 * @param stepMs 轮询间隔（毫秒），同样来自配置
 * @returns `function` 声明源码，求值结果兑现为一个 Promise
 */
export function buildUploadReadbackFunction(timeoutMs: number, stepMs: number): string {
  return `function () {
    const limitMs = ${String(timeoutMs)};
    const stepMs = ${String(stepMs)};
    const startedAt = Date.now();
    const probe = globalThis.${UPLOAD_PROBE_KEY};
    const record = probe ? probe.get(this) : null;
    const ready = () => record !== null && record !== undefined && record.changeCount > 0 && this.files && this.files.length > 0;
    return new Promise((resolve) => {
      const poll = () => {
        const first = this.files && this.files.length ? this.files[0] : null;
        if (ready() || Date.now() - startedAt >= limitMs) {
          resolve({
            changeCount: record ? record.changeCount : 0,
            isTrusted: record ? record.isTrusted === true : false,
            filesCount: this.files ? this.files.length : 0,
            fileName: first ? String(first.name) : '',
            fileSize: first ? Number(first.size) : 0,
            fileType: first ? String(first.type) : '',
          });
          return;
        }
        setTimeout(poll, stepMs);
      };
      poll();
    });
  }`;
}

/**
 * 钳制文件注入的回读读数（页面值一律是不可信输入）。
 * @param raw `Runtime.callFunctionOn` 的 `result.value`
 * @returns 字段齐全与类型确定的读数；拿不到时全为 0 / false / 空串
 */
export function toUploadReading(raw: unknown): UploadReading {
  const value = (raw ?? {}) as Record<string, unknown>;
  const number = (key: string): number => (typeof value[key] === 'number' && isFinite(value[key]) ? value[key] : 0);
  return {
    changeCount: Math.max(0, number('changeCount')),
    isTrusted: value.isTrusted === true,
    filesCount: Math.max(0, number('filesCount')),
    fileName: typeof value.fileName === 'string' ? value.fileName : '',
    fileSize: Math.max(0, number('fileSize')),
    fileType: typeof value.fileType === 'string' ? value.fileType : '',
  };
}

/**
 * 一个直接子 iframe 元素的位置与身份。
 * `src` 是解析后的绝对地址（跨源帧只能靠它对上 `WebFrameMain.url`）。
 */
export type IframeRect = ElementRect & { src: string; name: string };

/**
 * 生成「读本帧所有直接子 iframe 元素位置」的注入脚本源码（spec 2.2-09 的坐标折算依据）。
 * @returns 单个表达式源码，求值得到 `IframeRect[]`
 */
export function buildIframeRectsScript(): string {
  return `(() => {
    const nodes = document.querySelectorAll('iframe, frame');
    const out = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const box = node.getBoundingClientRect();
      out.push({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        src: node.src || node.getAttribute('src') || '',
        name: node.name || node.getAttribute('name') || '',
      });
    }
    return out;
  })()`;
}

/**
 * 钳制子 iframe 位置读数。
 * @param raw 注入脚本的返回值
 * @returns 字段齐全的位置数组
 */
export function toIframeRects(raw: unknown): IframeRect[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .map((item) => ({
      x: typeof item.x === 'number' && isFinite(item.x) ? item.x : 0,
      y: typeof item.y === 'number' && isFinite(item.y) ? item.y : 0,
      width: typeof item.width === 'number' && isFinite(item.width) ? item.width : 0,
      height: typeof item.height === 'number' && isFinite(item.height) ? item.height : 0,
      src: typeof item.src === 'string' ? item.src : '',
      name: typeof item.name === 'string' ? item.name : '',
    }));
}

/**
 * 把定位求值结果钳成 `LocatedReading[]`：页面来自不可信环境，字段缺失就用中性值补，
 * 单条畸形读数被丢弃而不是让整次定位失败。
 * @param raw `executeJavaScript` 的返回值
 * @returns 字段齐全、类型确定的读数数组；非数组时为 []
 */
export function toLocatedReadings(raw: unknown): LocatedReading[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => toLocatedReading(item)).filter((item): item is LocatedReading => item !== null);
}

/**
 * 钳制单条读数。
 * @param raw 页面里读出的一条候选命中
 * @returns 字段齐全与类型确定的读数；无法识别时 null
 */
export function toLocatedReading(raw: unknown): LocatedReading | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string): string => (typeof value[key] === 'string' ? value[key] : '');
  const number = (key: string, fallback: number): number =>
    typeof value[key] === 'number' && isFinite(value[key]) ? value[key] : fallback;
  const flag = (key: string): boolean => value[key] === true;
  const stringList = (key: string): string[] =>
    Array.isArray(value[key])
      ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
  const rawRect = (value.rect ?? {}) as Record<string, unknown>;
  const rectNumber = (key: string): number =>
    typeof rawRect[key] === 'number' && isFinite(rawRect[key]) ? rawRect[key] : 0;
  const attributes: Record<string, string> = {};
  if (value.attributes !== null && typeof value.attributes === 'object') {
    for (const [key, item] of Object.entries(value.attributes as Record<string, unknown>)) {
      if (typeof item === 'string') attributes[key] = item;
    }
  }
  const strategy = text('strategy') as LocateStrategy;
  return {
    frameUrl: text('frameUrl'),
    candidateIndex: number('candidateIndex', -1),
    strategy,
    siblingCount: Math.max(1, number('siblingCount', 1)),
    nodeIndex: number('nodeIndex', 0),
    hitIndex: Math.max(0, number('hitIndex', 0)),
    visible: flag('visible'),
    enabled: flag('enabled'),
    unobstructed: flag('unobstructed'),
    tagName: text('tagName'),
    role: text('role'),
    accessibleName: text('accessibleName'),
    text: text('text'),
    attributes,
    ancestorRoles: stringList('ancestorRoles'),
    nearbyTexts: stringList('nearbyTexts'),
    rect: {
      x: rectNumber('x'),
      y: rectNumber('y'),
      width: rectNumber('width'),
      height: rectNumber('height'),
    },
  };
}

/**
 * 钳制等待读数。
 * @param raw 等待脚本的返回值
 * @returns 字段齐全与类型确定的等待结局
 */
export function toWaitReading(raw: unknown): WaitReading {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    satisfied: value.satisfied === true,
    waitedMs: typeof value.waitedMs === 'number' && isFinite(value.waitedMs) ? value.waitedMs : 0,
    readings: toLocatedReadings(value.readings),
  };
}

/**
 * 钳制 DOM 兜底动作读数。
 * @param raw DOM 动作脚本的返回值
 * @returns 字段齐全与类型确定的动作结局
 */
export function toDomActionReading(raw: unknown): DomActionReading {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    ok: value.ok === true,
    valueAfter: typeof value.valueAfter === 'string' ? value.valueAfter : '',
    error: typeof value.error === 'string' ? value.error : '',
  };
}
