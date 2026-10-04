import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupI18n } from './i18n';
import './globals.css';
// 画布库的样式必须整体引入（不引则视口与连线不成形），这是 AGENTS.md §5.2 的第三方样式例外，
// 由 eslint 精确放行这一条字面量（spec 5.10-16）。节点卡片内部仍然只用 Tailwind utility。
import '@xyflow/react/dist/style.css';

setupI18n();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
