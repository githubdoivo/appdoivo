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
  if (support === 'unsupported' || support === 'ios-add-home') {
    await showAlert(t('notif_unsupported_msg'));
    return false;
  }

  const permission = await Notification.requestPermission();
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
  const needsHomeScreen = state === 'ios-add-home';
  const isOn = state === 'granted' && (await isSubscribed());
  notifBtn.classList.toggle('active', isOn);
  const label = t(needsHomeScreen ? 'notif_ios_add_home' : isOn ? 'notif_on' : 'notif_enable');
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
        if (ok) {
          await showAlert(t('notif_enabled_msg'));
          // Push works in a plain browser tab too, but it's far more
          // reliable (and feels like a real app) once installed to the
          // home screen - worth a nudge right after someone opts in.
          if (!isStandalone()) {
            await showAlert(t(isIOS() ? 'notif_add_home_tip_ios' : 'notif_add_home_tip_other'));
          }
        }
      }
    } catch { /* mensagens tratadas acima */ }
    refreshNotifButton(btnId);
  });
}
