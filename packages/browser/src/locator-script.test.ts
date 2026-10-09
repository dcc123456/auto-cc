import { describe, expect, it } from 'vitest';
import type { ElementRect, LocateCandidate, LocatedReading } from '@auto-cc/shared';
import {
  DEFAULT_SCRIPT_LIMITS,
  UPLOAD_PROBE_KEY,
  buildDomActionScript,
  buildFingerprintScanScript,
  buildIframeRectsScript,
  buildLocateScript,
  buildNodeHandleScript,
  buildRevealScript,
  buildUploadReadbackFunction,
  buildValueReadScript,
  buildWaitScript,
  toDomActionReading,
  toIframeRects,
  toLocatedReading,
  toLocatedReadings,
  toRevealReading,
  toUploadReading,
  toWaitReading,
  type ScriptLimits,
} from './locator-script.js';

/** 这份替身只实现注入脚本真正碰到的那几个 DOM 面，多一个都不写。 */
type FakeNode = {
  tagName: string;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  kids: FakeNode[];
  parent?: FakeNode;
  ownText?: string;
  value?: string;
  disabled?: boolean;
  labels?: FakeNode[];
  box: ElementRect;
  clickCalls: number;
  dispatched: string[];
  /**
   * 页面侧「滚进画面」的那只手（spec 8.4-05）：注入脚本只在越界时才调它，
   * 所以测试既能数它被调了几次，也能由它改写 `box` 来演「滚完之后矩形变了」这件事。
   * 不给这个字段就是"这一帧的节点没有 scrollIntoView"那一条出口。
   */
  scrollIntoView?: (options: { block: string; inline: string }) => void;
  /** 按事件类型记下的监听器；`dispatchEvent` 会真的回调它们，注入探针那条断言才不是自说自话。 */
  listeners: Record<string, ((event: { type: string; isTrusted?: boolean }) => void)[]>;
  /** `input[type=file]` 的文件列表（只读的那个数，脚本伪造不了，测试里手工放进）。 */
  files?: { name: string; size: number; type: string }[];
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => ElementRect;
  matches: (selector: string) => boolean;
  contains: (other: FakeNode) => boolean;
  click: () => void;
  dispatchEvent: (event: { type: string; isTrusted?: boolean }) => boolean;
  addEventListener: (type: string, handler: (event: { type: string; isTrusted?: boolean }) => void) => void;
  textContent: string;
};

/** 造一个替身节点，并把子节点的父亲指回来。 */
function fakeNode(tagName: string, init: Partial<FakeNode> = {}): FakeNode {
  const node = {
    tagName,
    attrs: init.attrs ?? {},
    dataset: init.dataset ?? {},
    kids: init.kids ?? [],
    parent: init.parent,
    ownText: init.ownText,
    value: init.value,
    disabled: init.disabled,
    labels: init.labels,
    box: init.box ?? { x: 0, y: 0, width: 100, height: 30 },
    clickCalls: 0,
    dispatched: [],
    listeners: init.listeners ?? {},
    files: init.files,
    getAttribute: (name: string) => node.attrs[name] ?? null,
    getBoundingClientRect: () => node.box,
    matches: (selector: string) => matchesSelector(node, selector),
    contains: (other: FakeNode) => other === node || node.kids.some((kid) => kid.contains(other)),
    click: () => {
      node.clickCalls += 1;
    },
    dispatchEvent: (event: { type: string; isTrusted?: boolean }) => {
      node.dispatched.push(event.type);
      (node.listeners[event.type] ?? []).forEach((handler) => handler(event));
      return true;
    },
    addEventListener: (type: string, handler: (event: { type: string; isTrusted?: boolean }) => void) => {
      (node.listeners[type] ??= []).push(handler);
    },
    textContent: '',
  } as unknown as FakeNode;
  node.kids.forEach((kid) => {
    kid.parent = node;
  });
  return node;
}

