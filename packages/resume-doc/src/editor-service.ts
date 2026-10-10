/**
 * `resume.editor` 服务（spec 3.6 的契约半边，plan §8.3 的登记落点）。
 *
 * 它存在的唯一理由是一条已有的边界：**简历文档正文不过进程边界**（`bridge.ts` 里 3.3 那段注释立下的口径——
 * 界面只认 docId，看到的永远是打印 HTML 投影）。既然正文不过来，编辑动作就只能发生在主进程这边，
 * 于是"编辑会话"必须有一只服务持有它（与 3.5-c₂ 的 `edit-session` 正好相反：那份 draft 本来就在渲染层）。
 *
 * 三件事刻意**不在**这里做：
 * ① 判据（界内界外、下标越界）全在 `editor-ops.ts` 那一份，本文件只把拒绝项翻成 `AppError`；
 * ② 历史与 dirty 位全在 `editor-session.ts` 那一份，本文件不另记一份"改过没有"；
 * ③ 落库全在 `resume.doc`，本文件的 `save` 只是把当前 draft 交出去（AGENTS.md §2.5：一件事一个入口）。
 *
 * 预览走 `resumePrint.buildHtml` 这**同一个** builder（spec 3.3-01「预览即导出所见」在编辑器里继续成立），
 * 字体 base 用 `@auto-cc/shared` 的 `PREVIEW_FONT_BASE`（相对路径，见那一条的注释）——所以本服务**不认得**
 * `resume.print` 端口：它只投影 HTML，从不产 PDF 字节，那个绝对 `file://` base 与它无关。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import { PREVIEW_FONT_BASE } from '@auto-cc/shared';
import { z } from 'zod';
import type { ResumeDocService } from './doc-store.js';
import {
  EDITOR_METRIC_BOUNDS,
  type DesignPatch,
  type EditorOutcome,
  type MetricBound,
  type MetricKey,
} from './editor-ops.js';
import { createResumeEditorSession, type ResumeEditorSession } from './editor-session.js';
import type { Layout, ResumeDocument, SectionKind } from './model.js';
import { resumePrint } from './print.js';
import { resumeTemplate, type TemplateLocale } from './template.js';

/**
 * 3.6-08 的两只阈值（plan §8.4）：判据原文是"操作响应在可接受阈值内，**阈值来自配置**"，
 * 所以它们落在本服务自己的 `static Config`，而不是界面里写死一个数，也不新开一套配置读取（§2）。
 * 版面界值**不在此列**——那是模型级事实（`EDITOR_METRIC_BOUNDS`），不是运行期可调项。
 */
export const resumeEditorSchema = z.strictObject({
  /** 一次预览构建的可接受上限（毫秒）；界面拿它与自己量到的往返时间比，只用于摆读数，判定不在界面重算。 */
  maxPreviewResponseMs: z.number().int().positive().default(1200),
  /** 区块数超过它就按"大文档"给一句提示（判据原文的 >5 页由这个数来，随配置走）。 */
  largeDocumentSectionCount: z.number().int().positive().default(5),
});
export type ResumeEditorConfig = z.infer<typeof resumeEditorSchema>;

/** 新建编辑会话时没指定模板的落点（与 `ResumePanel` 现在硬编码的那一个同源，3.6-c 之后由下拉给）。 */
const DEFAULT_TEMPLATE_ID = 'classic';

/** 投影里的一个区块：只有结构与 id，**不回正文**（区块标签由界面按 kind 走 i18n，同 3.2-06 口径）。 */
export interface ResumeEditorSectionState {
  id: string;
  kind: SectionKind;
  /** 条目 id 序列（界面条目级拖拽的把手数据；字段值不在其中）。 */
  entryIds: string[];
}

/**
 * 一次动作后的统一读数（`bridge.ts` 的 `ResumeEditorView` 与它一一对应）。
 * 度量与界表都在这份里：滑杆要摆的就是 `EDITOR_METRIC_BOUNDS` 那同一张表，界面不该再抄一份（§2.5）。
 */
export interface ResumeEditorState {
  docId: string;
  sections: ResumeEditorSectionState[];
  layout: Layout;
  templateId: string;
  locale: TemplateLocale;
  /** 可用模板 id（下拉的数据源；模板名是渲染期标签，不过界）。 */
  templates: string[];
  metricBounds: Readonly<Record<MetricKey, MetricBound>>;
  /** 3.6-08 的两只阈值（来自本服务 `static Config`）：界面摆读数用，判定不复制到界面去。 */
  timing: { maxPreviewResponseMs: number; largeDocumentSectionCount: number };
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * 排版编辑会话服务。
 */
export class ResumeEditorService extends Service {
  static provide = 'resume.editor';
  static Config = resumeEditorSchema;
  static inject = ['resume.doc'];

