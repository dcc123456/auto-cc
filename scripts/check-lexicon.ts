/**
 * 静态检查：被禁的那个字不许在全仓文本文件里长回来（用户裁定 2026-10-12，禁令与取代关系见 AGENTS.md §4.6 / §4.5）。
 *
 * 为什么是 C 类（静态检查）而不是跑出来的行为：这条判据禁的是**措辞**，运行期没有任何正面信号
 * 可以观察——界面文案对不对要靠 i18n 语言包与文档原文，而语言包只是众多出口之一。历史上这个说法
 * 散在 682 种写法里（plan / spec / 读数 / 代码注释 / 语言包），只改界面文案会留下一半继续生长，
 * 所以判据落在"整棵树扫一遍"这一层：任何一份跟踪文件里出现这个字，`pnpm lint` 即红。
 *
 * 三条判据：
 * 1. **全仓跟踪的文本文件不许出现被禁的字**（码位 U+817F；本文件用 `String.fromCharCode` 写它，
 *    免得判据本体把自己判红）。
 *    **2026-11-22 收窄**：只放行「跑腿」「火腿」两个完整词内部的该字（见 `ALLOWED_WORDS`），
 *    因为这些是常用词、不是被禁的比喻说法；词外任何位置的该字照旧判红，规则本意不变。
 *    豁免只允许两处，且必须是"禁令的点名现场"：`AGENTS.md`
 *    （规则要点名禁什么）与本脚本；豁免里的命中数照样打印在收尾行，不做静默放行。
 * 2. **页面文案不许把这个说法翻译成英文**：`packages/renderer/src/locales/*.json` 的**值**里
 *    不许出现 `leg` / `legs` 一词（键名不算——`settings.model.leg.*` 与 `data-model-leg`、
 *    `allowModelLeg`、错误码 `LEG_*` 这些是取证锚点与代码标识符，改名属于改 API，不在本判据射程内）。
 * 3. **扫描面必须真的非空**：一条都没扫到就报错，防的是判据在"扩展名清单写错"的那次提交上假绿
 *    （同 `check-dashboard-readonly.ts` 里"一条 import 都没解析出来先修这里"的口径）。
 *
 * 边界（诚实的那一半）：二进制文件不在扫描面内——`docs/acceptance/**` 里 5 张早前拍的截图 PNG 与
 * 随包字体仍是历史读数，画面里的旧文案无法由本判据追改，登记在 06 号 plan §3.32。
 *
 * 命令：`pnpm lint` 链末位，或单独 `tsx scripts/check-lexicon.ts`。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** 被禁的字（码位 U+817F）。写成码位而不是字面量，是为了让判据本体不在自己的射程里。 */
const BANNED_CHAR = String.fromCharCode(0x817f);

/** 扫描面：只扫文本扩展名（二进制与素材由 §7.5 的白名单管，不在这里）。 */
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html|yml|yaml|xml|sh|bat|ps1|py)$/;

/**
 * 判据 1 的例外机制（**不是豁免**，是延后）：共享工作树里有并行会话正在写的脏文件，
 * 本窗不许替它们提交（AGENTS.md §9 实测 5.10-13：pathspec 提交会把别人的脏区一起吞掉），
 * 所以现在只记账不判红——**它们一旦落地（从脏区消失）本判据立刻判红**，禁令由机检接手而不是靠那个窗自觉。
 * 收尾行必须把这笔账打印出来，不许静默。
 */
const DEFFER_WHILE_DIRTY = true;

/**
 * 豁免清单：只有"必须点名禁令内容"的两处。
 * 每一项都要在这里写清理由，否则新增豁免就变成给这条禁令开后门。
 */
const EXEMPT: readonly { readonly path: string; readonly why: string }[] = [
  { path: 'AGENTS.md', why: '§4.6 的禁令要写出被禁的字，并在§4.5 登记取代关系，否则规则读不出禁的是什么' },
  { path: 'scripts/check-lexicon.ts', why: '判据本体（码位注释）' },
];

