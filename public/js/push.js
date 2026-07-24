// Service worker registration and Web Push subscription.
import { api } from './api.js';
import { t } from './i18n.js';

let swRegistration = null;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  swRegistration = await navigator.serviceWorker.register('/sw.js');
  return swRegistration;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Estado das notificacoes: unsupported | denied | default | granted. */
export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission; // default | granted | denied
}

/** Pede permissao e subscreve o push. Devolve true se subscrito. */
export async function enablePush() {
  if (pushSupport() === 'unsupported') {
    alert(t('notif_unsupported_msg'));
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const { publicKey, enabled } = await api('/push/vapid-public-key');
  if (!enabled || !publicKey) {
    alert(t('notif_server_msg'));
    return false;
  }

  const reg = swRegistration || (await registerServiceWorker());
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await api('/push/subscribe', { method: 'POST', body: { subscription } });
  return true;
}
