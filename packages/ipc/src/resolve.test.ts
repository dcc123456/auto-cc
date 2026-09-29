import { describe, expect, it } from 'vitest';
import { pathCandidates, pickMethod, resolveCall } from './resolve.js';

/** 一个方法齐备的假服务，用来验证解析结果确实绑到了实例上。 */
class FakeService {
  calls: string[] = [];
  greet(label: string): string {
    this.calls.push(label);
    return `greet:${label}`;
  }
  readonly version = '1.0.0';
}

const table =
  (services: Record<string, object>) =>
  (name: string): object | undefined =>
    services[name];

describe('path 解析（spec 1.4-01）', () => {
  it('服务名本身可以带点，必须按最长前缀切而不是第一个点', () => {
    // `store.db.prepare` 若切成 service `store` + method `db.prepare`，
    // 就会把「服务找到了、方法找到了」误报成方法缺失。
    const candidates = pathCandidates('store.db.prepare');
    expect(candidates[0]).toEqual({ service: 'store.db', method: 'prepare' });
    expect(candidates).toContainEqual({ service: 'store', method: 'db.prepare' });
  });

  it('段数不足或含空段时不产生候选', () => {
    expect(pathCandidates('nodots')).toEqual([]);
    expect(pathCandidates('a..b')).toEqual([]);
    expect(pathCandidates('')).toEqual([]);
  });

  it('只接受可调用的成员，属性值不算能力', () => {
    const service = new FakeService();
    expect(pickMethod(service, 'greet')).toBeTypeOf('function');
    expect(pickMethod(service, 'version')).toBeUndefined();
    // 带点的方法名一定不是单个成员，直接拒掉，避免顺着对象链摸到别处。
    expect(pickMethod(service, 'db.prepare')).toBeUndefined();
  });

  it('解析出的方法绑定在原实例上调用', () => {
    const service = new FakeService();
    const target = resolveCall('fake.greet', table({ fake: service }));
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.invoke('hi')).toBe('greet:hi');
    expect(service.calls).toEqual(['hi']);
  });

  it('服务未挂载与方法不存在分开报错', () => {
    const missingService = resolveCall('kernel.tree', table({}));
    expect(missingService.ok).toBe(false);
    if (missingService.ok) return;
    expect(missingService.code).toBe('SERVICE_NOT_FOUND');

    const missingMethod = resolveCall('kernel.noSuchMethod', table({ kernel: new FakeService() }));
    expect(missingMethod.ok).toBe(false);
    if (missingMethod.ok) return;
    expect(missingMethod.code).toBe('METHOD_NOT_FOUND');
  });

  it('两层服务名要能被找到（先长后短的回溯）', () => {
    const target = resolveCall('store.db.greet', table({ 'store.db': new FakeService() }));
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.service).toBe('store.db');
    expect(target.method).toBe('greet');
  });
});