/** 判据 2 的落点：语言包目录，以及"值里不许出现的英文同款词"。 */
const LOCALE_DIR = 'packages/renderer/src/locales/';
const VALUE_LINE = /^\s*"[^"]+"\s*:\s*"(.*)"\s*,?\s*$/;
const BANNED_EN = /\b(?:leg|legs)\b/i;

/**
 * 词级放行清单（2026-11-22 用户裁定收窄 §4.6）。
 *
 * 机检按字（U+817F）扫全仓，会把「代跑腿」「火腿」这类**常用词**一起判红——那是检查器过宽，不是规则本意。
 * 只放行这两个完整词内部的该字，词外任何位置照旧判红；新增放行词必须按 dated 裁定流程登记，不许就地加。
 */
const ALLOWED_WORDS: readonly string[] = ['跑腿', '火腿'];

/**
 * 统计一段文本里「不被任何放行词覆盖」的该字出现次数与行号。
 * @param text 待检文本
 * @param banned 被禁的字（本文件用码位构造，避免判据本体自红）
 * @param allowedWords 放行词；该字落在一个完整放行词的字符区间内即不计
 * @returns hits 未覆盖的出现次数；lines 命中行号（1 起）
 */
function scanBanned(text: string, banned: string, allowedWords: readonly string[]): { hits: number; lines: number[] } {
  const covered: { start: number; end: number }[] = [];
  for (const word of allowedWords) {
    if (!word.includes(banned)) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(word, from);
      if (at < 0) break;
      covered.push({ start: at, end: at + word.length });
      from = at + 1;
    }
  }
  const lines: number[] = [];
  let hits = 0;
  let at = text.indexOf(banned);
  while (at >= 0) {
    if (!covered.some((span) => at >= span.start && at < span.end)) {
      hits += 1;
      lines.push(text.slice(0, at).split('\n').length);
    }
    at = text.indexOf(banned, at + 1);
  }
  return { hits, lines };
}

/**
 * 判据 1 收窄后的自检：放行词内的该字不计、词外仍计。每次运行都跑（两段内存字符串，代价可忽略），
 * 白名单写错的提交会在这里立刻判红，而不是等下一个撞上常用词的人来发现。
 * @returns 两条用例的结论；任一条不符即视为检查器坏了
 */
function selfCheck(): string[] {
  const banned = BANNED_CHAR;
  const allowed = scanBanned(`代跑${banned}`, banned, ALLOWED_WORDS);
  const blocked = scanBanned(`这条${banned}`, banned, ALLOWED_WORDS);
  const verdicts = [
    `代跑腿（放行词内）→ hits=${String(allowed.hits)}（期望 0）`,
    `这条腿（词外）→ hits=${String(blocked.hits)}（期望 1）`,
  ];
  return allowed.hits === 0 && blocked.hits === 1 ? [] : verdicts;
}

/**
 * 反向验证的口（与 `check-dashboard-readonly.ts` 同形）：命令行实参换成被检文件。
 * 违规副本只能落在被忽略的 `tmp/`（AGENTS.md §7.5），不能为做实验去动真文件——何况真文件一旦变脏，
 * 下面的延后机制就会把它接住，实验永远只拿到 EXIT=0。所以指定实参时**延后与豁免都不启用**，
 * 检的就是这一份内容本身。
 */
const PROBE_TARGETS = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

const tracked = execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\0')
  .filter(Boolean);

