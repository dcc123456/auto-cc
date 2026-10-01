/**
 * 知识库备份文件的编解码（spec 4.2-08）。
 *
 * 备份格式是**我们自己的一种 JSON**，不是 SQLite 二进制：用户要能在别的机器上用文本编辑器看出
 * 「库里都有什么」，而且换版本时表结构会变、`.db` 文件不会跟着兼容。
 *
 * 两件事在编码时是刻意的，读代码的人不该重新推断一遍：
 * 1. **不写 `normalized_hash`**——它是载荷的派生量，写进文件就等于允许用户改载荷而哈希不变。
 *    导入时用 `payloadHashOf` 重算，库里永远只有一种真相来源。
 * 2. **实体按 `entityId` 升序写出**——同一份库两次导出必须逐字节相同，否则 round-trip 断言
 *    只能比集合而不能比串，「备份不丢信息」这件事就验不出来。
 */
import { AppError } from '@auto-cc/core';
import { z } from 'zod';
import { KB_ENTITY_KINDS } from './entities.js';

/** 当前备份格式的版本号；格式变更时递增并在导入侧拒绝旧号，不假装能兼容。 */
export const KB_BACKUP_SCHEMA_VERSION = 1;

/** 备份里的一条实体（没有 `normalizedHash`，理由见文件头）。 */
const backupEntitySchema = z.strictObject({
  entityId: z.string().min(1),
  kind: z.enum(KB_ENTITY_KINDS),
  parentId: z.string().nullable(),
  sourceDocId: z.string().nullable(),
  payload: z.record(z.string(), z.string()),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/** 备份文件整体形状。 */
export const kbBackupSchema = z.strictObject({
  schemaVersion: z.number().int(),
  exportedAt: z.number().int(),
  entities: z.array(backupEntitySchema),
});

/** 备份文件解码后的形状。 */
export type KbBackupFile = z.output<typeof kbBackupSchema>;

/** 备份文件里的一条实体。 */
export type KbBackupEntry = KbBackupFile['entities'][number];

/**
 * 可被导出的实体：备份字段 + 库里那条的派生哈希。
 *
 * 哈希出现在类型里但**不会出现在文件里**（见文件头第 1 条）——这样 `list()` 的读数可以直接喂进来，
 * 不必在调用方先 map 一遍丢掉字段，也不必为它再造一个视图类型。
 */
export type KbExportableEntity = KbBackupEntry & { readonly normalizedHash: string };

/**
 * 把实体列表编成备份文件内容。
 * @param entities 要导出的实体（派生与手工都要带上，备份的语义是「整个库」而不是「手工那些」）
 * @param exportedAt 导出时间戳（毫秒），由调用方注入以便断言
 * @returns 缩进 2 空格的 JSON 串（人类可读优先于体积——这是给用户看的文件）
 */
export function encodeBackup(entities: readonly KbExportableEntity[], exportedAt: number): string {
  const ordered = [...entities]
    .map(({ normalizedHash: _normalizedHash, ...rest }) => rest)
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  return JSON.stringify({ schemaVersion: KB_BACKUP_SCHEMA_VERSION, exportedAt, entities: ordered }, null, 2);
}

/**
 * 解析并校验备份文件内容。
 * @param text 文件全文
 * @returns 校验通过的备份（`schemaVersion` 已确认为当前版本）
 * @throws `AppError('INVALID_ARGUMENT')` JSON 不合法、字段不合法、版本不认识，或文件内部 `entityId` 重复
 *         （重复必须拒绝：否则导入时后一条静默吃掉前一条，用户以为备份回来了两份）
 */
export function decodeBackup(text: string): KbBackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `备份文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validated = kbBackupSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `备份文件结构不合法：${validated.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
    );
  }
  if (validated.data.schemaVersion !== KB_BACKUP_SCHEMA_VERSION) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `备份格式版本 ${String(validated.data.schemaVersion)} 不被当前版本（${String(KB_BACKUP_SCHEMA_VERSION)}）认识`,
    );
  }
  const seen = new Set<string>();
  for (const entry of validated.data.entities) {
    if (seen.has(entry.entityId)) {
      throw new AppError('INVALID_ARGUMENT', `备份文件里 ${entry.entityId} 出现了两次，不能判定该取哪一条`);
    }
    seen.add(entry.entityId);
  }
  return validated.data;
}
