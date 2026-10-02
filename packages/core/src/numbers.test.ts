/**
 * 数值抽取与守恒比对的口径测试（原属 spec 4.5-04，随实现上移到 core 后一并搬来）。
 *
 * 这一份用例钉的是**口径**而不是"函数没写错"：哪些串算一个数、量级怎么折、副词强度读法为什么不算。
 * 两个消费者（4.5-08 的数值守恒、4.6-02 的话术无据断言）都按这份口径判，
 * 所以口径变了必须在这里先红一次，而不是在某个下游的界面上表现成"莫名拦下了正常话术"。
 */
import { describe, expect, it } from 'vitest';
import { chineseNumeralToNumber, diffNumberMultiset, numberKeyOf, numbersOf } from './numbers.js';

describe('4.5-04 数值抽取的归一化口径', () => {
  it('阿拉伯数字带量级、千分位、小数都按数值读，百分号不进比对', () => {
    expect(numbersOf('主导订单服务重构，P99 延迟下降 40%。')).toEqual([99, 40]);
    expect(numbersOf('月下载 2 万次')).toEqual([20000]);
    expect(numbersOf('管理 1,000 台机器，成本 3.5 万元')).toEqual([1000, 35000]);
  });

  it('中文数词只在紧跟量词时算一个数，副词强度读法不误报', () => {
    expect(numbersOf('三年后端经验')).toEqual([3]);
    expect(numbersOf('十分匹配岗位要求，万分感谢')).toEqual([]);
    expect(numbersOf('二十万人关注，百万级请求')).toEqual([200000, 1000000]);
  });

  it('中文数词解析覆盖十进制组合', () => {
    expect(chineseNumeralToNumber('二十三')).toBe(23);
    expect(chineseNumeralToNumber('两万')).toBe(20000);
    expect(chineseNumeralToNumber('百万')).toBe(1000000);
    expect(chineseNumeralToNumber('一百二十')).toBe(120);
  });

  it('多重集比对能抓到"少一个数"和"多一个数"两个方向', () => {
    expect(diffNumberMultiset('延迟下降 40%', '延迟大幅下降')).toEqual({ missing: ['40'], added: [] });
    expect(diffNumberMultiset('延迟下降 40%', '延迟下降 50%')).toEqual({ missing: ['40'], added: ['50'] });
    // 两个 40% 改写成一个 40%：集合口径会放行，多重集口径必须抓到（基线里的第二条没被消耗）
    expect(diffNumberMultiset('下降 40%，复用率 40%', '下降 40%')).toEqual({ missing: ['40'], added: [] });
  });

  it('量级折进数值之后，两种写法落在同一个键上（4.6-02 靠这一点判出处）', () => {
    expect(numberKeyOf(20000)).toBe('20000');
    expect(diffNumberMultiset('月下载 2 万次', '月下载 20000 次')).toEqual({ missing: [], added: [] });
    expect(diffNumberMultiset('服务过 30 万用户', '服务了 300000 人')).toEqual({ missing: [], added: [] });
  });

  it('无量词的裸数字也照样算一个数（年份、版本号都在内——出处判据因此是严格的）', () => {
    // 这条刻意为 4.6-02 服务：模型写「2019 年入职」而依据里没有 2019，就是编时间，必须能被抓到。
    expect(diffNumberMultiset('负责订单服务', '我 2019 年入职负责订单服务').added).toEqual(['2019']);
  });
});