/** 极简选择器匹配：只认 `tag` / `#id` / `.class` / `[attr]` / `[attr="v"]` 的串联，遇到组合器就抛错。 */
function matchesSelector(node: FakeNode, selector: string): boolean {
  if (/[\s>]/.test(selector) || selector.includes(':')) throw new Error(`替身选择器引擎不支持：${selector}`);
  const parts = selector.match(/^[a-zA-Z0-9]+|[.#][a-zA-Z0-9_-]+|\[[^\]]+\]/g) ?? [];
  return parts.every((part) => {
    if (part.startsWith('#')) return node.attrs.id === part.slice(1);
    if (part.startsWith('.')) return (node.attrs.class ?? '').split(/\s+/).includes(part.slice(1));
    if (part.startsWith('[')) {
      const body = part.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq < 0) return node.getAttribute(body) !== null;
      return node.getAttribute(body.slice(0, eq)) === body.slice(eq + 1).replaceAll('"', '');
    }
    return node.tagName.toLowerCase() === part.toLowerCase();
  });
}

/** 深度优先展开，顺序与真实 DOM 文档序一致——`nodeIndex` 的稳定性依赖这一点。 */
function flattenTree(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [root];
  root.kids.forEach((kid) => out.push(...flattenTree(kid)));
  return out;
}

/** 拼出子孙正文：脚本读 `textContent`，替身没有真实文本树就按当前结构现算。 */
function textContentOf(node: FakeNode): string {
  if (typeof node.ownText === 'string') return node.ownText;
  return node.kids.map(textContentOf).join(' ');
}

/** 页面替身：注入脚本用到的每个 document 面都在这里。 */
type FakePage = {
  body: FakeNode;
  documentElement: FakeNode;
  querySelectorAll: (selector: string) => FakeNode[];
  getElementById: (id: string) => FakeNode | null;
  elementFromPoint: (x: number, y: number) => FakeNode | null;
};

/**
 * 把结构派生出来的那几个面挂成 getter。
 *
 * 用 getter 而不是直接赋字段，是因为测试里会往 `kids` 里追加节点（歧义命中、后来才出现的元素），
 * 缓存下来的父亲与兄弟就成了过期快照——真实 DOM 的这几个属性永远是现算的。
 * @param node 目标节点
 */
function defineStructuralGetters(node: FakeNode): void {
  const siblings = node.parent?.kids ?? [];
  const position = siblings.indexOf(node);
  Object.defineProperties(node, {
    textContent: { get: () => textContentOf(node), configurable: true, enumerable: false },
    parentElement: { get: () => node.parent, configurable: true, enumerable: false },
    // `children` 在真实 DOM 里是**自己的**子节点；脚本读的 `parentElement.children` 才是兄弟表，
    // 这里若返回兄弟，父级文本会被当成锚点混进指纹里。
    children: { get: () => node.kids, configurable: true, enumerable: false },
    previousElementSibling: {
      get: () => (position > 0 ? siblings[position - 1] : undefined),
      configurable: true,
      enumerable: false,
    },
    nextElementSibling: {
      get: () => (position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : undefined),
      configurable: true,
      enumerable: false,
    },
  });
}

/**
 * 造页面替身。
 *
 * `querySelectorAll` 每次调用都重新展开树，而不是把结果缓存下来——等待脚本会反复扫描，
 * 而「后来才出现的元素」正是它要等到的东西。
 * @param root 文档根节点
 * @returns 可直接喂给注入脚本的 document 替身
 */
function fakePage(root: FakeNode): FakePage {
  const live = () => {
    const all = flattenTree(root);
    all.forEach(defineStructuralGetters);
    return all;
  };
  return {
    body: root,
    documentElement: root,
    querySelectorAll: (selector) =>
      selector === '*'
        ? live()
        : live().filter((node) =>
            selector
              .split(',')
              .map((part) => part.trim().toLowerCase())
              .includes(node.tagName.toLowerCase()),
          ),
    getElementById: (id) => live().find((node) => node.attrs.id === id) ?? null,
    elementFromPoint: (x, y) => {
      // 文档序里越靠后越在上层（后画的盖住先画的），所以命中的是最后一个包住该点的节点。
      const hits = live().filter(
        (node) =>
          node.box.x <= x && x <= node.box.x + node.box.width && node.box.y <= y && y <= node.box.y + node.box.height,
      );
      return hits.at(-1) ?? null;
    },
  };
}

/**
 * 一个「JS world」：注入脚本把 `nodeIndex` 注册表与上传探针都挂在它的 `globalThis` 上，
 * 所以换一个对象就等于换一个新的隔离世界——跨 world 寻址那条断言靠这个演。
 */
const DEFAULT_WORLD: Record<string, unknown> = {};

/**
 * 在替身页面上求值注入脚本——与 `executeJavaScript` 跑的是同一段源码。
 *
 * 只断言字符串里出现了 `roleOf` 证明不了脚本读得对，所以这里必须真的求值。
 * @param source 某个 builder 产出的表达式源码
 * @param page 页面替身
 * @param world 这一轮的 `globalThis` 替身；默认全文件共用一个（`nodeIndex` 跨多次求值要稳定）
 * @returns 脚本返回值（等待类脚本返回 Promise）
 */
function run(source: string, page: FakePage, world: Record<string, unknown> = DEFAULT_WORLD): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 被测对象本身就是一段注入脚本，绕开求值就只剩断言字符串
  return new Function('document', 'location', 'globalThis', `return ${source}`)(
    page,
    {
      href: 'http://127.0.0.1:10233/locator',
    },
    world,
  );
}

/**
 * 求值 `buildUploadReadbackFunction` 产出的**函数声明**，并以指定对象为 `this` 调用它。
 *
 * 真实调用走 `Runtime.callFunctionOn`，那里的 `this` 就是当初那个 objectId；
 * 这里用 `call` 复现同一件事，才能断言「回读的就是注入的那一个节点」。
 * @param declaration 函数声明源码
 * @param self 调用对象（通常是那个 input 替身）
 * @param world 与取节点那一步同一个 `globalThis` 替身（探针留在里面）
 * @returns 该函数兑现的 Promise
 */
function runReadback(declaration: string, self: unknown, world: Record<string, unknown>): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 同上：被测对象是一段注入函数体
  const readback = new Function('globalThis', `return (${declaration})`)(world) as (this: unknown) => Promise<unknown>;
  return readback.call(self);
}

