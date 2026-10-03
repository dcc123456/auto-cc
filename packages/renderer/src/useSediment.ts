/**
 * 对话 → 工作流沉淀的界面半边（spec 5.4-01 / 04 里那两只手，判据全在主进程）。
 *
 * 「能不能沉淀」「哪几格是残留具体值」「这一格为什么不行」三样都是 `agent.sediment.preview` 的读数，
 * 界面一份都不自己算（AGENTS.md §2.7）：预览与落库走的是同一条投影，所以卡片上说得出的「能沉淀」，
 * `save()` 必然做得成，反过来 `save()` 拒的每一条原因都能先在卡上看见。
 * 这里只持有两件属于人的东西：名字那一格的草稿，和「这张卡是给哪条 run 画的」——
 * runId 换了旧预览自动作废，不会出现「新任务沿用旧读数」的第二份事实。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SavedWorkflowPlanView, SedimentPreviewView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/**
 * 挂一张沉淀卡的界面状态。
 * @returns `preview`（这一次投影的逐格读数，没点开过为 undefined）、`saved`（刚落库的计划读数）、
 *   `nameDraft` / `setNameDraft`（名字那一格）、`busy` / `notice`、`open` / `save` / `close`
 */
export function useSediment() {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<SedimentPreviewView>();
  const [saved, setSaved] = useState<SavedWorkflowPlanView>();
  const [nameDraft, setNameDraft] = useState('');
  const bridge = window.autoCC;
  // 两次调用都以返回值即时落到本卡 state：沉淀没有「主进程还有一份进度要重读」这回事，
  // 计划列表由工作流面板自己现问（每次现读不缓存，那是 5.4-06 的口径），所以这里的重读是空操作。
  const read = useCallback((): Promise<unknown> => Promise.resolve(), []);
  const action = useBridgeAction(read);

  /**
   * 点开「保存为工作流」：向主进程要这一次对话的投影读数（只读，不写库）。
   * @param runId 对话卡片上那条 run 的 id
   */
  const open = useCallback(
    async (runId: string): Promise<void> => {
      await action.run(t('chat.sediment.actionPreview'), () => bridge?.agent['sediment.preview'](runId), {
        apply: (view) => {
          setPreview(view);
          // 换一条 run 的读数就把「已保存」那一行撤掉，否则旧回执会挂在新预览上被当成这次的凭据。
          setSaved(undefined);
        },
      });
    },
    [action, bridge, t],
  );

  /**
   * 存为自定义计划（人按的那一格）：名字原值交给服务侧校验，界面不做第二道。
   * @param runId 要沉淀的 run
   * @param nameRaw 名字输入框里的原值（含首尾空格，trim 与长度校验只有一处实现）
   */
  const save = useCallback(
    async (runId: string, nameRaw: string): Promise<void> => {
      await action.run(
        t('chat.sediment.actionSave', { name: nameRaw }),
        () => bridge?.agent['sediment.save'](runId, nameRaw),
        {
          apply: setSaved,
          describe: (view) => t('chat.sediment.saved', { name: view.name, count: view.nodeCount }),
        },
      );
    },
    [action, bridge, t],
  );

  /** 收起这张卡：库里的 run 与已存计划都一行不动。 */
  const close = useCallback((): void => {
    setPreview(undefined);
    setSaved(undefined);
    setNameDraft('');
  }, []);

  return { preview, saved, nameDraft, setNameDraft, busy: action.busy, notice: action.notice, open, save, close };
}
