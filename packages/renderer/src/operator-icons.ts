/**
 * 算子图标名 → lucide 组件（spec 5.10-03 的「节点渲染由描述表派生」里那一小段查表）。
 *
 * 描述表在 `@auto-cc/core`，那里不能出现 JSX（core 是 L0 内核层，AGENTS.md §4.1），
 * 所以表里存的是图标**名**，渲染层按名查这一张表——图标仍然只有 lucide 一个来源（§5.3）。
 */
import {
  Circle,
  FileText,
  GitBranch,
  List,
  MessageSquare,
  RotateCcw,
  Search,
  Send,
  type LucideIcon,
} from 'lucide-react';

/** 已用过的图标名；新增算子时在这里补一行，别在描述表里写组件。 */
const ICON_BY_NAME: Readonly<Record<string, LucideIcon>> = {
  search: Search,
  list: List,
  'message-square': MessageSquare,
  send: Send,
  'file-text': FileText,
  'rotate-ccw': RotateCcw,
  'git-branch': GitBranch,
};

/**
 * 按描述表里的图标名取 lucide 组件。
 * @param iconName `OperatorDescriptor.icon` 的值（kebab-case）
 * @returns 对应图标；名字没登记过则退回 `Circle`——一格画不出图标比画成空心圆更容易被误当成崩溃
 */
export function operatorIconOf(iconName: string): LucideIcon {
  return ICON_BY_NAME[iconName] ?? Circle;
}