/** 工作树脏区（改动过的跟踪文件 + 未跟踪文件）：并行会话正在写的那些由上面的延后机制接住。 */
const dirty = new Set([
  ...execSync('git diff --name-only -z HEAD', { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter(Boolean),
  ...execSync('git ls-files --others --exclude-standard -z', { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter(Boolean),
]);

const problems: string[] = [];
let scannedTextFiles = 0;
let scannedLocaleFiles = 0;
let exemptHits = 0;
const deferred: string[] = [];
const probing = PROBE_TARGETS.length > 0;

/** 自检失败的唯一原因就是检查器坏了，与仓内容无关，所以单独成一条 problem。 */
const selfCheckFailures = selfCheck();

for (const relPath of probing ? PROBE_TARGETS : tracked) {
  if (!TEXT_EXT.test(relPath) || !existsSync(relPath)) continue;
  const text = readFileSync(relPath, 'utf8');

  const exempt = probing ? undefined : EXEMPT.find((entry) => entry.path === relPath);
  const rawHits = text.split(BANNED_CHAR).length - 1;
  const { hits, lines: hitLines } = scanBanned(text, BANNED_CHAR, ALLOWED_WORDS);
  if (exempt) {
    exemptHits += rawHits;
  } else if (hits > 0) {
    const marked = hitLines.map((line) => `${relPath}:${String(line)}`);
    if (!probing && DEFFER_WHILE_DIRTY && dirty.has(relPath)) {
      deferred.push(`${relPath}（${String(hits)} 处，脏区中）`);
    } else {
      const shown = marked.slice(0, 5).join('、');
      problems.push(
        `${relPath} 出现被禁的字 ${String(hits)} 处（${shown}${marked.length > 5 ? ` 等 ${String(marked.length)} 行` : ''}）：` +
          `用户裁定 2026-10-12 禁用这一说法，改写成「那一条 / 判据 / 通道 / 轨」等具体所指（判据 1）`,
      );
    }
  }

  // —— 判据 2：语言包的值里不许把这个说法翻译成英文 leg ——
  if (relPath.startsWith(LOCALE_DIR) && relPath.endsWith('.json')) {
    scannedLocaleFiles += 1;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = VALUE_LINE.exec(line);
      if (match && match[1] && BANNED_EN.test(match[1])) {
        problems.push(
          `${relPath}:${String(index + 1)} 的页面文案含 leg 一词（${line.trim().slice(0, 60)}）：界面要说的是"哪一条"，` +
            `英文写 role / route / binding 这类具体所指（判据 2）`,
        );
      }
    });
  }

  scannedTextFiles += 1;
}

if (!probing && (scannedTextFiles === 0 || scannedLocaleFiles === 0)) {
  problems.push(
    `扫描面异常：文本文件 ${String(scannedTextFiles)} 个、语言包 ${String(scannedLocaleFiles)} 份，先修扫描面再谈判据（判据 3）`,
  );
}

if (selfCheckFailures.length > 0) {
  problems.push(`检查器自检失败：${selfCheckFailures.join('；')}（词级放行清单写坏了，先修检查器）`);
}

if (problems.length) {
  console.error('✖ 术语禁令静态检查未通过（用户裁定 2026-10-12 / AGENTS.md §4.6）：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (process.argv.includes('--self-check')) {
  console.log('✔ 词级放行自检：');
  for (const line of [`代跑${BANNED_CHAR}（放行词内）→ 期望 hits=0`, `这条${BANNED_CHAR}（词外）→ 期望 hits=1`])
    console.log(`  - ${line}`);
  console.log(`  - 实际：${selfCheck().length === 0 ? '两条均符合' : selfCheck().join('；')}`);
}

if (probing) {
  console.log(
    `✔ 探针目标内 0 处（${PROBE_TARGETS.join('、')}：被禁的字与语言包值里的 leg 都没命中——反向验证要的是"注入即红"，这条不该在正式读数里出现）`,
  );
  process.exit(0);
}

console.log(
  `✔ 术语禁令保持（扫描 ${String(scannedTextFiles)} 个跟踪文本文件、${String(scannedLocaleFiles)} 份语言包的值：` +
    `被禁的字在已进主干的内容里 0 处；` +
    `脏区延后 ${String(deferred.length)} 份${deferred.length > 0 ? `（${deferred.join('、')}）—— 落地即判，本窗不替它们清` : ''}；` +
    `放行词 ${String(ALLOWED_WORDS.length)} 个（${ALLOWED_WORDS.join('、')}，词级；自检 2/2 通过）；` +
    `豁免 ${String(EXEMPT.length)} 处（${EXEMPT.map((entry) => `${entry.path}——${entry.why}`).join('；')}）` +
    `内共 ${String(exemptHits)} 处，逐处都是禁令本体；二进制与素材文件不在扫描面内，见 plan §3.32 登记的边界）`,
);
