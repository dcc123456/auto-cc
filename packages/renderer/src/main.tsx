import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupI18n } from './i18n';
import './globals.css';

setupI18n();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
