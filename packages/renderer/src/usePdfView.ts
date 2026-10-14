/**
 * 「看一份既有 PDF」这一轨的**唯一一份**状态（spec 3.5-12 的查看半边，裁定㊳）。
 *
 * 为什么要从面板里抽出来：2026-10-10 的裁定把画面搬进了右栏那一格（真纸面），控件留在左列，
 * 于是同一份查看会话有**两个消费者**。原先它们同在一个组件里，state 就地长出来；
 * 拆成两格后若各存一份，就是「左边的清单」与「右边的纸」各说各话（AGENTS.md §2.5），
 * 所以 state 上抬到 desk，两边只转述。
 *
 * 2026-10 下旬的裁定㊳把这一轨收窄成**纯查看**：覆盖层草稿、页序、橡皮筋、就地改、另存
 * （那条渲染层调用主进程导出接口的一笔）整条摘除——改字与出纸归整页编辑那一屏，
 * 这一轨只剩 `pdf.io.open` 的量得结果与 `pdf.io.bytes` 送来的整份字节（只交给 pdf.js 解析，不二次加工）。
 * 主进程侧的写口一行未动（那是另一个边界），只是渲染层不再调它——"不再调用"就是终态，不顺手清理。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppErrorPayload, PdfOpenReceiptView } from '@auto-cc/shared';
import type { PdfPaper, PdfPaperPage } from './pdf-page-view';
import { loadPdfPaper } from './pdf-page-view';
import { useBridgeAction } from './useBridgeAction';

/**
 * 真纸面这一格的供料状态（左列与纸面都只转述它，不各自判一次）。
 * - `idle` 还没开文件
 * - `loading` 字节在途，或 pdf.js 正在解析这一页
 * - `ready` 纸上已经是这一页的真图
 * - `failed` 画不出来（字节读不到 / 文件结构损坏），原因摆在那一句读数里
 */
export type PdfPaperState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * 把 pdf.js 抛出的任何东西转成一句可展示的成因。
 * pdf.js 的异常类型很多（结构损坏、加密、渲染被取消），界面只认「说了什么」，不在这里重判它是不是 PDF。
 * @param error 捕获到的异常
 */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/**
 * PDF 查看这一轨的模型。
 * @param active 纸面此刻是否在 PDF 这一档（desk 是唯一判别人）。为 false 时把上一份的 worker 一起收掉——
 *                旧形状里「关掉面板就卸载」的等价物
 * @param onClose 人按「关闭」时的退档动作
 */
