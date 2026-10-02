/**
 * 验收用的本地 fixture HTTP 服务（AGENTS.md §7.2：自动化测试一律打本地站点）。
 *
 * 只绑 `127.0.0.1`，且拒绝任何其他 host 的绑定请求 —— 它模拟的是「已登录的招聘站」，
 * 暴露到局域网就没有「不碰真实平台」这条保证了。
 *
 * 能力覆盖 1.8 / 1.9 / 2.1 的验收：
 * - `/login` 写一份 **带 Max-Age 的持久 cookie**（会话型 cookie 不会被 Chromium 落盘，
 *   用它验 1.8-03 的「跨重启保持」会测到假阴性）；`?next=` 决定登录完回到哪一页；
 * - `/` 与 `/alt` 是同一个站点、同一个 cookie 名的两条路径，用来证明隔离发生在**分区**
 *   而不是域名上（spec 1.8-01）；
 * - `/boss` 与 `/boss/detail` 是**本地仿招聘站**（列表 + 详情），DOM 结构刻意模仿但不含任何
 *   真实平台代码与数据，登录横幅按请求 cookie 现判（spec 2.1-03 / 2.1-05）。2.3 起列表是**无限滚动**：
 *   页面只有一个空 `<ul>`，卡片由 `/api/jobs?query=&city=&experience=&page=` 一屏五张地长出来，
 *   `hasMore:false` 之后不再长（这就是 spec 2.3-06 要的「无新内容」），详情页按 `?jobId=` 现渲，
 *   其中 `1005` 刻意不渲染岗位职责那一段（spec 2.3-08 的坏数据靶子）；
 * - `POST /api/outbound` 与 `GET /api/outbox` 是 1.9 的**样例收件箱**：外发是否真的发生，
 *   由这里的计数说，而不是由 app 自述（spec 1.9-03 / 1.9-04）；
 * - `/locator` 是**定位策略靶页**（testid / role+可读名 / 可见文本 / CSS / XPath 各一块），
 *   带一个「延迟插入」按钮（800ms 后才出现的节点，spec 2.2-03 要观察器等待而不是轮询）和
 *   `?variant=before|after` 两份 DOM —— `after` 只改一个 `data-testid` 并去掉一个类，
 *   tagName / role / 可读名 / 祖先结构全部不变，正是 2.2-05 指纹自愈的输入；
 * - `/chat` 把聊天区放进**同源 iframe**（`/chat/frame`），帧内输入框与发送按钮把消息
 *   POST 到 `/api/outbound`，主页面显示帧内 postMessage 与服务端收件计数两路读数（spec 2.2-10 / 2.2-13）；
 *   2.5 起帧内还按 1.2s 轮询 `GET /api/threads?targetId=&after=` 增量画会话（出站与对方回复同一条时间线，
 *   节点带 `data-message-id`），`POST /api/reply` 就是「对方回了一条」的注入开关（spec 2.5-07）；
 * - `/newtab` 有 `target=_blank` 链接与 `window.open()` 按钮两个入口，`/newtab/target`
 *   回显自身 location 与 `document.cookie` —— 新标签有没有被接管进同一分区，看它读不读得到会话 cookie（spec 2.2-11）；
 * - `/trusted` 把 `mousedown/click/input` 的 `{type,isTrusted,inputType,value}` 记进
 *   `window.__autoCcTrustReadings` 并 POST 到 `/api/trust`（`GET /api/trust` 读回同一份），
 *   受通道是否产出受信事件、中文与 emoji 有没有乱码，都由这份对端读数说（spec 2.2-12 / 2.2-13）；
 * - `/deliver` 是**简历投递靶页**（spec 2.6-04 / 06 / 07）：`input[type=file]` 刻意做成 `display:none`
 *   （真实站点把入口藏在「选择文件」背后，按默认可点判据永远定位不到），页面对那一次 `change` 自报
 *   `{changeCount,isTrusted,name,size,type}`，选中后把**文件字节原样** POST 到 `/api/deliver-upload`，
 *   服务端算 sha256 登记成附件，`POST /api/deliver` 才让状态行变成「简历已送达」——
 *   于是「简历真的到了站点」由 `GET /api/deliveries` 说，而不是由 app 自述。
 *   `?targetId=1002` 这一条的状态行开局就是「该岗位已下架」，是 2.6-07 的二次校验靶子；
 * - `/api/fail-counter` 是**失败注入计数器**（POST 计一次并回 `{hits}`，GET 只读，DELETE 归零）：
 *   `boss-basic` 计划的 `demo.flaky` 节点打它，于是「前两次必失败、第三次成功」这条退避重试的路径
 *   在 app 被真的 kill 掉之后仍然接得上（spec 2.4-03 / 2.4-05 —— 计数放在进程外才有跨重启的证据）；
 * - `/api/risk-mode` 是**风控靶页开关**（POST `{mode}`，GET 只读，DELETE 归回 `off`）：
 *   `off` 让 `/boss` 照常出列表页，`captcha` 出 200 的「安全验证」页（正文判据的靶子），
 *   `blocked` 出 403 的「访问受限」页（状态码判据的靶子）。开关在 fixture 进程里，所以能在
 *   工作流正跑着的时候切，把「运行中突然被拦 → 立即暂停」这条时序演出来（spec 2.7-01）；
 * - `/api/generate-mode` 是**改写腿档位开关**（POST `{mode:'rewrite'|'fabricate'}`，GET 只读，
 *   DELETE 归回 `rewrite`），对端是 `/v1/chat/completions` —— 一个只回 OpenAI 信封的本地靶端点：
 *   它把请求里那份「待改写清单」原样回填位置三 id，`rewrite` 档在正文后追加一句不含数字与机构名的
 *   哨兵（确定性事实校验三条判据都会放行，界面能拍到真改写行），`fabricate` 档凭空补一个 `91%`
 *   （数值守恒必然不过，两轮都过不了 → 拒绝产出）。4.5 的 V 类条目要的就是「界面上看得见改写行 /
 *   看得见被拒」，而真打外部模型服务要花钱、也需用户单独授权，所以这一条腿在本地打靶（spec 4.5-02 /
 *   05 / 11，与 §7.2「测试不打真实平台」同一条口径）；
 * - `/pii` 是**脱敏靶页**（spec 2.7-07）：裸写的手机号 / 邮箱 / 身份证 + 一组刻意留下的对照数字
 *   （薪资区间、编号、年份）+ 一个把号码拆成三个文本节点的块，遮罩到底盖住了什么、盖不住什么，
 *   由这一页的截图与正文读数说，不由实现自述；
 * - 进程可以被独立停掉，这就是 1.8-09「站点不可达要有明确错误态」的开关。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const labPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'session-lab.html');
const bossSearchPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'boss-search.html');
const bossDetailPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'boss-detail.html');
const locatorPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'locator-lab.html');
const chatPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'chat-lab.html');
const newtabPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'newtab-lab.html');
const trustPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'trust-lab.html');
const host = '127.0.0.1';
const port = Number(process.env.FIXTURE_PORT ?? 10233);
const cookieName = 'autocc_session';

/**
 * 登录后允许回跳的目标（spec 2.1-05 需要在仿站里「登录 → 回到原页」）。
 * 只认这几个已知页面：`next` 直接来自查询串，放开成任意值就是本站自己的开放式跳转。
 */
const loginTargets: Record<string, string> = {
  '/': '/',
  '/alt': '/alt',
  '/boss': '/boss',
  '/boss/detail': '/boss/detail',
  '/locator': '/locator',
  '/chat': '/chat',
  '/newtab': '/newtab',
  '/trusted': '/trusted',
  '/deliver': '/deliver',
};

/** 解析请求头里的 cookie，只回名字 —— 证据文件里也不该出现值。 */
function cookieNames(header: string | undefined): string[] {
  return (header ?? '')
    .split(';')
    .map((pair) => pair.trim().split('=')[0] ?? '')
    .filter(Boolean)
    .sort();
}

/**
 * 样例收件箱（1.9 用）。
 * 「消息真的出去了」由对端计数证明，app 自述不算（plan §8.4）。
 */
const outbox: unknown[] = [];