/** 「职位卡片」树：搜索框 + 列表 + 卡片（标题与打招呼按钮）+ 盖在按钮上的浮层。 */
function jobCardTree(): { root: FakeNode; apply: FakeNode; keyword: FakeNode; title: FakeNode } {
  const overlay = fakeNode('div', { attrs: { class: 'mask' }, box: { x: 0, y: 300, width: 500, height: 40 } });
  const apply = fakeNode('button', {
    attrs: { 'data-testid': 'apply-btn', class: 'btn btn-primary', id: 'apply-1', type: 'button' },
    dataset: { testid: 'apply-btn' },
    ownText: '打招呼',
    box: { x: 0, y: 300, width: 120, height: 40 },
  });
  const keyword = fakeNode('input', {
    attrs: { name: 'query', placeholder: '搜索职位、公司', type: 'text' },
    value: '前端',
    box: { x: 0, y: 10, width: 300, height: 32 },
  });
  const headingRef = fakeNode('span', { attrs: { id: 'job-title' }, ownText: '资深前端工程师' });
  const title = fakeNode('div', {
    attrs: { role: 'heading', 'aria-labelledby': 'job-title', 'aria-label': '自报的名字' },
    kids: [headingRef],
    box: { x: 0, y: 60, width: 300, height: 24 },
  });
  const card = fakeNode('div', {
    attrs: { class: 'card' },
    kids: [title, apply],
    box: { x: 0, y: 50, width: 400, height: 300 },
  });
  const list = fakeNode('div', {
    attrs: { role: 'list' },
    kids: [card, overlay],
    box: { x: 0, y: 40, width: 400, height: 400 },
  });
  const root = fakeNode('body', { kids: [keyword, list], box: { x: 0, y: 0, width: 500, height: 800 } });
  return { root, apply, keyword, title };
}

/** 按上限跑一次定位扫描。 */
function scan(
  candidates: LocateCandidate[],
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
  page: FakePage = fakePage(jobCardTree().root),
  world: Record<string, unknown> = DEFAULT_WORLD,
): LocatedReading[] {
  return toLocatedReadings(run(buildLocateScript(candidates, limits), page, world));
}

