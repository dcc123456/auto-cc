import { parse as parseYaml } from 'yaml';

/**
 * `cordis.yml` 装配清单解析（spec 1.3-01）。
 *
 * 清单只写**插件 id 与配置**，不写模块路径：主进程是 esbuild 打成单文件的，
 * `import(变量)` 拿不到运行时路径，因此实现由 `plugin-kernel` 的注册表提供，
 * 清单负责「装哪些、以什么顺序、带什么配置」。注掉一行即少装一个插件。
 */

export interface ManifestEntry {
  id: string;
  enabled: boolean;
  dependsOn: string[];
  config: Record<string, unknown>;
}

export class ManifestError extends Error {
  constructor(
    readonly fieldPath: string,
    message: string,
  ) {
    super(`装配清单 ${fieldPath}: ${message}`);
    this.name = 'ManifestError';
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestError(path, '应为对象');
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ManifestError(path, '应为字符串数组');
  }
  return value as string[];
}

export function parseManifest(text: string): ManifestEntry[] {
  const doc = asRecord(parseYaml(text) ?? {}, '(root)');
  if (!Array.isArray(doc['plugins'])) throw new ManifestError('plugins', '应为插件数组');
  return (doc['plugins'] as unknown[]).map((raw, index): ManifestEntry => {
    const path = `plugins[${String(index)}]`;
    const entry = asRecord(raw, path);
    const id = entry['id'];
    if (typeof id !== 'string' || id === '') throw new ManifestError(`${path}.id`, '必填且为字符串');
    const enabled = entry['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new ManifestError(`${path}.enabled`, '应为布尔值');
    }
    const config = entry['config'] === undefined ? {} : asRecord(entry['config'], `${path}.config`);
    return {
      id,
      enabled: enabled ?? true,
      dependsOn: asStringArray(entry['dependsOn'], `${path}.dependsOn`),
      config,
    };
  });
}

/** 拓扑排序（依赖在前）；缺依赖与成环都在挂载前报错，而不是留到运行期死锁。 */
export function topoSort(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const output: ManifestEntry[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (entry: ManifestEntry, chain: string[]): void => {
    if (done.has(entry.id)) return;
    if (visiting.has(entry.id)) {
      throw new ManifestError('dependsOn', `依赖成环：${[...chain, entry.id].join(' -> ')}`);
    }
    visiting.add(entry.id);
    for (const dep of entry.dependsOn) {
      const target = byId.get(dep);
      if (!target) throw new ManifestError(`${entry.id}.dependsOn`, `依赖的插件不在清单中：${dep}`);
      visit(target, [...chain, entry.id]);
    }
    visiting.delete(entry.id);
    done.add(entry.id);
    output.push(entry);
  };

  for (const entry of entries) visit(entry, []);
  return output;
}

/**
 * 先按**全量**清单拓扑，再过滤 `enabled`。
 *
 * 顺序不能反过来：注掉一个被依赖的插件时，如果先过滤就会报「依赖不在清单中」，
 * 而 spec 1.3-09 要的是「依赖它的插件进入 PENDING 而不是装配失败」。
 */
export function selectEnabled(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return topoSort(entries).filter((entry) => entry.enabled);
}
