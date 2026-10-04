# LICENSES.md — 随包第三方素材与依赖的许可记账

本文件是 AGENTS.md §8.7「抽取来源的许可证必须记账」的落地清单：凡**随 app 分发的第三方素材 / 被抽取的代码 / AGPL 类依赖**，在此登记来源、许可与分发义务（含是否需要附 NOTICE）。

> **生产依赖的全量许可清单由机检生成并与本文件对齐**（spec 5.9-04 / plan §7.7.3 切片 5.9-c）：
> 见下面「生产依赖全量清单」一节，取数口是 `pnpm licenses list --json --prod`，核对脚本是
> `scripts/check-licenses.ts`（已进 `pnpm lint` 链，新增依赖而未记账即 lint 失败）。
> 本节上方与下方的人工记账只放**机检查不到的东西**：素材的来源、被抽取代码的授权状态、跨包分发的处置决定。

## 随包内嵌素材（resources/**）

| 素材                                                                             | 位置                      | 来源                                                    | 许可                      | 义务与处置                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Noto Sans SC（中文简历正文字体，400/700，chinese-simplified + latin 子集 woff2） | `resources/fonts/*.woff2` | Google Noto（经 `@fontsource/noto-sans-sc@5.3.0` 分发） | SIL Open Font License 1.1 | OFL 允许内嵌与子集化；许可证全文随字体附于 `resources/fonts/OFL.txt`。仅作为未修改字体消费，不触发保留名（Reserved Font Name）冲突的重命名分发。 |

## 抽取来源与依赖候选（人工记账，机检查不到的一类）

| 候选                      | 用途                       | 许可                                  | 状态                                                                                                                                |
| ------------------------- | -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ai-resume` 模板 / prompt | 生成轨模板与文案（3.3-13） | 自述 MIT 但**无 LICENSE 文件**        | `[!]` 所有权与授权未确认，未抽取前不放宽                                                                                            |
| `canva-pdf` `core/writer` | 编辑轨保真改写（3.5-11）   | README 自述 MIT 但**无 LICENSE 文件** | `[!]` 抽取前须补授权                                                                                                                |
| `pdfjs-dist`              | 编辑轨 PDF 引擎（3.4-09）  | **Apache-2.0**（实测，见下方生成节）  | `[x]` 已随包分发；Apache-2.0 不传染，但须保留 LICENSE/NOTICE —— 该包整体随 `app.asar.unpacked` 进产物，LICENSE 文件在包目录内       |
| `mupdf`                   | 编辑轨 PDF 引擎的备选      | AGPL-3.0                              | `[!]` **未引入**（依赖树里没有这个包，实测）；一旦引入即触发附 NOTICE 的义务，须由 `scripts/check-licenses.ts` 的 copyleft 闸门拦下 |

**勘误（2026-10-04，5.9-c 实测）**：本表原先把 `mupdf / pdfjs-dist` 并列为 "AGPL-3.0 且尚未引入"。
扫描结果是两件都不对——`pdfjs-dist@6.3.289` 的许可是 **Apache-2.0**，而且它**已经**进产物（搬运层的第二个
外置根，见 `scripts/vendor-runtime-deps.ts` 的 `RUNTIME_EXTERNAL_ROOTS`）；真正带 AGPL 的 `mupdf` 从未引入。
判据原文（spec 5.9-04 写的是"AGPL 来源（pdfjs-dist/mupdf）"）保持不动，勘误写在这里——
按 AGENTS.md §6.2「文档转述不可信，以实测为准」，这条正是那次实测把文档里的假设纠正过来的记录。

## 生产依赖全量清单（机检生成）

<!-- BEGIN:generated-by-check-licenses -->

> 本节由 `tsx scripts/check-licenses.ts --write` 生成，请勿手改；正文其余部分是人工记账。
> 取数口：`pnpm licenses list --json --prod`（与安装事实同源，不另写依赖解析）。

**生产依赖合计 60 个包条目**，按许可分组：

| 许可                      | 包数 |
| ------------------------- | ---- |
| MIT                       | 43   |
| ISC                       | 5    |
| BSD-2-Clause              | 4    |
| Apache-2.0                | 2    |
| (MIT AND Zlib)            | 1    |
| (MIT OR GPL-3.0-or-later) | 1    |
| BlueOak-1.0.0             | 1    |
| BSD                       | 1    |
| BSD-3-Clause              | 1    |
| Python-2.0                | 1    |

**逐包清单**（版本 = 锁定的实际解析版本）：

| 包                               | 版本        | 许可                      |
| -------------------------------- | ----------- | ------------------------- |
| `pako`                           | 1.0.11      | (MIT AND Zlib)            |
| `jszip`                          | 3.10.2      | (MIT OR GPL-3.0-or-later) |
| `pdfjs-dist`                     | 6.3.289     | Apache-2.0                |
| `typescript`                     | 5.9.3       | Apache-2.0                |
| `sax`                            | 1.6.1       | BlueOak-1.0.0             |
| `duck`                           | 0.1.12      | BSD                       |
| `dingbat-to-unicode`             | 1.0.2       | BSD-2-Clause              |
| `lop`                            | 0.4.2       | BSD-2-Clause              |
| `mammoth`                        | 1.13.0      | BSD-2-Clause              |
| `option`                         | 0.2.4       | BSD-2-Clause              |
| `sprintf-js`                     | 1.0.3       | BSD-3-Clause              |
| `graceful-fs`                    | 4.2.11      | ISC                       |
| `inherits`                       | 2.0.4       | ISC                       |
| `lucide-react`                   | 0.544.0     | ISC                       |
| `semver`                         | 7.7.4       | ISC                       |
| `yaml`                           | 2.9.1       | ISC                       |
| `@babel/runtime`                 | 7.29.7      | MIT                       |
| `@napi-rs/canvas`                | 1.0.9       | MIT                       |
| `@napi-rs/canvas-win32-x64-msvc` | 1.0.9       | MIT                       |
| `@standard-schema/spec`          | 1.1.0       | MIT                       |
| `@xmldom/xmldom`                 | 0.8.15      | MIT                       |
| `argparse`                       | 1.0.10      | MIT                       |
| `base64-js`                      | 1.5.1       | MIT                       |
| `builder-util-runtime`           | 9.7.0       | MIT                       |
| `cordis`                         | 4.0.0-rc.10 | MIT                       |
| `core-util-is`                   | 1.0.3       | MIT                       |
| `cosmokit`                       | 1.8.1       | MIT                       |
| `cron-parser`                    | 5.10.1      | MIT                       |
| `debug`                          | 4.4.3       | MIT                       |
| `electron-updater`               | 6.8.9       | MIT                       |
| `fs-extra`                       | 10.1.0      | MIT                       |
| `html-parse-stringify`           | 3.1.0       | MIT                       |
| `i18next`                        | 25.10.10    | MIT                       |
| `immediate`                      | 3.0.6       | MIT                       |
| `isarray`                        | 1.0.0       | MIT                       |
| `js-yaml`                        | 4.3.2       | MIT                       |
| `jsonfile`                       | 6.2.1       | MIT                       |
| `lazy-val`                       | 1.0.5       | MIT                       |
| `lie`                            | 3.3.0       | MIT                       |
| `lodash.escaperegexp`            | 4.1.2       | MIT                       |
| `lodash.isequal`                 | 4.5.0       | MIT                       |
| `luxon`                          | 3.7.2       | MIT                       |
| `ms`                             | 2.1.3       | MIT                       |
| `process-nextick-args`           | 2.0.1       | MIT                       |
| `react`                          | 19.3.0      | MIT                       |
| `react-dom`                      | 19.3.0      | MIT                       |
| `react-i18next`                  | 15.7.4      | MIT                       |
| `readable-stream`                | 2.3.8       | MIT                       |
| `safe-buffer`                    | 5.1.2       | MIT                       |
| `scheduler`                      | 0.28.0      | MIT                       |
| `setimmediate`                   | 1.0.5       | MIT                       |
| `string_decoder`                 | 1.1.1       | MIT                       |
| `tiny-typed-emitter`             | 2.1.0       | MIT                       |
| `underscore`                     | 1.13.8      | MIT                       |
| `universalify`                   | 2.0.1       | MIT                       |
| `util-deprecate`                 | 1.0.2       | MIT                       |
| `void-elements`                  | 3.1.0       | MIT                       |
| `xmlbuilder`                     | 10.1.1      | MIT                       |
| `zod`                            | 4.6.5       | MIT                       |
| `argparse`                       | 2.0.1       | Python-2.0                |

**随包运行时**：

| 项                                       | 版本   | 许可 | 义务与处置                                                                                               |
| ---------------------------------------- | ------ | ---- | -------------------------------------------------------------------------------------------------------- |
| electron（随包运行时，非 `--prod` 闭包） | 44.4.5 | MIT  | 产物内附 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`（electron-builder 自动放置，本机实测在包内） |

