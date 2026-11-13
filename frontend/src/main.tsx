import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
// Schriften liegen im Panel selbst: kein Abruf bei Google (Datenschutz), sie
// laden schneller und stehen auch offline in der App bereit.
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-500.css';
import '@fontsource/rubik/latin-600.css';
import '@fontsource/rubik/latin-700.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/silkscreen/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

// Nach einem Panel-Update verweist eine noch offene Seite auf Pakete, die es
// nicht mehr gibt. Dann einmal neu laden – nicht in einer Schleife.
window.addEventListener('vite:preloadError', (event) => {
  let reloaded = false;
  try { reloaded = sessionStorage.getItem('mcpanel.reload') === '1'; } catch { /* ohne Speicher: einmal versuchen */ }
  if (reloaded) return;
  event.preventDefault();
  try { sessionStorage.setItem('mcpanel.reload', '1'); } catch { /* egal */ }
  window.location.reload();
});
window.addEventListener('load', () => {
  setTimeout(() => { try { sessionStorage.removeItem('mcpanel.reload'); } catch { /* egal */ } }, 10_000);
});

// PWA: Service Worker nur im Produktionsbuild registrieren –
// im Dev-Modus würde er HMR und frische Assets aus dem Cache verdrängen.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(async () => {
      // Alte Pakete früherer Versionen aus dem Offline-Speicher räumen.
      const ready = await navigator.serviceWorker.ready;
      ready.active?.postMessage('prune-assets');
    }).catch(() => {
      /* z. B. HTTP ohne localhost – App funktioniert trotzdem */
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
