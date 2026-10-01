import { Ban, Eye, FileDown, FileText, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportReceiptView, ResumeLocaleView, ResumeSeedView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/** 固定模板 id（3.2 落地的第一套；编辑轨 3.5 之后由用户选模板取代）。 */
const TEMPLATE_ID = 'classic';

/** 故意不存在的文档 id：供「注入失败导出」按钮触发主进程返回 `AppErrorPayload`（spec 3.3-11 的验证入口）。 */
const FAILURE_DOC_ID = 'resume-fail-injected';

/**
 * 简历生成轨自测面板（spec 3.3-01 / 04 / 05 / 09 / 10 的界面化身）：
 * 「载入固定内容 → iframe 预览 → 导出 PDF」三步把「文档 → 同一份打印 HTML → PDF」这条链
 * 摆到界面上，让 harness 能在同一张截图里取到预览与回执证据（AGENTS.md §7.1）。
 *
 * 只转述主进程读数：预览 HTML 与导出用的是**同一份** `resume.export` 产物（3.3-01「预览即导出所见」在界面上的体现），
 * 回执里的页数 / 字节 / 路径全部来自 `toPdf`，界面不自己算（AGENTS.md §2.5）。
 * 编辑轨（3.5）之前没有录入入口，故用 `seedDemo` 喂一份虚构内容做端到端种子（3.3-10）。
 */
export function ResumePanel() {
  const { t } = useTranslation();
  const [seed, setSeed] = useState<ResumeSeedView>();
  const [locale, setLocale] = useState<ResumeLocaleView>('zh-CN');
  const [previewHtml, setPreviewHtml] = useState<string>();
  const [receipt, setReceipt] = useState<ExportReceiptView>();
  const bridge = window.autoCC;

  // 本面板无持久快照要回读，动作后不需要额外刷新主进程状态。
  const read = useCallback(async () => {}, []);
  const { busy, notice, run } = useBridgeAction(read);

  /**
   * 落一份固定内容演示文档，成功后立刻按当前语言渲一次预览（种子与预览一次点到位）。
   */
  const loadDemo = () =>
    void run(t('resume.seed'), () => bridge?.resume['export.seedDemo'](), {
      apply: (value) => {
        setSeed(value);
        setReceipt(undefined);
      },
      describe: (value) => t('resume.seedReceipt', { docId: value.docId }),
    });

  /**
   * 拉取预览 HTML 并塞进 iframe——与导出走的是同一份打印 HTML 源（3.3-01）。
   * @param docId 已落库的文档 id
   */
  const renderPreview = (docId: string) =>
    void run(t('resume.preview'), () => bridge?.resume['export.preview'](docId, TEMPLATE_ID, locale), {
      apply: (html) => setPreviewHtml(html),
      describe: () => t('resume.previewDone'),
    });

  /**
   * 导出 PDF：主进程离屏视图 printToPDF → 落 userData/exports → 回写页数，界面摆回执（3.3-04 / 05 / 09）。
   * @param docId 已落库的文档 id
   */
  const exportPdf = (docId: string) =>
    void run(t('resume.export'), () => bridge?.resume['export.toPdf'](docId, TEMPLATE_ID, locale), {
      apply: (value) => setReceipt(value),
      describe: (value) => t('resume.exportReceipt', { pages: value.pages, bytes: value.bytes }),
    });

  /**
   * 注入一次导出失败（对不存在的文档调 `toPdf`），让主进程的 `AppErrorPayload` 经同一个
   * `run` 外壳显示为可读中文提示——spec 3.3-11「注入失败 → 截图错误态，主进程不崩」的界面入口。
   */
  const injectFailure = () =>
    void run(t('resume.fail'), () => bridge?.resume['export.toPdf'](FAILURE_DOC_ID, TEMPLATE_ID, locale));

  return (
    <section data-testid="resume-panel" className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <FileText size={16} />
          {t('resume.heading')}
        </h2>
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          {t('resume.locale')}
          <select
            data-testid="resume-locale"
            value={locale}
            onChange={(event) => setLocale(event.target.value as ResumeLocaleView)}
            className="rounded-md border border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px] text-slate-200"
          >
            <option value="zh-CN">zh-CN</option>
            <option value="en">en</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-action="seed"
          disabled={!!busy}
          onClick={loadDemo}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          <RefreshCw size={12} />
          {t('resume.seed')}
        </button>
        <button
          type="button"
          data-action="preview"
          disabled={!seed || !!busy}
          onClick={() => seed && renderPreview(seed.docId)}
          className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
        >
          <Eye size={12} />
          {t('resume.preview')}
        </button>
        <button
          type="button"
          data-action="export"
          disabled={!seed || !!busy}
          onClick={() => seed && exportPdf(seed.docId)}
          className="flex items-center gap-1 rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
        >
          <FileDown size={12} />
          {t('resume.export')}
        </button>
        <button
          type="button"
          data-action="fail"
          disabled={!!busy}
          onClick={injectFailure}
          className="flex items-center gap-1 rounded-md border border-rose-800 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950 disabled:opacity-40"
        >
          <Ban size={12} />
          {t('resume.fail')}
        </button>
      </div>

      {notice && (
        <p
          className="mt-2 break-all rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
          data-testid="resume-notice"
        >
          {notice}
        </p>
      )}

      {receipt && (
        <p className="mt-2 break-all text-[11px] text-slate-500" data-testid="resume-receipt-path">
          {receipt.path}
        </p>
      )}

      {previewHtml ? (
        <iframe
          data-testid="resume-preview"
          title={t('resume.heading')}
          sandbox=""
          srcDoc={previewHtml}
          className="mt-3 h-[520px] w-full rounded-md border border-slate-800 bg-white"
        />
      ) : (
        <p className="mt-3 text-[11px] text-slate-500" data-testid="resume-preview-empty">
          {t('resume.previewEmpty')}
        </p>
      )}
    </section>
  );
}
