// Custom alert()/confirm() replacement - same overlay/card look as the
// tutorial (see .modal-overlay/.modal-card in styles.css), so admin actions
// and error messages don't drop a jarring unstyled browser dialog on top of
// the app's own aesthetic.
import { t } from './i18n.js';

let overlay, messageEl, actionsEl;

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay hidden';
  overlay.innerHTML = '<div class="modal-card" role="alertdialog" aria-modal="true"><p class="modal-message"></p><div class="modal-actions"></div></div>';
  document.body.appendChild(overlay);
  messageEl = overlay.querySelector('.modal-message');
  actionsEl = overlay.querySelector('.modal-actions');
}

/**
 * One sentence per line.
 *
 * Most of these messages are two short sentences - "this opens the next
 * moment and notifies everyone. continue?" - and left to wrap freely the
 * end of one and the start of the next share a line, which reads as a wall
 * rather than as a statement and a question. Splitting rather than styling,
 * for the same reason as the tour: no text-wrap setting puts a line break
 * at a sentence boundary.
 *
 * The element is already white-space: pre-line, so newlines are enough -
 * no markup, and textContent keeps the message unescaped-by-construction.
 */
function oneSentencePerLine(message) {
  return String(message ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function open(message, buttons) {
  build();
  messageEl.textContent = oneSentencePerLine(message);
  actionsEl.innerHTML = '';
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      overlay.classList.add('hidden');
      document.removeEventListener('keydown', onKeydown);
      resolve(value);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') finish(buttons.escapeValue);
    };
    buttons.list.forEach(({ label, value, variant, focus }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (variant) btn.classList.add(variant);
      btn.addEventListener('click', () => finish(value));
      actionsEl.appendChild(btn);
      if (focus) setTimeout(() => btn.focus(), 0);
    });
    document.addEventListener('keydown', onKeydown);
    overlay.classList.remove('hidden');
  });
}

/** Replaces window.alert(message) - resolves once dismissed. */
export function showAlert(message) {
  return open(message, {
    escapeValue: undefined,
    list: [{ label: t('modal_ok'), value: undefined, focus: true }],
  });
}

/** Replaces window.confirm(message) - resolves true/false.
 * Pass { danger: true } for destructive actions (matches the app's existing
 * red .danger button convention for delete/reset actions); otherwise confirm
 * gets the normal solid primary-button look. */
export function showConfirm(message, { danger = false } = {}) {
  return open(message, {
    escapeValue: false,
    list: [
      { label: t('modal_cancel'), value: false, variant: 'ghost', focus: true },
      { label: t('modal_confirm'), value: true, variant: danger ? 'danger' : undefined },
    ],
  });
}
