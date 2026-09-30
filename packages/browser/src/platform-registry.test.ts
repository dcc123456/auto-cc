/**
 * `platform.registry` 用例（spec 2.2-06 / 2.2-07 → 2.5-02）。
 *
 * 这里验的是**依赖方向的守门员**：登记处只认契约，不认站点。四条关键行为是
 * 「按名取回」「未登记给出可读错误（带当前装着的平台清单）」「重复登记替换并留痕」
 * 「外发侧现问渠道、答案永远跟着当前活着的那份适配器」，
 * 再加一条白名单断言——适配器实例能被渲染层拿到的话，就等于把主进程能力递出了进程边界。
 */
import type { AppError, ResumeAttachment } from '@auto-cc/core';
import { Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import { RENDERER_ALLOWLIST, isAllowedCall } from '@auto-cc/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  JobDetail,
  JobSearchCriteria,
  JobSummary,
  OutboundResult,
  PlatformAdapter,
  ReplyMessage,
} from './platform-contract.js';
import { PlatformRegistryService } from './platform-registry.js';
import { errorDetails } from './test-doubles.js';

const fibers: Fiber[] = [];

/** 一份假的简历附件：登记处不读它的内容，只把它原样递给适配器。 */
const RESUME: ResumeAttachment = {
  path: '/tmp/resume.pdf',
  fileName: 'resume.pdf',
  sizeBytes: 204800,
  sha256: 'a'.repeat(64),
};

/**
 * 起一个空的登记处。
 * @returns 登记处服务与它的上下文（挂事件/日志时用）
 */
async function boot(): Promise<PlatformRegistryService> {
  const ctx = new Context();
  fibers.push(await ctx.plugin(PlatformRegistryService, NO_CONFIG));
  return ctx.get('platform.registry') as PlatformRegistryService;
}

/**
 * 造一个只做记账的空壳适配器：契约的每个动作各返回固定值，用来验证「契约可被实现」。
 * @param id 平台标识
 * @param overrides 需要改动的自我声明项（displayName / capabilities）
 * @returns 满足 `PlatformAdapter` 的替身，带调用计数
 */