**copyleft / 双许可闸门命中 1 条**，处置如下（新增命中而未登记即 `pnpm lint` 失败）：

| 包      | 处置                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jszip` | 双许可 `(MIT OR GPL-3.0-or-later)`：**取 MIT 那一支**（mammoth 的依赖，随 asar 分发）。MIT 分支无 NOTICE 义务；此条存在的意义是防止下一个人看到 GPL-3 字样就以为整个 app 被传染。 |

**搬运层缺许可全文的包 2 个**（上游发布物本身没有 LICENSE 文件，义务由产物内的 `THIRD-PARTY-NOTICES.txt` 按 manifest 登记承接；两者都走 `pnpm lint` 闸门）：

| 包         | 处置                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isarray`  | `isarray@1.0.0` 的 npm 发布物内只有 Makefile/README/component.json/index.js/package.json/test.js，**没有 LICENSE 文件**（实测）。许可字段是 MIT、作者是 package.json 里的 Julian Gruber，义务由 `THIRD-PARTY-NOTICES.txt` 按 manifest 登记承接；不从网络补抄条文——那是凭记忆生成许可文本，比登记缺口更危险。 |
| `lazy-val` | `lazy-val@1.0.5`（electron-updater 带进来的）发布物内只有 out/、package.json、readme.md，**没有 LICENSE 文件**（实测）。许可字段是 MIT、作者是 package.json 里的 Vladimir Krivosheev，处置与 isarray 同一条：由 `THIRD-PARTY-NOTICES.txt` 按 manifest 登记，不从网络补抄条文。                               |

<!-- END:generated-by-check-licenses -->