describe('定位读取脚本（spec 2.2-01）', () => {
  it('testId 命中读出的是一条完整指纹：帧地址、角色、可读名、位置都在，class 却一条都不留', () => {
    const readings = scan([{ strategy: 'testId', attribute: 'data-testid', value: 'apply-btn' }]);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      frameUrl: 'http://127.0.0.1:10233/locator',
      candidateIndex: 0,
      strategy: 'testId',
      siblingCount: 1,
      tagName: 'button',
      role: 'button',
      accessibleName: '打招呼',
      text: '打招呼',
      visible: true,
      enabled: true,
      rect: { x: 0, y: 300, width: 120, height: 40 },
    });
    expect(readings[0]!.attributes).toEqual({ id: 'apply-1', type: 'button', 'data-testid': 'apply-btn' });
    expect(readings[0]!.ancestorRoles).toEqual(['list']);
    expect(readings[0]!.nearbyTexts).toEqual(['资深前端工程师']);
  });

  it('id / name 候选按属性全等命中；placeholder 是输入框可读名的兜底来源', () => {
    expect(scan([{ strategy: 'id', value: 'apply-1' }])[0]?.strategy).toBe('id');
    const byName = scan([{ strategy: 'name', value: 'query' }]);
    expect(byName[0]).toMatchObject({ role: 'textbox', accessibleName: '搜索职位、公司', text: '前端' });
  });

  it('role 候选要角色和可读名都对上才算命中，包含匹配与 exact 全等分开', () => {
    const contains = scan([{ strategy: 'role', role: 'heading', name: '前端' }]);
    expect(contains).toHaveLength(1);
    expect(contains[0]).toMatchObject({ tagName: 'div', role: 'heading' });
    expect(scan([{ strategy: 'role', role: 'heading', name: '资深前端工程师', exact: true }])).toHaveLength(1);
    expect(scan([{ strategy: 'role', role: 'heading', name: '不存在的名字' }])).toHaveLength(0);
    expect(scan([{ strategy: 'role', role: 'button', name: '打招呼' }])).toHaveLength(1);
  });

  it('可读名的级联次序：aria-labelledby 压过 aria-label，引用到的节点文本才是名字', () => {
    const reading = scan([{ strategy: 'css', value: 'div' }]).find((item) => item.role === 'heading');
    expect(reading!.accessibleName).toBe('资深前端工程师');
  });

  it('文本候选只留最深的一层命中，容器不参与；hitsPerCandidate 截断不改 siblingCount', () => {
    const readings = scan([{ strategy: 'text', value: '打招呼' }], DEFAULT_SCRIPT_LIMITS, fakePage(jobCardTree().root));
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ tagName: 'button', siblingCount: 1, strategy: 'text' });
  });

  it('歧义命中把总数带回来，界面才看得出「一条条件中了几个」', () => {
    const tree = jobCardTree();
    const duplicate = fakeNode('button', { attrs: { 'data-testid': 'apply-btn' }, ownText: '打招呼' });
    tree.apply.parent!.kids.push(duplicate);
    const readings = scan(
      [{ strategy: 'testId', attribute: 'data-testid', value: 'apply-btn' }],
      DEFAULT_SCRIPT_LIMITS,
      fakePage(tree.root),
    );
    expect(readings).toHaveLength(2);
    expect(readings.map((item) => item.siblingCount)).toEqual([2, 2]);
    expect(readings[0]!.nodeIndex).not.toBe(readings[1]!.nodeIndex);
  });

  it('一条候选命中过多时按上限截断回读，但总数仍是真实总数', () => {
    const tree = jobCardTree();
    for (let index = 0; index < 6; index += 1) {
      tree.apply.parent!.kids.push(fakeNode('button', { attrs: { 'data-testid': 'apply-btn' }, ownText: '打招呼' }));
    }
    const readings = scan(
      [{ strategy: 'testId', attribute: 'data-testid', value: 'apply-btn' }],
      { ...DEFAULT_SCRIPT_LIMITS, hitsPerCandidate: 2 },
      fakePage(tree.root),
    );
    expect(readings).toHaveLength(2);
    expect(readings[0]!.siblingCount).toBe(7);
  });

  it('动作前置判据如实读出：disabled 关掉 enabled，被浮层盖住关掉 unobstructed，零尺寸关掉 visible', () => {
    expect(scan([{ strategy: 'css', value: 'button' }])[0]).toMatchObject({
      visible: true,
      enabled: true,
      unobstructed: false,
    });
    const disabled = fakeNode('button', { attrs: { id: 'apply-1' }, disabled: true });
    expect(
      scan(
        [{ strategy: 'id', value: 'apply-1' }],
        DEFAULT_SCRIPT_LIMITS,
        fakePage(fakeNode('body', { kids: [disabled] })),
      )[0],
    ).toMatchObject({
      enabled: false,
      visible: true,
    });
    const collapsed = fakeNode('button', { attrs: { id: 'apply-1' }, box: { x: 0, y: 0, width: 0, height: 0 } });
    expect(
      scan(
        [{ strategy: 'id', value: 'apply-1' }],
        DEFAULT_SCRIPT_LIMITS,
        fakePage(fakeNode('body', { kids: [collapsed] })),
      )[0],
    ).toMatchObject({ visible: false, unobstructed: false });
  });

  it('像机器生成的属性值进不了指纹：下次构建它就变了，留着只会把自愈带偏', () => {
    const generated = fakeNode('button', {
      attrs: { id: 'btn-4711' },
      dataset: { render: 'a1b2c3d4', stable: 'apply-entry' },
      ownText: '打招呼',
    });
    const reading = scan(
      [{ strategy: 'css', value: 'button' }],
      DEFAULT_SCRIPT_LIMITS,
      fakePage(fakeNode('body', { kids: [generated] })),
    )[0]!;
    expect(reading.attributes).toEqual({ 'data-stable': 'apply-entry' });
  });

  it('css 候选交给 matches；非法选择器只让这条候选零命中，不掀翻整次扫描', () => {
    expect(scan([{ strategy: 'css', value: 'button' }])).toHaveLength(1);
    expect(scan([{ strategy: 'css', value: 'div button' }])).toHaveLength(0);
    const readings = scan([
      { strategy: 'css', value: 'div button' },
      { strategy: 'id', value: 'apply-1' },
    ]);
    expect(readings).toHaveLength(1);
    expect(readings[0]!.candidateIndex).toBe(1);
  });

  it('没有 document.evaluate 时 xpath 候选安静地零命中，而不是抛错拖垮整帧', () => {
    expect(scan([{ strategy: 'xpath', value: '//button' }])).toHaveLength(0);
  });

  it('非法属性名的 testId 候选被拒收，选择器语法进不了页面', () => {
    expect(scan([{ strategy: 'testId', attribute: 'data-x"]', value: 'apply-btn' }])).toHaveLength(0);
  });

  it('nodeIndex 在同一帧的多次求值之间稳定，所以「定位到某节点」和「对它下动作」接得上', () => {
    const page = fakePage(jobCardTree().root);
    const first = scan([{ strategy: 'id', value: 'apply-1' }], DEFAULT_SCRIPT_LIMITS, page)[0]!;
    const second = scan([{ strategy: 'css', value: 'button' }], DEFAULT_SCRIPT_LIMITS, page)[0]!;
    expect(second.nodeIndex).toBe(first.nodeIndex);
    expect(first.nodeIndex).toBeGreaterThan(0);
  });

  it('指纹扫描按标签名预筛，读出的 strategy 一律是 fingerprint 且 candidateIndex 为 -1', () => {
    const readings = toLocatedReadings(run(buildFingerprintScanScript('button'), fakePage(jobCardTree().root)));
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      strategy: 'fingerprint',
      candidateIndex: -1,
      siblingCount: 1,
      tagName: 'button',
    });
  });

  it('子 iframe 的位置与身份读得出来，坐标折算才有依据（spec 2.2-09）', () => {
    const inner = fakeNode('iframe', {
      attrs: { src: '/chat-frame', name: 'chat-box' },
      box: { x: 200, y: 100, width: 300, height: 200 },
    });
    const rects = toIframeRects(run(buildIframeRectsScript(), fakePage(fakeNode('body', { kids: [inner] }))));
    expect(rects).toEqual([{ x: 200, y: 100, width: 300, height: 200, src: '/chat-frame', name: 'chat-box' }]);
    expect(toIframeRects(null)).toEqual([]);
  });
});