function fakeAdapter(
  id: string,
  overrides: Partial<PlatformAdapter['meta']> = {},
): PlatformAdapter & { calls: string[] } {
  const calls: string[] = [];
  const summary: JobSummary = {
    platform: id,
    jobId: 'job-1',
    title: '资深前端工程师',
    company: '示例公司',
    salaryText: '25-40K·15薪',
    city: '杭州',
    experience: '3-5 年',
    education: '本科',
    detailUrl: 'https://example.com/job/1',
    capturedAt: 1,
  };
  return {
    calls,
    meta: {
      id,
      displayName: `${id} 站`,
      startUrl: 'https://example.com',
      capabilities: ['search', 'detail', 'chat', 'sendResume', 'readReplies'],
      ...overrides,
    },
    // 空壳适配器声明「这条站没有文案判据」：`risk` 是必填项，缺段的语义要靠 null 说，不能靠不写这个键。
    risk: null,
    openSearch: (criteria: JobSearchCriteria) => {
      calls.push(`openSearch:${criteria.keyword}`);
      return Promise.resolve();
    },
    readListing: () => {
      calls.push('readListing');
      return Promise.resolve([summary]);
    },
    search: (criteria: JobSearchCriteria) => {
      calls.push(`search:${criteria.keyword}`);
      return Promise.resolve([summary]);
    },
    detail: (jobId: string) => {
      calls.push(`detail:${jobId}`);
      return Promise.resolve({
        summary,
        description: '负责前端架构',
        requirements: ['五年经验'],
        postedText: '3 天前',
      } satisfies JobDetail);
    },
    chat: (jobId: string, text: string) => {
      // 连要发的文字一起记账：外发侧的投影有没有把 text 原样递到适配器手上，只有这里能看出来。
      calls.push(`chat:${jobId} ${text}`);
      return Promise.resolve({ sent: true, reason: '回读到成功态', ledgerKey: `${id}:chat` } satisfies OutboundResult);
    },
    sendResume: (jobId: string, attachment: ResumeAttachment) => {
      // 附件整份记账：投递渠道的投影只递「这个文件」，编排层给的字节信息有没有原样到适配器手上，只有这里能看出来。
      calls.push(`sendResume:${jobId}:${attachment.fileName}:${String(attachment.sizeBytes)}`);
      return Promise.resolve({
        sent: false,
        reason: '页面出现验证码，已暂停',
        ledgerKey: null,
      } satisfies OutboundResult);
    },
    readReplies: (jobId: string) => {
      calls.push(`readReplies:${jobId}`);
      return Promise.resolve([
        { platform: id, jobId, from: 'recruiter', text: '方便聊聊吗', at: 2, externalId: 'reply-1' },
      ] satisfies ReplyMessage[]);
    },
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('平台登记处（spec 2.2-07）', () => {
  it('刚就绪时是空的，但清单结构仍然可用', async () => {
    const registry = await boot();
    expect(registry.list()).toEqual({ platforms: [] });
  });

  it('登记后按名取回的是同一个适配器实例，五个动作都能调', async () => {
    const registry = await boot();
    const adapter = fakeAdapter('boss');
    registry.register(adapter);

    expect(registry.get('boss')).toBe(adapter);
    await expect(adapter.search({ keyword: '前端' })).resolves.toHaveLength(1);
    await expect(adapter.chat('job-1', '你好')).resolves.toMatchObject({ sent: true, ledgerKey: 'boss:chat' });
    await expect(adapter.sendResume('job-1', RESUME)).resolves.toMatchObject({ sent: false, ledgerKey: null });
    expect(adapter.calls).toEqual(['search:前端', 'chat:job-1 你好', 'sendResume:job-1:resume.pdf:204800']);
  });

  it('只读清单原样回显适配器的自我声明，不含任何定位信息', async () => {
    const registry = await boot();
    registry.register(fakeAdapter('liepin', { displayName: '猎聘', capabilities: ['search'] }));
    registry.register(fakeAdapter('boss', { capabilities: ['search', 'chat'] }));

    expect(registry.list().platforms).toEqual([
      { id: 'liepin', displayName: '猎聘', startUrl: 'https://example.com', capabilities: ['search'] },
      { id: 'boss', displayName: 'boss 站', startUrl: 'https://example.com', capabilities: ['search', 'chat'] },
    ]);
  });

  it('未登记的平台给出可读错误，并把当前装着的平台一起带回', async () => {
    const registry = await boot();
    registry.register(fakeAdapter('boss'));
    try {
      registry.get('lagou');
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('PLATFORM_NOT_REGISTERED');
      expect((error as AppError).message).toContain('lagou');
      expect(errorDetails(error).known).toEqual(['boss']);
    }
  });

  it('热重载同名适配器是替换而不是追加，清单里只留最新那份实现', async () => {
    const registry = await boot();
    registry.register(fakeAdapter('boss', { displayName: 'BOSS 直聘 v1' }));
    registry.register(fakeAdapter('boss', { displayName: 'BOSS 直聘 v2' }));

    const platforms = registry.list().platforms;
    expect(platforms).toHaveLength(1);
    expect(platforms[0]!.displayName).toBe('BOSS 直聘 v2');
  });

  it('打招呼渠道是现问出来的投影：跟着当前活着的适配器，且不把计量凭证漏给外发侧（spec 2.5-02）', async () => {
    const registry = await boot();
    const boss = fakeAdapter('boss');
    registry.register(boss);
    registry.register(fakeAdapter('liepin', { capabilities: ['search'] }));

    // 只有声明了 chat 能力的平台算「现在能打招呼」。
    expect(registry.greetablePlatforms()).toEqual(['boss']);
    const channel = registry.greetChannel('boss');
    expect(channel).not.toBeNull();
    // `ledgerKey` 被有意丢掉：额度凭证由 `entitlement.gate` 落账时生成，适配器那份不算数。
    await expect(channel?.send('job-9', '您好')).resolves.toEqual({ sent: true, reason: '回读到成功态' });
    expect(boss.calls).toEqual(['chat:job-9 您好']);

    // 没 chat 能力 / 不认识的平台上问到 null 而不是抛——缺渠道是外发侧能处置的失败。
    expect(registry.greetChannel('liepin')).toBeNull();
    expect(registry.greetChannel('lagou')).toBeNull();

    // 适配器换人之后，下一次问到的就是新那份：编排层缓存不了旧的。
    const replaced = fakeAdapter('boss', { displayName: 'BOSS 直聘 v2' });
    registry.register(replaced);
    await expect(registry.greetChannel('boss')?.send('job-9', '换人之后的一条')).resolves.toMatchObject({
      sent: true,
    });
    expect(replaced.calls).toEqual(['chat:job-9 换人之后的一条']);
    expect(boss.calls).toHaveLength(1);
  });

  it('投递渠道问的是 sendResume 能力，与打招呼那条是两份清单（spec 2.6-05）', async () => {
    const registry = await boot();
    // 一只有 chat 没有 sendResume，一只有 sendResume 没有 chat：两份清单必须各自独立，
    // 否则「会打招呼但不会递简历」的站点会被编排层当成能投递，然后在页面上找一个不存在的上传控件。
    registry.register(fakeAdapter('liepin', { capabilities: ['search', 'chat'] }));
    const boss = fakeAdapter('boss', { capabilities: ['search', 'sendResume'] });
    registry.register(boss);

    expect(registry.greetablePlatforms()).toEqual(['liepin']);
    expect(registry.deliverablePlatforms()).toEqual(['boss']);

    const channel = registry.deliverChannel('boss');
    expect(channel).not.toBeNull();
    await expect(channel?.send('job-9', RESUME)).resolves.toEqual({
      sent: false,
      reason: '页面出现验证码，已暂停',
    });
    expect(boss.calls).toEqual(['sendResume:job-9:resume.pdf:204800']);

    expect(registry.deliverChannel('liepin')).toBeNull();
    expect(registry.deliverChannel('lagou')).toBeNull();
  });

  it('风控文案判据也是现问的投影：缺段与未登记都回 null，绝不回一个猜出来的正则（spec 2.7-01）', async () => {
    const registry = await boot();
    registry.register(fakeAdapter('liepin'));
    // 用 spread 换掉那一份判据：适配器的 `risk` 是只读声明，测试替身也不该在运行时偷偷改它。
    registry.register({ ...fakeAdapter('boss'), risk: { pattern: '安全验证|访问验证' } });

    expect(registry.riskPatternOf('boss')).toBe('安全验证|访问验证');
    // 空壳适配器（知识包没这段）与不认识的平台上都回 null：观测层据此只按 HTTP 状态判风控。
    expect(registry.riskPatternOf('liepin')).toBeNull();
    expect(registry.riskPatternOf('lagou')).toBeNull();
  });
});

describe('渲染层拿不到适配器（spec 2.2-07 的边界）', () => {
  it('白名单里只有 platform.registry.list，取回实例与登记都不过进程边界', () => {
    expect(isAllowedCall('platform.registry.list')).toBe(true);
    expect(isAllowedCall('platform.registry.get')).toBe(false);
    expect(isAllowedCall('platform.registry.register')).toBe(false);
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('platform.registry.'))).toEqual(['platform.registry.list']);
  });
});