/** 受信事件读数（2.2-12 / 2.2-13 用）：由 `/trusted` 整份上报，GET 读回的就是页面上那张表。 */
let trustReadings: unknown[] = [];

/** 会话里的一条消息。`id` 全局单调递增，页面把它写进 `data-message-id`，app 侧靠它去重（spec 2.5-07）。 */
type ThreadMessage = {
  id: number;
  direction: 'outbound' | 'inbound';
  text: string;
  ts: number;
};

/**
 * 按 targetId 分组的对话（2.5 用）。
 * 出站与入站放在**同一条时间线**上：真实聊天页就是这么摆的，适配器读 DOM 时不需要区分来源，
 * 「哪些是我方已入库的」由 app 侧 `conversation_messages` 的 externalId 去重决定，而不是由 fixture 决定。
 */
const threads = new Map<string, ThreadMessage[]>();

/** 消息 id 发号器（全局而不是每会话一份）：跨会话也唯一，去重键因此可以是单列而不是复合。 */
let threadSeq = 0;

/**
 * 往某个会话追加一条消息。
 * @param targetId 会话对端标识（fixture 里就是打招呼目标）
 * @param direction 出站（我方发的）还是入站（对方回的）
 * @param text 正文，按字面存，不做任何转义（中文与 emoji 要原样到达 DOM）
 * @returns 刚落库的那条消息（带发号器给的 id）
 */
function appendThreadMessage(targetId: string, direction: ThreadMessage['direction'], text: string): ThreadMessage {
  threadSeq += 1;
  const message: ThreadMessage = { id: threadSeq, direction, text, ts: Date.now() };
  const history = threads.get(targetId) ?? [];
  history.push(message);
  threads.set(targetId, history);
  return message;
}

/**
 * 失败注入计数器（2.4-03 / 2.4-05 用）：`demo.flaky` 节点每尝试一次就加一。
 * 放在 fixture 而不是 app 进程里，是因为 2.4-05 要**真的把 app kill 掉再重启**：
 * 计数若在主进程内存里，那一刻会被清零，「第 3 次才成功」这条完整路径就拍不到证据了。
 */
let failCounterHits = 0;

/**
 * 风控靶页的开关（spec 2.7-01 用）：`off` 照常出列表页，`captcha` 出 200 的验证页，`blocked` 出 403。
 *
 * 三种而不是两种，是因为 `browser.risk` 有两条独立的判据：文案判据只在 200 的验证页上命中
 * （状态码是 200，光看响应头判不出来），状态码判据要靠 403 才有东西可判。
 * 开关放在 fixture 进程里、由验收脚本按条目现调，是为了让「工作流正在跑 → 页面突然变验证页」
 * 这条真实时序能被演出来，而不是靠事先把站点改成坏样子（那种靶子测不到运行中的暂停）。
 */
type RiskMode = 'off' | 'captcha' | 'blocked';

let riskMode: RiskMode = 'off';

/** 一张最朴素的人机验证页：标题与正文都带「安全验证」，正好落进知识包 `risk.riskPattern` 的判据里。 */
const RISK_CAPTCHA_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>安全验证 - 本地仿站</title></head>' +
  '<body><h1 data-testid="risk-heading">请完成安全验证</h1>' +
  '<p data-testid="risk-body">检测到异常访问，请输入下方验证码后继续。</p></body></html>';

/** 403 那一档的响应体：真实站点的拦下页也带一句人话，正文为空会让「页面照样装载完成」这条实测失去靶子。 */
const RISK_BLOCKED_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>访问受限 - 本地仿站</title></head>' +
  '<body><h1 data-testid="risk-heading">访问受限</h1>' +
  '<p data-testid="risk-body">您的请求过于频繁，请稍后再试。</p></body></html>';

/**
 * 改写腿的应答档位（spec 4.5-02 / 05 / 11 的 V 半边用）。
 *
 * 为什么要有这个靶子：这三条的判据都是"界面上看得见改写行"，而**没有模型就没有改写行**
 * （4.5-09 的保守版只有重排）。真打外部模型服务要花钱、也需用户单独授权（同 4.4-02 一直标 `[!]`
 * 的理由），所以这里在本地做一个只回 OpenAI 信封的靶端点：
 * - `rewrite` 逐条原样回填位置三 id，正文只在原文后追加一句**不含数字、不含机构名**的哨兵，
 *   于是确定性事实校验（数值守恒 + 具名回查 + 事实锁）三条全过，产物是 `rewritten`；
 *   截图里"改后"与"改前"必须肉眼可分，否则证明不了这一行真从模型腿来。
 * - `fabricate` 把正文换成一句凭空多了 `91%` 的说法，**必然**命中数值守恒，两轮都不过 →
 *   `rejected`、没有产物、界面列出违规行（4.5-05 要的正是"注入必失败用例"）。
 * 档位由验收脚本现调，不在启动时定死：同一份简历要能反复拍这两种结局。
 */
type GenerateMode = 'rewrite' | 'fabricate';

let generateMode: GenerateMode = 'rewrite';

/** 待改写清单的一条（与 `generate-model.ts` 递给模型的那份 JSON 同形）。 */
interface GenerateTarget {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  readonly text: string;
}

/** 提示词里那份清单的前导标记串，与 `buildGenerateMessages` 的 user 消息逐字一致。 */
const GENERATE_TARGET_MARKER = '待改写的段落清单（JSON）：\n';

/**
 * 过校验的哨兵后缀：不加数字、不加机构名，只让改前改后在截图里分得开。
 * 尾巴上那串纯 ASCII（`JD-REWRITE-MARK`）是给 4.5-13 的 PDF 文本层断言用的：
 * 中文字体在打印产物里被子集化，`pdftotext` 读不出中文，只有 ASCII 稳（见 3.3 的取证口径）。
 */
const GENERATE_REWRITE_SUFFIX = '【定制】这段做法可按岗位要求逐条核对，事实与指标保持原样。JD-REWRITE-MARK';

/** 越界的哨兵正文：凭空补一个基线里不存在的百分比，数值守恒判据一定会抓到它。 */
const GENERATE_FABRICATED_TEXT = '把存量问题的解决率提升到 91%。';

/**
 * 从一次 chat 请求体里读出那份待改写清单。
 *
 * 认标记串而不是认模型名或某条消息的顺序：清单只可能由改写腿的提示词拼出来，
 * 而 4.4 的拆解腿、2.5 的话术腿用的是完全不同的提示词，它们打到这里应当被判"不是改写腿"
 * 并回 400，而不是拿到一份看似成功、实则答非所问的回复。
 * @param body 请求体（OpenAI 信封：`{model, messages:[{role, content}]}`）
 * @returns 清单条目；请求里没有那份清单（或读不出合法 JSON）时 null
 */
function readGenerateTargets(body: Record<string, unknown>): GenerateTarget[] | null {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return null;
  let userText = '';
  for (const message of messages) {
    const entry = message as { role?: unknown; content?: unknown };
    if (entry.role === 'user' && typeof entry.content === 'string') userText = entry.content;
  }
  const markerAt = userText.indexOf(GENERATE_TARGET_MARKER);
  if (markerAt < 0) return null;
  const afterMarker = userText.slice(markerAt + GENERATE_TARGET_MARKER.length);
  // 清单是单独一行 JSON（后面只跟一句"请按要求输出改写结果"），按换行切出那一行即可。
  const line = afterMarker.slice(0, afterMarker.indexOf('\n') === -1 ? afterMarker.length : afterMarker.indexOf('\n'));
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(payload)) return null;
  const targets: GenerateTarget[] = [];
  for (const item of payload) {
    const candidate = item as Record<string, unknown>;
    const { sectionId, entryId, fieldKey, text } = candidate;
    if (
      typeof sectionId !== 'string' ||
      typeof entryId !== 'string' ||
      typeof fieldKey !== 'string' ||
      typeof text !== 'string'
    ) {
      return null;
    }
    targets.push({ sectionId, entryId, fieldKey, text });
  }
  return targets;
}