describe('DOM 兜底与等待脚本（spec 2.2-03 / 2.2-12）', () => {
  /** 先定位，再按胜出的候选下标 + 身份号下动作——与真实调用顺序一致。 */
  const actOn = (
    action: 'click' | 'type' | 'select',
    candidates: LocateCandidate[],
    chosen: LocatedReading,
    page: FakePage,
    payload?: string,
  ): ReturnType<typeof toDomActionReading> =>
    toDomActionReading(
      run(
        buildDomActionScript(
          action,
          candidates,
          { candidateIndex: chosen.candidateIndex, nodeIndex: chosen.nodeIndex },
          payload,
        ),
        page,
      ),
    );

  it('click 走 DOM 通道时节点真的收到了点击', () => {
    const tree = jobCardTree();
    const page = fakePage(tree.root);
    const candidates: LocateCandidate[] = [{ strategy: 'id', value: 'apply-1' }];
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page)[0]!;
    expect(actOn('click', candidates, chosen, page)).toMatchObject({ ok: true, error: '' });
    expect(tree.apply.clickCalls).toBe(1);
  });

  it('type 写入 value 并补 input / change，回读的 valueAfter 就是页面里的当前值', () => {
    const tree = jobCardTree();
    const page = fakePage(tree.root);
    const candidates: LocateCandidate[] = [{ strategy: 'name', value: 'query' }];
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page)[0]!;
    expect(actOn('type', candidates, chosen, page, '资深前端 3年经验')).toMatchObject({
      ok: true,
      valueAfter: '资深前端 3年经验',
    });
    expect(tree.keyword.dispatched).toEqual(['input', 'change']);
    expect(tree.keyword.value).toBe('资深前端 3年经验');
  });

  it('select 把值写进目标并补 change', () => {
    const picker = fakeNode('select', { attrs: { id: 'salary' }, value: '' });
    const page = fakePage(fakeNode('body', { kids: [picker] }));
    const candidates: LocateCandidate[] = [{ strategy: 'id', value: 'salary' }];
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page)[0]!;
    expect(actOn('select', candidates, chosen, page, '10k-20k')).toMatchObject({ ok: true, valueAfter: '10k-20k' });
    expect(picker.dispatched).toEqual(['change']);
  });

  it('目标节点被移走时返回结构化失败并说明要重新定位，不抛异常', () => {
    const tree = jobCardTree();
    const page = fakePage(tree.root);
    const candidates: LocateCandidate[] = [{ strategy: 'id', value: 'apply-1' }];
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page)[0]!;
    tree.root.kids.length = 0;
    expect(actOn('click', candidates, chosen, page)).toMatchObject({
      ok: false,
      error: '目标节点已不在当前帧里，需要重新定位',
    });
  });

  it('appear 等到元素出现即兑现，waitedMs 不超过上限', async () => {
    const root = fakeNode('body', { kids: [] });
    const page = fakePage(root);
    setTimeout(() => {
      root.kids.push(fakeNode('button', { attrs: { id: 'late' }, ownText: '打招呼' }));
    }, 10);
    const reading = toWaitReading(
      await run(buildWaitScript('appear', [{ strategy: 'id', value: 'late' }], 500, 5), page),
    );
    expect(reading.satisfied).toBe(true);
    expect(reading.waitedMs).toBeLessThanOrEqual(500);
    expect(reading.readings[0]).toMatchObject({ tagName: 'button' });
  });

  it('disappear 等不到就如实报未满足并带上仍在的元素——超时是结局，不是异常', async () => {
    const page = fakePage(jobCardTree().root);
    const reading = toWaitReading(
      await run(buildWaitScript('disappear', [{ strategy: 'id', value: 'apply-1' }], 30, 5), page),
    );
    expect(reading.satisfied).toBe(false);
    expect(reading.readings).toHaveLength(1);
  });

  it('clickable 要求可见 + 启用 + 未被遮挡三者齐备，被浮层盖住时不满足', async () => {
    const reading = toWaitReading(
      await run(
        buildWaitScript('clickable', [{ strategy: 'css', value: 'button' }], 30, 5),
        fakePage(jobCardTree().root),
      ),
    );
    expect(reading.satisfied).toBe(false);
  });

  it('textChanges 以脚本自己取的基线为准，页面文本没变就不算等到', async () => {
    const reading = toWaitReading(
      await run(
        buildWaitScript('textChanges', [{ strategy: 'id', value: 'apply-1' }], 20, 5),
        fakePage(jobCardTree().root),
      ),
    );
    expect(reading.satisfied).toBe(false);
  });
});

