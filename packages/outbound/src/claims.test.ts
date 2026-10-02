/**
 * 话术侧无依据断言判据的测试（spec 4.6-02 的判据本身）。
 *
 * 数值抽取与多重集比对的口径不在这里测——那份实现在 `@auto-cc/core/numbers.ts`，
 * 用例住在 `packages/core/src/numbers.test.ts`。本文件只钉**策略**：
 * 支撑面由调用方给全、只拦"说出口的数没有出处"这一个方向、读数报的是归一后的数值键。
 * 这三条决定话术发得出去还是回落模板，所以必须可读地钉住。
 */
import { describe, expect, it } from 'vitest';
import { findUnsupportedClaims } from './claims.js';

describe('有出处的数放行（4.6-02 的反向半边：别拦正常话术）', () => {
  it('模型引用的数这次真喂给它了：放过，哪怕只用到依据的一部分', () => {
    expect(
      findUnsupportedClaims('我把 P99 延迟下降 40%。', [
        '主导订单服务重构，P99 延迟下降 40%，服务 30 万用户',
        '后端开发工程师',
        '星桥科技',
      ]),
    ).toEqual([]);
    // 依据里的「30 万」没被写进话术——那是写作选择。判据只看 added，不看 missing。
  });

  it('比的是数值不是字面串：量级写法换了照样有出处', () => {
    expect(findUnsupportedClaims('月下载量做到 20000 次。', ['月下载 2 万次'])).toEqual([]);
    expect(findUnsupportedClaims('成本压到 35000 元。', ['管理 1,000 台机器，成本 3.5 万元'])).toEqual([]);
  });
});

describe('没有出处的数报出来（4.6-02 的正向半边：编造即拦）', () => {
  it('模型自己补的数一条条报，报的是归一后的数值键（与 4.5 的违规行同一口径）', () => {
    expect(findUnsupportedClaims('延迟下降 40%，服务 30 万用户。', ['主导过订单服务重构'])).toEqual(['40', '300000']);
  });

  it('汉字数字同样要出处——这是搬到 core 的抽取器之后收紧的口径（§8.4 里"时间"也是锁定项）', () => {
    expect(findUnsupportedClaims('我有五年后端经验。', ['负责订单与结算服务'])).toEqual(['5']);
    // 但「十分」是副词强度不是数：不误伤这一条，客套话才发得出去。
    expect(findUnsupportedClaims('这个岗位我十分感兴趣。', [])).toEqual([]);
  });

  it('裸数字也算一个数：年份、版本号都要出处，宁可回落模板也不放一个没依据的时间出去', () => {
    expect(findUnsupportedClaims('我 2019 年入职做后端。', ['负责订单与结算服务'])).toEqual(['2019']);
    expect(findUnsupportedClaims('第 1 个点想向您确认。', ['负责订单与结算服务'])).toEqual(['1']);
  });

  it('同一个数出现两次只报一条（读数进日志与界面，不该被刷屏）', () => {
    expect(findUnsupportedClaims('下降 40%，错误率也下降 40%。', [])).toEqual(['40']);
  });

  it('支撑面为空或全是空白：等价于没有任何依据，文案里的数全算无据', () => {
    expect(findUnsupportedClaims('服务 30 万用户。', ['', '   '])).toEqual(['300000']);
    expect(findUnsupportedClaims('服务 30 万用户。', [])).toEqual(['300000']);
  });

  it('不含数的文案永远放过，与支撑面无关（否则打招呼的客套句都会被拦）', () => {
    expect(findUnsupportedClaims('您好，想向您请教岗位的具体要求。', [])).toEqual([]);
  });
});