/**
 * 脱敏靶页（spec 2.7-07）。
 *
 * 每一块都是刻意的形状，不是随手写的假数据：
 * - **裸值**（中文标签 + 冒号 + 号码）而不是 `phone=13800138000`，因为页面正文里 PII 就是这个长相，
 *   而既有 `redactText` 的键值判据在这里一个都不命中——这条正是本片要补的那一半；
 * - `pii-control` 是**反向靶子**：`15000-25000` / `123456` / `2019` 这些数字必须原样留在截图与正文里，
 *   否则「脱敏」就变成了把页面涂黑，验收时用它证明判据没有过界；
 * - `pii-split` 是**能力边界**：号码被站点的样式标签切成三个文本节点，任何按文本节点匹配的方案都抓不到它，
 *   验收记录必须写明这一条没被盖住，不许说成「截图全脱敏」；
 * - `pii-link` 的可见文字要盖住，而 `href="tel:…"` 里的号码不在页面上渲染，遮罩按定义不管属性。
 */
const PII_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>候选人联系方式 - 本地仿站</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        font-size: 15px;
        line-height: 1.9;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <h1 data-testid="pii-heading">简历正文靶页</h1>
    <p data-testid="pii-phone">联系人手机：13800138000（工作日 9-19 点可联系）</p>
    <p data-testid="pii-email">投递邮箱：zhaopin.huang@example.com.cn</p>
    <p data-testid="pii-id">证件号码：330106199001011234</p>
    <p data-testid="pii-anchor">电话直达：<a href="tel:13800138000" data-testid="pii-link">13800138000</a></p>
    <p data-testid="pii-control">薪资 15000-25000，经验 3-5 年，编号 123456，成立于 2019，共 20 个项目</p>
    <p data-testid="pii-split">跨标签的号码：<span>138</span><span>0013</span><span>8000</span></p>
  </body>