describe('文件注入脚本（spec 2.6-04 / plan §13.3 第 4 条）', () => {
  const idCandidate: LocateCandidate[] = [{ strategy: 'id', value: 'resume-file' }];

  /** 站点常见的上传现场：一个隐藏的 `input[type=file]` + 一个真的按钮。 */
  function uploadTree(): { page: FakePage; file: FakeNode; button: FakeNode } {
    const file = fakeNode('input', {
      attrs: { id: 'resume-file', type: 'file', 'data-testid': 'resume-upload' },
      box: { x: 0, y: 0, width: 0, height: 0 },
    });
    const button = fakeNode('button', { attrs: { id: 'send-resume' }, ownText: '投递简历' });
    const root = fakeNode('body', { kids: [file, button], box: { x: 0, y: 0, width: 500, height: 800 } });
    return { page: fakePage(root), file, button };
  }

  /**
   * 先定位、再把胜出读数交给取节点脚本——与 `browser.act.upload` 的调用顺序一致。
   * @param candidates 声明候选（定位与取节点共用同一份）
   * @param page 页面替身
   * @param world 定位那一轮的 `globalThis`
   * @param hit 取第几条读数（默认第一条）
   * @returns 取节点脚本的求值结果与那条读数
   */
  function locateThenHandle(
    candidates: LocateCandidate[],
    page: FakePage,
    world: Record<string, unknown>,
    hit = 0,
    handleWorld: Record<string, unknown> = world,
  ): { chosen: LocatedReading; node: unknown } {
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page, world)[hit]!;
    return {
      chosen,
      node: run(
        buildNodeHandleScript(
          candidates,
          { candidateIndex: chosen.candidateIndex, hitIndex: chosen.hitIndex },
          { tagName: chosen.tagName, rect: chosen.rect },
          DEFAULT_SCRIPT_LIMITS,
        ),
        page,
        handleWorld,
      ),
    };
  }

  it('每条命中带自己的序号：hitIndex 是候选命中列表里的第几个，与帧内身份号无关', () => {
    const twinA = fakeNode('input', { attrs: { class: 'up', type: 'file' } });
    const twinB = fakeNode('input', { attrs: { class: 'up', type: 'file' } });
    const page = fakePage(fakeNode('body', { kids: [twinA, twinB] }));
    const readings = scan([{ strategy: 'css', value: '.up' }], DEFAULT_SCRIPT_LIMITS, page);
    expect(readings.map((item) => item.hitIndex)).toEqual([0, 1]);
    expect(readings.map((item) => item.siblingCount)).toEqual([2, 2]);
  });

  it('取节点脚本交出的是那一个节点本身，并顺手在它上面装好 change 探针', () => {
    const { page, file } = uploadTree();
    const world: Record<string, unknown> = {};
    expect(locateThenHandle(idCandidate, page, world).node).toBe(file);
    expect(file.listeners.change).toHaveLength(1);
  });

  it('跨 world 只认序号：身份号在新 world 里是另发的号，按它找回的是空气', () => {
    const twin = fakeNode('input', { attrs: { class: 'up', type: 'file' } });
    const file = fakeNode('input', { attrs: { class: 'up', id: 'resume-file', type: 'file' } });
    const page = fakePage(fakeNode('body', { kids: [twin, file] }));
    const candidates: LocateCandidate[] = [
      { strategy: 'css', value: '.up' },
      { strategy: 'id', value: 'resume-file' },
    ];
    // 第一条候选先给两个输入框发了 1、2 号，于是 id 候选的读数带着 nodeIndex=2。
    const located = scan(candidates, DEFAULT_SCRIPT_LIMITS, page, {})[2]!;
    expect(located).toMatchObject({ candidateIndex: 1, hitIndex: 0, nodeIndex: 2 });
    // 换一个新的 world（CDP 的隔离世界）：按序号仍找回同一个节点……
    const isolated: Record<string, unknown> = {};
    expect(locateThenHandle(candidates, page, {}, 2, isolated).node).toBe(file);
    // ……而按身份号找回（DOM 兜底那条路）只能报「节点不在了」。
    const readBack = toDomActionReading(
      run(
        buildValueReadScript(candidates, { candidateIndex: located.candidateIndex, nodeIndex: located.nodeIndex }),
        page,
        isolated,
      ),
    );
    expect(readBack).toMatchObject({ ok: false });
  });

  it('标签名不是 input、或 type 不是 file 时返回 null——不把简历注进一个按钮', () => {
    const { page, button } = uploadTree();
    const world: Record<string, unknown> = {};
    const candidates: LocateCandidate[] = [{ strategy: 'id', value: 'send-resume' }];
    expect(locateThenHandle(candidates, page, world).node).toBeNull();
    expect(button.listeners.change).toBeUndefined();
  });

  it('几何一变就返回 null：宁可不注入，也不把文件塞进恰好排在旧位置上别的控件', () => {
    const { page, file } = uploadTree();
    const world: Record<string, unknown> = {};
    const chosen = scan(idCandidate, DEFAULT_SCRIPT_LIMITS, page, world)[0]!;
    file.box = { x: 0, y: 120, width: 0, height: 0 };
    expect(
      run(
        buildNodeHandleScript(
          idCandidate,
          { candidateIndex: chosen.candidateIndex, hitIndex: chosen.hitIndex },
          { tagName: chosen.tagName, rect: chosen.rect },
        ),
        page,
        world,
      ),
    ).toBeNull();
  });

  it('序号越界（DOM 中途少了一个同类节点）同样返回 null，不退回「就近找一个」', () => {
    const { page, file } = uploadTree();
    const world: Record<string, unknown> = {};
    const chosen = scan(idCandidate, DEFAULT_SCRIPT_LIMITS, page, world)[0]!;
    expect(
      run(
        buildNodeHandleScript(
          idCandidate,
          { candidateIndex: chosen.candidateIndex, hitIndex: chosen.hitIndex + 1 },
          { tagName: chosen.tagName, rect: chosen.rect },
        ),
        page,
        world,
      ),
    ).toBeNull();
    expect(file.listeners.change).toBeUndefined();
  });

  it('注入后页面真的收到过 change：回读把文件与 isTrusted 一起交出来', async () => {
    const { page, file } = uploadTree();
    const world: Record<string, unknown> = {};
    expect(locateThenHandle(idCandidate, page, world).node).toBe(file);
    file.files = [{ name: '资深前端-简历.pdf', size: 226, type: 'application/pdf' }];
    file.dispatchEvent({ type: 'change', isTrusted: true });
    const reading = toUploadReading(await runReadback(buildUploadReadbackFunction(50, 5), file, world));
    expect(reading).toEqual({
      changeCount: 1,
      isTrusted: true,
      filesCount: 1,
      fileName: '资深前端-简历.pdf',
      fileSize: 226,
      fileType: 'application/pdf',
    });
  });

  it('每取一次节点都把计数清零：上一轮的 change 不能替这一轮作保', async () => {
    const { page, file } = uploadTree();
    const world: Record<string, unknown> = {};
    locateThenHandle(idCandidate, page, world);
    file.dispatchEvent({ type: 'change', isTrusted: false });
    expect(toUploadReading(await runReadback(buildUploadReadbackFunction(30, 5), file, world)).changeCount).toBe(1);
    locateThenHandle(idCandidate, page, world);
    expect(toUploadReading(await runReadback(buildUploadReadbackFunction(30, 5), file, world)).changeCount).toBe(0);
  });

  it('站点没派发 change 时回读带着全零兑现，不会永远悬在那儿', async () => {
    const file = fakeNode('input', { attrs: { id: 'resume-file', type: 'file' } });
    const reading = toUploadReading(await runReadback(buildUploadReadbackFunction(30, 5), file, {}));
    expect(reading).toEqual({
      changeCount: 0,
      isTrusted: false,
      filesCount: 0,
      fileName: '',
      fileSize: 0,
      fileType: '',
    });
  });

  it('探针键只有一个名字：取节点与回读两段脚本共用同一个 globalThis 挂点', () => {
    expect(UPLOAD_PROBE_KEY).toBe('__autoCcUploadProbe');
    expect(buildUploadReadbackFunction(1500, 50)).toContain(UPLOAD_PROBE_KEY);
  });

  it('回读读数的字段一律钳齐：页面给什么形状的垃圾都不影响类型', () => {
    expect(toUploadReading(null)).toMatchObject({ changeCount: 0, isTrusted: false, fileName: '' });
    expect(toUploadReading({ changeCount: -3, isTrusted: 'true', fileName: 42, fileSize: Number.NaN })).toEqual({
      changeCount: 0,
      isTrusted: false,
      filesCount: 0,
      fileName: '',
      fileSize: 0,
      fileType: '',
    });
    expect(toUploadReading('不是对象').filesCount).toBe(0);
  });
});

