/**
 * `resume.export` 服务（spec 3.3-02 / 05 / 07 / 09 / 11 / 12 的编排半边 + 3.7-01 的「每次导出记快照」）：
 * 文档 → 打印 HTML → 内核产 PDF → 落盘 → 回写页数 → 记不可变快照。
 *
 * 分层：本服务在 L2 `resume-doc`，**不认识 Electron**——唯一碰 `WebContents.printToPDF` 的动作经依赖注入的
 * `resume.print` 端口（由 L1 shell 实现）完成。落盘目录取自 L0 `config` 的 `userDataDir`（与 1.3 的库、2.4 的失败证据同一个根），
 * 于是「写文件」这件事不需要 import electron 也做得了，本包 `package.json` 里没有、也不该有 electron 依赖。
 *
 * 单一入口：预览与导出都走这一份 HTML 源（`resumePrint`），3.3-01「预览即导出所见」因此在结构上成立，而不是两处各渲一遍再祈祷一致。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { ConfigService } from '@auto-cc/plugin-config';
import {
  DEMO_RESUME_DOC_ID,
  PREVIEW_FONT_BASE,
  type ResumePrintPort,
  type ResumeTemplateSummaryView,
} from '@auto-cc/shared';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResumeDocService } from './doc-store.js';
import { createEmptyDocument, makeField, type ResumeDocument, type Section } from './model.js';
import { resumePrint } from './print.js';
import { resumeTemplate } from './template.js';
import type { ResumeSnapshotService } from './snapshot-store.js';
import type { TemplateLocale } from './template.js';

/** 导出产物落盘的子目录名（在 `userDataDir` 之下，与库、会话分区同根）。 */
const EXPORTS_SUBDIR = 'exports';

/**
 * 演示种子的两个版本：`base` 是首次载入的样子，`edited` 在它之上改两处自由文本并追加一个项目区块。
 * 只为 3.7-03 的 diff 界面在「编辑轨还没落地」时能拿到两份内容真的不同的快照（见 `demoDocument`）。
 */
export type ResumeSeedVariant = 'base' | 'edited';

/** `edited` 变体改写的个人简介（虚构内容，与非锁定字段 `summary.text` 对应）。 */
const EDITED_SUMMARY_TEXT = '五年后端工程师，近两年专注桌面端与内核自动化。';

/** `edited` 变体改写的技能行（虚构内容，与非锁定字段 `skills.text` 对应）。 */
const EDITED_SKILLS_TEXT = 'TypeScript / Node.js / Electron / PDF 打印管线';

/** 无配置服务：目录来自 `config`，打印来自注入端口，本服务自身没有运行期可调项。 */
export const resumeExportSchema = z.strictObject({});
export type ResumeExportConfig = z.infer<typeof resumeExportSchema>;

/** 一次导出的回执：产物绝对路径、页数、字节数、回写后的文档内容 hash，以及这次留下的快照 id。 */
export interface ExportReceipt {
  docId: string;
  path: string;
  pages: number;
  bytes: number;
  hash: string;
  /**
   * 这次导出的不可变快照 id（spec 3.7-01 的产物标识）。
   * 回执里没有它就等于「留了档但没人知道档在哪」：投递要引用这个 id 才答得出当时内容（spec 3.7-02）。
   */
  snapshotId: string;
}

/**
 * 简历导出服务。
 */
export class ResumeExportService extends Service {
  static provide = 'resume.export';
  static Config = resumeExportSchema;
  static inject = ['resume.doc', 'resume.print', 'resume.snapshot', 'config'];

  constructor(ctx: Context, _options: ResumeExportConfig) {
    super(ctx, 'resume.export');
  }

  private get docStore(): ResumeDocService {
    return asApp(this.ctx)['resume.doc'];
  }

  private get printPort(): ResumePrintPort {
    return asApp(this.ctx)['resume.print'];
  }

  private get snapshotStore(): ResumeSnapshotService {
    return asApp(this.ctx)['resume.snapshot'];
  }

  private get config(): ConfigService {
    return asApp(this.ctx).config;
  }

  /**
   * 落一份**固定内容**的演示简历文档（spec 3.3-10 的「本机先用固定内容验」）。
   *
   * 编辑轨（3.5）之前界面没有「录入文档」的入口，导出管线的端到端自测需要先有一份合法文档做种子；
   * 内容全为虚构、不含真实个人信息，只用来把「文档 → 打印 HTML → PDF」这条链在真实内核上跑通。
   * @param variant `base`（默认）或 `edited`（给 3.7-03 的 diff 界面准备的第二版内容）
   * @returns 种子文档的 id 与落库后的内容 hash
   */
  /**
   * 列出可给界面摆的模板（id + 展示名 + 版式骨架的七条轴）：模板架唯一的数据源，
   * 界面不自己抄一份清单、也不自己猜一份轴表（§2.5 / spec 6.4-09）。
   *
   * 轴取自注册表里那一份 `spec`——它就是 `renderWithSpec` 渲染时真正吃的对象，
   * 所以小图与产物之间不存在"改了轴、忘了小图"的窗口。
   * @returns 按注册次序的模板摘要
   */
  templates = (): ResumeTemplateSummaryView[] =>
    resumeTemplate.list().map((template) => ({
      id: template.id,
      name: template.name,
      layout: {
        columns: template.spec.columns,
        accent: template.spec.accent,
        header: template.spec.header,
        heading: template.spec.heading,
        entry: template.spec.entry,
        density: template.spec.density,
        serif: template.spec.serif,
      },
    }));

