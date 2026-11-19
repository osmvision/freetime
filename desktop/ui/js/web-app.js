import { h, toast } from './dom.js';

let installPrompt;

export async function installApp() {
  if (!installPrompt) {
    toast('Use your browser menu to add freetime to your home screen. On iPhone, open Share, then Add to Home Screen.', 'info', 9000);
    return;
  }
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
}

export async function initWebApp() {
  const manifest = h('link', { rel: 'manifest', href: '/manifest.webmanifest' });
  document.head.append(manifest,
    h('meta', { name: 'theme-color', content: '#0d1b3d' }),
    h('link', { rel: 'apple-touch-icon', href: '/icon-192.png' }));
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => toast('Offline cache could not be prepared. You can keep using the web app.'));
  }
  window.addEventListener('offline', () => toast('You are offline. Reconnect to load new picks and messages.', 'info', 6000));
  window.addEventListener('online', () => toast('Connection restored', 'ok'));
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
  });
}
