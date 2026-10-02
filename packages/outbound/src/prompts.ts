/**
 * `outbound` 包的话术库与提示词注册表（spec 4.6-09）。
 *
 * 本包内**唯一**允许出现「发给模型的消息字面量」与「回落话术字面量」的文件，
 * 由 `scripts/check-prompts.ts` 机检（判据：别处出现 `role: 'system'` 的消息对象或
 * `*_PROMPT_VERSION` 声明即 lint 失败）。之所以收在一处：
 * 1. **可版本化**——改文案必须同时改版本，复盘时才分得清是哪一版产出的话术（2.5-09）；
 * 2. **可核对**——§8.4 的事实锁定与 §8.5 的脱敏要盯的就是这几句约束写没写住，散在业务文件里就没人逐字读过；
 * 3. **不夹带传输**——这里只拼字符串，一个端点都不碰（模型出口唯一性由 `check-llm-single-entry` 守着）。
 *
 * 4.6-b 起这里是「话术库」而不是一句开场白：三类话术（`greeting` / `follow-up` / `rejection`）
 * 的模型约束与模板文案各占一组常量，共用同一个组装函数——**三类话术的差别只在文案，不在装配逻辑**，
 * 所以这里刻意不做三个平行 builder（§2.2：同一逻辑出现第二次就要抽）。
 * 语气档位（`formal` / `warm` / `brief`）在模型路和模板路上**都有落点**（`TONE_COPY` 的两列分别进
 * system 与模板收尾句），因为 spec 4.6-04 要的是"风格受配置约束"，一个只改提示词的档位等于没约束。
 *
 * 全部文案为本仓库自写的中文表达，未从任何参考项目搬运（browser-copilot 的 LICENSE 是 PolyForm 非商用，
 * 见 plan §4.6 取证一）。话术内容本身不做多语言（plan §4.6「不做的事」）：`en` 只覆盖界面文案与
 * 岗位名/平台名的插值语序，这里产出的始终是发给招聘方的中文消息。
 */
import type { ScriptKind, ScriptRequest, ScriptTone } from './script.js';

/**
 * 话术文案版本（与 spec 2.5-09 的 `scriptVersion` 同一条播报，也是配置项 `scriptVersion` 的默认值）。
 *
 * 为什么把版本放在文案旁边而不是只放配置里：改这几句的人就在本文件里，版本号必须在同一次改动里
 * 看得见；配置侧那一份仍可覆盖（付费档位或 A/B 文案时用），但默认值与文案同源。
 */
export const SCRIPT_PROMPT_VERSION = 'script-v1';

/**
 * 三类话术各自写给模型的角色句（system 的第一句）。
 *
 * 判据是「一句话说清这条消息在对话里处于哪一步」：开场白是第一次接触、追问是已有一轮之后往前推、
 * 拒绝应对是收尾且不再索取。少了这个差别，模型会把追问写成第二条自我介绍。
 */
const KIND_ROLE: Record<ScriptKind, string> = {
  greeting: '你帮中国求职者在招聘软件上写第一条打招呼消息，目标是让招聘方愿意点开简历。',
  'follow-up':
    '你帮中国求职者在招聘软件上写一条追问消息：前面已经有一轮沟通，现在要接着对方说过的话把这事往前推一步，' +
    '不是重发自我介绍。',
  rejection:
    '你帮中国求职者在招聘软件上写一条拒绝应对消息：对方已经婉拒或表示不合适，' +
    '目标是体面收尾、留下以后再联系的可能，不纠缠、不追问原因、不辩解。',
};

/** 三类话术共用的事实与凭据约束（§8.4 事实锁定 + §8.5 个人数据，一条都不许少）。 */
const COMMON_RULES =
  '只依据用户给出的事实，不得编造公司、职位、时间或数字；' +
  '禁止出现手机号、身份证号、验证码、密码等个人凭据；' +
  '必须点明岗位名或公司名，不要留任何占位符（如「XX 公司」）；' +
  '只输出消息正文，不要解释、不要前后缀、不要用 Markdown。';

/**
 * 语气档位的两处落点：给模型的约束句 + 模板的收尾句。
 *
 * 两列必须成对改：只给模型一句「简短点」而模板照旧啰嗦，界面就会在回落时换一种风格说话（4.6-04）。
 */
const TONE_COPY: Record<ScriptTone, { systemHint: string; closing: string }> = {
  formal: {
    systemHint: '语气正式克制，全程用「您」称呼对方，不要堆感叹号。',
    closing: '方便的话希望进一步沟通，谢谢！',
  },
  warm: {
    systemHint: '语气亲和自然，用「您」称呼对方，可以有温度但不要套近乎。',
    closing: '期待有机会和您详细聊聊。',
  },
  brief: {
    systemHint: '语气简短直接，一到两句话说完，省掉客套铺垫。',
    closing: '方便聊聊吗？',
  },
};

