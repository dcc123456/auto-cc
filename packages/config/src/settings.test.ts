/**
 * 密钥库与设置持久层（spec 7.1-01 ~ 7.1-06）。
 *
 * 分两半：`SecretStore` / `SettingsStore` 用临时目录直接验落盘形态（0600、密文、掩码、坏文件保留），
 * `ConfigService` 那半边验「装载 → 写入 → 重新装载」这条重启存活的路。
 * 加密分支用**假加密器**（base64 包装，够证明"文件里不是明文"这一条结构事实），
 * 真 `safeStorage` 的可用性由 spike 与活体验收取证（plan §3.1），不在单测里赌平台。
 */
import { asApp, Context } from '@auto-cc/core';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigService } from './index.js';
import { SettingsStore } from './persist.js';
import { SecretStore, maskSecret, plainCipher, resolveCipher, type Cipher } from './secret.js';

/** 假加密器：整段做 base64 包装——够证明"落盘的不是明文"，同时可逆。 */
const fakeCipher: Cipher = {
  encrypted: true,
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toString('base64'), 'utf8'),
  decrypt: (blob) => Buffer.from(blob.toString('utf8'), 'base64').toString('utf8'),
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-cc-p7-'));
}

describe('SecretStore 密钥库', () => {
  it('写入后文件模式是 0600，且文件里 grep 不到明文（spec 7.1-01 / 7.1-02）', () => {
    const dir = tempDir();
    const store = new SecretStore(dir, fakeCipher);
    store.set('llm.chat', 'sk-probe-abcdef12345');
    const file = store.filePath();
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-probe-abcdef12345');
    expect(new SecretStore(dir, fakeCipher).load().records[0]?.tail).toBe('2345');
  });

  it('恒等端口下如实报 encrypted:false，并且仍然只有一份文件（spec 7.1-03）', () => {
    const dir = tempDir();
    const store = new SecretStore(dir, plainCipher);
    store.set('llm.embed', 'sf-key-9');
    expect(store.isEncrypted).toBe(false);
    expect(readFileSync(store.filePath(), 'utf8')).toContain('sf-key-9');
  });

  it('解不开时报 unreadable、保留原文件、不把已存的其它键当成空（spec 7.1-04）', () => {
    const dir = tempDir();
    new SecretStore(dir, fakeCipher).set('llm.chat', 'sk-a-1111');
    const broken = new SecretStore(dir, plainCipher);
    const loaded = broken.load();
    expect(loaded.unreadable).toBe(true);
    expect(broken.get('llm.chat')).toBe('');
    // 原文件必须还在且完好：静默清空等于把用户唯一的凭证抹掉。
    expect(Buffer.from(readFileSync(broken.filePath(), 'utf8'), 'base64').toString('utf8')).toContain('sk-a-1111');
  });

  it('清除是幂等的，掩码只交末 4 位', () => {
    const dir = tempDir();
    const store = new SecretStore(dir, fakeCipher);
    store.set('llm.chat', 'sk-xyz');
    store.clear('llm.chat');
    expect(() => store.clear('llm.chat')).not.toThrow();
    expect(store.list()).toEqual([]);
    expect(maskSecret('sk-abcdefgh')).toBe('efgh');
  });

  it('非 Electron 运行时（纯 Node）探测回恒等端口，不抛（plan §3.1 实测）', async () => {
    const cipher = await resolveCipher();
    expect(cipher.encrypted).toBe(false);
  });
});

describe('SettingsStore 与持久层', () => {
  it('写入 → 重新装载 → 值还在（spec 7.1-05 的半边）', () => {
    const dir = tempDir();
    new SettingsStore(dir).write('llm', { baseUrl: 'https://gw.example/v1', model: 'gw-chat' });
    const reloaded = new SettingsStore(dir).load();
    expect(reloaded.llm).toEqual({ baseUrl: 'https://gw.example/v1', model: 'gw-chat' });
    expect((statSync(join(dir, 'settings.json')).mode & 0o777).toString(8)).toBe('600');
  });

  it('同插件的后续写是深合并，不顶掉没提到的键', () => {
    const dir = tempDir();
    const store = new SettingsStore(dir);
    store.write('llm', { baseUrl: 'https://a/v1', model: 'm1' });
    store.write('llm', { model: 'm2' });
    expect(store.get('llm')).toEqual({ baseUrl: 'https://a/v1', model: 'm2' });
  });

  it('坏文件不挡装载，读成空表', () => {
    const dir = tempDir();
    new SettingsStore(dir).load();
    expect(new SettingsStore(dir).get('llm')).toEqual({});
  });
});

