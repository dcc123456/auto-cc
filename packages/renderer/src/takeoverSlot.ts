/**
 * 接管横幅的全局槽位 id（spec 10.11-19：横幅「全局常驻」）。
 *
 * 为什么要一个共享常量：`App` 摆槽位、`ChatPanel` 往里 portal，两处写同一个字面量就是第二次复制；
 * 槽位是布局事实而不是状态——读数与按钮仍然只有 `useTakeover` 那一份，这里只约定"画在哪"。
 */
export const TAKEOVER_SLOT_ID = 'takeover-slot';