</html>`;

/**
 * 投递靶页的状态（2.6 用）。
 *
 * `offlineJobIds` 里的那些岗位**在 `/boss` 列表里照常出现**（能被抓到、能进库），只有投递页说它下架了
 * ——这正是 spec 2.6-07 要演的场景：库里那条 JD 是抓取那一刻的快照，只有页面能回答「现在还在不在招」。
 * `1002`（React 前端工程师）是刻意挑的：它是一条正常数据，不是什么坏数据，所以「下架」这个结局
 * 只能来自页面的回答，不会与 2.3-08 的坏数据靶子（`1005` 缺正文）混在一起。
 */
const offlineJobIds = new Set(['1002']);

/** 服务端登记过的一份附件（字节到了站点这一步的证据；sha256 在这里算，不信任页面报的任何摘要）。 */
type DeliverAttachment = {
  id: number;
  targetId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  receivedAt: number;
};

/** 一次「点发送」的收讫记录：`GET /api/deliveries` 回的就是它，投递是否真发生由这里说。 */
type DeliverReceipt = {
  id: number;
  targetId: string;
  attachmentId: number;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  deliveredAt: number;
};

const deliverAttachments: DeliverAttachment[] = [];
const deliverReceipts: DeliverReceipt[] = [];

/** 附件与收讫记录共用一个发号器：截图里的「#7」在两张表里指向同一份东西，对账不用换算。 */
let deliverSeq = 0;

/**
 * 原始体的上限（字节）。
 * 简历上限是 5 MB（`outbound.deliver.maxResumeBytes` 的默认值），这里留到 8 MB：
 * 让「超限」由被测代码判，而不是被 fixture 抢先回一个 413 冒充成功路径。
 */
const MAX_DELIVER_UPLOAD_BYTES = 8 * 1024 * 1024;

/** 仿站的一条虚构岗位。字段与知识包 `capture.list.fields` 一一对应，正文两条对应 `capture.detail`。 */
type FixtureJob = {
  /** 平台侧岗位标识（详情页地址的 `jobId`，也是抓取去重用的 jobId） */
  id: string;
  title: string;
  company: string;
  /** 薪资原文，不做任何归一化——归一化是被测代码的活（spec 2.3-03） */
  salary: string;
  city: string;
  experience: string;
  education: string;
  /** 发布时间原文（相对写法），折算同样归被测代码（spec 2.3-03） */
  posted: string;
  /**
   * 岗位职责正文；`null` 时详情页**不渲染**这一段（1005 就是这条靶子）：
   * 真实站点确实有这种页面，而 spec 2.3-08 要看的正是「一条读不到只进 skipped，整轮继续」。
   */
  description: string | null;
  requirement: string;
};

/**
 * 仿站的岗位库（spec 2.3-09：fixture 上要能抓到 ≥10 条）。
 *
 * 全部为虚构数据，与任何真实公司、真实职位无关。条数、城市分布与经验档位是刻意配的：
 * 关键词「前端」命中 11 条（`1006` 那条不命中，用来证明筛选真的在筛），
 * 城市「上海」4 条、「经验不限」2 条，五屏一页正好把「滚动加载」跑出来。
 */
const fixtureJobs: FixtureJob[] = [
  {
    id: '1001',
    title: '桌面端前端工程师（Electron）',
    company: '星桥科技',
    salary: '25-40K·14薪',
    city: '上海 · 浦东新区',
    experience: '3-5 年',
    education: '本科',
    posted: '刚刚发布',
    description:
      '负责桌面端应用的渲染层与主进程功能开发；参与浏览器自动化、会话管理与打包发布链路。示例文本，虚构内容。',
    requirement: '三年及以上 TypeScript 经验；熟悉 Electron 主进程与渲染进程通信；能独立排查打包问题',
  },
  {
    id: '1002',
    title: 'React 前端工程师',
    company: '云栖数据',
    salary: '30-45K',
    city: '上海 · 徐汇区',
    experience: '5-10 年',
    education: '本科',
    posted: '1 小时前',
    description: '负责数据可视化控制台的组件库与图表交互；与后端约定接口形状并推动前端工程化。示例文本，虚构内容。',
    requirement: '五年及以上 React 经验；熟悉 TypeScript 与状态管理；带过两人以上小团队',
  },
  {
    id: '1003',
    title: '全栈工程师（Node + React）',
    company: '灯塔智能',
    salary: '面议',
    city: '杭州 · 滨江区',
    experience: '经验不限',
    education: '大专',
    posted: '3 天前',
    description: '从前端页面到 Node 服务端接口一起负责，参与内部工具的设计与实现。示例文本，虚构内容。',
    requirement: '熟悉 Node.js 与关系型数据库；能独立交付一个完整功能；有前端页面经验优先',
  },
  {
    id: '1004',
    title: '客户端工程师（桌面应用方向）',
    company: '北岸软件',
    salary: '1.8-2.5万·15薪',
    city: '北京 · 海淀区',
    experience: '3-5 年',
    education: '硕士',
    posted: '2 天前',
    description: '负责桌面客户端的前端界面与本地存储；参与跨平台打包与自动更新方案。示例文本，虚构内容。',
    requirement: '熟悉 TypeScript 与桌面端渲染层；了解跨平台构建；有 Electron 项目经验优先',
  },
  {
    id: '1005',
    title: '前端工程师（支付方向）',
    company: '星海科技',
    salary: '28-38K·13薪',
    city: '深圳 · 福田区',
    experience: '3-5 年',
    education: '本科',
    posted: '5 小时前',
    // 刻意缺正文：详情页只渲染任职要求与发布时间（spec 2.3-08 的坏数据靶子，放在第一屏才好演示）。
    description: null,
    requirement: '三年及以上前端经验；熟悉支付流程的表单校验与埋点；细心、能配合安全评审',
  },
  {
    id: '1006',
    title: '自动化测试开发工程师',
    company: '原野科技',
    salary: '20-30K',
    city: '成都 · 高新区',
    experience: '1-3 年',
    education: '本科',
    posted: '5 天前',
    description: '负责测试平台的服务端与用例执行调度，维护 CI 流水线。示例文本，虚构内容。',
    requirement: '熟悉 Python 或 Node；了解持续集成与用例分层；能编写稳定的自动化脚本',
  },
  {
    id: '1007',
    title: '高级前端工程师（可视化方向）',
    company: '星桥科技',
    salary: '35-50K·15薪',
    city: '上海 · 杨浦区',
    experience: '3-5 年',
    education: '本科',
    posted: '4 小时前',
    description: '负责大屏与图表渲染性能，制定团队的前端规范并评审设计稿。示例文本，虚构内容。',
    requirement: '三年及以上 TypeScript 经验；熟悉 Canvas 或 WebGL；关注帧率与内存指标',
  },
  {
    id: '1008',
    title: '前端架构师',
    company: '长江智算',
    salary: '50-70K·14薪',
    city: '上海 · 静安区',
    experience: '5-10 年',
    education: '硕士',
    posted: '6 天前',
    description: '负责前端整体技术选型与基础设施建设，推动构建、发布与监控链路。示例文本，虚构内容。',
    requirement: '五年及以上前端经验；主导过大型项目的工程化改造；能带教团队成员',
  },
  {
    id: '1009',
    title: '前端工程师（移动端 Web）',
    company: '南岭信息',
    salary: '22-32K',
    city: '杭州 · 西湖区',
    experience: '1-3 年',
    education: '本科',
    posted: '2 小时前',
    description: '负责移动端页面与小程序的界面实现，配合设计完成交互细节。示例文本，虚构内容。',
    requirement: '一到三年前端经验；熟悉响应式布局与移动端调试；能读懂设计标注',
  },
  {
    id: '1010',
    title: '前端工程师（应届 / 实习）',
    company: '海豚开放平台',
    salary: '4-6K',
    city: '北京 · 朝阳区',
    experience: '经验不限',
    education: '本科',
    posted: '7 天前',
    description: '参与开放平台控制台的页面开发，由导师带教完成需求交付。示例文本，虚构内容。',
    requirement: '计算机相关专业；熟悉 HTML 与 JavaScript 基础；有开源或个人项目经历优先',
  },
  {
    id: '1011',
    title: '全栈工程师（Go + React）',
    company: '海豚开放平台',
    salary: '30-40K·13薪',
    city: '深圳 · 南山区',
    experience: '3-5 年',
    education: '本科',
    posted: '3 小时前',
    description: '负责开放平台的服务端接口与前端页面，参与数据库建模。示例文本，虚构内容。',
    requirement: '熟悉 Go 与 React；能独立完成从接口到页面的交付；了解容器化部署优先',
  },
  {
    id: '1012',
    title: '前端负责人',
    company: '汇流网络',
    salary: '40-60K·16薪',
    city: '成都 · 天府新区',
    experience: '5-10 年',
    education: '大专',
    posted: '昨天',
    description: '负责前端团队的目标拆解与排期，亲自承担关键模块的实现。示例文本，虚构内容。',
    requirement: '五年及以上前端经验；带过五人团队；能在业务与技术之间做取舍',
  },
];

/** 一页给几张卡：五张 × 若干屏正好把「滚动加载」这条路径跑出来，也让 12 行的抽取上限不越界。 */
const JOBS_PER_PAGE = 5;

/**
 * 按搜索条件筛仿站的岗位（条件名与知识包 `search.params` 一致：`query` / `city` / `experience`）。
 *
 * 匹配刻意做得宽松（子串、大小写无关）：真实站点的筛选逻辑我们不想知道，
 * 这里只需要「条件变了、结果真的变了」这一件事可观察。
 * @param query 关键词，命中标题、公司或正文
 * @param city 城市，命中城市字段前缀（「上海」命「上海 · 徐汇区」）
 * @param experience 经验档位，子串命中（「3-5」命「3-5 年」）
 * @returns 命中的岗位，按库里声明的顺序
 */
function filterJobs(query: string, city: string, experience: string): FixtureJob[] {
  const keyword = query.trim().toLowerCase();
  return fixtureJobs.filter((job) => {
    if (city && !job.city.startsWith(city.trim())) return false;
    if (experience && !job.experience.includes(experience.trim())) return false;
    if (!keyword) return true;
    return [job.title, job.company, job.description ?? '', job.requirement].some((text) =>
      text.toLowerCase().includes(keyword),
    );
  });
}

/**
 * 渲染仿站的详情页。
 * @param job 要渲染的岗位；`undefined` 时回一份「岗位不存在」的页面
 * @param loggedIn 请求里有没有会话 cookie（2.1-05 的横幅读数）
 * @param authLabel 横幅文案（已登录 / 未登录）
 * @returns 完整 HTML
 */
function renderDetailPage(job: FixtureJob | undefined, loggedIn: boolean, authLabel: string): string {
  const base = readFileSync(bossDetailPage, 'utf8');
  if (!job) {
    return base
      .replaceAll('{{loggedIn}}', loggedIn ? 'true' : 'false')
      .replaceAll('{{authLabel}}', authLabel)
      .replaceAll('{{jobId}}', '（未知）')
      .replaceAll('{{title}}', '岗位不存在或已下线')
      .replaceAll('{{company}}', '—')
      .replaceAll('{{salary}}', '—')
      .replaceAll('{{city}}', '—')
      .replaceAll('{{experience}}', '—')
      .replaceAll('{{education}}', '—')
      .replaceAll('{{requirementSection}}', '')
      .replace('{{descriptionSection}}', '')
      .replace('{{posted}}', '—');
  }
  // `{{descriptionSection}}` / `{{requirementSection}}` 是**整块**占位：正文缺失时连标题一起不渲染，
  // 这样「页面确实没有这一段」是 DOM 事实，而不是页面上写了一句话让我们自己判断。
  const descriptionSection =
    job.description === null ? '' : `<h2>岗位职责</h2>\n    <p data-field="description">${job.description}</p>`;
  return base
    .replaceAll('{{loggedIn}}', loggedIn ? 'true' : 'false')
    .replaceAll('{{authLabel}}', authLabel)
    .replaceAll('{{jobId}}', job.id)
    .replaceAll('{{title}}', job.title)
    .replaceAll('{{company}}', job.company)
    .replaceAll('{{salary}}', job.salary)
    .replaceAll('{{city}}', job.city)
    .replaceAll('{{experience}}', job.experience)
    .replaceAll('{{education}}', job.education)
    .replace('{{descriptionSection}}', descriptionSection)
    .replace('{{requirementSection}}', `<h2>任职要求</h2>\n    <p data-field="requirement">${job.requirement}</p>`)
    .replace('{{posted}}', job.posted);
}

/**
 * 没带 `?targetId=` 时页面默认聊的那个目标。
 * 会话按目标分线程（spec 2.5-08 要「有的已回复、有的未回复」），所以目标 id 从地址上来，
 * 不再由页面写死——写死会让 app 侧无论传哪个 jobId 都读到同一个线程，那条验收就成了假证据。
 */
const chatTargetId = 'fixture-job-1001';

/**
 * `/chat/frame` 的内容：同源 iframe 里的输入框与发送按钮（spec 2.2-10 的靶子）。
 * 这张子视图与父页是同一个验收动作的两半（帧内敲字、父页报状态），拆成独立文件反而看不出耦合，故就地内联。
 */
const chatFramePageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>聊天区（同源 iframe）· 本地 fixture</title>
    <style>
      body {
        margin: 0;
        padding: 12px;
        font: 13px/1.7 system-ui, sans-serif;
        color: #e2e8f0;
        background: #111c31;
      }
      code {
        color: #7dd3fc;
      }
      textarea,
      button {
        font: inherit;
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid #334155;
        background: #1e293b;
        color: #e2e8f0;
      }
      textarea {
        box-sizing: border-box;
        width: 100%;
        background: #020617;
      }
      ul {
        padding-left: 18px;
      }
    </style>
  </head>
  <body data-fixture-page="chat-frame">
    <p>聊天区在帧内：<code>/chat/frame</code>（同源 iframe）—— 帧外的自动化必须换算坐标才点得到这里。</p>
    <p>打招呼目标：<code data-testid="chat-target">（脚本未运行）</code></p>
    <p><textarea data-testid="chat-input" rows="3" placeholder="输入打招呼文案（含中文与 emoji）"></textarea></p>
    <p><button type="button" data-testid="chat-send">发送打招呼</button></p>
    <p>帧内状态：<strong data-testid="chat-frame-status">待发送</strong></p>
    <p>会话消息（出站与对方回复同一条时间线，<code>li</code> 带 <code>data-message-id</code> 供 app 侧去重，正文只装在 <code>[data-testid=chat-log-body]</code> 里）：</p>
    <ul data-testid="chat-log"></ul>
    <script>
      const chatInput = document.querySelector('[data-testid="chat-input"]');
      const chatLog = document.querySelector('[data-testid="chat-log"]');
      const frameStatus = document.querySelector('[data-testid="chat-frame-status"]');
      // 目标 id 从地址栏取：同一张帧页要能演「三个目标、两个已回、一个未回」（spec 2.5-08）。
      const chatTarget = new URLSearchParams(location.search).get('targetId') || '${chatTargetId}';
      /** 已渲染到的消息 id：轮询只取比它新的，所以重复轮询不会画出重复节点。 */
      let cursor = 0;

      /**
       * 把一条服务端消息画进帧内列表。
       * @param message 服务端读数（id / direction / text）
       */
      function renderMessage(message) {
        const line = document.createElement('li');
        line.dataset.testid = 'chat-log-item';
        line.dataset.messageId = String(message.id);
        line.dataset.direction = message.direction;
        // 方向标记与正文分成两个节点：真人看得出是谁说的，app 读正文时也不会把「对方：」一起读进库（spec 2.5-08）。
        const marker = document.createElement('span');
        marker.dataset.messageMarker = message.direction;
        marker.textContent = message.direction === 'inbound' ? '对方：' : '我：';
        const body = document.createElement('span');
        // 用 textContent 而不是拼 HTML：中文与 emoji 要按字面出现在帧内（spec 2.2-13）。
        body.dataset.testid = 'chat-log-body';
        body.dataset.messageBody = 'true';
        body.textContent = message.text;
        line.append(marker, body);
        chatLog.append(line);
      }

      /** 增量拉一次会话：对方回复只有走这条路才会出现在页面上（spec 2.5-07 的 observable 面）。 */
      function pullThread() {
        fetch('/api/threads?targetId=' + encodeURIComponent(chatTarget) + '&after=' + String(cursor))
          .then((response) => response.json())
          .then((payload) => {
            for (const message of payload.messages ?? []) renderMessage(message);
            cursor = payload.cursor ?? cursor;
            // 目标与「线程总条数」一起报出来：截图里要能证明这一页读的是这个 jobId 的线程，
            // 而不是一个写死的常量；条数取服务端总数，增量批次的大小会把「已注入几条」说小。
            document.querySelector('[data-testid="chat-target"]').textContent =
              chatTarget + '（线程内 ' + String(payload.total ?? 0) + ' 条）';
          })
          .catch(() => {
            frameStatus.textContent = '会话拉取失败：服务端不可达';
          });
      }

      /** 发出一次打招呼：交给 /api/outbound（对端数得清），画到页面上由上面的轮询负责（同一个来源）。 */
      function sendGreeting() {
        const text = chatInput.value;
        // action 与 targetId 是 /api/outbound 的必填字符串字段，缺一个就被 400 拒掉，验收会当场暴露。
        fetch('/api/outbound', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'greet', targetId: chatTarget, text, frameUrl: location.pathname }),
        })
          .then((response) => response.json())
          .then((payload) => {
            frameStatus.textContent = '第 ' + String(payload.received) + ' 条已送达服务端';
            chatInput.value = '';
            // 状态由帧内报给父页：父页显示的每一条都追溯到「iframe 里确实点过」。
            window.parent.postMessage({ type: 'chat-outbound', received: payload.received, text }, window.location.origin);
            // 立刻补拉一次：等下一个轮询周期才出现会让「发出去 → 看得见」这条判据在截图里对不上。
            pullThread();
          })
          .catch((error) => {
            frameStatus.textContent = '发送失败：' + String(error);
          });
      }

      document.querySelector('[data-testid="chat-send"]').addEventListener('click', sendGreeting);
      pullThread();
      setInterval(pullThread, 1200);
    </script>
  </body>
</html>
`;

