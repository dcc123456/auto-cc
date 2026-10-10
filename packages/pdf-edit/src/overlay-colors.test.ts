/**
 * 覆盖区配色的单测（spec 3.5-14 的 U 半边）。
 *
 * 判据全部是**纯数**：中位数抗不抗得住相邻行的墨迹、量不到时是不是老实回落墨色而不是猜白、
 * 外部递进来的颜色字符串形状对不对。这些都不需要画布，也不需要 Electron——
 * 「画面上看不出是覆盖」那半边是 V 判据，按 §7.1 走活体截图，本文件不假装收掉它。
 */
import { describe, expect, it } from 'vitest';
import { backdropOfBand, colorsOfOverlay, normalizeHexColor, type BackdropBand } from './overlay-colors.js';

/**
 * 造一条环带：整圈是一种颜色，中央那块盒子是另一种（模拟"行盒里是字、盒外是纸"）。
 * @param band 尺寸与内沿
 * @param ring 圈上的颜色
 * @param inner 盒里的颜色
 * @param ink 要额外洒在圈上的墨点（相邻行的字，逐通道取负差即可）
 * @returns 可直接交给 `backdropOfBand` 的取样输入
 */
function bandOf(
  band: { width: number; height: number; innerX: number; innerY: number; innerWidth: number; innerHeight: number },
  ring: readonly [number, number, number],
  inner: readonly [number, number, number],
  ink: readonly (readonly [number, number, number])[] = [],
): BackdropBand {
  const data = new Uint8ClampedArray(band.width * band.height * 4);
  const put = (x: number, y: number, [red, green, blue]: readonly [number, number, number]) => {
    const offset = (y * band.width + x) * 4;
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < band.height; y += 1) {
    for (let x = 0; x < band.width; x += 1) {
      const inBox =
        x >= band.innerX && x < band.innerX + band.innerWidth && y >= band.innerY && y < band.innerY + band.innerHeight;
      put(x, y, inBox ? inner : ring);
    }
  }
  for (const [index, colour] of ink.entries()) {
    // 按行主序洒（先从带子顶边往下铺满一行再换行）：相邻行的墨迹在真纸面上就是连着压住圈的上沿几条像素，
    // 而不是随机散点——随机散点会让中位数也站不住，那种对照测不出判据的差别。
    put(index % band.width, Math.floor(index / band.width), colour);
  }
  return { data, ...band, stepPx: 1, minSamples: 8 };
}

describe('normalizeHexColor：跨进程递来的颜色只认 `#rrggbb`', () => {
  it('大写入参归一成小写，画布与 pdf-lib 两条腿拿到的是同一个字面量', () => {
    expect(normalizeHexColor('#ABCDEF')).toBe('#abcdef');
  });

  it('形状不对的一律 undefined（名字色、三位缩写、带 alpha、非字符串都不算量到了）', () => {
    for (const value of ['red', '#fff', '#ffffff00', '#12345', '#1234567', '#gggggg', 3, null, undefined]) {
      expect(normalizeHexColor(value)).toBeUndefined();
    }
  });
});

describe('colorsOfOverlay：量到了就用纸色，量不到按墨色垫底并且把新字反白', () => {
  it('量到的那一支：垫底就是它，墨色仍是默认的深墨', () => {
    const colors = colorsOfOverlay({ backdropHex: '#f4ecd8' });
    expect(colors).toEqual({
      fillHex: '#f4ecd8',
      fillRgb01: [0xf4 / 255, 0xec / 255, 0xd8 / 255],
      inkHex: '#0f172a',
      inkRgb01: [0x0f / 255, 0x17 / 255, 0x2a / 255],
      sampled: true,
    });
  });

  it('没量到的那一支：垫底换成墨、字换成纸白，`sampled:false` 让界面上那句话说得出条数', () => {
    expect(colorsOfOverlay({})).toMatchObject({ fillHex: '#111111', inkHex: '#f8fafc', sampled: false });
    // 形状坏了等同"没量到"：宁可难看，也不许悄悄拿纯白去猜一张不是白底的纸。
    expect(colorsOfOverlay({ backdropHex: '#fff' })).toMatchObject({ fillHex: '#111111', sampled: false });
  });
});

describe('backdropOfBand：从行盒外那一圈定出纸的底色', () => {
  /** 一条 40×12 的带子，中央 30×6 是行盒。 */
  const geometry = { width: 40, height: 12, innerX: 5, innerY: 3, innerWidth: 30, innerHeight: 6 };

  it('盒子里是黑字也不要紧：量的是盒外那一圈，回的是纸色', () => {
    expect(backdropOfBand(bandOf(geometry, [244, 236, 216], [10, 10, 10]))).toBe('#f4ecd8');
  });

  it('圈的上沿被相邻行的墨迹压住两行（那一圈 12.5% 的像素）——中位数不动，平均值被拉灰（这就是判据不取平均的理由）', () => {
    const wide = { width: 60, height: 20, innerX: 10, innerY: 3, innerWidth: 40, innerHeight: 6 };
    const ink = Array.from({ length: 120 }, () => [0, 0, 0] as [number, number, number]);
    const band = bandOf(wide, [255, 250, 240], [12, 12, 12], ink);
    expect(backdropOfBand(band)).toBe('#fffaf0');
    // 同一圈像素按平均算：红通道 255 → 223（实测），拿它去垫底就是一块比纸暗一档的灰补丁，
    // 一圈叠一圈就能看出"这里盖过东西"——本轮要消掉的正是这个。
    expect(Math.round(meanOfRing(band)[0])).toBe(223);
  });

  it('带子整个被盒子占满（取样不足）时回 undefined，由调用方走那句诚实回落', () => {
    const filled = bandOf(
      { ...geometry, innerX: 0, innerY: 0, innerWidth: geometry.width, innerHeight: geometry.height },
      [1, 2, 3],
      [9, 9, 9],
    );
    expect(backdropOfBand(filled)).toBeUndefined();
  });

  it('透明像素不是纸：整圈都还没被位图铺上时回 undefined', () => {
    const band = bandOf(geometry, [255, 255, 255], [0, 0, 0]);
    for (let index = 3; index < band.data.length; index += 4) {
      (band.data as Uint8ClampedArray)[index] = 0;
    }
    expect(backdropOfBand(band)).toBeUndefined();
  });

  it('带子尺寸无效（画布还没画过）时回 undefined 而不是抛', () => {
    expect(
      backdropOfBand({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
        innerX: 0,
        innerY: 0,
        innerWidth: 0,
        innerHeight: 0,
        stepPx: 1,
        minSamples: 8,
      }),
    ).toBeUndefined();
  });
});

/**
 * 环带里**圈上**那些像素的逐通道平均值（对照用：本文件要证明"取平均会得到发灰的底色"）。
 * @param band 一条环带
 * @returns 三个通道的平均值
 */
function meanOfRing(band: BackdropBand): [number, number, number] {
  const totals: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < band.height; y += 1) {
    for (let x = 0; x < band.width; x += 1) {
      const inBox =
        x >= band.innerX && x < band.innerX + band.innerWidth && y >= band.innerY && y < band.innerY + band.innerHeight;
      if (inBox) continue;
      const offset = (y * band.width + x) * 4;
      totals[0] += band.data[offset] ?? 0;
      totals[1] += band.data[offset + 1] ?? 0;
      totals[2] += band.data[offset + 2] ?? 0;
      count += 1;
    }
  }
  return count === 0 ? totals : [totals[0] / count, totals[1] / count, totals[2] / count];
}
