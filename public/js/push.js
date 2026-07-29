// Service worker registration and Web Push subscription.
import { api } from './api.js';
import { t } from './i18n.js';
import { showAlert } from './modal.js';

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
 * Estado das notificacoes: unsupported | needs-install | denied | default | granted.
 * Gated on being installed (standalone) everywhere, not just iOS - some
 * browsers would technically still support push in a plain tab, but the
 * experience is far less reliable there, so the message and the gate are
 * the same regardless of platform: install first, then notifications.
 */
export function pushSupport() {
  if (!isStandalone()) return 'needs-install';
  const hasPushApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasPushApi) return 'unsupported';
  return Notification.permission; // default | granted | denied
}

/**
 * Whether THIS device currently has an active push subscription. Distinct
 * from Notification.permission ('granted' can't be revoked by the site
 * once given - it stays granted even after we unsubscribe), so this is
 * the actual source of truth for the button's on/off state.
 */
async function isSubscribed() {
  if (Notification.permission !== 'granted') return false;
  const reg = swRegistration || (await registerServiceWorker());
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}

/** Pede permissao e subscreve o push. Devolve true se subscrito. */
export async function enablePush() {
  const support = pushSupport();
  if (support === 'needs-install') {
    await showAlert(t(isIOS() ? 'notif_needs_install_ios' : 'notif_needs_install_other'));
    return false;
  }
  if (support === 'unsupported') {
    await showAlert(t('notif_browser_unsupported_msg'));
    return false;
  }

  // Once denied, the browser resolves this instantly with no prompt - so
  // without this branch, a user who denied (or whose OS/browser denies by
  // default) got zero feedback on every future click: no prompt, no alert,
  // no state change. The button just looked dead.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    await showAlert(t('notif_denied_msg'));
    return false;
  }
  if (permission !== 'granted') return false;

  const { publicKey, enabled } = await api('/push/vapid-public-key');
  if (!enabled || !publicKey) {
    await showAlert(t('notif_server_msg'));
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

/** Unsubscribes this device. Notification.permission stays 'granted' (the
 * site can't revoke that), but no more pushes reach this device until
 * enablePush() runs again - which needs no new permission prompt. */
export async function disablePush() {
  const reg = swRegistration || (await registerServiceWorker());
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try { await api('/push/unsubscribe', { method: 'POST', body: { endpoint } }); } catch { /* best effort */ }
}

/** Updates a notif icon button (any page) to match current support/state. */
export async function refreshNotifButton(btnId = 'notif-btn') {
  const notifBtn = document.getElementById(btnId);
  if (!notifBtn) return;
  const state = pushSupport();

  if (state === 'unsupported') {
    notifBtn.classList.add('hidden');
    return;
  }

  notifBtn.classList.remove('hidden');
  const needsInstall = state === 'needs-install';
  const isOn = state === 'granted' && (await isSubscribed());
  notifBtn.classList.toggle('active', isOn);
  const label = t(needsInstall ? 'notif_needs_install_label' : isOn ? 'notif_on' : 'notif_enable');
  notifBtn.title = label;
  notifBtn.setAttribute('aria-label', label);
}

/** Wires a notif icon button's click handler (any page): a real toggle -
 * on while off enables, on while on disables (see disablePush()). */
export function wireNotifButton(btnId = 'notif-btn') {
  const notifBtn = document.getElementById(btnId);
  if (!notifBtn) return;
  notifBtn.addEventListener('click', async () => {
    try {
      if (await isSubscribed()) {
        await disablePush();
        await showAlert(t('notif_disabled_msg'));
      } else {
        const ok = await enablePush();
        if (ok) await showAlert(t('notif_enabled_msg'));
      }
    } catch { /* mensagens tratadas acima */ }
    refreshNotifButton(btnId);
  });
}