/**
 * 证据不足时用的那句中性表述（没有 `kb.search` 结果时话术仍然能成立，但不能假装个性化）。
 *
 * 「假装个性化」的代价由 4.6-06 那条界面标识承担：这里给的是**不声称匹配**的说法。
 * @param request 已校验的生成入参
 * @returns 一句可直接嵌进模板的中文短语（不带句末标点）
 */
function evidencePhrase(request: ScriptRequest): string {
  const first = request.evidence[0]?.fact.trim();
  if (first === undefined || first.length === 0) return '我对这个方向有兴趣';
  // 证据正文可能自带换行与句末标点：模板要是一句话，这里先压平再截。
  const flat = first.replace(/\s+/g, ' ');
  return `我有「${flat.length > 34 ? `${flat.slice(0, 34)}…` : flat}」这段经历`;
}

/**
 * 把对方那句话压成可引用的短引子（追问与拒绝应对都围着它写）。
 * @param text 招聘方的原话（入参侧已限 200 字）
 * @returns 压平空白、超 40 字加省略号的引用串
 */
function counterpartQuote(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/**
 * 拼本地模板话术（spec 4.6-06 的回落路：模型不可用时走这里，界面必须标出「模板」）。
 *
 * 三类各有形状：追问必须引用对方那句话，否则"追问"无从指涉；拒绝应对必须明确"不纠缠"，
 * 否则同一段文案在两种语境下发出去都很失礼。关键词方向只在开场白里出现——追问时对方已经知道你要什么。
 * @param request 已校验过的生成入参（岗位名、公司名必非空；追问/拒绝应对已由服务保证带对方原话）
 * @param tone 语气档位（配置项，决定收尾句）
 * @returns 一条完整中文消息；长度是否超上限由调用方 `assertSendable` 判，这里不做截断
 */
export function renderScriptTemplate(request: ScriptRequest, tone: ScriptTone): string {
  const closing = TONE_COPY[tone].closing;
  const job = `「${request.company}」的「${request.title}」`;
  if (request.kind === 'follow-up') {
    const quote = counterpartQuote(request.recruiterMessage ?? '');
    return `您好，关于${job}，您提到「${quote}」。${evidencePhrase(request)}，想再跟您确认下一步怎么安排比较合适，${closing}`;
  }
  if (request.kind === 'rejection') {
    const quote = counterpartQuote(request.recruiterMessage ?? '');
    return `感谢您直接告知结果，关于${job}我不再多打扰。您说的「${quote}」我记下了，${evidencePhrase(request)}，后续若有合适的岗位欢迎再联系我，${closing}`;
  }
  const direction = request.keywords.length > 0 ? `（方向：${request.keywords.slice(0, 3).join('、')}）` : '';
  return `您好！看到贵司${job}${direction}，${evidencePhrase(request)}，想向您请教岗位的具体要求，${closing}`;
}

/**
 * 组装给模型的两句消息（system 定规矩，user 给事实）。
 *
 * 三类话术**共用这一个函数**：差异全在 `KIND_ROLE` 与 user 里那句"这次要写什么"，
 * 事实清单的组装一份到底（长第二份就是长第二套判据，§2.5）。
 * @param request 生成入参（`kind` 决定角色句与指涉对象）
 * @param maxChars 长度上限（字符），进提示词
 * @param tone 语气档位（配置项，决定风格约束句）
 * @returns 直接可交给 `llm.chat.complete` 的消息数组（两条：system + user）
 */
export function buildScriptMessages(
  request: ScriptRequest,
  maxChars: number,
  tone: ScriptTone,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `${KIND_ROLE[request.kind]}${COMMON_RULES}长度不超过 ${String(maxChars)} 个字。${TONE_COPY[tone].systemHint}`;
  const ask: Record<ScriptKind, string> = {
    greeting: '请针对以下岗位写一条开场白：',
    'follow-up': '请接着对方最后一句话写一条追问（不要重复自我介绍，也不要催促）：',
    rejection: '请针对对方的拒绝写一条收尾消息（体面、不再索取回复、不追问原因）：',
  };
  const facts = [
    `岗位：${request.title}`,
    `公司：${request.company}`,
    request.keywords.length > 0 ? `方向关键词：${request.keywords.join('、')}` : '',
    request.evidence.length > 0 ? `可引用的经历：${request.evidence.map((item) => item.fact).join('；')}` : '',
    request.recruiterMessage === undefined ? '' : `对方最后一条消息：${request.recruiterMessage}`,
  ].filter((line) => line.length > 0);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${ask[request.kind]}\n${facts.join('\n')}` },
  ];
}
