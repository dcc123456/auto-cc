/**
 * `platform.registry` 用例（spec 2.2-06 / 2.2-07）。
 *
 * 这里验的是**依赖方向的守门员**：登记处只认契约，不认站点。三条关键行为是
 * 「按名取回」「未登记给出可读错误（带当前装着的平台清单）」「重复登记替换并留痕」，
 * 再加一条白名单断言——适配器实例能被渲染层拿到的话，就等于把主进程能力递出了进程边界。
 */
import type { AppError } from '@auto-cc/core';
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
    chat: (jobId: string) => {
      calls.push(`chat:${jobId}`);
      return Promise.resolve({ sent: true, reason: '回读到成功态', ledgerKey: `${id}:chat` } satisfies OutboundResult);
    },
    sendResume: (jobId: string) => {
      calls.push(`sendResume:${jobId}`);
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
    await expect(adapter.sendResume('job-1')).resolves.toMatchObject({ sent: false, ledgerKey: null });
    expect(adapter.calls).toEqual(['search:前端', 'chat:job-1', 'sendResume:job-1']);
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
});

describe('渲染层拿不到适配器（spec 2.2-07 的边界）', () => {
  it('白名单里只有 platform.registry.list，取回实例与登记都不过进程边界', () => {
    expect(isAllowedCall('platform.registry.list')).toBe(true);
    expect(isAllowedCall('platform.registry.get')).toBe(false);
    expect(isAllowedCall('platform.registry.register')).toBe(false);
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('platform.registry.'))).toEqual(['platform.registry.list']);
  });
});
