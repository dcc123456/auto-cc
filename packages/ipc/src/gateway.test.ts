import { AppError, type AppErrorPayload } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { Gateway, type GatewayDeps } from './gateway.js';

/** 假服务表：只登记白名单里有的那几个名字，与真实网关读到的是同一份名单。 */
const services: Record<string, Record<string, unknown>> = {
  log: {
    tail: (limit?: number) => [`line-${String(limit ?? 'all')}`],
    status: () => ({ file: undefined, level: 'info' }),
  },
  kernel: {
    tree: () => {
      throw new Error('boom in kernel');
    },
  },
  shell: {
    getStatus: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { appVersion: '0.1.0' };
    },
    setKernelViewVisible: (visible: boolean) => ({ kernelViewVisible: visible }),
  },
};

const deps = (extra: Partial<GatewayDeps> = {}): GatewayDeps => ({
  lookup: (name) => services[name],
  ...extra,
});

/** 失败回复里的错误载荷（测试里就是要读它，所以断言一次收窄）。 */
const errorOf = (reply: Awaited<ReturnType<Gateway['invoke']>>): AppErrorPayload => {
  if (reply.ok) throw new Error('expected a rejected reply');
  return reply.error;
};

describe('IPC 网关（spec 1.4-04 / 1.4-05 / 1.4-06 / 1.4-07）', () => {
  it('白名单内的调用正常返回，参数按数组逐个透传', async () => {
    const gateway = new Gateway(deps());
    expect(await gateway.invoke({ path: 'log.tail', args: [3] })).toEqual({ ok: true, value: ['line-3'] });
    expect(await gateway.invoke({ path: 'shell.setKernelViewVisible', args: [false] })).toEqual({
      ok: true,
      value: { kernelViewVisible: false },
    });
  });

  it('白名单外一律拒绝，并给出 NOT_IN_ALLOWLIST 与 path', async () => {
    const denied: string[] = [];
    const gateway = new Gateway(deps({ onDenied: (path) => denied.push(path) }));
    const reply = await gateway.invoke({ path: 'shell.readFile', args: [] });
    expect(reply.ok).toBe(false);
    expect(errorOf(reply)).toMatchObject({ code: 'NOT_IN_ALLOWLIST', path: 'shell.readFile' });
    // 拒绝要有旁路记录，否则主进程日志里看不出有人在试探边界。
    expect(denied).toEqual(['shell.readFile']);
  });

  it('载荷被渲染层写成非法形状时不炸进程', async () => {
    const gateway = new Gateway(deps());
    // 缺 path：按未登记处理，而不是 undefined 拼进错误里。
    expect(errorOf(await gateway.invoke({ args: [] } as unknown as { path: string; args: unknown[] })).code).toBe(
      'NOT_IN_ALLOWLIST',
    );
    // 缺 args：当成空参数数组，让方法自己的默认值生效。
    expect(await gateway.invoke({ path: 'log.tail' } as unknown as { path: string; args: unknown[] })).toEqual({
      ok: true,
      value: ['line-all'],
    });
  });

  it('服务未挂载给出 SERVICE_NOT_FOUND，方法抛错保留原始 message', async () => {
    const gateway = new Gateway(deps());
    expect(errorOf(await gateway.invoke({ path: 'kernel.tree', args: [] }))).toMatchObject({
      code: 'UNKNOWN',
      message: 'boom in kernel',
      path: 'kernel.tree',
    });
    const empty = new Gateway({ lookup: () => undefined });
    expect(errorOf(await empty.invoke({ path: 'log.tail', args: [] })).code).toBe('SERVICE_NOT_FOUND');
  });

  it('返回值不可序列化时点名 NOT_SERIALIZABLE，而不是静默丢字段', async () => {
    // 不改动共享假表：这条要给 `log.tail` 换一个返回函数的实现。
    const gateway = new Gateway({ lookup: (name) => (name === 'log' ? { tail: () => ({ fn: () => 0 }) } : undefined) });
    expect(errorOf(await gateway.invoke({ path: 'log.tail', args: [] }))).toMatchObject({
      code: 'NOT_SERIALIZABLE',
      path: 'log.tail',
    });
  });

  it('并发调用各回各值，在途计数在全部落定后归零（不会串号）', async () => {
    let peak = 0;
    // 峰值必须在**服务方法内**采样：调用方的 `.then` 排队时前面的请求已经计数归位了。
    const sample = () => {
      peak = Math.max(peak, gateway.stats.inFlight);
    };
    const concurrent: Record<string, Record<string, unknown>> = {
      shell: {
        getStatus: async () => {
          sample();
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { appVersion: '0.1.0' };
        },
        setKernelViewVisible: (visible: boolean) => {
          sample();
          return { kernelViewVisible: visible };
        },
      },
      log: {
        tail: (limit?: number) => {
          sample();
          return [`line-${String(limit ?? 'all')}`];
        },
      },
    };
    const gateway = new Gateway({ lookup: (name) => concurrent[name] });
    const [slow, fast, toggled] = await Promise.all([
      gateway.invoke({ path: 'shell.getStatus', args: [] }),
      gateway.invoke({ path: 'log.tail', args: [7] }),
      gateway.invoke({ path: 'shell.setKernelViewVisible', args: [true] }),
    ]);
    // 慢的那个还在途时，快的两个已经完成——这正是要排除的「共享当前请求」类错乱。
    expect(slow).toEqual({ ok: true, value: { appVersion: '0.1.0' } });
    expect(fast).toEqual({ ok: true, value: ['line-7'] });
    expect(toggled).toEqual({ ok: true, value: { kernelViewVisible: true } });
    expect(peak).toBe(3);
    expect(gateway.stats).toEqual({ inFlight: 0, completed: 3, denied: 0 });
  });

  it('拒绝计数只统计白名单外的调用（spec 1.6-12 的口径）', async () => {
    const counting = new Gateway({
      lookup: (name) => {
        if (name === 'shell') return { getStatus: () => ({}) };
        if (name === 'kernel')
          return {
            // 白名单内、服务也在，只是方法自己抛错：那是业务失败，不是「越权被拒」。
            tree: () => {
              throw new Error('boom in kernel');
            },
          };
        return undefined;
      },
    });
    await counting.invoke({ path: 'shell.getStatus', args: [] });
    await counting.invoke({ path: 'kernel.tree', args: [] });
    // 服务在、方法不在：`METHOD_NOT_FOUND` 同样是白名单内的调用，不计入拒绝。
    await counting.invoke({ path: 'shell.probeRedact', args: [] });
    await counting.invoke({ path: 'shell.readFile', args: [] });
    expect(counting.stats).toEqual({ inFlight: 0, completed: 4, denied: 1 });
  });

  it('嵌套调用不会把同一次越权数两遍（面板的拒绝数要能对上操作次数）', async () => {
    // 场景取自真实装配：`ipc.probeReject` 在白名单内，它内部再走一次网关去调白名单外的 path，
    // 并把网关的 NOT_IN_ALLOWLIST 原样抛出来。外层若只看错误码再数一次，界面上就是「点一下 +2」。
    const inner = new Gateway({ lookup: (name) => (name === 'shell' ? { getStatus: () => ({}) } : undefined) });
    const outer = new Gateway({
      lookup: (name) =>
        name === 'ipc'
          ? {
              probeReject: (path: string) =>
                inner.invoke({ path, args: [] }).then((reply) => {
                  if (reply.ok) return reply.value;
                  throw new AppError(reply.error.code, reply.error.message, reply.error.path);
                }),
            }
          : undefined,
    });
    const reply = await outer.invoke({ path: 'ipc.probeReject', args: ['shell.readFile'] });
    expect(reply.ok).toBe(false);
    expect(inner.stats.denied).toBe(1);
    // 外层这次调用本身登记过，它只是转述内部的拒绝，不该再算一次越权。
    expect(outer.stats).toEqual({ inFlight: 0, completed: 1, denied: 0 });
  });
});
