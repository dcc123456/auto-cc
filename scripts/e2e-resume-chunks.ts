/**
 * 端到端自测（resume chunk flow，对应 .trae/documents/resume_chunk_flow_plan.md 片 1～4）：
 *
 *   导入陌生要素简历 → 按要素拆分（证书/荣誉在六类词典之外，必须保真为 custom，信息不丢）
 *   → 核对（改字 / 加条 / 改名 / 新增自定义要素，落母版 + chunk 同趟重建）
 *   → 贴 JD1 生成变体 → 变体 PDF 文本层含 custom 原文标题
 *   → 贴 JD2 再出第二支变体 → 母版始终不改
 *   → 后续使用：直接再来一支 JD，不需要重新导入
 *
 * 与 `e2e-resume-jd.ts` 的分工：那一条验「PDF→建库→抓真 JD→模型改写」六分钟大链；本链不碰平台、
 * 不依赖模型端点（空 userData 下生成走 4.5-09 的仅重排保守通道，JD 文本由脚本直接喂），
 * 专验 chunk flow 的新面：custom 保真、`kb.profile.review/revise`、变体 PDF 文本层、两支变体与母版不变。
 *
 * 纪律（与既有 e2e 相同）：只用白名单口（`window.autoCC.*`）；独立 userData；产物归档到
 * docs/acceptance/04-resume-kb/；零出网。
 *
 * 用法：`pnpm e2e:resume-chunks`（可加 `--cdp-port` `--vite-url` `--out-dir`）。
 * 启动方式：5173 已有 vite 在听（共享工作树里的开发会话）就**复用它**、自己只拉一只独立 Electron
 * （CDP 端口与 userData 各自独立，§9 的 5.10-13 并存配方）；没在听才自起 `scripts/dev.ts`。
 * 复用模式要求 `packages/main/dist/main.cjs` 已按当前源码构建（dev 会话的 esbuild watch 会在源码变更
 * 后重建）；脚本启动前会 grep 新白名单名确认产物没落后。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CdpSession, listTargets } from '../packages/testing/src/cdp.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 读取 `--key value` 形态的命令行参数。
 * @param name 参数名（不含前导 `--`）
 * @param fallback 缺省值
 * @returns 参数字符串
 */
const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
};

const cdpPort = Number(flag('cdp-port', '10288'));
const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const workDir = path.join(repoRoot, 'tmp', 'e2e-chunks');
const userdataDest = path.resolve(repoRoot, flag('userdata-dest', path.join(workDir, `userdata-${stamp}`)));
const outDir = path.resolve(repoRoot, flag('out-dir', path.join(repoRoot, 'docs', 'acceptance', '04-resume-kb')));
const logFile = path.join(workDir, `chunks-${stamp}.txt`);
const fixturePath = path.join(workDir, '林可-陌生要素.md');

/** 简历语料：刻意放两只六类词典之外的要素（证书 / 荣誉），以及抬头一行身份证号残留（必须不丢）。 */
const RESUME_MD = [
  '林可',
  '电话：13800003333 身份证：11010119900101000X',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%，负责容量规划与灰度发布值班体系。',
  '',
  '## 技能',
  '- TypeScript、Node.js、Go、Kubernetes、PostgreSQL、Redis、Kafka',
  '',
  '## 证书',
  '- CET-6 大学英语六级',
  '',
  '- PMP 项目管理专业人士认证',
  '',
  '## 荣誉',
  '- 2023 年度公司级优秀员工',
].join('\n');

// JD1：技能词面命中，让仅重排通道把技能区块移到工作经历之前。
// 无模型配置时生成走保守「仅重排」通道：相关性靠 JD 词面命中库里实体。
// custom（证书/荣誉）不派生实体，因此 JD1 把压舱石压在技能实体上（TypeScript 等），
// 让技能区块真的被重排到工作经历前面；JD2 不含技能词，回基线顺序，两支变体顺序相反。
const JD1 = [
  '岗位：高级后端工程师',
  '硬性要求精通 TypeScript / Node.js / Go，熟悉 Kubernetes、PostgreSQL、Redis、Kafka；',
  '负责订单与交易系统的高并发架构、容量规划与灰度发布。',
].join('\n');

/** JD2：换一支 PMO 向 JD，不点名技能实体（第二支变体回基线顺序，与 JD1 产物不同）。 */
const JD2 = [
  '岗位：项目管理办公室（PMO）交付负责人',
  '要求有跨团队交付、风险管理与值班体系建设经验，看重历年公司级表彰；',
  '负责订单服务重构类项目的推进与灰度发布值班。',
].join('\n');