/** `/newtab/target` 的内容：新标签被接管后，这页的 location 与 cookie 就是分区一致性的读数（spec 2.2-11）。 */
const newtabTargetPageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>新标签目标页 · 本地 fixture</title>
    <style>
      body {
        margin: 0;
        padding: 16px;
        font: 13px/1.7 system-ui, sans-serif;
        color: #e2e8f0;
        background: #0f172a;
      }
      code {
        color: #7dd3fc;
        word-break: break-all;
      }
    </style>
  </head>
  <body data-fixture-page="newtab-target">
    <h1>新标签目标页</h1>
    <p>本地 fixture 站点（AGENTS.md §7.2），由 <code>/newtab</code> 的两条入口唤出。</p>
    <p>当前地址：<code data-testid="target-url">（脚本未运行）</code></p>
    <p>document.cookie：<code data-testid="target-cookie">（空）</code></p>
    <p>cookie 名：<code data-testid="target-cookie-names">（空）</code></p>
    <p>判定：读得到 <code>autocc_session</code> 才说明新页面和发起页落在同一个会话分区。</p>
    <script>
      document.querySelector('[data-testid="target-url"]').textContent = window.location.href;
      document.querySelector('[data-testid="target-cookie"]').textContent = document.cookie || '（空）';
      // 名字单独列一份：证据里只留名字不留值，跟 /api/state 的口径一致。
      document.querySelector('[data-testid="target-cookie-names"]').textContent =
        document.cookie
          .split(';')
          .map((pair) => pair.trim().split('=')[0])
          .filter(Boolean)
          .sort()
          .join(', ') || '（空）';
    </script>
  </body>