  /**
   * docId → 会话。只活在内存里，**重启即失**（plan §8.5 裁定⑨「只拦不存」：draft 不落库，
   * 所以 3.6 全程不碰迁移台账）。重建本服务（例如 `resume-doc` 的配置被热改）会丢掉未保存的编辑，
   * 届时的读数是一条明确的 `RESUME_EDITOR_NOT_OPEN` 而不是"看起来还在其实回到已存那份"。
   */
  private readonly sessions = new Map<string, ResumeEditorSession>();

  /**
   * 3.6-08 的阈值：构造时从配置取一次，随投影出去（配置热改会重建本服务，见 §9 的 2.5——
   * 重建即换一份阈值，界面下一份投影拿到的就是新值，界面不缓存它）。
   */
  private readonly timing: ResumeEditorState['timing'];

  constructor(ctx: Context, options: ResumeEditorConfig) {
    super(ctx, 'resume.editor');
    this.timing = {
      maxPreviewResponseMs: options.maxPreviewResponseMs,
      largeDocumentSectionCount: options.largeDocumentSectionCount,
    };
  }

  private get docStore(): ResumeDocService {
    return asApp(this.ctx)['resume.doc'];
  }

  /**
   * 打开一份文档的编辑会话（界面进编辑器面板时调一次）。
   * @param docId `resume_docs` 里的那份文档 id
   * @param templateId 预览模板 id，缺省用 `classic`；id 不存在直接结构化失败（下拉的数据源就是 `view().templates`）
   * @param locale 预览语言，缺省 `zh-CN`
   * @returns 会话投影
   * @throws AppError(`RESUME_EDITOR_DOC_UNAVAILABLE`) 库里没有这份文档或那行已损坏；
   *         AppError(`RESUME_EDITOR_TEMPLATE_UNKNOWN`) 未知模板 id
   */
  open = (docId: string, templateId?: string, locale?: TemplateLocale): ResumeEditorState => {
    const resolved = templateId ?? DEFAULT_TEMPLATE_ID;
    if (resumeTemplate.get(resolved) === null) {
      throw new AppError(
        'RESUME_EDITOR_TEMPLATE_UNKNOWN',
        `未知模板 ${resolved}（可用：${resumeTemplate
          .list()
          .map((template) => template.id)
          .join(', ')}）`,
      );
    }
    const loaded = this.docStore.load(docId);
    if (loaded.status !== 'found') {
      throw new AppError(
        'RESUME_EDITOR_DOC_UNAVAILABLE',
        loaded.status === 'missing'
          ? `库里没有 id 为 ${docId} 的简历文档`
          : `id 为 ${docId} 的简历文档已损坏：${loaded.reason}`,
      );
    }
    // 重新打开＝放弃上一份未保存的 draft（裁定⑨：未保存的东西只有拦截提示，没有恢复途径）。
    this.sessions.set(docId, createResumeEditorSession(loaded.document, { templateId: resolved, locale }));
    return this.state(docId);
  };

  /**
   * 读当前会话投影（界面重挂、或只想刷新读数时调）。
   * @param docId 文档 id
   * @returns 会话投影
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN`) 会话未开（未 open 过，或本服务被重建过）
   */
  view = (docId: string): ResumeEditorState => this.state(docId);

  /**
   * 拖一次：搬区块（不给 entryId）或搬条目（给 entryId，作用域限在该区块内）。
   * @param docId 文档 id
   * @param sectionId 目标区块 id
   * @param toIndex 落点下标（结果序列里的位置）
   * @param entryId 条目 id；缺省表示搬整个区块
   * @returns 新的会话投影
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN` / `RESUME_EDITOR_EDIT_REJECTED`)
   */
  move = (docId: string, sectionId: string, toIndex: number, entryId?: string): ResumeEditorState => {
    const session = this.require(docId);
    const outcome =
      entryId === undefined ? session.moveSection(sectionId, toIndex) : session.moveEntry(sectionId, entryId, toIndex);
    return this.afterEdit(docId, outcome);
  };

  /**
   * 改一条度量（字号 / 行距 / 四条边距）。
   * @param docId 文档 id
   * @param key 度量键
   * @param value 新值（单位随键；非有限数与界外都拒，界表见 `view().metricBounds`）
   * @returns 新的会话投影
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN` / `RESUME_EDITOR_EDIT_REJECTED`)
   */
  metric = (docId: string, key: MetricKey, value: number): ResumeEditorState =>
    this.afterEdit(docId, this.require(docId).setMetric(key, value));

  /**
   * 改一次样式（spec 6.6-05）：文档主题三色、正文三轴、某一类区块的六条段落轴。
   * **一次调用 = 一个撤销单元**（弹窗里"整格保存"是一次调用，不是六次），形状与界的判定全在
   * `editor-ops.ts` 那一份，本文件只把拒绝项翻成 `AppError`（与 `metric` 同一条通道）。
   * @param docId 文档 id
   * @param patch 结构化补丁（同一格给 `null` 就是取消它，回到模板默认档）
   * @returns 新的会话投影（`layout.design` 就是补丁之后的形状）
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN` / `RESUME_EDITOR_EDIT_REJECTED`)
   */
  design = (docId: string, patch: DesignPatch): ResumeEditorState =>
    this.afterEdit(docId, this.require(docId).setDesign(patch));