  /**
   * 读人设定的默认模板 id（spec 3.2-03 的「用户可设置用哪套生成」那半边的存储出口）。
   * @returns 存过的模板 id；从没设定过时回退 `classic`（第一套内置模板，始终存在）
   */
  preference = (): { templateId: string } => ({
    templateId: this.docStore.getPreference('defaultTemplateId') ?? 'classic',
  });

  /**
   * 写下人设定的默认模板 id：之后 `preview` / `toPdf` 不给 templateId 时就用它。
   * @param templateId 目标模板 id；不存在的 id 直接被拒（而不是存进去等渲染时炸）
   * @throws AppError(`INVALID_ARGUMENT`) 模板 id 不在注册表里
   */
  setPreference = (templateId: string): { templateId: string } => {
    if (resumeTemplate.get(templateId) === null) {
      throw new AppError('INVALID_ARGUMENT', `未知模板 ${templateId}，不能作为默认模板设定`);
    }
    this.docStore.setPreference('defaultTemplateId', templateId, Date.now());
    return { templateId };
  };

  /**
   * 定下这次渲染用哪套模板：显式给的优先，没给就用人设定的默认值。
   * @param templateId 调用方给的模板 id（可为 undefined）
   * @returns 实际生效的模板 id
   */
  private resolveTemplateId(templateId: string | undefined): string {
    return templateId ?? this.preference().templateId;
  }

  seedDemo = (variant: ResumeSeedVariant = 'base'): { docId: string; hash: string } => {
    const saved = this.docStore.save(this.demoDocument(variant));
    return { docId: DEMO_RESUME_DOC_ID, hash: saved.hash };
  };

  /**
   * 造一份虚构的演示文档（内容不含任何真实个人信息，只为把导出链与快照链喂通）。
   *
   * `edited` 变体存在的理由只有一个：**编辑轨（3.5）之前界面没有录入入口**，而 3.7-03 的 diff 界面
   * 需要两份内容真的不同的快照才能摆出「条目级 + 字段级」。它在 `base` 之上改两处自由文本、
   * 追加一个项目区块（条目级新增），不动任何事实锁定字段——于是 diff 里既有普通改动，
   * 也有整块新增的事实字段可打上「待确认」标（3.1-03 的口径）。编辑轨落地后这个变体就该由真实编辑取代。
   * @param variant `base` 首次载入的样子；`edited` 在其之上的两处文本改动 + 一个新项目区块
   * @returns 可直接交给 `resume.doc.save` 的合法文档
   */
  private demoDocument(variant: ResumeSeedVariant): ResumeDocument {
    const base: ResumeDocument = {
      ...createEmptyDocument(DEMO_RESUME_DOC_ID, Date.now()),
      profile: { name: '张三', contact: { email: 'zhangsan@example.com', phone: '13800000000', location: '上海' } },
      sections: [
        {
          id: 'summary',
          kind: 'summary',
          title: '个人简介',
          entries: [{ id: 's1', fields: [makeField('summary', 'text', '五年后端工程师，专注高并发服务与可观测性。')] }],
        },
        {
          id: 'exp',
          kind: 'experience',
          title: '工作经历',
          entries: [
            {
              id: 'e1',
              fields: [
                makeField('experience', 'company', '星桥科技'),
                makeField('experience', 'role', '后端工程师'),
                makeField('experience', 'period', '2021 - 2024'),
                makeField('experience', 'achievement', '主导订单服务重构，P99 延迟下降 40%。'),
              ],
            },
          ],
        },
        {
          id: 'skills',
          kind: 'skills',
          title: '技能',
          entries: [
            { id: 'k1', fields: [makeField('skills', 'text', 'TypeScript / Node.js / PostgreSQL / Electron')] },
          ],
        },
      ],
    };
    if (variant === 'base') return base;
    const project: Section = {
      id: 'project',
      kind: 'project',
      title: '项目经历',
      entries: [
        {
          id: 'p1',
          fields: [
            makeField('project', 'company', '未名开源社区'),
            makeField('project', 'role', '维护者'),
            makeField('project', 'period', '2023 - 至今'),
            makeField('project', 'achievement', '发布 PDF 打印工具链，月下载 2 万次。'),
          ],
        },
      ],
    };
    return {
      ...base,
      sections: [
        ...base.sections.map((section) => {
          if (section.id === 'summary') {
            return { ...section, entries: [{ id: 's1', fields: [makeField('summary', 'text', EDITED_SUMMARY_TEXT)] }] };
          }
          if (section.id === 'skills') {
            return { ...section, entries: [{ id: 'k1', fields: [makeField('skills', 'text', EDITED_SKILLS_TEXT)] }] };
          }
          return section;
        }),
        project,
      ],
    };
  }

