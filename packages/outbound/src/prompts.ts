/**
 * `outbound` 包的话术库与提示词注册表（spec 4.6-09）。
 *
 * 本包内**唯一**允许出现「发给模型的消息字面量」与「回落话术字面量」的文件，
 * 由 `scripts/check-prompts.ts` 机检（判据：别处出现 `role: 'system'` 的消息对象或
 * `*_PROMPT_VERSION` 声明即 lint 失败）。之所以收在一处：
 * 1. **可版本化**——改文案必须同时改版本，复盘时才分得清哪一版产出的话术（2.5-09）；
 * 2. **可核对**——§8.4 的事实锁定与 §8.5 的脱敏要盯的就是这几句约束写没写住，散在业务文件里就没人逐字读过；
 * 3. **不夹带传输**——这里只拼字符串，一个端点都不碰（模型出口唯一性由 `check-llm-single-entry` 守着）。
 *
 * 全部文案为本仓库自写的中文表达，未从任何参考项目搬运（browser-copilot 的 LICENSE 是 PolyForm 非商用，
 * 见 plan §4.6 取证一）。
 */
import type { ScriptRequest } from './script.js';

/**
 * 拼本地模板开场白（spec 4.6-06 的回落路：模型不可用时走这里，且界面必须标出「模板」）。
 * @param request 已校验过的生成入参（岗位名、公司名必非空）
 * @returns 含岗位名与公司名的中文开场白；无关键词时省略方向那一小句
 */
export function renderGreetingTemplate(request: ScriptRequest): string {
  const direction = request.keywords.length > 0 ? `（方向：${request.keywords.slice(0, 3).join('、')}）` : '';
  const evidence = request.evidence.length > 0 ? '我的经历与岗位要求比较匹配，' : '我对这个方向有兴趣，';
  return `您好！看到贵司「${request.company}」在招「${request.title}」${direction}，${evidence}想向您请教岗位的具体要求，方便的话希望进一步沟通，谢谢！`;
}

/**
 * 组装给模型的两句消息（system 定规矩，user 给事实）。
 * @param request 生成入参
 * @param maxChars 长度上限（字符），进提示词
 * @returns 直接可交给 `llm.chat.complete` 的消息数组
 */
export function buildGreetingMessages(
  request: ScriptRequest,
  maxChars: number,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system =
    '你帮中国求职者在招聘软件上写第一条打招呼消息。只依据用户给出的事实，不得编造公司、职位、时间或数字；' +
    `语气礼貌克制，不超过 ${String(maxChars)} 个字，必须点明岗位名或公司名，不要留任何占位符。` +
    '禁止出现手机号、身份证号、验证码、密码等个人凭据。只输出消息正文。';
  const facts = [
    `岗位：${request.title}`,
    `公司：${request.company}`,
    request.keywords.length > 0 ? `方向关键词：${request.keywords.join('、')}` : '',
    request.evidence.length > 0 ? `可引用的经历：${request.evidence.map((item) => item.fact).join('；')}` : '',
  ].filter((line) => line.length > 0);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请针对以下岗位写一条开场白：\n${facts.join('\n')}` },
  ];
}