  /**
   * 换预览模板或语言（3.6-04）。它**不碰文档**，所以不产生撤销单元。
   * @param docId 文档 id
   * @param templateId 目标模板 id，不给表示不改
   * @param locale 目标语言，不给表示不改
   * @returns 新的会话投影
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN` / `RESUME_EDITOR_TEMPLATE_UNKNOWN`)
   */
  use = (docId: string, templateId?: string, locale?: TemplateLocale): ResumeEditorState => {
    const session = this.require(docId);
    if (templateId !== undefined) {
      if (resumeTemplate.get(templateId) === null) {
        throw new AppError(
          'RESUME_EDITOR_TEMPLATE_UNKNOWN',
          `未知模板 ${templateId}（可用：${resumeTemplate
            .list()
            .map((template) => template.id)
            .join(', ')}）`,
        );
      }
      session.useTemplate(templateId);
    }
    if (locale !== undefined) session.useLocale(locale);
    return this.state(docId);
  };

  /**
   * 当前 draft 的预览 HTML：与 `resume.export.preview` 用**同一份** builder 与同一个相对字体 base
   * （`PREVIEW_FONT_BASE`），区别只在这里喂的是**未保存**的那一份文档（spec 3.6-01「松开即预览更新」的前提）。
   * @param docId 文档 id
   * @returns 完整打印 HTML 字符串
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN`)
   */
  preview = (docId: string): string => {
    const session = this.require(docId);
    return resumePrint.buildHtml(session.document(), session.templateId(), session.locale(), PREVIEW_FONT_BASE);
  };

  /**
   * 回退一步。
   * @param docId 文档 id
   * @returns 新的会话投影（`canUndo` 变 false、`isDirty` 可能归零）
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN`)
   */
  undo = (docId: string): ResumeEditorState => {
    this.require(docId).undo();
    return this.state(docId);
  };

  /**
   * 重做一步。
   * @param docId 文档 id
   * @returns 新的会话投影
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN`)
   */
  redo = (docId: string): ResumeEditorState => {
    this.require(docId).redo();
    return this.state(docId);
  };

  /**
   * 保存：把当前 draft 交给 `resume.doc`（唯一的写入入口），成功后把会话的 dirty 基线推到当前内容。
   * @param docId 文档 id
   * @returns 新的会话投影（`isDirty` 为 false；撤销历史照旧保留）
   * @throws AppError(`RESUME_EDITOR_NOT_OPEN`)；库侧校验不过时上浮 `resume.doc` 的 `INVALID_ARGUMENT`
   */
  save = (docId: string): ResumeEditorState => {
    const session = this.require(docId);
    const current = session.document();
    this.docStore.save({ ...current, updatedAt: Date.now() });
    session.markSaved();
    return this.state(docId);
  };

  /**
   * 取会话，未开则结构化失败。
   * @param docId 文档 id
   * @returns 会话实例
   */
  private require(docId: string): ResumeEditorSession {
    const session = this.sessions.get(docId);
    if (!session) {
      throw new AppError('RESUME_EDITOR_NOT_OPEN', `文档 ${docId} 没有打开的编辑会话，请先调 open`);
    }
    return session;
  }

  /**
   * 把一次纯操作的判定翻成读数：通过就返回投影，拒绝就抛带**子原因**的一条码。
   * @param docId 文档 id
   * @param outcome `editor-ops` 的判定结果（界外、未知 id、越界都从这里出去，本文件不写第二条判据）
   * @returns 新的会话投影
   */
  private afterEdit(docId: string, outcome: EditorOutcome<ResumeDocument>): ResumeEditorState {
    if (!outcome.ok) {
      throw new AppError('RESUME_EDITOR_EDIT_REJECTED', `${outcome.code}：${outcome.detail}`, undefined, {
        reason: outcome.code,
      });
    }
    return this.state(docId);
  }

  /**
   * 组一份投影。
   * @param docId 文档 id
   * @returns 会话投影
   */
  private state(docId: string): ResumeEditorState {
    const session = this.require(docId);
    const doc = session.document();
    return {
      docId,
      sections: doc.sections.map((section) => ({
        id: section.id,
        kind: section.kind,
        entryIds: section.entries.map((entry) => entry.id),
      })),
      layout: doc.layout,
      templateId: session.templateId(),
      locale: session.locale(),
      templates: resumeTemplate.list().map((template) => template.id),
      metricBounds: EDITOR_METRIC_BOUNDS,
      timing: this.timing,
      isDirty: session.isDirty(),
      canUndo: session.canUndo(),
      canRedo: session.canRedo(),
    };
  }
}