</html>
`;

/**
 * 读完请求体再回调；默认上限 64 KB，避免样例端点被当成缓冲区滥用。
 * @param request 入站请求
 * @param response 出站响应（超限时就地回 413，所以调用方拿到 null 时不要再写头）
 * @param maxBytes 体积上限（字节）；改写腿的请求体带整份待改写清单，只有它需要放宽
 * @returns 解析后的对象；体不是合法 JSON 时 `undefined`，超限并已就地回了 413 时 `null`
 */
function readJson(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown> | undefined | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.writeHead(413).end();
        request.destroy();
        // destroy 之后不会再有 end，必须在这里定下来，否则调用方永远悬着。
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        // 只能 Buffer.concat：Buffer.from(缓冲数组) 按字节数组解释，会把每个分片变成 0x00。
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * `/deliver` 的内容：简历投递靶页（spec 2.6-04 / 06 / 07 的截图对象）。
 *
 * 三处刻意复刻真实站点，而不是做一张「好点」的页：
 * ① 上传控件 `display:none`（站点把入口藏在「选择文件」背后）——所以知识包那条定位声明必须带
 *    `requireActionable:false`，也所以 2.6-a 把等待判据换成 `appear`；人用的入口是一个 `<label>`，
 *    点标签照样能唤起隐藏控件，DOM 里只有那一个 `input[type=file]`；
 * ② 状态行开局文本由服务端按 `targetId` 现填（下架岗位一进来就写「该岗位已下架」），
 *    「在不在架」是页面的读数，不是 app 能猜的（spec 2.6-07）；
 * ③ 「已送达」这句话只在**服务端收讫那份字节之后**才画出来——点了按钮不等于站点收了简历。
 * 页面对那一次 `change` 的自述（`changeCount` / `isTrusted` / 文件名 / 字节数）按 `data-testid` 逐条摆开，
 * 机读判据要的就是这几行（spec 2.6-04）。
 */
const deliverPageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>简历投递页 · 本地 fixture</title>
    <style>
      body {
        margin: 0;
        padding: 16px;
        font: 13px/1.7 system-ui, sans-serif;
        color: #e2e8f0;
        background: #0f172a;
      }
      code {
        color: #7dd3fc;
        word-break: break-all;
      }
      .upload-input {
        display: none;
      }
      .pick,
      button {
        display: inline-block;
        font: inherit;
        padding: 4px 12px;
        border-radius: 6px;
        border: 1px solid #334155;
        background: #1e293b;
        color: #e2e8f0;
        cursor: pointer;
      }
      .card {
        margin-top: 12px;
        padding: 10px 12px;
        border: 1px solid #1e293b;
        border-radius: 8px;
        background: #111c31;
      }
      .status {
        font-weight: 700;
        color: #fbbf24;
      }
      b {
        color: #f8fafc;
      }
    </style>
  </head>
  <body data-fixture-page="deliver">
    <h1>简历投递页（本地仿站）</h1>
    <p>投递目标：<code data-testid="deliver-target">（脚本未运行）</code></p>
    <p>登录态：<code data-testid="deliver-auth">（脚本未运行）</code></p>

    <div class="card">
      <p>上传控件与真实站点一样藏在按钮背后（<code>display:none</code>）：按默认可点判据它永远定位不到，注入走的是 CDP 而不是坐标。</p>
      <p>
        <label class="pick" for="resume-file">选择简历文件</label>
        <span data-testid="deliver-note">（人点这个标签；app 用 <code>browser.act.upload</code> 直接注进控件）</span>
      </p>
      <input id="resume-file" class="upload-input" type="file" name="resume" accept="application/pdf" data-testid="resume-upload-input" />
      <p>
        页面对 <code>change</code> 的自述：收到 <b data-testid="upload-change-count">0</b> 次 ·
        isTrusted <b data-testid="upload-is-trusted">（无）</b> · 文件 <b data-testid="upload-file-name">（空）</b> ·
        字节 <b data-testid="upload-file-size">0</b> · 类型 <b data-testid="upload-file-type">（空）</b>
      </p>
      <p data-testid="deliver-server-readout">服务端登记：（尚未上传）</p>
    </div>

    <p><button type="button" data-testid="resume-send">发送简历</button></p>
    <p>投递状态行（<code>sentPattern</code> 与 <code>offlinePattern</code> 都从这里回读）：</p>
    <p class="status" data-testid="resume-deliver-status" data-role="deliver-status">{{initialStatus}}</p>
    <script>
      const uploadInput = document.querySelector('[data-testid="resume-upload-input"]');
      const serverReadout = document.querySelector('[data-testid="deliver-server-readout"]');
      const statusLine = document.querySelector('[data-testid="resume-deliver-status"]');
      // 目标 id 由页面自己从地址栏读并画出来（不服务端插值）：截图里那一行就是「这一页演的是哪个 jobId」的证据，
      // 也顺带保证「targetId 里带任何字符」都不会变成这页里的 HTML。
      const deliverTarget = new URLSearchParams(location.search).get('targetId') || '';
      document.querySelector('[data-testid="deliver-target"]').textContent = deliverTarget || '（地址里没有 targetId）';
      let changeCount = 0;
      let attachmentId = null;

      /**
       * 写一行页面读数。
       * @param selector 目标节点的 <code>data-testid</code> 选择器
       * @param text 要落的文本（按字面写，中文与文件名原样出现在 DOM 里）
       */
      function fill(selector, text) {
        document.querySelector(selector).textContent = text;
      }

      /** 把选中的那份文件原样 POST 给服务端：字节到了站点这一步，才算「附件登记上了」。 */
      function registerUpload(file) {
        const query = new URLSearchParams({ targetId: deliverTarget, fileName: file.name });
        fetch('/api/deliver-upload?' + query.toString(), { method: 'POST', body: file })
          .then((response) => response.json())
          .then((payload) => {
            if (!payload.ok) {
              serverReadout.textContent = '服务端登记失败：' + payload.error;
              attachmentId = null;
              return;
            }
            attachmentId = payload.attachmentId;
            // 摘要只报前 12 位：与账本 <code>source</code> 里 <code>resume:&lt;sha256 前 12 位&gt;</code> 同一形状，截图里能直接对（spec 2.6-05）。
            serverReadout.textContent =
              '服务端已登记附件 #' + String(payload.attachmentId) + '：' + payload.fileName +
              ' / ' + String(payload.sizeBytes) + ' 字节 · sha256 前 12 位 ' + payload.sha256.slice(0, 12);
          })
          .catch((error) => {
            serverReadout.textContent = '服务端登记失败：' + String(error);
            attachmentId = null;
          });
      }

      uploadInput.addEventListener('change', (event) => {
        changeCount += 1;
        // 注入不带用户手势，isTrusted 就必须报 false——这一行是页面自己答的，不由我们替它宣称（spec 2.2-12 延伸到 2.6）。
        fill('[data-testid="upload-change-count"]', String(changeCount));
        fill('[data-testid="upload-is-trusted"]', String(event.isTrusted));
        const file = uploadInput.files && uploadInput.files.length ? uploadInput.files[0] : null;
        fill('[data-testid="upload-file-name"]', file ? file.name : '（空）');
        fill('[data-testid="upload-file-size"]', file ? String(file.size) : '0');
        fill('[data-testid="upload-file-type"]', file ? file.type || '（空）' : '（空）');
        if (file) registerUpload(file);
      });

      /** 点「发送简历」：只有服务端收讫过的那份附件才允许状态行变成已送达。 */
      function sendResume() {
        if (attachmentId === null) {
          statusLine.textContent = '页面未登记任何附件，简历不会送达';
          return;
        }
        fetch('/api/deliver', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetId: deliverTarget, attachmentId }),
        })
          .then((response) => response.json())
          .then((payload) => {
            statusLine.textContent = payload.ok
              ? '简历已送达：目标 ' + payload.targetId + ' · 附件 #' + String(payload.attachmentId) +
                '（服务端第 ' + String(payload.received) + ' 次收讫）'
              : '投递未成功：' + payload.error;
          })
          .catch((error) => {
            statusLine.textContent = '投递失败：服务端不可达（' + String(error) + '）';
          });
      }

      document.querySelector('[data-testid="resume-send"]').addEventListener('click', sendResume);
      fetch('/api/state')
        .then((response) => response.json())
        .then((payload) => {
          document.querySelector('[data-testid="deliver-auth"]').textContent = payload.loggedIn
            ? '已登录（读得到 autocc_session）'
            : '未登录';
        })
        .catch(() => {
          document.querySelector('[data-testid="deliver-auth"]').textContent = '服务端不可达';
        });
    </script>
  </body>
</html>
`;

/**
 * 读完一段**原始**请求体（不是 JSON）——上传靶页把文件字节原样 POST 上来，摘要必须由服务端自己算。
 *
 * 为什么不复用 `readJson`：它的 64 KB 上限装不进一份真简历，而 base64-in-JSON（plan §13.5 的原始打算）
 * 会把体积再抬 4/3 并让「服务端收到的字节」变成「解码出来的字节」，中间多一道换算就多一分不实。
 * @param request 进来的请求
 * @param response 待写的响应（超限时就地回 413）
 * @param limitBytes 上限（字节）
 * @returns 原始字节；超限且已回 413 时为 `null`（调用方必须立刻返回，体已被销毁不会再有 end）
 */
