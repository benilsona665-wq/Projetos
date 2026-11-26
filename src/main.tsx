import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { applyThemeToDocument, getInitialTheme } from './hooks/useTheme.ts';
import './index.css';

applyThemeToDocument(getInitialTheme());

if (import.meta.env.PROD) {
  registerSW({
    immediate: true,
  });
} else if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) {
      reg.unregister().catch(() => {});
    }
  }).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
