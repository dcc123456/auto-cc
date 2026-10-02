/**
 * 「工具 id + 入参」的原文切法（spec 1.11-14 与 5.2-01 共用）。
 *
 * 抽出来之前它长在 `session.ts` 的 `parseToolRequest` 里，只有 `/tool` 那一条路用它；
 * 5.2-a 的桩模型要从自由文本里认出被点名的工具，同一段切法就是第二次出现（AGENTS.md §2.2），
 * 于是各写一份「怎么从文本里抠出 JSON」这种细节从此不许再有。
 */

/** 从 `index` 起扫出一段**配平的** JSON 对象文本（只认对象，不认裸值）。 */
function sliceJsonObject(text: string, index: number): string | null {
  if (text[index] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(index, cursor + 1);
    }
  }
  return null;
}

/**
 * 把「工具 id 后面跟一段文本」切成 id 与入参。
 * @param raw 已经去掉前缀与空白的原文（例如 `kb.profile.search {"query":"订单"}`）
 * @returns `toolId` 为空串表示只给了前缀没指名；入参不是合法 JSON 时**把原始字符串照交**，
 *   由注册表的 schema 回 `TOOL_INPUT_INVALID`——这里不另造一套入参校验（AGENTS.md §2.6）
 */
export function splitToolRequest(raw: string): { toolId: string; input: unknown } {
  if (!raw) return { toolId: '', input: {} };
  const spaceAt = raw.search(/\s/);
  const toolId = spaceAt === -1 ? raw : raw.slice(0, spaceAt);
  const rest = spaceAt === -1 ? '' : raw.slice(spaceAt + 1).trim();
  if (!rest) return { toolId, input: {} };
  try {
    return { toolId, input: JSON.parse(rest) as unknown };
  } catch {
    return { toolId, input: rest };
  }
}

/**
 * 按**出现顺序**找出一段自由文本里点名的已知工具，并就地抠出它后面的入参对象。
 *
 * 只认「注册表里真有这只手」的字面 id，不做任何模糊匹配或意图猜测（与 5.1-05 同一口径）：
 * 桩模型因此不会凭措辞凭空造出一只工具，界面演示的每一步都能在表上对上号。
 * @param text 用户原文
 * @param knownToolIds 注册表现读出来的 id 清单（顺序无关，本函数按文本里的位置排）
 * @returns 每项含 id 与入参；同一位置有前后缀关系的取更长的那个
 */
export function findNamedTools(text: string, knownToolIds: readonly string[]): { toolId: string; input: unknown }[] {
  const found: { toolId: string; after: number }[] = [];
  // 从左到右扫，每个位置取**最长**的那只命中的 id：`a.b` 与 `a.b.c` 都从同一点起时，被点名的是后者。
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    let matched = '';
    for (const toolId of knownToolIds) {
      if (toolId.length > matched.length && text.startsWith(toolId, cursor)) matched = toolId;
    }
    if (matched) {
      found.push({ toolId: matched, after: cursor + matched.length });
      cursor = cursor + matched.length - 1;
    }
  }
  return found.map((entry) => {
    const rest = text.slice(entry.after).trimStart();
    const json = sliceJsonObject(rest, 0);
    if (!json) return { toolId: entry.toolId, input: {} };
    try {
      return { toolId: entry.toolId, input: JSON.parse(json) as unknown };
    } catch {
      return { toolId: entry.toolId, input: rest };
    }
  });
}