export function usePdfView({ active, onClose }: { active: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [filePath, setFilePath] = useState('');
  const [receipt, setReceipt] = useState<PdfOpenReceiptView>();
  const [openError, setOpenError] = useState<AppErrorPayload>();
  const [page, setPage] = useState(1);
  /** 当下这一页的真纸面句柄（画布从它取）。 */
  const [paperPage, setPaperPage] = useState<PdfPaperPage>();
  const [paperState, setPaperState] = useState<PdfPaperState>('idle');
  const [paperError, setPaperError] = useState<string>();

  /** 动作结束后要重读的是**当下**这一页，而闭包里的 state 是起手那一刻的，故页号留一份 ref。 */
  const pageRef = useRef(1);
  /** 真纸面那份文档句柄（一次装载同时供位图与行盒，见 `pdf-page-view.ts`）。 */
  const paperRef = useRef<PdfPaper | null>(null);
  /**
   * 装载的序列号：连开两份文件时，慢的那一趟回来必须整条丢弃
   * （否则上一份的 worker 会把这一份的画布盖掉，而界面上看着是「同一颗纸」）。
   */
  const paperSeqRef = useRef(0);

  /** 真纸面不挂在全屏 `busy` 上：它是一条后台供料那一条，走自己的状态读数（与纸面实时那条 effect 同一取向）。 */
  const loadPaper = useCallback(
    async (target: string) => {
      const seq = paperSeqRef.current + 1;
      paperSeqRef.current = seq;
      setPaperState('loading');
      setPaperError(undefined);
      setPaperPage(undefined);
      const reply = await bridge?.pdf?.['io.bytes'](target);
      if (seq !== paperSeqRef.current) return;
      if (!reply?.ok) {
        setPaperState('failed');
        setPaperError(reply ? reply.error.message : t('action.noBridge'));
        return;
      }
      // pdf.js 会把这块缓冲区转移给 worker，所以 `reply.value` 到此为止，不再拿它做第二次解析。
      let paper: PdfPaper;
      try {
        paper = await loadPdfPaper(reply.value);
      } catch (error) {
        if (seq === paperSeqRef.current) {
          setPaperState('failed');
          setPaperError(reasonOf(error));
        }
        return;
      }
      // 换文件先收掉上一份：一个 worker port 只允许登记一个 PDFWorker，留着旧的就会当场抛错。
      await paperRef.current?.dispose();
      if (seq !== paperSeqRef.current) {
        void paper.dispose();
        return;
      }
      paperRef.current = paper;
      const view = await paper.page(pageRef.current);
      if (seq !== paperSeqRef.current) return;
      setPaperPage(view);
      setPaperState('ready');
    },
    [bridge, t],
  );

  /** 本轨的读数就是那份 paper 状态（由 `loadPaper` 自己写），所以动作收尾无需再发一次桥调用。 */
  const read = useCallback(() => Promise.resolve(), []);
  const { busy, notice, noticeTone, run } = useBridgeAction(read);

  /** 退出这一档即回收：worker 不留在内存里冒充「还能接着看上一份」。 */
  useEffect(() => {
    if (active) return;
    paperSeqRef.current += 1;
    void paperRef.current?.dispose();
    paperRef.current = null;
    setReceipt(undefined);
    setPaperPage(undefined);
    setPaperState('idle');
    setPaperError(undefined);
  }, [active]);

  /**
   * 用给定路径打开一份 PDF（spec 3.5-12 的打开半边，查看版）：路径交给主进程量页数与逐页宽高，
   * 成功后立刻把整份字节取回来交给渲染层的 pdf.js 画纸。换文件即回到第 1 页，不出现「新文件配旧页号」。
   * @param target 人给的绝对路径（来自输入框或系统选文件面板）
   */
  const openPdfWith = (target: string) => {
    pageRef.current = 1;
    setPage(1);
    setOpenError(undefined);
    void run(t('pdfEdit.open'), () => bridge?.pdf?.['io.open'](target), {
      apply: (value) => {
        setReceipt(value);
        void loadPaper(target);
      },
      onError: (error) => {
        setOpenError(error);
        setReceipt(undefined);
      },
      describe: (value) => t('pdfEdit.opened', { count: value.pageCount, hash: value.sourceHash.slice(0, 12) }),
    });
  };

  /** 打开输入框里那条路径（`data-action="pdf-edit-open"` 走的就是这一句）。 */
  const openPdf = () => openPdfWith(filePath.trim());

  /**
   * 请系统弹「打开文件」面板并直接打开选中的那份 PDF（spec 3.5-01 的入口半边）。
   * 渲染层读不了文件系统（§8.1），所以这一步只能由主进程代问；人取消时保持原状（取消不是失败）。
   */
  const pickSourceFile = () =>
    void run(
      t('pdfEdit.pickFile'),
      () =>
        bridge?.shell.selectFile({
          title: t('pdfEdit.pickerTitle'),
          filters: [{ name: t('pdfEdit.pickerFilterPdf'), extensions: ['pdf'] }],
        }),
      {
        apply: (value) => {
          if (value.filePath === null) return;
          setFilePath(value.filePath);
          openPdfWith(value.filePath);
        },
        describe: (value) =>
          value.filePath === null ? t('pdfEdit.pickerCanceled') : t('pdfEdit.pickerPicked', { path: value.filePath }),
      },
    );

  /**
   * 换到某一页：页号先落到 ref 再取那一页的纸，这样紧随其后的翻页用的就是人刚看的那一页。
   * @param pageNumber 目标**源页号**（1 起）
   */
  const showPage = async (pageNumber: number) => {
    pageRef.current = pageNumber;
    setPage(pageNumber);
    const paper = paperRef.current;
    if (!paper) return;
    const seq = paperSeqRef.current;
    const view = await paper.page(pageNumber);
    if (seq !== paperSeqRef.current || pageRef.current !== pageNumber) return;
    setPaperPage(view);
    setPaperState('ready');
  };

  return {
    active,
    onClose,
    filePath,
    setFilePath,
    receipt,
    openError,
    page,
    paperPage,
    paperState,
    paperError,
    busy,
    notice,
    noticeTone,
    openPdf,
    pickSourceFile,
    showPage,
  };
}

/** 这一轨模型的形状（纸面视图与左列控件共用，见 `PdfPaperView.tsx` / `PdfViewPanel.tsx`）。 */
export type PdfViewModel = ReturnType<typeof usePdfView>;