async function readRawBody(
  request: IncomingMessage,
  response: ServerResponse,
  limitBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        response.writeHead(413).end();
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * 回一份静态 HTML。
 * @param response 待写的响应
 * @param html 页面内容（已做过占位替换或本身就是静态子视图）
 * @param status 状态码；默认 200，风控靶页那一档要的是 403（spec 2.7-01 的状态码判据）
 */
function sendHtml(response: ServerResponse, html: string, status = 200): void {
  // no-store 是必需的：验收截图一旦拿到缓存里的旧 DOM，判据就跟当前实现错位了。
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
}

/**
 * 处理一次实验台请求。
 * @param request 进来的请求（`/api/outbound` 需要先读完请求体，所以是 async）
 * @param response 待写的响应
 */
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
  const loggedIn = cookieNames(request.headers.cookie).includes(cookieName);

  if (url.pathname === '/login' || url.pathname === '/logout') {
    const isLogin = url.pathname === '/login';
    // Max-Age=0 让 Chromium 立刻丢掉这条 cookie，等价于站点自己的「退出登录」。
    response.setHeader('Set-Cookie', `${cookieName}=fixture-token; Path=/; Max-Age=${isLogin ? '86400' : '0'}`);
    // 回跳到发起登录的那一页：登录态要能在**同一张页面**上前后对照（spec 2.1-05 的截图判据）。
    response.writeHead(302, { Location: loginTargets[url.searchParams.get('next') ?? '/'] ?? '/' });
    response.end();
    return;
  }

  // 1.9 的样例收件端点：记下这一条，并回「我是第几条收到的」。
  if (url.pathname === '/api/outbound' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    if (!body || typeof body['action'] !== 'string' || typeof body['targetId'] !== 'string') {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 action / targetId' }));
      return;
    }
    outbox.push({ ...body, receivedAt: Date.now() });
    // 同一条外发也进会话时间线：正文在 1.9 叫 `message`、在聊天帧里叫 `text`，两种都是这条验收的输入。
    const outboundText = body['message'] ?? body['text'];
    if (typeof outboundText === 'string') {
      appendThreadMessage(body['targetId'], 'outbound', outboundText);
    }
    console.log(`[fixture] 收到第 ${String(outbox.length)} 条外发：${body['action']} → ${body['targetId']}`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, received: outbox.length }));
    return;
  }

  if (url.pathname === '/api/outbox') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ count: outbox.length, items: outbox }));
    return;
  }

  // 上传靶页把文件**字节原样**POST 上来（2.6-04 / 05 的对端读数）：名字来自页面，字节与摘要只信这里。
  if (url.pathname === '/api/deliver-upload' && request.method === 'POST') {
    const bytes = await readRawBody(request, response, MAX_DELIVER_UPLOAD_BYTES);
    if (bytes === null) return;
    const targetId = url.searchParams.get('targetId') ?? '';
    const fileName = url.searchParams.get('fileName') ?? '';
    if (!targetId || !fileName) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 targetId / fileName' }));
      return;
    }
    if (bytes.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '空附件' }));
      return;
    }
    deliverSeq += 1;
    const attachment: DeliverAttachment = {
      id: deliverSeq,
      targetId,
      fileName,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      receivedAt: Date.now(),
    };
    deliverAttachments.push(attachment);
    console.log(
      `[fixture] 登记附件 #${String(attachment.id)}：${fileName}（${String(bytes.length)} 字节）→ ${targetId}`,
    );
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        ok: true,
        attachmentId: attachment.id,
        targetId: attachment.targetId,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
      }),
    );
    return;
  }

  // 「点发送」的收讫端点（spec 2.6-03 / 07）：在架才收，且只认已登记的附件——状态行那句「已送达」由这里的答复撑着。
  if (url.pathname === '/api/deliver' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    if (typeof body['targetId'] !== 'string' || typeof body['attachmentId'] !== 'number') {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 targetId / attachmentId' }));
      return;
    }
    const attachment = deliverAttachments.find((item) => item.id === body['attachmentId']);
    if (!attachment) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: `服务端没有登记过附件 #${String(body['attachmentId'])}` }));
      return;
    }
    if (offlineJobIds.has(body['targetId'])) {
      // 409 而不是 200：下架岗位不该收到「发送成功」这句话，页面上那句失败文案就是这么来的。
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '岗位已下架，站点不收这份简历' }));
      return;
    }
    deliverSeq += 1;
    const receipt: DeliverReceipt = {
      id: deliverSeq,
      targetId: body['targetId'],
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      deliveredAt: Date.now(),
    };
    deliverReceipts.push(receipt);
    console.log(
      `[fixture] 第 ${String(deliverReceipts.length)} 次投递收讫：附件 #${String(receipt.id)} → ${receipt.targetId}`,
    );
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        ok: true,
        targetId: receipt.targetId,
        receiptId: receipt.id,
        attachmentId: receipt.attachmentId,
        received: deliverReceipts.length,
      }),
    );
    return;
  }

  if (url.pathname === '/api/deliveries') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({ count: deliverReceipts.length, receipts: deliverReceipts, attachments: deliverAttachments }),
    );
    return;
  }

  // 注入一条「对方回复」（spec 2.5-07 的靶子）：验收脚本调它，页面下一次轮询就会把这条渲染进帧内 DOM。
  if (url.pathname === '/api/reply' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    if (typeof body['targetId'] !== 'string' || typeof body['text'] !== 'string' || body.text.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 targetId / text' }));
      return;
    }
    const message = appendThreadMessage(body['targetId'], 'inbound', body['text']);
    console.log(`[fixture] 注入回复 #${String(message.id)} → ${body['targetId']}`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, message }));
    return;
  }

  // 会话读数：`?after=<id>` 只要比它新的那几条，页面据此增量渲染（不是整表重画，所以节点 id 能当去重键）。
  if (url.pathname === '/api/threads') {
    const targetId = url.searchParams.get('targetId') ?? chatTargetId;
    const after = Number(url.searchParams.get('after') ?? '0');
    const history = threads.get(targetId) ?? [];
    const fresh = Number.isFinite(after) && after > 0 ? history.filter((item) => item.id > after) : history;
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    // `total` 是该线程的总条数（`messages` 只是这一批增量的），帧内读数要报前者。
    response.end(
      JSON.stringify({ targetId, messages: fresh, total: history.length, cursor: history.at(-1)?.id ?? after }),
    );
    return;
  }

  // 失败注入计数器（spec 2.4-03 / 2.4-05）：`demo.flaky` 每尝试一次 POST 一下，命中次数不超过 failTimes 就失败。
  if (url.pathname === '/api/fail-counter' && request.method === 'POST') {
    failCounterHits += 1;
    console.log(`[fixture] 失败计数器命中第 ${String(failCounterHits)} 次`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ hits: failCounterHits }));
    return;
  }

  // DELETE 归零：验收要能重复拍「两次失败、第三次成功」这条路径，否则第二次就没有内容可拍。
  if (url.pathname === '/api/fail-counter' && request.method === 'DELETE') {
    failCounterHits = 0;
    console.log('[fixture] 失败计数器归零');
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ hits: 0 }));
    return;
  }

  if (url.pathname === '/api/fail-counter') {
    // GET 只读不计数：面板与验收脚本要能在不推进注入进度的前提下看清现在是第几次。
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ hits: failCounterHits }));
    return;
  }

  // 风控靶页开关（spec 2.7-01）：POST 只认 off / captcha / blocked 三个值，别的以 400 拒绝而不是默默当 off 处理
  // ——「靶子没立起来」必须是一次可看见的失败，否则截图里那张正常列表页会被当成「风控没触发」的证据。
  if (url.pathname === '/api/risk-mode' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    const next = body['mode'];
    if (next !== 'off' && next !== 'captcha' && next !== 'blocked') {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'mode 只接受 off / captcha / blocked' }));
      return;
    }
    riskMode = next;
    console.log(`[fixture] 风控靶页切换为 ${next}`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, mode: riskMode }));
    return;
  }

  // DELETE 归到 off：验收要能重复拍同一条暂停路径，而停在 blocked 档时后续每一轮导航都会立刻 403，
  // 第二次拍不到「正常列表页 → 突然变验证页」的对比。
  if (url.pathname === '/api/risk-mode' && request.method === 'DELETE') {
    riskMode = 'off';
    console.log('[fixture] 风控靶页归零（off）');
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, mode: riskMode }));
    return;
  }

  if (url.pathname === '/api/risk-mode') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ mode: riskMode }));
    return;
  }

  // 改写腿档位开关（spec 4.5-02 / 05 / 11 的 V 半边）：只认 rewrite / fabricate 两个值，
  // 别的按 400 拒绝——靶子没立起来必须是一次看得见的失败，否则截图里那份"改写版"说明不了任何事。
  if (url.pathname === '/api/generate-mode' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    const next = body?.['mode'];
    if (next !== 'rewrite' && next !== 'fabricate') {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'mode 只接受 rewrite / fabricate' }));
      return;
    }
    generateMode = next;
    console.log(`[fixture] 改写腿档位切换为 ${next}`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, mode: generateMode }));
    return;
  }

  // DELETE 归回 rewrite：验收要能反复拍「改写过 → 被拒 → 再改写过」这三段，停在 fabricate 时
  // 后面每一轮都会立刻被拒，第二次的「改写版」截图就拍不到了。
  if (url.pathname === '/api/generate-mode' && request.method === 'DELETE') {
    generateMode = 'rewrite';
    console.log('[fixture] 改写腿档位归零（rewrite）');
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, mode: generateMode }));
    return;
  }

  if (url.pathname === '/api/generate-mode') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ mode: generateMode }));
    return;
  }

  // OpenAI 信封的本地靶端点（`llm.baseUrl` 指到 `http://127.0.0.1:<port>/v1` 时打的就是这里）。
  // 只应答改写腿，别的提示词一律 400 并说清原因：话术腿、拆解腿的答案这里给不出，
  // 假装给得出就会把「模型腿跑通了」的假证据留在截图里。
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    // 提示词带的是整份待改写清单，64KB 那道上限是给页面表单定的，这里按 512KB 走。
    const body = await readJson(request, response, 512 * 1024);
    if (body === null) return;
    const targets = body === undefined ? null : readGenerateTargets(body);
    if (targets === null || targets.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({ error: { message: 'fixture 的 chat 端点只应答简历改写腿：请求里读不出待改写清单' } }),
      );
      return;
    }
    const entries = targets.map((target) => ({
      sectionId: target.sectionId,
      entryId: target.entryId,
      fieldKey: target.fieldKey,
      text: generateMode === 'rewrite' ? `${target.text}${GENERATE_REWRITE_SUFFIX}` : GENERATE_FABRICATED_TEXT,
    }));
    // 模型名按请求回显（`llm.chat` 配置里给的是 `fixture-generate-model`，界面上要能认出打的是靶端点），
    // 但只回显字符串：`String(非字符串)` 会印出 `[object Object]`，那是条会误导人的读数。
    const requestedModel = body['model'];
    // 日志只落条数与档位，正文一个字都不打（AGENTS.md §8.5：简历内容默认脱敏）。
    console.log(`[fixture] 改写腿应答 ${String(entries.length)} 条，档位 ${generateMode}`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        id: 'fixture-generate',
        object: 'chat.completion',
        model: typeof requestedModel === 'string' ? requestedModel : 'fixture-generate-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: JSON.stringify({ entries }) }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: entries.length },
      }),
    );
    return;
  }

  // 2.2-12 / 2.2-13 的对端读数：页面把 isTrusted / inputType / value 整份报上来。
  if (url.pathname === '/api/trust' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    const readings = body?.['readings'];
    if (!Array.isArray(readings)) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 readings 数组' }));
      return;
    }
    // 覆盖而不是追加：上报的就是页面上那张表的全部行，追加会让 GET 与截图数不上行号。
    trustReadings = readings;
    console.log(`[fixture] 收到 ${String(trustReadings.length)} 条受信事件读数`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, count: trustReadings.length }));
    return;
  }

  if (url.pathname === '/api/trust') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ count: trustReadings.length, readings: trustReadings }));
    return;
  }

  if (url.pathname === '/api/state') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ loggedIn, cookieNames: cookieNames(request.headers.cookie) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/alt') {
    // 分区标签由路径决定，界面上肉眼可分：两张截图长得一样就没法证明隔离真的发生了。
    sendHtml(
      response,
      readFileSync(labPage, 'utf8').replaceAll('{{partitionLabel}}', url.pathname === '/alt' ? 'B' : 'A'),
    );
    return;
  }

  if (url.pathname === '/api/jobs') {
    // 分页读数由服务端说了算：`hasMore` 为 false 时页面不再长出新卡片，
    // 抓取编排因此能观察到「无新内容」这个停止条件（spec 2.3-06）。
    const matched = filterJobs(
      url.searchParams.get('query') ?? '',
      url.searchParams.get('city') ?? '',
      url.searchParams.get('experience') ?? '',
    );
    const rawPage = Number(url.searchParams.get('page') ?? '1');
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    const start = (page - 1) * JOBS_PER_PAGE;
    const items = matched.slice(start, start + JOBS_PER_PAGE).map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      salary: job.salary,
      city: job.city,
      experience: job.experience,
      education: job.education,
      detailUrl: `/boss/detail?jobId=${job.id}`,
    }));
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        page,
        pageSize: JOBS_PER_PAGE,
        total: matched.length,
        hasMore: start + items.length < matched.length,
        items,
      }),
    );
    return;
  }

  if (url.pathname === '/boss') {
    // 风控靶页（spec 2.7-01）：抓取的第一次导航就落在这里，所以两种拦下形态都能在工作流运行中被撞见。
    if (riskMode === 'blocked') {
      console.log('[fixture] 风控靶页：403 访问受限');
      sendHtml(response, RISK_BLOCKED_HTML, 403);
      return;
    }
    if (riskMode === 'captcha') {
      console.log('[fixture] 风控靶页：200 安全验证');
      sendHtml(response, RISK_CAPTCHA_HTML);
      return;
    }
    sendHtml(
      response,
      readFileSync(bossSearchPage, 'utf8')
        .replaceAll('{{loggedIn}}', loggedIn ? 'true' : 'false')
        .replaceAll('{{authLabel}}', loggedIn ? '已登录' : '未登录'),
    );
    return;
  }

  if (url.pathname === '/boss/detail') {
    // 详情页按 `jobId` 现渲（2.3-02 要求逐条读详情）：一条岗位一个地址，抓取跳一次读一次。
    const jobId = url.searchParams.get('jobId') ?? '';
    const job = fixtureJobs.find((item) => item.id === jobId);
    const authLabel = loggedIn ? '已登录' : '未登录';
    if (!job) {
      // 「岗位不存在」也要回一份能渲染的页面（不是 404 空文档）：界面上要看得出是站点说没有，
      // 而不是我们的服务挂了；抓取侧看到的是「详情页没有读到任何容器」这条结构化失败。
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderDetailPage(undefined, loggedIn, authLabel));
      return;
    }
    sendHtml(response, renderDetailPage(job, loggedIn, authLabel));
    return;
  }

  if (url.pathname === '/locator') {
    // 改版前后两份 DOM 由页面自己按 ?variant= 渲染，服务端不分支：
    // 自愈比对的输入必须来自同一份静态文件，否则「结构没变」这句话就成了服务端保证的。
    sendHtml(response, readFileSync(locatorPage, 'utf8'));
    return;
  }

  if (url.pathname === '/chat') {
    sendHtml(response, readFileSync(chatPage, 'utf8'));
    return;
  }

  if (url.pathname === '/chat/frame') {
    sendHtml(response, chatFramePageHtml);
    return;
  }

  if (url.pathname === '/newtab') {
    sendHtml(response, readFileSync(newtabPage, 'utf8'));
    return;
  }

  if (url.pathname === '/newtab/target') {
    sendHtml(response, newtabTargetPageHtml);
    return;
  }

  if (url.pathname === '/trusted') {
    sendHtml(response, readFileSync(trustPage, 'utf8'));
    return;
  }

  if (url.pathname === '/pii') {
    // 脱敏靶页：裸值 + 一组必须原样留下的对照数字，遮罩与正文脱敏都拿这一页判「盖住了什么、没盖住什么」。
    sendHtml(response, PII_PAGE_HTML);
    return;
  }

  if (url.pathname === '/deliver') {
    // 开局状态行由服务端按 `targetId` 现填：页面上那句「已下架」是站点说的，不是 app 能猜的（spec 2.6-07）。
    const initialStatus = offlineJobIds.has(url.searchParams.get('targetId') ?? '')
      ? '该岗位已下架，简历不会送达'
      : '等待投递';
    sendHtml(response, deliverPageHtml.replaceAll('{{initialStatus}}', initialStatus));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
}

/** `createServer` 的回调只能同步返回，异步的处理函数交给 `void` 转交。 */
const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(port, host, () => {
  // 路由清单打在启动日志里：验收脚本按这份列表逐条 curl，不用回头翻代码。
  console.log(
    `[fixture] 实验台已启动：http://${host}:${String(port)}/ · /alt · /boss · /locator · /chat · /newtab · /trusted · /deliver · /api/fail-counter · /api/risk-mode · /api/generate-mode · /v1/chat/completions · /api/deliveries（cookie ${cookieName}）`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
