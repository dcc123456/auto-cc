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
import type { ResumePrintPort } from '@auto-cc/shared';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResumeDocService } from './doc-store.js';
import { createEmptyDocument, makeField, type ResumeDocument } from './model.js';
import { resumePrint } from './print.js';
import type { ResumeSnapshotService } from './snapshot-store.js';
import type { TemplateLocale } from './template.js';

/** 导出产物落盘的子目录名（在 `userDataDir` 之下，与库、会话分区同根）。 */
const EXPORTS_SUBDIR = 'exports';

/** 演示种子文档 id（spec 3.3-10「本机先用固定内容验」，编辑轨 3.5 落地后由用户文档取代）。 */
const DEMO_DOC_ID = 'resume-demo';

/** 无配置服务：目录来自 `config`，打印来自注入端口，本服务自身没有运行期可调项。 */
export const resumeExportSchema = z.strictObject({});
export type ResumeExportConfig = z.infer<typeof resumeExportSchema>;

/** 一次导出的回执：产物绝对路径、页数、字节数与回写后的文档内容 hash。 */
export interface ExportReceipt {
  docId: string;
  path: string;
  pages: number;
  bytes: number;
  hash: string;
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
   * @returns 种子文档的 id 与落库后的内容 hash
   */
  seedDemo = (): { docId: string; hash: string } => {
    const seeded: ResumeDocument = {
      ...createEmptyDocument(DEMO_DOC_ID, Date.now()),
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
    const saved = this.docStore.save(seeded);
    return { docId: DEMO_DOC_ID, hash: saved.hash };
  };

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
   * @param docId 文档 id
   * @param templateId 模板 id（未知由模板层抛可读错）
   * @param locale 语言，默认 `zh-CN`
   * @returns 可直接塞进视图的完整 HTML 文档字符串
   */
  preview = (docId: string, templateId: string, locale: TemplateLocale = 'zh-CN'): string => {
    const doc = this.requireDoc(docId);
    return resumePrint.buildHtml(doc, templateId, locale, this.printPort.fontBaseUrl());
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
  toPdf = async (docId: string, templateId: string, locale: TemplateLocale = 'zh-CN'): Promise<ExportReceipt> => {
    const doc = this.requireDoc(docId);
    const request = resumePrint.toRequest(doc, templateId, locale, this.printPort.fontBaseUrl());

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
    const target = join(dir, `${docId}-${templateId}.pdf`);
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
    this.snapshotStore.record(finalDoc, templateId, resumePrint.fontSet, Date.now());

    return { docId, path: target, pages: inspection.pageCount, bytes: inspection.byteLength, hash: saved.hash };
  };
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.export': ResumeExportService;
    'resume.print': ResumePrintPort;
  }
}
