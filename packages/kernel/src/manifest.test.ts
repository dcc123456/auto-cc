import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifest, selectEnabled, topoSort } from './manifest.js';

const sample = `
plugins:
  - id: config
  - id: logger
    dependsOn: [config]
    config:
      level: debug
  - id: store
    dependsOn: [config, logger]
    enabled: false
`;

describe('cordis.yml 装配清单（spec 1.3-01）', () => {
  it('解析出插件顺序、开关、依赖与配置', () => {
    const entries = parseManifest(sample);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toEqual({ id: 'logger', enabled: true, dependsOn: ['config'], config: { level: 'debug' } });
    expect(entries[2]?.enabled).toBe(false);
  });

  it('拓扑排序把依赖排到前面', () => {
    expect(topoSort(parseManifest(sample)).map((entry) => entry.id)).toEqual(['config', 'logger', 'store']);
  });

  it('注掉的插件不再挂载，但依赖它的会被点名', () => {
    expect(selectEnabled(parseManifest(sample)).map((entry) => entry.id)).toEqual(['config', 'logger']);
    const broken = parseManifest(`
plugins:
  - id: a
    dependsOn: [ghost]
`);
    expect(() => topoSort(broken)).toThrow(ManifestError);
    expect(() => topoSort(broken)).toThrow(/不在清单中：ghost/);
  });

  it('依赖成环在挂载前报错', () => {
    const cyclic = parseManifest(`
plugins:
  - id: a
    dependsOn: [b]
  - id: b
    dependsOn: [a]
`);
    expect(() => topoSort(cyclic)).toThrow(/依赖成环/);
  });

  it('清单字段写错时给出具体路径', () => {
    expect(() => parseManifest('plugins:\n  - enabled: true\n')).toThrow(/plugins\[0\]\.id/);
    expect(() => parseManifest('plugins: []\nother: 1')).not.toThrow();
    expect(() => parseManifest('version: 1')).toThrow(/plugins/);
    expect(() => parseManifest('plugins:\n  - id: a\n    dependsOn: config\n')).toThrow(/dependsOn/);
  });
});