describe('滚进视口脚本（spec 8.4-05）', () => {
  /**
   * 真 BOSS 会话页在开发实例最宽档上的实测视口（证据 8.4-05 第一节：站点把版面撑到
   * `scrollWidth` 1224，而内嵌视图只有 863 宽，于是发送键长在裁掉的那 361px 里）。
   * 它同时是脚本里 `globalThis.innerWidth/innerHeight` 的来源——那个对象就是页面的 world。
   */
  const VIEWPORT_WORLD = { innerWidth: 863, innerHeight: 654 };

  /**
   * 造一个「越界的发送键」并把它滚到指定落点。
   * @param box 定位时看到的矩形（帧内 CSS 像素）
   * @param landed 滚完之后的矩形；null 表示"这一帧滚到底也到不了"
   * @returns 节点替身与 `scrollIntoView` 的调用参数记录
   */
  function sendButton(box: ElementRect, landed: ElementRect | null) {
    const calls: string[] = [];
    const node = fakeNode('button', { attrs: { id: 'send-1', class: 'btn-send' }, ownText: '发送', box });
    node.scrollIntoView = (options) => {
      calls.push(`${options.block}/${options.inline}`);
      if (landed) node.box = landed;
    };
    return { node, calls };
  }

  /**
   * 先定位（发身份号），再对同一格跑滚进画面脚本——与真实调用顺序一致。
   * @param node 目标节点（它的 `box` 就是定位时看到的那一份矩形）
   * @returns 脚本读数与定位时的那格身份
   */
  async function revealSendButton(node: FakeNode) {
    const candidates: LocateCandidate[] = [{ strategy: 'id', value: 'send-1' }];
    const page = fakePage(fakeNode('body', { kids: [node], box: { x: 0, y: 0, width: 1224, height: 654 } }));
    const world: Record<string, unknown> = { ...VIEWPORT_WORLD };
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page, world)[0]!;
    const reading = toRevealReading(
      await run(
        buildRevealScript(candidates, { candidateIndex: chosen.candidateIndex, nodeIndex: chosen.nodeIndex }, 100, 10),
        page,
        world,
      ),
    );
    return { reading, chosen };
  }

  it('本来就在视口里时一次都不动页面——不能每点一下就把人看着的画面推一次', async () => {
    const { node, calls } = sendButton({ x: 100, y: 300, width: 60, height: 30 }, null);
    const { reading } = await revealSendButton(node);
    expect(calls).toEqual([]);
    expect(reading).toMatchObject({ found: true, moved: false, inside: true, error: '' });
    expect([reading.viewportWidth, reading.viewportHeight]).toEqual([863, 654]);
    expect(reading.rect).toEqual({ x: 100, y: 300, width: 60, height: 30 });
  });

  it('越界时交回的是滚完之后**复读**的那份矩形，不是定位时那一份', async () => {
    // 平滑滚动容器里 scrollIntoView 是一段动画：同一帧读回来还是旧位置（AGENTS.md §9 的 5.10-13 ⑪），
    // 所以这条断言盯的是「派发点用的坐标」——1112 与 400 差着整整一个裁切量，用错了就是点到画面外。
    const { node, calls } = sendButton(
      { x: 1112, y: 300, width: 60, height: 30 },
      { x: 400, y: 300, width: 60, height: 30 },
    );
    const { reading } = await revealSendButton(node);
    expect(calls).toEqual(['center/center']);
    expect(reading).toMatchObject({ found: true, moved: true, inside: true, error: '' });
    expect(reading.rect).toEqual({ x: 400, y: 300, width: 60, height: 30 });
  });

  it('滚到极限仍在视口外时 inside 为 false 并说清原因，同时把视口尺寸交回去', async () => {
    const landed = { x: 900, y: 300, width: 60, height: 30 };
    const { node, calls } = sendButton({ x: 1112, y: 300, width: 60, height: 30 }, landed);
    const { reading } = await revealSendButton(node);
    expect(calls).toEqual(['center/center']);
    expect(reading).toMatchObject({ found: true, moved: true, inside: false, rect: landed, viewportWidth: 863 });
    expect(reading.error).toContain('视口外');
  });

  it('节点在这一帧里没了就如实报 found:false，调用方据此保留定位时的读数', async () => {
    const { node } = sendButton({ x: 1112, y: 300, width: 60, height: 30 }, null);
    const candidates: LocateCandidate[] = [{ strategy: 'id', value: 'send-1' }];
    const root = fakeNode('body', { kids: [node], box: { x: 0, y: 0, width: 1224, height: 654 } });
    const page = fakePage(root);
    const world: Record<string, unknown> = { ...VIEWPORT_WORLD };
    const chosen = scan(candidates, DEFAULT_SCRIPT_LIMITS, page, world)[0]!;
    root.kids.length = 0;
    const reading = toRevealReading(
      await run(
        buildRevealScript(candidates, { candidateIndex: chosen.candidateIndex, nodeIndex: chosen.nodeIndex }, 100, 10),
        page,
        world,
      ),
    );
    expect(reading).toMatchObject({ found: false, moved: false, inside: false });
  });
});

