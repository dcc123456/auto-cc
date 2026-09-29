/**
 * CDP 端口读数（spec 1.6-01 / 1.6-08 的判定依据）。
 *
 * 单独成文件是为了让这段判断能在 Node 里直接测：它决定「打包版有没有远程调试入口」，
 * 而打包态在本机跑不出来（1.7 才出安装包），所以把规则抽成纯函数钉住，而不是等真机。
 */

/** 端口合法区间；超界或非数字一律视为「没开」。 */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * 由命令行开关值与打包标记推出实际 CDP 端口。
 * @param switchValue `remote-debugging-port` 的原始值，未传时为空串
 * @param isPackaged 是否打包态——打包态**一律**返回 null，不看开关
 * @returns 生效端口，未开启为 null
 */
export function resolveCdpPort(switchValue: string, isPackaged: boolean): number | null {
  // 打包闸门排在解析之前：这是结构性保证，产物里就算被塞进开关也不会开出端口。
  if (isPackaged) return null;
  const port = Number(switchValue);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}