async function mounted(dir: string): Promise<ConfigService> {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir, logDir: join(dir, 'logs') } });
  return asApp(ctx).config;
}

const Schema = z.strictObject({
  baseUrl: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
});

describe('config 服务：持久层与白名单', () => {
  it('持久层排在 file 之上、env 之下，并在来源追溯里可见（spec 7.1-05）', async () => {
    const dir = tempDir();
    const config = await mounted(dir);
    config.setFile('llm', { baseUrl: 'https://file.example/v1', model: 'file-model' });
    config.setPersisted('llm', { model: 'saved-model' }, ['baseUrl', 'model']);
    (config as unknown as { env: Record<string, string | undefined> }).env = { AUTO_CC_MODEL: 'env-model' };

    const trace = config.trace('llm', { schema: Schema, envMap: { model: 'AUTO_CC_MODEL' } });
    expect(trace.layers.map((layer) => layer.scope)).toEqual(['default', 'file', 'persisted', 'env', 'runtime']);
    // env 仍然盖过持久层（QA/CI 的覆盖口子不许被存下来的值焊死，plan §3.2）；
    // 持久层盖过文件层。
    expect(trace.value).toEqual({ baseUrl: 'https://file.example/v1', model: 'env-model' });
  });

  it('白名单外的键与嵌套对象都拒绝写盘（spec 7.1-08 的闸门）', async () => {
    const config = await mounted(tempDir());
    expect(() => config.setPersisted('llm', { timeoutMs: 1 }, ['baseUrl', 'model'])).toThrow(
      /SETTING_NOT_ALLOWED|不允许/,
    );
    expect(() => config.setPersisted('llm', { nested: { a: 1 } }, ['nested'])).toThrow(/不允许/);
  });

  it('密钥经服务读写：trace 与 settings.json 里都没有明文（spec 7.1-06）', async () => {
    const dir = tempDir();
    const config = await mounted(dir);
    config.setSecret('llm.chat', 'sk-service-probe-777');
    config.setPersisted('llm', { baseUrl: 'https://gw.example/v1', model: 'gw-chat' }, ['baseUrl', 'model']);

    expect(config.getSecret('llm.chat')).toBe('sk-service-probe-777');
    expect(config.listSecrets()).toEqual([
      { path: 'llm.chat', tail: '-777', updatedAt: expect.stringMatching(/^\d{4}-/) },
    ]);
    expect(config.secretStorage().file).toBe(join(dir, 'secrets.bin'));
    expect(JSON.stringify(config.trace('llm', { schema: Schema, envMap: {} }).layers)).not.toContain(
      'sk-service-probe-777',
    );
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('sk-service-probe-777');

    // 空串按「清除」处置：界面上清空输入框再保存不该留下一条空密钥。
    config.setSecret('llm.chat', '');
    expect(config.getSecret('llm.chat')).toBe('');
  });

  it('重新装载后持久层与密钥都还在（spec 7.1-05 的重启半边）', async () => {
    const dir = tempDir();
    const first = await mounted(dir);
    first.setPersisted('llm', { baseUrl: 'https://saved.example/v1', model: 'saved-model' }, ['baseUrl', 'model']);
    first.setSecret('llm.chat', 'sk-restart-4321');

    const second = await mounted(dir);
    expect(second.persisted('llm')).toEqual({
      baseUrl: 'https://saved.example/v1',
      model: 'saved-model',
    });
    expect(second.getSecret('llm.chat')).toBe('sk-restart-4321');
  });
});