describe('页面读数钳制（外部页面是不可信输入）', () => {
  it('非数组的返回值钳成空表，null 与非对象项被剔除', () => {
    expect(toLocatedReadings(null)).toEqual([]);
    expect(toLocatedReadings('nope')).toEqual([]);
    expect(toLocatedReadings([null, 1, undefined])).toEqual([]);
  });

  it('字段类型不对时用中性值补齐，siblingCount 至少是 1', () => {
    const reading = toLocatedReading({ siblingCount: 'many', rect: 'none', attributes: 'x', nearbyTexts: ['a', 1] })!;
    expect(reading.siblingCount).toBe(1);
    expect(reading.nodeIndex).toBe(0);
    expect(reading.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(reading.attributes).toEqual({});
    expect(reading.nearbyTexts).toEqual(['a']);
    expect(reading.visible).toBe(false);
  });

  it('等待读数与动作读数各自钳齐字段', () => {
    expect(toWaitReading(null)).toEqual({ satisfied: false, waitedMs: 0, readings: [] });
    expect(toWaitReading({ satisfied: true, waitedMs: 12, readings: [{ nodeIndex: 3 }] })).toMatchObject({
      satisfied: true,
      waitedMs: 12,
    });
    expect(toDomActionReading(null)).toEqual({ ok: false, valueAfter: '', error: '' });
    expect(toDomActionReading({ ok: true, valueAfter: 5, error: null })).toEqual({
      ok: true,
      valueAfter: '',
      error: '',
    });
  });

  it('滚进画面的读数：页面答不上来就是 found:false，脏数字与脏矩形钳成 0', () => {
    expect(toRevealReading(null)).toEqual({
      found: false,
      moved: false,
      inside: false,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      viewportWidth: 0,
      viewportHeight: 0,
      error: '',
    });
    expect(
      toRevealReading({ found: true, inside: true, rect: { x: '1112', y: Number.NaN, width: 60, height: 30 } }).rect,
    ).toEqual({ x: 0, y: 0, width: 60, height: 30 });
  });
});
