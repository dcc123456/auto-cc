/**
 * 「整屏编辑」那一下跳出的两步串联（裁定㊵ / spec 3.16-01）。
 *
 * 为什么要单独一个模块：这一步跨**两座**桥（先出 PDF，再把产物交出去），
 * 而 `useBridgeAction.run` 的壳只包一次调用。把串联写进组件里，负对照
 * （"导出失败还照样跳"）就没有能打进假桥的地方——那一格是这一条判据的全部风险所在。
 *
 * 顺序不可反：交出去的路径只能是**这一趟**回执里的那一份产物。
 * 若先跳再导，伴生应用打开的是上一份产物，而界面回一句"已交给 Office-cc"，那是假话。
 */
import type { BridgeReply, ExportReceiptView, ResumeLocaleView } from '@auto-cc/shared';

/** 跳出成功后给界面那句话用的回执：伴生应用拿到的是哪份文件、它有几页、多大。 */
export interface CompanionHandoffReceipt {
  /** 交给伴生应用的那份产物绝对路径（主进程 `userData/exports` 轨里的回执路径）。 */
  openedPath: string;
  /** 这一趟产物的页数（人要在界面上确认交出去的是刚出的那一份）。 */
  pages: number;
  /** 这一趟产物的字节数。 */
  bytes: number;
}

/** 这一步要问的两座桥；真实调用点接 `window.autoCC`，单测把假桥塞进来。 */
export interface CompanionHandoffBridge {
  /** 出 PDF（主进程离屏打印 → 落 `userData/exports` → 回产物回执）。 */
  toPdf: (docId: string, templateId: string, locale: ResumeLocaleView) => Promise<BridgeReply<ExportReceiptView>>;
  /** 把一份已存在的绝对路径交给伴生应用（裁定㊴ 那一条通道）。 */
  open: (filePath: string) => Promise<BridgeReply<{ openedPath: string }>>;
}

/**
 * 先出 PDF，成功才把那份产物交给伴生应用。
 * @param bridge 两座桥的把手（见 `CompanionHandoffBridge`）
 * @param docId 当前简历文档 id；空串由主进程拒，本模块不自己判（§2.6 只在系统边界校验）
 * @param templateId 出纸用的样式（desk 从 `export.preference` 读来的那一份，本模块不另存一份事实）
 * @param locale 出纸语言
 * @returns 成功时是伴生应用那趟的回执合并产物读数；任一趟失败就把**那一趟**的结构化错误原样带回，
 *          且导出失败时第二跳根本不会发起
 */
export async function handOffDocumentToCompanion(
  bridge: CompanionHandoffBridge,
  docId: string,
  templateId: string,
  locale: ResumeLocaleView,
): Promise<BridgeReply<CompanionHandoffReceipt>> {
  const exported = await bridge.toPdf(docId, templateId, locale);
  if (!exported.ok) return exported;
  const opened = await bridge.open(exported.value.path);
  if (!opened.ok) return opened;
  return {
    ok: true,
    value: { openedPath: opened.value.openedPath, pages: exported.value.pages, bytes: exported.value.bytes },
  };
}