const lines: string[] = [];
let runningApp: ReturnType<typeof spawn> | undefined;
let runningBridge: CdpSession | undefined;
let appExitCode: number | null | undefined;

/**
 * 同时打到 stdout 与日志缓冲。
 * @param text 一行读数
 */
const say = (text: string): void => {
  lines.push(text);
  console.log(text);
};

/**
 * 记录一条判据读数；不过就抛，让整条链路非零退出。
 * @param label 判据说明
 * @param passed 判定结果
 * @param detail 现场值原话
 */
const requireStep = (label: string, passed: boolean, detail: string): void => {
  say(`${passed ? 'PASS' : 'FAIL'} · ${label} —— ${detail}`);
  if (!passed) throw new Error(`链路失败：${label}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** IPC 回包信封（`BridgeReply`）：渲染层不抛，判据必须现读 `ok`。 */
type BridgeReply<T> = { ok: true; value: T } | { ok: false; error?: { message?: string; code?: string } };
type SlotView<T> = { state: string; reply?: BridgeReply<T>; error?: string };

/**
 * 在页面里调一条白名单口，用「发起 → 轮询」而不是长 await（与 e2e-resume-jd 同一份理由）。
 * @param bridge CDP 会话
 * @param apiPath 白名单里的完整 path
 * @param args 实参数组
 * @param timeoutMs 等待上限
 * @returns 回包里的 `value`
 */
async function callBridge<T>(
  bridge: CdpSession,
  apiPath: string,
  args: unknown[] = [],
  timeoutMs = 120_000,
): Promise<T> {
  const reply = await callBridgeRaw<T>(bridge, apiPath, args, timeoutMs);
  if (reply.ok !== true) {
    throw new Error(`${apiPath} 被拒：${JSON.stringify(reply.error ?? null)}`);
  }
  return reply.value;
}

/**
 * 同上但保留原始信封——变体判据要的就是 `ok:false` + code（结构化拒绝也是产品行为，不是异常）。
 * @param bridge CDP 会话
 * @param apiPath 白名单 path
 * @param args 实参数组
 * @param timeoutMs 等待上限
 * @returns 原始回包
 */
async function callBridgeRaw<T>(
  bridge: CdpSession,
  apiPath: string,
  args: unknown[] = [],
  timeoutMs = 120_000,
): Promise<BridgeReply<T>> {
  const dot = apiPath.indexOf('.');
  const namespace = apiPath.slice(0, dot);
  const method = apiPath.slice(dot + 1);
  const slot = `s${String(Math.floor(Math.random() * 1e9))}`;
  const kicked = await bridge.evaluate(
    `(() => {
      const w = window;
      w.__e2e = w.__e2e ?? {};
      w.__e2e[${JSON.stringify(slot)}] = { state: 'pending' };
      Promise.resolve(window.autoCC[${JSON.stringify(namespace)}][${JSON.stringify(method)}](...${JSON.stringify(args)}))
        .then((reply) => { w.__e2e[${JSON.stringify(slot)}] = { state: 'done', reply }; })
        .catch((error) => { w.__e2e[${JSON.stringify(slot)}] = { state: 'thrown', error: String(error && error.message ? error.message : error) }; });
      return 'kicked';
    })()`,
  );
  if (kicked !== 'kicked') throw new Error(`${apiPath} 发起失败`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slotView = await bridge
      .evaluate<SlotView<T>>(`window.__e2e?.[${JSON.stringify(slot)}] ?? { state: 'lost' }`)
      .catch((): SlotView<T> => ({ state: 'lost' }));
    if (slotView?.state === 'done' && slotView.reply) return slotView.reply;
    if (slotView?.state === 'thrown') throw new Error(`${apiPath} 抛错：${String(slotView.error)}`);
    if (slotView?.state === 'lost') throw new Error(`${apiPath} 所在页面还没挂上读数槽`);
    if (Date.now() > deadline) throw new Error(`${apiPath} 等待超过 ${String(timeoutMs)}ms`);
    await sleep(400);
  }
}

/** 导入回执（镜像 `ImportReceiptView`，只取判据要的字段）。 */
interface ImportReceipt {
  status: 'imported' | 'scanned';
  docId: string;
  format: string;
  textLength: number;
  sections: { kind: string; title: string; entries: number }[];
}

/** `kb.profile.review` 读数（镜像 `KbReviewRowView`）。 */
interface ReviewView {
  docId: string;
  sections: {
    id: string;
    kind: string;
    title: string;
    entries: { id: string; fields: { key: string; value: string }[] }[];
  }[];
}

/** `kb.profile.revise` 回执（镜像 `KbReviseRowResult`）。 */
interface ReviseReceipt {
  docId: string;
  applied: number;
  created: number;
  updated: number;
  removed: number;
}

/** 生成回执（镜像 `GenerationReceiptRowView`）。 */
interface GenerationReceipt {
  id: string;
  docId: string;
  jdId: string | null;
  modelStatus: string;
  modelReason: string | null;
  outcome: string;
  movedSections: number;
  movedEntries: number;
}

/** `resume.generate.run` 的过界读数（只取要的几支）。 */
interface GenerationRun {
  receipt: GenerationReceipt;
  rewrites: unknown[];
  reorderBases: unknown[];
}

/** 接受回执（镜像 `GenerationAcceptRowResult`，docId 是变体 id）。 */
interface AcceptReceipt {
  docId: string;
  appliedRewrites: number;
  reorderApplied: boolean;
  movedSections: number;
  movedEntries: number;
}

/** 导出回执（镜像 `ExportReceiptView`）。 */
interface ExportReceipt {
  path: string;
  pages: number;
  bytes: number;
  hash: string;
  snapshotId: string;
}

/** 文档摘要（镜像 `ResumeDocSummaryView`，只取判据字段）。 */
interface DocSummary {
  id: string;
  parentDocId: string | null;
}

async function waitForPageTarget(port: number, urlContains: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const targets = await listTargets(port).catch(() => []);
    if (targets.some((target) => target.type === 'page' && target.url.includes(urlContains))) return;
    await sleep(400);
  }
  throw new Error(`CDP ${String(port)} 上没等到页面（过滤词 ${urlContains}）`);
}

/**
 * 抽一份 PDF 的文本层（不是渲染后 OCR）：pdf.js 的 getTextContent，逐 item 拼字。
 *
 * pdfjs-dist 只挂在 pdf-edit 包的依赖图里，脚本从根 node_modules 解析不到，所以照
 * resolveElectron 的办法从该包的 package.json 解析绝对路径再动态 import。
 * @param filePath PDF 路径
 * @returns 全文文本层（空格连接，足够判「标题在不在」）
 */
async function extractPdfTextLayer(filePath: string): Promise<string> {
  const pdfRequire = createRequire(path.join(repoRoot, 'packages', 'pdf-edit', 'package.json'));
  const modulePath = pdfRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfModule = (await import(pathToFileURL(modulePath).href)) as {
    getDocument(source: unknown): {
      promise: Promise<{
        getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>;
        numPages: number;
      }>;
    };
  };
  const bytes = new Uint8Array(readFileSync(filePath));
  const document = await pdfModule.getDocument({ data: bytes }).promise;
  const pageTexts: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => item.str ?? '').join(' '));
  }
  return pageTexts.join('\n');
}

/**
 * 主流程：任何一段抛错都让进程非零退出。
 */
async function main(): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(userdataDest, { recursive: true });
  writeFileSync(fixturePath, RESUME_MD, 'utf8');
  say(`auto-cc 端到端自测（chunk flow：陌生要素保真→核对→双 JD 双变体→母版不变）· ${new Date().toISOString()}`);
  say(`· 语料：${fixturePath} · userData=${userdataDest} · CDP=${String(cdpPort)}`);

  // 启动：5173 在听就复用那台 vite、只拉自己的 Electron；否则自起整套 dev 会话。
  const viteUrl = flag('vite-url', 'http://127.0.0.1:5173');
  const viteUp = await fetch(viteUrl)
    .then((response) => response.ok)
    .catch(() => false);
  const mainCjs = path.join(repoRoot, 'packages', 'main', 'dist', 'main.cjs');
  let boot: ReturnType<typeof spawn>;
  let targetPart: string;
  if (viteUp) {
    const bundle = readFileSync(mainCjs, 'utf8');
    if (!bundle.includes('kb.profile.review') || !bundle.includes('kb.profile.revise')) {
      throw new Error('main.cjs 落后于当前源码（没有 kb.profile.review/revise）；先让 dev 会话重建一次再跑本脚本');
    }
    const electronRequire = createRequire(path.join(repoRoot, 'packages', 'main', 'package.json'));
    targetPart = viteUrl.slice(viteUrl.lastIndexOf(':') + 1);
    boot = spawn(
      electronRequire('electron') as string,
      [
        mainCjs,
        `--remote-debugging-port=${String(cdpPort)}`,
        `--user-data-dir=${userdataDest}`,
        '--disable-features=CalculateNativeWinOcclusion',
      ],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RENDERER_URL: viteUrl } },
    );
    say(`· 会话来源：复用已在听的 ${viteUrl} + 本轮独立 Electron（CDP=${String(cdpPort)}）`);
  } else {
    targetPart = '5173';
    boot = spawn('npx', ['tsx', 'scripts/dev.ts'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AUTO_CC_CDP_PORT: String(cdpPort), AUTO_CC_USER_DATA_DIR: userdataDest },
    });
    say('· 会话来源：本轮自起 dev 会话（esbuild + vite + Electron）');
  }
  runningApp = boot;
  boot.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[dev] ${chunk.toString()}`));
  boot.stderr?.on('data', (chunk: Buffer) => process.stdout.write(`[dev!] ${chunk.toString()}`));
  boot.on('exit', (code, signal) => {
    appExitCode = code ?? 0;
    say(`· 会话进程退出 code=${String(code)} signal=${String(signal)}`);
  });

  await waitForPageTarget(cdpPort, targetPart);
  const bridge = await CdpSession.attach(cdpPort, targetPart);
  runningBridge = bridge;
  // 等桥挂上。
  for (;;) {
    const ready = await bridge
      .evaluate<boolean>('!!(window.autoCC && document.querySelector(\'[data-view="chat"]\'))')
      .catch(() => false);
    if (ready) break;
    await sleep(400);
  }

  // 隐私首屏（新 userData 每次出现）：node.click() 直接派给组件监听（理由同 e2e-resume-jd）。
  const sawPrivacy = await bridge.evaluate<boolean>('!!document.querySelector(\'[data-testid="privacy-notice"]\')');
  if (sawPrivacy) {
    await bridge.evaluate(
      `(() => { document.querySelector('[data-action="privacy-acknowledge"]')?.click(); return true; })()`,
    );
    await sleep(500);
  }
  requireStep(
    '启动 渲染层桥挂上、隐私遮罩消失',
    !(await bridge.evaluate<boolean>('!!document.querySelector(\'[data-testid="privacy-notice"]\')')),
    `隐私首屏出现过=${String(sawPrivacy)}`,
  );

  // 段 1：导入带陌生要素的简历。
  const imported = await callBridge<ImportReceipt>(bridge, 'resume.parse.fromFile', [fixturePath]);
  const masterId = imported.docId;
  say(
    `· 导入：status=${imported.status} docId=${masterId} format=${imported.format} 文本=${String(imported.textLength)} 字`,
  );
  say(
    `· 解析区块：${imported.sections.map((section) => `${section.kind}(${section.title})×${String(section.entries)}`).join(' / ')}`,
  );
  const importedCustoms = imported.sections.filter((section) => section.kind === 'custom');
  requireStep(
    '段 1 陌生要素（证书 / 荣誉）没有被静默丢弃，解析为 custom 区块',
    imported.status === 'imported' &&
      importedCustoms.some((section) => section.title === '证书' && section.entries === 2) &&
      importedCustoms.some((section) => section.title === '荣誉' && section.entries === 1),
    `custom 区块=${importedCustoms.map((section) => `${section.title}×${String(section.entries)}`).join('、') || '无'}`,
  );

  // 建库（chunk 由母版派生）。
  const sync = await callBridge<{ created: number; updated: number; removed: number }>(bridge, 'kb.profile.sync', [
    masterId,
  ]);
  say(`· 建库：created=${String(sync.created)} updated=${String(sync.updated)} removed=${String(sync.removed)}`);

  // 段 2：核对读口——陌生要素带原文标题逐条读得到。
  // 区块 id 不硬编码：抬头若有残留会先占 custom-1（本语料的身份证 / 手机在解析期已脱敏，无残留），
  // 一律按标题找到区块、再取它的真实 id 与条目 id。
  const reviewBefore = await callBridge<ReviewView>(bridge, 'kb.profile.review', [masterId]);
  const certBefore = reviewBefore.sections.find((section) => section.title === '证书');
  const honorBefore = reviewBefore.sections.find((section) => section.title === '荣誉');
  requireStep(
    '段 2a review 读口逐块读得到：证书原文标题 + 两条，荣誉一条',
    certBefore?.entries.map((entry) => entry.fields[0]?.value).join('|') ===
      'CET-6 大学英语六级|PMP 项目管理专业人士认证' &&
      honorBefore?.entries[0]?.fields[0]?.value.includes('优秀员工') === true,
    `证书=${certBefore?.entries.map((entry) => entry.fields[0]?.value).join('|') ?? '无'}（id=${certBefore?.id ?? '无'}） · 荣誉=${honorBefore?.entries.length === 1 ? '在' : '无'}`,
  );
  const certSectionId = certBefore!.id;
  const certFirstEntryId = certBefore!.entries[0]!.id;

  // 段 3：核对写口——改名 + 改字 + 新增自定义要素，一批；再加一条空条目（结构先落）再补字（id 由主进程给）。
  const revise1 = await callBridge<ReviseReceipt>(bridge, 'kb.profile.revise', [
    masterId,
    [
      { op: 'section.rename', sectionId: certSectionId, title: '资格证书' },
      {
        op: 'entry.text',
        sectionId: certSectionId,
        entryId: certFirstEntryId,
        fieldKey: 'text',
        value: 'CET-6（580 分）',
      },
      { op: 'section.create', title: '语言能力' },
    ],
  ]);
  say(`· 核对批次 1：applied=${String(revise1.applied)} 重建 ${String(revise1.updated)} 行`);
  const revise2 = await callBridge<ReviseReceipt>(bridge, 'kb.profile.revise', [
    masterId,
    [{ op: 'entry.create', sectionId: certSectionId }],
  ]);
  say(`· 核对批次 2（加空条目）：applied=${String(revise2.applied)}`);
  const reviewMid = await callBridge<ReviewView>(bridge, 'kb.profile.review', [masterId]);
  const certMid = reviewMid.sections.find((section) => section.id === certSectionId);
  const blankEntry = certMid?.entries.find((entry) => entry.fields.every((field) => field.value === ''));
  requireStep(
    '段 3a 加条目结构先落库：主进程给出新条目 id（界面不猜 id）',
    blankEntry !== undefined && blankEntry.id.startsWith(`${certSectionId}-`) && (certMid?.entries.length ?? 0) === 3,
    `证书区块条目=${String(certMid?.entries.length ?? 0)} 空条目 id=${blankEntry?.id ?? '无'}`,
  );
  const revise3 = await callBridge<ReviseReceipt>(bridge, 'kb.profile.revise', [
    masterId,
    [
      {
        op: 'entry.text',
        sectionId: certSectionId,
        entryId: blankEntry!.id,
        fieldKey: 'text',
        value: '雅思 IELTS 7.5',
      },
    ],
  ]);
  const reviewAfter = await callBridge<ReviewView>(bridge, 'kb.profile.review', [masterId]);
  const certAfter = reviewAfter.sections.find((section) => section.id === certSectionId);
  const langAfter = reviewAfter.sections.find((section) => section.title === '语言能力');
  requireStep(
    '段 3b 三批核对全部落在母版：改名/改字/新要素/新条目补字',
    revise1.applied === 3 &&
      revise2.applied === 1 &&
      revise3.applied === 1 &&
      certAfter?.title === '资格证书' &&
      certAfter?.entries.map((entry) => entry.fields[0]?.value).join('|') ===
        'CET-6（580 分）|PMP 项目管理专业人士认证|雅思 IELTS 7.5' &&
      langAfter?.kind === 'custom',
    `证书区块=${certAfter?.title}：${certAfter?.entries.map((entry) => entry.fields[0]?.value).join(' / ') ?? '无'} · 语言能力=${langAfter ? '在' : '无'}`,
  );

  // 段 3c：给新要素「语言能力」也补一条正文——导出模板按产品规则不渲染空区块，
  // 要有正文才能在变体 PDF 的文本层里核到这个新要素（新区块 id 同样从读口现取，不猜）。
  const langSectionId = langAfter!.id;
  const revise4 = await callBridge<ReviseReceipt>(bridge, 'kb.profile.revise', [
    masterId,
    [{ op: 'entry.create', sectionId: langSectionId }],
  ]);
  const reviewLang = await callBridge<ReviewView>(bridge, 'kb.profile.review', [masterId]);
  const langSection = reviewLang.sections.find((section) => section.id === langSectionId);
  const langBlank = langSection?.entries.find((entry) => entry.fields.every((field) => field.value === ''));
  const revise5 = await callBridge<ReviseReceipt>(bridge, 'kb.profile.revise', [
    masterId,
    [
      {
        op: 'entry.text',
        sectionId: langSectionId,
        entryId: langBlank!.id,
        fieldKey: 'text',
        value: '英语可作为工作语言，技术文档读写流利',
      },
    ],
  ]);
  const reviewLangAfter = await callBridge<ReviewView>(bridge, 'kb.profile.review', [masterId]);
  const langFilled = reviewLangAfter.sections.find((section) => section.id === langSectionId);
  requireStep(
    '段 3c 新增要素补正文：在新 custom 区块加条目并填字，落的是母版',
    revise4.applied === 1 &&
      revise5.applied === 1 &&
      langFilled?.entries[0]?.fields[0]?.value === '英语可作为工作语言，技术文档读写流利',
    `语言能力区块条目=${String(langFilled?.entries.length ?? 0)}：${langFilled?.entries.map((entry) => entry.fields[0]?.value).join(' / ') ?? '无'}`,
  );

  /**
   * 喂一支 JD → 接受全部 → 返回变体 id。
   * @param jdText JD 正文
   * @param jdId JD 主键（喂文本也要给，台账按它记账）
   * @param label 读数里的名字
   * @returns 生成与接受读数
   */
  async function generateOne(
    jdText: string,
    jdId: string,
    label: string,
  ): Promise<{ generation: GenerationRun; accepted: AcceptReceipt; exported: ExportReceipt; textLayer: string }> {
    const generation = await callBridge<GenerationRun>(bridge, 'resume.generate.run', [
      jdText,
      { docId: masterId, jdId },
    ]);
    say(
      `· ${label} 生成：outcome=${generation.receipt.outcome} modelStatus=${generation.receipt.modelStatus} ` +
        `移动区块 ${String(generation.receipt.movedSections)} 移动条目 ${String(generation.receipt.movedEntries)} ` +
        `原因=${String(generation.receipt.modelReason ?? '无')}`,
    );
    const accepted = await callBridge<AcceptReceipt>(bridge, 'resume.generate.accept', [
      generation.receipt.id,
      { acceptedIndexes: generation.rewrites.map((_, index) => index), applyReorder: true },
    ]);
    say(
      `· ${label} 接受：变体 docId=${accepted.docId} 改写 ${String(accepted.appliedRewrites)} 处 ` +
        `移动区块 ${String(accepted.movedSections)} 条目 ${String(accepted.movedEntries)}`,
    );
    const exported = await callBridge<ExportReceipt>(bridge, 'resume.export.toPdf', [accepted.docId], 120_000);
    const textLayer = await extractPdfTextLayer(exported.path);
    say(
      `· ${label} 导出：${exported.path} ${String(exported.pages)} 页 ${String(exported.bytes)} 字节 hash=${exported.hash.slice(0, 12)}`,
    );
    return { generation, accepted, exported, textLayer };
  }

  // 段 4：JD1 → 变体 1，PDF 文本层含 custom 原文标题（核对后的新标题）与改后正文。
  // PDF 文本层每个汉字 / 数字可能是独立 text item，拼接后带空格，比对前统一压掉所有空白。
  const compactText = (raw: string): string => raw.replace(/\s+/gu, '');
  const one = await generateOne(JD1, 'jd-chunks-1', 'JD1');
  const variant1Id = one.accepted.docId;
  const layer1 = compactText(one.textLayer);
  const layer1Tokens = ['资格证书', '荣誉', '语言能力', '580', '雅思', '优秀员工', '可作为工作语言'];
  const layer1Hits = layer1Tokens.filter((token) => layer1.includes(compactText(token)));
  const layer1Miss = layer1Tokens.filter((token) => !layer1.includes(compactText(token)));
  const pdfCopy1 = path.join(outDir, `chunk-flow-variant1-${stamp}.pdf`);
  copyFileSync(one.exported.path, pdfCopy1);
  requireStep(
    '段 4 JD1 变体：保守通道真按 JD 重排（技能区块前移），PDF 文本层含核对后的 custom 原文标题与正文',
    variant1Id !== masterId &&
      one.generation.receipt.movedSections >= 1 &&
      one.exported.bytes > 0 &&
      layer1Miss.length === 0,
    `移动区块=${String(one.generation.receipt.movedSections)} · 命中 ${layer1Hits.join('、')}${layer1Miss.length > 0 ? `；缺失 ${layer1Miss.join('、')}` : ''} · 副本 ${pdfCopy1}`,
  );

  // 段 5：变体不是素材源头——review/revise 对变体 id 一律结构化拒绝。
  const reviewVariant = await callBridgeRaw<ReviewView>(bridge, 'kb.profile.review', [variant1Id]);
  const reviseVariant = await callBridgeRaw<ReviseReceipt>(bridge, 'kb.profile.revise', [
    variant1Id,
    [{ op: 'section.create', title: '不该出现的要素' }],
  ]);
  requireStep(
    '段 5 review / revise 对变体 id 都是 INVALID_ARGUMENT（素材源头只能是母版）',
    reviewVariant.ok === false &&
      (reviewVariant as { error?: { code?: string } }).error?.code === 'INVALID_ARGUMENT' &&
      reviseVariant.ok === false &&
      (reviseVariant as { error?: { code?: string } }).error?.code === 'INVALID_ARGUMENT',
    `review=${JSON.stringify((reviewVariant as { error?: unknown }).error)} revise=${JSON.stringify((reviseVariant as { error?: unknown }).error)}`,
  );

  // 段 6：后续使用——直接喂 JD2 出第二支变体，不重新导入；两支变体 id 不同，母版仍在。
  const two = await generateOne(JD2, 'jd-chunks-2', 'JD2');
  const variant2Id = two.accepted.docId;
  const layer2 = compactText(two.textLayer);
  const layer2Hits = ['资格证书', '荣誉', '580'].filter((token) => layer2.includes(token));
  const pdfCopy2 = path.join(outDir, `chunk-flow-variant2-${stamp}.pdf`);
  copyFileSync(two.exported.path, pdfCopy2);
  const docs = await callBridge<DocSummary[]>(bridge, 'resume.doc.list', []);
  const masterRow = docs.find((row) => row.id === masterId);
  const variantRows = docs.filter((row) => row.parentDocId === masterId);
  const reviewMasterEnd = await callBridge<ReviewView>(bridge, 'kb.profile.review', [masterId]);
  const masterStill = {
    renamed: reviewMasterEnd.sections.some((section) => section.kind === 'custom' && section.title === '资格证书'),
    language: reviewMasterEnd.sections.some((section) => section.title === '语言能力'),
    edited: reviewMasterEnd.sections
      .flatMap((section) => section.entries)
      .some((entry) => entry.fields.some((field) => field.value === '雅思 IELTS 7.5')),
  };
  requireStep(
    '段 6 两支 JD 各出一支变体，母版行只有一条且核对结果原样保留（生成永不改母版）',
    variant1Id !== variant2Id &&
      masterRow?.parentDocId === null &&
      variantRows
        .map((row) => row.id)
        .sort()
        .join(',') === [variant1Id, variant2Id].sort().join(',') &&
      masterStill.renamed &&
      masterStill.language &&
      masterStill.edited &&
      two.exported.hash !== one.exported.hash &&
      two.exported.bytes > 0 &&
      layer2Hits.length === 3,
    `变体=${variant1Id.slice(0, 10)}、${variant2Id.slice(0, 10)} · 母版 parentDocId=${String(masterRow?.parentDocId)} · ` +
      `母版核对保留=${JSON.stringify(masterStill)} · 产物 hash ${one.exported.hash.slice(0, 8)}≠${two.exported.hash.slice(0, 8)} · ` +
      `变体2 文本层命中 ${layer2Hits.join('、')} · 副本 ${pdfCopy2}`,
  );

  // 段 7（界面取证）：切到简历视图、选中母版、展开②核对要素，拍帧。
  // 挂载后 read() 要连问四口（templates/preference/pending/provenance）首启有 sqlite 冷启成本，
  // 每步都轮询而不是死等；行迟迟不出现时从页面上下文直接问 doc.list 留诊断。
  // 先在页面里装上错误兜网，再切视图——挂载 effect 若有抛错 / 拒绝，这里留证。
  await bridge.evaluate(
    `(() => {
      const w = window;
      w.__e2eErrs = [];
      window.addEventListener('error', (event) => { w.__e2eErrs.push('error:' + String(event.message)); });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        w.__e2eErrs.push('reject:' + String(reason && (reason.message ?? reason.code) ? (reason.message ?? reason.code) : reason));
      });
      return true;
    })()`,
  );
  const switchedView = await bridge.evaluate<string>(
    `(() => {
      const target = [...document.querySelectorAll('[data-view]')].find((n) => (n.getAttribute('data-view') ?? '') === 'resume');
      if (!target) return 'none';
      target.click();
      return 'resume';
    })()`,
  );
  const rowSelector = `[data-testid="resume-doc-row"][data-doc-id=${JSON.stringify(masterId)}]`;
  let rowVisible = false;
  for (let attempt = 0; attempt < 20 && !rowVisible; attempt += 1) {
    await sleep(500);
    rowVisible = await bridge.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(rowSelector)})`);
  }
  let rowDiag = '';
  if (!rowVisible) {
    rowDiag = await bridge.evaluate<string>(
      `(async () => {
        const probe = async (name, call) => {
          try { const reply = await call(); return name + '=' + (reply?.ok ? 'ok' : JSON.stringify(reply?.error?.code ?? reply?.error)); }
          catch (error) { return name + '!threw:' + String(error && error.message ? error.message : error); }
        };
        const probes = await Promise.all([
          probe('templates', () => window.autoCC.resume['export.templates']()),
          probe('preference', () => window.autoCC.resume['export.preference']()),
          probe('pending', () => window.autoCC.resume['parse.pending']()),
          probe('provenance', () => window.autoCC.resume['parse.provenance']()),
          probe('doclist', () => window.autoCC.resume['doc.list']()),
        ]);
        const reply = await window.autoCC.resume['doc.list']();
        const ids = reply?.ok ? reply.value.map((doc) => doc.id).join(',') : JSON.stringify(reply?.error ?? null);
        const rows = [...document.querySelectorAll('[data-testid="resume-doc-row"]')].map((n) => n.getAttribute('data-doc-id')).join(',');
        const noneMarker = document.querySelector('[data-testid="resume-doc-none"]') ? '空态在' : '空态无';
        return probes.join(' · ') + ' · 页面桥读数=[' + ids + '] DOM 行=[' + rows + '] ' + noneMarker +
          ' · 页面错误=' + JSON.stringify(window.__e2eErrs ?? []);
      })()`,
    );
  }
  // 选中母版：setDocId 在内部那颗 resume-doc-pick 按钮上（点 <li> 本身不会选中）。
  const pickSelector = `${rowSelector} [data-action="resume-doc-pick"]`;
  await bridge.evaluate(`document.querySelector(${JSON.stringify(pickSelector)})?.click(); true`);
  let masterPicked = false;
  for (let attempt = 0; attempt < 10 && !masterPicked; attempt += 1) {
    await sleep(300);
    masterPicked = await bridge.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(rowSelector)})?.getAttribute('data-current') === 'true'`,
    );
  }
  // 导入在另一视图完成，这一格的「导入后自动展开②」沿只在本屏导入时走；这里手动展开做画面取证。
  let reviewExpanded = false;
  for (let attempt = 0; attempt < 12 && !reviewExpanded; attempt += 1) {
    await sleep(400);
    reviewExpanded =
      (await bridge.evaluate<number>(`document.querySelectorAll('[data-testid="chunk-review-section"]').length`)) >= 5;
    if (!reviewExpanded && attempt === 0) {
      await bridge.evaluate(`document.querySelector('[data-action="resume.review-toggle"]')?.click(); true`);
    }
  }
  const uiChecks = await bridge.evaluate<{ steps: number; sections: number; entries: number; customTags: number }>(
    `(() => ({
      steps: document.querySelectorAll('[data-testid="resume-steps"] [data-action^="resume-step-"]').length,
      sections: document.querySelectorAll('[data-testid="chunk-review-section"]').length,
      entries: document.querySelectorAll('[data-testid="chunk-review-entry"]').length,
      customTags: [...document.querySelectorAll('[data-testid="chunk-review-section"]')]
        .filter((n) => n.getAttribute('data-section-kind') === 'custom').length,
    }))()`,
  );
  const shotPath = path.join(outDir, `chunk-flow-review-ui-${stamp}.png`);
  const tookShot = await Promise.race([bridge.screenshot(shotPath).then(() => true), sleep(20_000).then(() => false)]);
  requireStep(
    '段 7 界面：四步引导条在、核对区按区块/条目渲染，custom 区块都在画面上',
    switchedView === 'resume' &&
      rowVisible &&
      masterPicked &&
      reviewExpanded &&
      uiChecks.steps === 4 &&
      uiChecks.sections >= 5 &&
      uiChecks.customTags >= 3 &&
      tookShot,
    `视图=${switchedView} 母版行可见=${String(rowVisible)} 母版选中=${String(masterPicked)}${rowDiag === '' ? '' : ` ${rowDiag}`} 核对展开=${String(reviewExpanded)} · ` +
      `步骤=${String(uiChecks.steps)} 区块=${String(uiChecks.sections)} custom=${String(uiChecks.customTags)} 条目=${String(uiChecks.entries)} 截图=${tookShot ? shotPath : '未取得'}`,
  );

  say(
    `链路结论：段 1 陌生要素保真 / 段 2 核对读口 / 段 3 核对写母版重建 / 段 4 变体 PDF 文本层 / 段 5 变体拒绝 / 段 6 双变体母版不变 / 段 7 界面 全过。`,
  );
  void bridge.send('Browser.close').catch(() => undefined);
  const exitDeadline = Date.now() + 15_000;
  while (appExitCode === undefined && Date.now() < exitDeadline) await sleep(200);
  if (appExitCode === undefined) runningApp?.kill();
  try {
    bridge.close();
  } catch {
    /* 浏览器先走了 */
  }
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
  // 读数归档到验收目录（PDF 与截图已直接写在那里）。
  copyFileSync(logFile, path.join(outDir, `chunk-flow-live-${stamp}.txt`));
  say(`· 读数：${logFile}（副本 ${path.join(outDir, `chunk-flow-live-${stamp}.txt`)}）`);
}

try {
  await main();
} catch (error) {
  lines.push(`链路结论：失败 —— ${error instanceof Error ? error.message : String(error)}`);
  console.error(lines[lines.length - 1]);
  try {
    runningBridge?.close();
  } catch {
    /* 会话本来就没建成 */
  }
  if (runningApp && runningApp.exitCode === null) runningApp.kill();
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
}
