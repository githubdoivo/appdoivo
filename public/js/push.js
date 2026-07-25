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

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/**
 * Estado das notificacoes: unsupported | ios-add-home | denied | default | granted.
 * No iOS, o Push API so existe depois de "Adicionar ao ecra principal" - nesse
 * caso distinguimos de um "unsupported" genuino para podermos guiar o utilizador.
 */
export function pushSupport() {
  const hasPushApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasPushApi) {
    return isIOS() && !isStandalone() ? 'ios-add-home' : 'unsupported';
  }
  return Notification.permission; // default | granted | denied
}

/** Pede permissao e subscreve o push. Devolve true se subscrito. */
export async function enablePush() {
  const support = pushSupport();
  if (support === 'unsupported' || support === 'ios-add-home') {
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

/** Updates a notif icon button (any page) to match current support/state. */
export function refreshNotifButton(btnId = 'notif-btn') {
  const notifBtn = document.getElementById(btnId);
  if (!notifBtn) return;
  const state = pushSupport();

  if (state === 'unsupported') {
    notifBtn.classList.add('hidden');
    return;
  }

  notifBtn.classList.remove('hidden');
  const isOn = state === 'granted';
  const needsHomeScreen = state === 'ios-add-home';
  notifBtn.classList.toggle('active', isOn);
  const label = t(needsHomeScreen ? 'notif_ios_add_home' : isOn ? 'notif_on' : 'notif_enable');
  notifBtn.title = label;
  notifBtn.setAttribute('aria-label', label);
}

/** Wires a notif icon button's click handler (any page). */
export function wireNotifButton(btnId = 'notif-btn') {
  const notifBtn = document.getElementById(btnId);
  if (!notifBtn) return;
  notifBtn.addEventListener('click', async () => {
    if (pushSupport() === 'granted') {
      alert(t('notif_already_on_msg'));
      return;
    }
    try {
      const ok = await enablePush();
      if (ok) alert(t('notif_enabled_msg'));
    } catch { /* mensagens tratadas acima */ }
    refreshNotifButton(btnId);
  });
}