  /**
   * 载入一份合法文档；缺失或库里存坏了都以 `RESUME_EXPORT_FAILED` 结构化失败上浮（3.3-11 的「文档非法」腿）。
   * @param docId 文档 id
   * @returns 合法文档
   */
  private requireDoc(docId: string) {
    const loaded = this.docStore.load(docId);
    if (loaded.status === 'missing') {
      throw new AppError('RESUME_EXPORT_FAILED', `简历文档不存在：${docId}`);
    }
    if (loaded.status === 'corrupt') {
      throw new AppError('RESUME_EXPORT_FAILED', `简历文档已损坏，无法导出：${loaded.reason}`);
    }
    return loaded.document;
  }

  /**
   * 渲染预览 HTML——与 {@link toPdf} 用的是**同一份**打印 HTML 源（3.3-01「预览即导出所见」）。
   *
   * 只有字体 base 的形状不同，而且这一支**必须是相对路径**：这份 HTML 落到渲染层的 `about:srcdoc` 纸面帧里，
   * 开发态那一面是 http 页，取 `file://` 字体会被 Chromium 挡掉（屏上永远掉回系统字体，见 spec 6.6-04）；
   * `toPdf` 那一面由执行器经临时 `file://` 文档装载，只有绝对同源 URL 才读得到本地字体，所以它仍走 `fontBaseUrl()`。
   * @param docId 文档 id
   * @param templateId 模板 id（未知由模板层抛可读错）
   * @param locale 语言，默认 `zh-CN`
   * @returns 可直接塞进视图的完整 HTML 文档字符串
   */
  preview = (docId: string, templateId?: string, locale: TemplateLocale = 'zh-CN'): string => {
    const doc = this.requireDoc(docId);
    return resumePrint.buildHtml(doc, this.resolveTemplateId(templateId), locale, PREVIEW_FONT_BASE);
  };

  /**
   * 把指定文档导出成一份 A4 简历 PDF 并落 `userData/exports`，同时把真实页数回写模型（3.3-09）。
   *
   * 全程只用局部量、每次独立建视图（并发不串，3.3-12 由注入端口的实现保证），任何一环失败都收敛成
   * 一个 `RESUME_EXPORT_FAILED` 的 `AppErrorPayload`（3.3-11），跨进程不丢 message。
   * @param docId 文档 id
   * @param templateId 模板 id
   * @param locale 语言，默认 `zh-CN`
   * @returns 导出回执（路径 / 页数 / 字节数 / 内容 hash）
   */
  toPdf = async (docId: string, templateId?: string, locale: TemplateLocale = 'zh-CN'): Promise<ExportReceipt> => {
    const doc = this.requireDoc(docId);
    const usedTemplateId = this.resolveTemplateId(templateId);
    const request = resumePrint.toRequest(doc, usedTemplateId, locale, this.printPort.fontBaseUrl());

    let pdf: Uint8Array;
    try {
      pdf = await this.printPort.render(request);
    } catch (error) {
      throw new AppError(
        'RESUME_EXPORT_FAILED',
        `内核打印失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const inspection = resumePrint.inspectPdf(pdf);
    if (!inspection.isPdf) {
      throw new AppError('RESUME_EXPORT_FAILED', '打印产物不是合法 PDF');
    }

    const dir = join(this.config.paths().userDataDir, EXPORTS_SUBDIR);
    const target = join(dir, `${docId}-${usedTemplateId}.pdf`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, pdf);
    } catch (error) {
      throw new AppError(
        'RESUME_EXPORT_FAILED',
        `导出落盘失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 页数回写（3.3-09）：以打印侧真实读数为准，供编辑器与快照（3.7）使用。
    const finalDoc: ResumeDocument = { ...doc, metrics: { ...doc.metrics, pages: inspection.pageCount } };
    const saved = this.docStore.save(finalDoc);
    // 导出瞬间记一份不可变快照（3.7-01）：与上面那次 save 用的是同一份 `finalDoc`，
    // 所以快照 hash 与回执 hash 必然同源一致——「投出去的到底是哪一版」因此在库里留了不可变的一行。
    const snapshot = this.snapshotStore.record(finalDoc, usedTemplateId, resumePrint.fontSet, Date.now());

    return {
      docId,
      path: target,
      pages: inspection.pageCount,
      bytes: inspection.byteLength,
      hash: saved.hash,
      snapshotId: snapshot.snapshotId,
    };
  };
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.export': ResumeExportService;
    'resume.print': ResumePrintPort;
  }
}
