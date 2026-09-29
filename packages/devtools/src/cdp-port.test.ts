/**
 * CDP 端口判定单测（spec 1.6-08 的纯逻辑部分）。
 *
 * 打包态在本机复现不出来（安装包要到 1.7 才有），所以「产物里没有远程调试入口」这条
 * 只能钉在规则上：闸门排在解析之前，开关值再合法也不看。
 */
import { describe, expect, it } from 'vitest';
import { resolveCdpPort } from './cdp-port.js';

describe('resolveCdpPort', () => {
  it('开发态按开关值给出端口', () => {
    expect(resolveCdpPort('10222', false)).toBe(10222);
  });

  it('打包态一律不开端口，无论开关里写了什么', () => {
    expect(resolveCdpPort('10222', true)).toBeNull();
    // 就算有人把开关塞进产物，这道闸门也不会开出远程调试入口。
    expect(resolveCdpPort('9222', true)).toBeNull();
  });

  it('没传开关与非法值都判定为未开启', () => {
    expect(resolveCdpPort('', false)).toBeNull();
    expect(resolveCdpPort('not-a-port', false)).toBeNull();
    expect(resolveCdpPort('1.5', false)).toBeNull();
    expect(resolveCdpPort('70000', false)).toBeNull();
    expect(resolveCdpPort('0', false)).toBeNull();
  });
});
