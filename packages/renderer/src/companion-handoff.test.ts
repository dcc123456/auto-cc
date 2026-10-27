/**
 * 「整屏编辑」那两步串联的单测（spec 3.16-01）。
 * 判据的重心在负对照：导出失败时第二跳**一次都不许发**——那是把上一份产物冒充这一份。
 */
import { describe, expect, it } from 'vitest';
import type { AppErrorPayload, BridgeReply, ExportReceiptView } from '@auto-cc/shared';
import { handOffDocumentToCompanion, type CompanionHandoffBridge } from './companion-handoff';

/** 主进程出纸成功时那一份回执的够用形状（hash 与 snapshotId 这一趟判据不读，给个值让类型闭得上）。 */
function exportOk(path: string): BridgeReply<ExportReceiptView> {
  return { ok: true, value: { docId: 'resume-1', path, pages: 2, bytes: 4096, hash: 'h1', snapshotId: 'snap-1' } };
}

/** 一座假桥：记下每一趟的实参，返回值按调用者给好的脚本走。 */
function fakeBridge(reply: { toPdf: BridgeReply<ExportReceiptView>; open: BridgeReply<{ openedPath: string }> }) {
  const toPdfCalls: [string, string, string][] = [];
  const openCalls: string[] = [];
  const bridge: CompanionHandoffBridge = {
    toPdf: (docId, templateId, locale) => {
      toPdfCalls.push([docId, templateId, locale]);
      return Promise.resolve(reply.toPdf);
    },
    open: (filePath) => {
      openCalls.push(filePath);
      return Promise.resolve(reply.open);
    },
  };
  return { bridge, toPdfCalls, openCalls };
}

const EXPORT_ERROR: AppErrorPayload = { code: 'UNKNOWN', message: '内核打印失败', path: 'resume.export.toPdf' };
const COMPANION_ERROR: AppErrorPayload = {
  code: 'COMPANION_EDITOR_MISSING',
  message: '本机找不到伴生应用的命令行：officecc',
  path: 'shell.openInCompanionEditor',
};

describe('handOffDocumentToCompanion：先出 PDF，成功才交出去（裁定㊵）', () => {
  it('两趟都成：第二跳收到的必须是这一趟回执里的那个路径，回执合并页数与字节', async () => {
    const { bridge, toPdfCalls, openCalls } = fakeBridge({
      toPdf: exportOk('/Users/me/Library/Application Support/auto-cc/exports/resume-1.pdf'),
      open: { ok: true, value: { openedPath: '/Users/me/Library/Application Support/auto-cc/exports/resume-1.pdf' } },
    });
    const reply = await handOffDocumentToCompanion(bridge, 'resume-1', 'modern', 'zh-CN');
    expect(toPdfCalls).toEqual([['resume-1', 'modern', 'zh-CN']]);
    expect(openCalls).toEqual(['/Users/me/Library/Application Support/auto-cc/exports/resume-1.pdf']);
    expect(reply).toEqual({
      ok: true,
      value: {
        openedPath: '/Users/me/Library/Application Support/auto-cc/exports/resume-1.pdf',
        pages: 2,
        bytes: 4096,
      },
    });
  });

  it('负对照：导出失败时第二跳一次都不发，错误原样带回（不许拿上一份产物冒充）', async () => {
    const { bridge, openCalls } = fakeBridge({
      toPdf: { ok: false, error: EXPORT_ERROR },
      open: { ok: true, value: { openedPath: '' } },
    });
    const reply = await handOffDocumentToCompanion(bridge, 'resume-1', 'classic', 'zh-CN');
    expect(openCalls).toEqual([]);
    expect(reply).toEqual({ ok: false, error: EXPORT_ERROR });
  });

  it('伴生应用那趟失败（本机没装 / 它按自己的 reason 拒了）：错误是它那一句，不是导出的那一句', async () => {
    const { bridge, toPdfCalls } = fakeBridge({
      toPdf: exportOk('/tmp/out.pdf'),
      open: { ok: false, error: COMPANION_ERROR },
    });
    const reply = await handOffDocumentToCompanion(bridge, 'resume-1', 'classic', 'en');
    expect(toPdfCalls).toHaveLength(1);
    expect(reply).toEqual({ ok: false, error: COMPANION_ERROR });
  });
});
