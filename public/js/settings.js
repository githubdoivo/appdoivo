import { api, getToken, setToken, clearToken } from './api.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode, syncThemeColor } from './theme.js';
import { registerServiceWorker, refreshNotifButton, wireNotifButton } from './push.js';
import { wireLogoEasterEgg } from './logoEasterEgg.js';
import { wirePasswordToggle } from './passwordToggle.js';
import { wireVersionBadge } from './version.js';
import { showAlert, showConfirm } from './modal.js';
import { resizePhotoToJpeg } from './photo.js';
import { formatEuDate, formatEuDateTime, formatTimeInZone } from './time.js';

// See the matching comment in app.js - stops an installed iOS PWA from
// restoring a stale scroll position when its backgrounded WKWebView is
// resumed instead of freshly loaded.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Same linkify() as app.js - kept here rather than a shared import since
// this file already keeps its own local esc() the same way. See app.js
// for why the regex requires "/path" on a bare domain.
const URL_RE = /\b(?:https?:\/\/[^\s<]+|www\.[^\s<]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<]*)/gi;
function linkify(escapedText) {
  return escapedText.replace(URL_RE, (match) => {
    let trail = '';
    const trailMatch = match.match(/[.,;:!?)\]}]+$/);
    if (trailMatch) {
      trail = trailMatch[0];
      match = match.slice(0, -trail.length);
    }
    const href = /^https?:\/\//i.test(match) ? match : `https://${match}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${match}</a>${trail}`;
  });
}

/** Copies text to the clipboard and gives brief feedback on the button. */
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignora */ }
    document.body.removeChild(ta);
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = t('copied');
    setTimeout(() => (btn.textContent = prev), 1200);
  }
}

let adminPromotionEnabled = false;
// Golden rule: nobody but the owner sees other users' access keys, so
// non-owner admins ("testers") don't get the Manage Users tab at all.
let isOwner = false;
let isAdmin = false;
let plazaEnabled = false;
let memoEnabled = false;
let myUserId = null;
let myName = '';

// Your own name, role and access key, click-to-reveal/copy same as a row
// in Manage Users below - the token itself never needs a server round-trip,
// it's already what's in localStorage (see getToken() in api.js).
function renderAccountCard() {
  $('account-name').textContent = myName;
  $('account-role-badge').className = `badge ${isOwner ? 'role-owner' : isAdmin ? 'role-admin' : 'role-user'}`;
  $('account-role-badge').textContent = isOwner ? 'owner' : isAdmin ? 'admin' : 'user';
  const tokenEl = $('account-token');
  tokenEl.dataset.token = getToken();
  const toggle = async () => {
    const revealed = tokenEl.classList.toggle('censored') === false;
    tokenEl.textContent = revealed ? tokenEl.dataset.token : '••••••••••••';
    await copyToClipboard(tokenEl.dataset.token);
    tokenEl.classList.add('just-copied');
    setTimeout(() => tokenEl.classList.remove('just-copied'), 600);
  };
  tokenEl.addEventListener('click', toggle);
  tokenEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}

// renderAccountCard() only ever runs once at boot, so without this the
// account card kept showing/copying the OLD key after a self-service
// change (see wireChangeKeyForm()) - one that no longer even works to log
// in - until a full page reload synced it back up.
function refreshAccountToken() {
  const tokenEl = $('account-token');
  tokenEl.dataset.token = getToken();
  if (!tokenEl.classList.contains('censored')) tokenEl.textContent = tokenEl.dataset.token;
}

async function boot() {
  window.scrollTo(0, 0);
  applyMode();
  applyI18n();
  updateLangUI();
  wireVersionBadge();
  await registerServiceWorker().catch(() => {});
  // Not authenticated (no token, or one the server no longer accepts) -
  // land on the actual login page, same as the main app does on a failed
  // /me (see boot() in app.js). This used to just print an error message
  // here and leave the visitor stranded on a dead-end admin page with no
  // way back in except manually navigating to "/" themselves.
  if (!getToken()) {
    location.href = '/';
    return;
  }
  let me;
  try {
    me = await api('/me');
    adminPromotionEnabled = !!me.adminPromotionEnabled;
    isOwner = !!me.isOwner;
    isAdmin = !!me.isAdmin;
    plazaEnabled = !!me.plazaEnabled;
    memoEnabled = !!me.memoEnabled;
    myUserId = me.id;
    myName = me.name;
    // Feeds the off-screen autocomplete="username" anchor in the change-key
    // form (see settings.html) - Safari needs a username to pair with the
    // saved password, and giving it one here is what keeps it off the
    // user-search box.
    $('change-key-username').value = me.name;
    wireLogoEasterEgg(me.name, me.logo_customized);
    renderAccountCard();
  } catch {
    clearToken();
    location.href = '/';
    return;
  }

  // Plaza is mid-rebuild (single note -> real posts feed), so it's
  // QA-only for now (see ENABLE_PLAZA in src/routes.js) - hidden for
  // everyone, owner included, regardless of the role-based rules below.
  if (!plazaEnabled) {
    document.querySelector('#admin-tabs [data-atab="plaza"]').classList.add('hidden');
  }
  // Same QA-only gating shape as Plaza above, see ENABLE_MEMO.
  if (!memoEnabled) {
    document.querySelector('#admin-tabs [data-atab="memo"]').classList.add('hidden');
  }

  // This page is now open to every logged-in user, not just admins - a
  // plain user only gets the "Settings" tab (change their own key, no
  // user-management section); the rest of this scoping matches the main
  // admin panel's existing rules.
  if (!isAdmin) {
    ['plaza', 'outfit', 'rata', 'wall', 'memo'].forEach((tab) => {
      document.querySelector(`#admin-tabs [data-atab="${tab}"]`).classList.add('hidden');
    });
    $('users-management').classList.add('hidden');
  } else {
    // User management now lives inside Settings (below change-key), not
    // its own tab - owner-only. A regular (non-owner) admin only ever gets
    // their own row back from the API (see GET /admin/users), with no
    // actions on it either (rename/regenerate/promote are all owner-gated
    // further down) - that's just a read-only duplicate of the account
    // card already at the top of this page, not a useful section.
    $('users-management').classList.toggle('hidden', !isOwner);
    // The Plaza admin tab (pseudonym mapping, internal id "wall") is
    // owner-only and no longer a normal tab bar entry at all (see the
    // permanently-hidden button in settings.html) - the only way in is the
    // near-invisible star at the end of atab-memo, itself only shown to
    // the owner.
    $('wall-secret-btn').classList.toggle('hidden', !isOwner);
    $('votelog-secret-btn').classList.toggle('hidden', !isOwner);
    // Owner-only, and only when Memo is on at all - it fires a push to
    // every guest (see POST /admin/memo/trigger-next).
    $('memo-trigger-card').classList.toggle('hidden', !(isOwner && memoEnabled));
    if (!isOwner) {
      // Any admin - not just the owner - can post to Plaza (see requireAdmin
      // on POST /admin/plaza-posts), so the tab stays visible.
      // Per-feature kill switches (see POST /admin/consequences/wipe etc.)
      // are owner-only, same golden rule as everything else destructive.
      // chat-wipe-card doesn't need listing here - it lives inside the
      // wall tab, already hidden above.
      ['rata-wipe-card', 'outfit-wipe-card', 'plaza-wipe-card', 'memo-wipe-card'].forEach((id) => {
        $(id).classList.add('hidden');
      });
      // Contestant creation/removal is owner-only too (see requireOwner on
      // POST /admin/contestants/register and DELETE /admin/contestants/:id)
      // - a regular admin still sees the contestants list itself (search +
      // table), just not the form or the remove button on each row.
      $('admin-register-form').classList.add('hidden');
    }
  }
  // Whoever you are, tapping the settings icon should always land you on
  // "Settings" first - admins/owner can still switch to their other tabs.
  selectAdminTab('settings');
  $('admin-content').classList.remove('hidden');
  window.scrollTo(0, 0);
  refreshNotifButton('notif-btn');
  wireChangeKeyForm();
  if (isAdmin) reloadAll();
  startRoleWatcher();
}

// Polls /me every 30s for a role change (promoted, demoted, or removed
// entirely) made by the owner while this page is already open - same
// mechanism as app.js's own watcher. Losing admin access entirely sends
// them back to the main app's landing tab (Wall) instead of reloading
// into a stripped-down view of a page they no longer have a reason to be
// on - no need to log out, just stop looking at admin pages. Any other
// change (promoted, or still admin but owner status differs) reloads in
// place so the newly-available tabs/content show up.
let roleWatchTimer = null;
function startRoleWatcher() {
  if (roleWatchTimer) return;
  roleWatchTimer = setInterval(async () => {
    try {
      const fresh = await api('/me');
      const freshIsAdmin = !!fresh.isAdmin;
      const freshIsOwner = !!fresh.isOwner;
      if (freshIsAdmin !== isAdmin || freshIsOwner !== isOwner) {
        if (isAdmin && !freshIsAdmin) {
          location.href = '/';
          return;
        }
        location.reload();
      }
    } catch (err) {
      if (err.status === 401) {
        clearToken();
        location.reload();
      }
    }
  }, 30000);
}

function reloadAll() {
  loadVotingState();
  // Manage Users is owner-only now (see boot()) - skip the fetch entirely
  // for a regular admin rather than pulling a list that's never shown.
  if (isOwner) loadUsers();
  loadContestants();
  loadVotes();
  loadConsequences();
  // Both build their rows' text (button labels, column headers) via t()
  // at render time rather than data-i18n attributes applyI18n() can walk,
  // so a language switch left them stuck in whichever language was active
  // the last time they were fetched until this call was added.
  if (isOwner) loadWallPseudonyms();
  if (isAdmin) loadPlazaPosts();
  if (isAdmin && memoEnabled) loadMemoDays();
}

/* -------------------------------- Idioma --------------------------------- */
// Single square button, like the theme toggle: shows the language that's
// currently active, not the one it switches to.

function updateLangUI() {
  $('lang-toggle').textContent = getLang();
}

$('theme-toggle').addEventListener('click', () => toggleMode());
wireNotifButton('notif-btn');

$('logout-btn').addEventListener('click', () => {
  clearToken();
  location.href = '/';
});

$('lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'pt' ? 'en' : 'pt');
  applyI18n();
  updateLangUI();
  if (!$('admin-content').classList.contains('hidden')) reloadAll();
});

/* ------------------------------ Votacao ---------------------------------- */

// Night currently selected in the panel (scope of controls/contestants/votes).
function currentNight() {
  return $('admin-night-switch')?.querySelector('.active')?.dataset.night || 'furnished';
}

// Mirrors applyNight() in app.js so the admin page's action buttons/accents
// pick up the same per-section colour as their guest-facing counterpart
// (see the shared button-tint rules in styles.css) instead of everything
// staying on the default ink/paper palette regardless of which admin tab
// is open. Theme classes follow the DISPLAYED feature, not the internal
// tab id - see index.html's tab nav comment for the plaza/wall naming swap.
function applyAdminTheme(tab) {
  const night = currentNight();
  const outfitLike = tab === 'outfit' || tab === 'votelog';
  document.body.classList.toggle('theme-furnished', outfitLike && night === 'furnished');
  document.body.classList.toggle('theme-swamp', outfitLike && night === 'swamp');
  document.body.classList.toggle('theme-rata', tab === 'rata');
  document.body.classList.toggle('theme-mural', tab === 'plaza');
  document.body.classList.toggle('theme-plaza', tab === 'wall');
  document.body.classList.toggle('theme-memo', tab === 'memo');
  // Each admin tab carries its section's colour, so the status bar follows
  // it here the same way it does in the main app.
  syncThemeColor();
}

// Latest /admin/voting response per night, keyed by night - lets the close
// warning below (see the voting-advance-btn handler) reuse what
// loadVotingState() already fetched instead of a redundant request.
let votingStateCache = {};

// The chosen night is remembered, and remembered in the same place the
// guest-facing app keeps it (NIGHT_KEY in app.js), so the two pages agree.
// It used to live only in which button carried .active, which reset to
// furnished on every load - on a swamp night that meant reaching for the
// switch again after every single page open.
const NIGHT_KEY = 'appivo_night';
const NIGHTS = ['furnished', 'swamp'];

function setAdminNight(night) {
  const chosen = NIGHTS.includes(night) ? night : NIGHTS[0];
  localStorage.setItem(NIGHT_KEY, chosen);
  $('admin-night-switch').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.night === chosen);
  });
}

setAdminNight(localStorage.getItem(NIGHT_KEY));

$('admin-night-switch').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setAdminNight(btn.dataset.night);
    applyAdminTheme('outfit');
    loadVotingState();
    loadContestants();
    loadVotes();
  });
});

// What clicking "reveal next" will do, keyed by the *current* phase.
const NEXT_REVEAL_LABEL = {
  hidden: 'reveal_next_btn_third',
  third: 'reveal_next_btn_second',
  second: 'reveal_next_btn_first',
  first: 'reveal_next_btn_all',
  all: 'reveal_next_btn_done',
};

const VOTING_STATE_LABEL = {
  registration: 'voting_is_registration',
  open: 'voting_is_open',
  closed: 'voting_is_closed',
};

// One button drives every stage in order - registration -> open -> closed
// -> reveal 3rd -> 2nd -> 1st -> all - instead of four separate buttons for
// stages that never happen out of order anyway. Its label always names the
// NEXT thing a click will do; a separate reset button is the only way back.
async function loadVotingState() {
  const { nights } = await api('/admin/voting');
  nights.forEach((n) => { votingStateCache[n.night] = n; });
  const night = currentNight();
  const info = nights.find((n) => n.night === night) || {};
  const status = info.status || 'closed';
  const started = !!info.started;
  const phase = info.resultsPhase || 'hidden';

  const label = $('voting-state-label');
  label.textContent = t(VOTING_STATE_LABEL[status]);
  label.classList.toggle('is-registration', status === 'registration');
  label.classList.toggle('is-open', status === 'open');
  label.classList.toggle('is-closed', status === 'closed');

  const btn = $('voting-advance-btn');
  if (!started) {
    btn.textContent = t('voting_start_btn');
    btn.dataset.action = 'registration';
    btn.disabled = false;
  } else if (status === 'registration') {
    btn.textContent = t('voting_open_btn');
    btn.dataset.action = 'open';
    btn.disabled = false;
  } else if (status === 'open') {
    btn.textContent = t('voting_close_btn');
    btn.dataset.action = 'close';
    btn.disabled = false;
  } else {
    btn.textContent = t(NEXT_REVEAL_LABEL[phase]);
    btn.dataset.action = phase === 'all' ? '' : 'reveal-next';
    btn.disabled = phase === 'all';
  }
}

// Every stage transition here is either hard to undo (reveal-next: no way
// back once a rank is shown) or disruptive mid-event (open/close/registration
// affect everyone's screen at once) - one stray tap on a phone during a
// party is enough to trigger any of them, so all four get a plain
// "are you sure" first, on top of (not instead of) the more specific
// warnings below for the cases that have one.
const GENERIC_CONFIRM = {
  registration: 'confirm_voting_registration',
  open: 'confirm_voting_open',
  close: 'confirm_voting_close',
  'reveal-next': 'confirm_voting_reveal_next',
};

$('voting-advance-btn').addEventListener('click', async () => {
  const action = $('voting-advance-btn').dataset.action;
  if (!action) return;
  $('voting-msg').textContent = '';
  const genericKey = GENERIC_CONFIRM[action];
  if (genericKey && !(await showConfirm(t(genericKey)))) return;
  // Closing while some accounts never voted at all leaves them out with no
  // way back - unlike the two 409 cases below (which the server itself
  // refuses so a stray API call can't skip them either), this is purely
  // advisory: the organiser very often doesn't vote themselves, so it can't
  // be a hard requirement, just a heads-up before the number of people who
  // could still vote goes to zero. Checked client-side against data
  // loadVotingState() already fetched, rather than gating /close itself.
  if (action === 'close') {
    const notVoted = votingStateCache[currentNight()]?.notVoted ?? 0;
    if (notVoted > 0) {
      const ok = await showConfirm(t(notVoted === 1 ? 'confirm_close_not_voted_one' : 'confirm_close_not_voted_other', { n: notVoted }));
      if (!ok) return;
    }
  }
  try {
    await api(`/admin/voting/${currentNight()}/${action}`, { method: 'POST' });
  } catch (err) {
    // Two ways an advance can strand a half-finished duo: opening the
    // voting locks out entries the partner never confirmed, closing it
    // locks out votes the partner never confirmed. Either way the server
    // refuses once (409) with the count, so this can name the number
    // rather than warn vaguely; confirming re-sends with force.
    const PENDING_CONFIRM = {
      err_pending_duo_entries: ['confirm_open_pending_one', 'confirm_open_pending_other'],
      err_pending_duo_votes: ['confirm_close_pending_one', 'confirm_close_pending_other'],
    };
    const keys = PENDING_CONFIRM[err.data?.error];
    if (err.status === 409 && keys) {
      const n = err.data.pending;
      const ok = await showConfirm(t(n === 1 ? keys[0] : keys[1], { n }));
      if (!ok) return;
      try {
        await api(`/admin/voting/${currentNight()}/${action}`, { method: 'POST', body: { force: true } });
      } catch (forced) {
        $('voting-msg').textContent = forced.message;
        return;
      }
    } else {
      $('voting-msg').textContent = err.message;
      return;
    }
  }
  loadVotingState();
  loadVotes();
  loadContestants();
});

$('voting-runoff-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_voting_runoff')))) return;
  $('voting-msg').textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/runoff`, { method: 'POST' });
    loadVotingState();
    loadVotes();
  } catch (err) {
    $('voting-msg').textContent = err.message;
  }
});

$('voting-reset-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_reset')))) return;
  $('voting-msg').textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/reset`, { method: 'POST' });
    loadVotingState();
    loadVotes();
    loadContestants();
  } catch (err) {
    $('voting-msg').textContent = err.message;
  }
});

$('voting-reset-all-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_reset_all'), { danger: true }))) return;
  $('voting-msg').textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/reset-all`, { method: 'POST' });
    loadVotingState();
    loadVotes();
    loadContestants();
  } catch (err) {
    $('voting-msg').textContent = err.message;
  }
});

/* ------------------------------ Utilizadores ----------------------------- */

let allUsers = [];

function renderUsersList(users) {
  $('users-list').innerHTML = users.length
    ? users.map((u) => `
      <div class="user-row">
        <div class="user-row-top" data-row-toggle role="button" tabindex="0" aria-expanded="false">
          <div class="user-row-name">
            <span class="user-row-name-text${isOwner ? ' name-edit' : ''}"${isOwner ? ` data-rename-user="${u.id}" data-current-name="${esc(u.name)}" role="button" tabindex="0"` : ''}>${esc(u.name)}</span>
            ${u.is_owner ? '<span class="badge role-owner">owner</span>' : u.is_admin ? '<span class="badge role-admin">admin</span>' : '<span class="badge role-user">user</span>'}
          </div>
          <span class="user-row-chevron">›</span>
        </div>
        <div class="user-row-details hidden">
          <div class="user-row-token censored" data-token="${esc(u.token)}" data-reveal-token role="button" tabindex="0">••••••••••••</div>
          ${isOwner ? `
          <div class="row-actions">
            ${adminPromotionEnabled && !u.is_owner ? `<button class="small ghost" data-toggle-admin="${u.id}" data-next="${u.is_admin ? '0' : '1'}">${u.is_admin ? 'user' : 'admin'}</button>` : ''}
            <button class="small ghost" data-regen-user="${u.id}">${t('regen_key')}</button>
            ${u.is_owner ? '' : `<button class="small danger" data-del-user="${u.id}">${t('remove')}</button>`}
          </div>` : ''}
        </div>
      </div>`).join('')
    : `<p class="muted">${t('no_users')}</p>`;

  // Collapsed to just name+role by default - with a real guest list (not
  // 24 demo accounts), showing every key/action for every single row at
  // once made the whole tab one very long, mostly-irrelevant scroll. Tap
  // the row to reveal its key and actions instead of dumping everyone's
  // open at once.
  $('users-list').querySelectorAll('[data-row-toggle]').forEach((row) => {
    const toggle = () => {
      const details = row.nextElementSibling;
      const nowOpen = details.classList.toggle('hidden') === false;
      row.setAttribute('aria-expanded', String(nowOpen));
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // Keys are censored by default (someone glancing at a screen share
  // shouldn't see everyone's access keys) - click to reveal/hide. Every
  // click also copies the real value to the clipboard, so revealing and
  // copying are the same action instead of two separate controls.
  $('users-list').querySelectorAll('[data-reveal-token]').forEach((el) => {
    const toggle = async () => {
      const revealed = el.classList.toggle('censored') === false;
      el.textContent = revealed ? el.dataset.token : '••••••••••••';
      // No btn arg - that path swaps textContent to "copiado!", which would
      // overwrite the token we just displayed instead of just confirming
      // the copy. A brief border flash confirms it without touching the text.
      await copyToClipboard(el.dataset.token);
      el.classList.add('just-copied');
      setTimeout(() => el.classList.remove('just-copied'), 600);
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // Click the name itself to rename it in place - same click-to-act
  // convention as the admin contestant rename below, instead of a separate
  // button.
  $('users-list').querySelectorAll('[data-rename-user]').forEach((b) => {
    const startEdit = () => {
      const nameEl = b.closest('.user-row').querySelector('.user-row-name-text');
      if (nameEl.tagName === 'INPUT') return; // already editing
      const currentName = b.dataset.currentName;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName;
      input.maxLength = 60;
      input.className = 'user-row-name-text';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const commit = async () => {
        if (settled) return;
        settled = true;
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
          try {
            await api(`/admin/users/${b.dataset.renameUser}/name`, { method: 'PATCH', body: { name: newName } });
          } catch (err) {
            await showAlert(err.message);
          }
        }
        loadUsers();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { settled = true; loadUsers(); }
      });
      // Same bubbling issue as the span it replaced - typing/clicking into
      // the input would otherwise also toggle the row shut mid-edit.
      input.addEventListener('click', (e) => e.stopPropagation());
    };
    // Both stop propagation - without it, clicking the name to rename (or
    // just tabbing/space-ing into it) also bubbles up to the row's own
    // expand/collapse toggle, since the name sits inside that same
    // clickable row header.
    b.addEventListener('click', (e) => { e.stopPropagation(); startEdit(); });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); startEdit(); }
    });
  });

  $('users-list').querySelectorAll('[data-regen-user]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await showConfirm(t('confirm_regen_key')))) return;
      // No need to show/copy the new key here anymore - regenerating also
      // reopens first-time name-search retrieval (see keyClaim.js), so the
      // person just finds their own name again and claims it themselves.
      try {
        await api(`/admin/users/${b.dataset.regenUser}/regenerate-token`, { method: 'POST' });
        loadUsers();
      } catch (err) {
        await showAlert(err.message);
      }
    });
  });

  $('users-list').querySelectorAll('[data-del-user]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await showConfirm(t('confirm_remove_user'), { danger: true }))) return;
      await api(`/admin/users/${b.dataset.delUser}`, { method: 'DELETE' });
      loadUsers();
    });
  });

  $('users-list').querySelectorAll('[data-toggle-admin]').forEach((b) => {
    b.addEventListener('click', async () => {
      const makingAdmin = b.dataset.next === '1';
      if (!(await showConfirm(t(makingAdmin ? 'confirm_make_admin' : 'confirm_remove_admin_role')))) return;
      try {
        await api(`/admin/users/${b.dataset.toggleAdmin}/admin`, { method: 'PATCH', body: { isAdmin: makingAdmin } });
        markRecent(Number(b.dataset.toggleAdmin));
        loadUsers();
      } catch (err) {
        await showAlert(err.message);
      }
    });
  });
}

// The name input doubles as a live search: below 3 characters it's treated
// as "not enough to judge yet" (full list shown, create disabled). At 3+
// characters it filters the list (e.g. "Rui" already matches) - if nothing
// matches, this is clearly a new person rather than someone already here,
// so create becomes the only sensible action. If something DOES match,
// creating is disabled on purpose - act on the existing user via its row
// buttons instead (copy, rename, remove, etc.), rather than risking an
// accidental duplicate.
// The base list from the server is alphabetical (owner first), which stays
// stable and easy to scan. Whoever you just created or changed the role of
// in THIS session floats to the top instead (most recent first), so the
// thing you just did is immediately visible without hunting for it - but
// that's a session-local nicety, not a permanent sort, so it resets on
// reload rather than permanently reordering the list for next time.
const recentUserIds = [];
function markRecent(id) {
  const i = recentUserIds.indexOf(id);
  if (i !== -1) recentUserIds.splice(i, 1);
  recentUserIds.unshift(id);
}
function withRecentFirst(users) {
  const owner = users.filter((u) => u.is_owner);
  const rest = users.filter((u) => !u.is_owner);
  const recent = recentUserIds
    .map((id) => rest.find((u) => u.id === id))
    .filter(Boolean);
  const others = rest.filter((u) => !recentUserIds.includes(u.id));
  return [...owner, ...recent, ...others];
}

// Strips accents so "cesar" matches "César" - typing the plain-ASCII form
// of a name should always find it, not just the exact accented spelling.
function foldAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function roleOf(u) {
  return u.is_owner ? 'owner' : u.is_admin ? 'admin' : 'user';
}

// Role filter narrows the VIEW only - it never affects whether "create"
// is offered, which is purely about whether the typed name already
// exists (creating always makes a plain user regardless of this filter).
// Owner/admin/user are independent, cumulative (OR) toggles - picking more
// than one widens the view rather than narrowing it to users matching all
// of them at once (which for mutually-exclusive roles would always be
// empty). All three start lit, because the list starts showing everyone:
// three unlit pills above a full list read as "no filter applied" when the
// honest description is "all three are included". Turning them all off
// would mean an empty list, so that case snaps back to all-on instead.
const ALL_ROLES = ['owner', 'admin', 'user'];
const roleFilter = new Set(ALL_ROLES);
function byRole(users) {
  return roleFilter.size === ALL_ROLES.length ? users : users.filter((u) => roleFilter.has(roleOf(u)));
}

function syncRolePills() {
  $('user-role-filter').querySelectorAll('.role-pill').forEach((b) => {
    b.classList.toggle('active', roleFilter.has(b.dataset.role));
  });
}

// Re-rendering a list that gets shorter makes the whole page shorter, and a
// shorter page cannot hold the scroll position you were at - the browser
// clamps it and everything jumps upward under your thumb, exactly as the
// filtered results appear. Holding the container at the height it already
// had keeps the document the same length, so nothing moves; the floor is
// released only once the list is whole again, or it would never come back
// down. Shared by every filtered list here for the same reason it was
// needed by the first one.
function renderKeepingPlace(container, render, filtered) {
  const heldHeight = container.offsetHeight;
  const y = window.scrollY;
  render();
  if (filtered) {
    if (heldHeight) container.style.minHeight = `${heldHeight}px`;
  } else {
    container.style.minHeight = '';
  }
  if (window.scrollY !== y) window.scrollTo(0, y);
}

function applyUserSearch() {
  const term = $('user-name-input').value.trim();
  const createBtn = $('user-create-btn');
  const searching = term.length >= 3;
  const everyRole = roleFilter.size === ALL_ROLES.length;

  if (!searching) {
    renderKeepingPlace($('users-list'), () => {
      renderUsersList(withRecentFirst(byRole(allUsers)));
    }, !everyRole);
    $('user-search-hint').classList.add('hidden');
    createBtn.disabled = true;
    return;
  }

  const foldedTerm = foldAccents(term.toLowerCase());
  const nameMatches = allUsers.filter((u) => foldAccents(u.name.toLowerCase()).includes(foldedTerm));
  renderKeepingPlace($('users-list'), () => {
    renderUsersList(withRecentFirst(byRole(nameMatches)));
  }, true);

  const noMatch = nameMatches.length === 0;
  $('user-search-hint').classList.toggle('hidden', !noMatch);
  createBtn.disabled = !noMatch;
}

async function loadUsers() {
  allUsers = await api('/admin/users');
  applyUserSearch();
}

syncRolePills();
$('user-name-input').addEventListener('input', applyUserSearch);

$('user-role-filter').querySelectorAll('.role-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (roleFilter.has(btn.dataset.role)) {
      roleFilter.delete(btn.dataset.role);
    } else {
      roleFilter.add(btn.dataset.role);
    }
    // Nothing selected would show nothing at all - treat it as "show
    // everyone" and light them all again.
    if (roleFilter.size === 0) ALL_ROLES.forEach((r) => roleFilter.add(r));
    syncRolePills();
    applyUserSearch();
  });
});

// #user-form is a div rather than a <form> (see settings.html) so Safari
// stops reading this box as a sign-in, which means submit has to be wired
// by hand: the button, plus Enter, which a real form would have given free.
async function createUserFromInput() {
  const name = $('user-name-input').value.trim();
  if (!name || $('user-create-btn').disabled) return;
  try {
    const u = await api('/admin/users', { method: 'POST', body: { name } });
    $('user-name-input').value = '';
    $('user-search-hint').classList.add('hidden');
    $('user-create-btn').disabled = true;
    markRecent(u.id);
    await showAlert(t('user_created', { name: u.name, token: u.token }));
    loadUsers();
  } catch (err) {
    await showAlert(err.message);
  }
}
$('user-create-btn').addEventListener('click', createUserFromInput);
$('user-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    createUserFromInput();
  }
});

// Per-feature kill switches - each hits its own dedicated wipe route (see
// POST /admin/consequences/wipe etc. in routes.js), scoped to just that
// feature's data, unlike the single cross-feature reset this replaced.
function wireWipeButton(btnId, msgId, endpoint, confirmKey, doneMsgKey, afterWipe) {
  $(btnId).addEventListener('click', async () => {
    if (!(await showConfirm(t(confirmKey), { danger: true }))) return;
    try {
      await api(endpoint, { method: 'POST' });
      $(msgId).textContent = t(doneMsgKey);
      setTimeout(() => ($(msgId).textContent = ''), 3000);
      afterWipe();
    } catch (err) {
      $(msgId).textContent = err.message;
    }
  });
}

wireWipeButton('rata-wipe-btn', 'rata-wipe-msg', '/admin/consequences/wipe', 'confirm_rata_wipe', 'rata_wipe_done_msg', loadConsequences);
wireWipeButton('outfit-wipe-btn', 'outfit-wipe-msg', '/admin/contestants/wipe', 'confirm_outfit_wipe', 'outfit_wipe_done_msg', () => {
  loadVotingState();
  loadContestants();
  loadVotes();
});
wireWipeButton('plaza-wipe-btn', 'plaza-wipe-msg', '/admin/plaza-posts/wipe', 'confirm_plaza_wipe', 'plaza_wipe_done_msg', loadPlazaPosts);
// Nothing on this admin tab displays chat messages themselves (just the
// pseudonym mapping, a separate table untouched by this), so no reload
// needed after wiping.
wireWipeButton('chat-wipe-btn', 'chat-wipe-msg', '/admin/chat/wipe', 'confirm_chat_wipe', 'chat_wipe_done_msg', () => {});

/* ------------------------------ Concorrentes ----------------------------- */

let allContestants = [];

async function loadContestants() {
  const { contestants } = await api(`/admin/contestants?night=${encodeURIComponent(currentNight())}`);
  allContestants = contestants;
  renderContestants();
}

// A real fetch()+blob download rather than a plain <a href> - the latter
// (tried first) had no way to show progress/errors, and target="_blank"
// pointed at a URL requiring auth meant a bare failure (e.g. no photos
// yet) just landed the new tab on the app's own default route instead of
// showing anything - indistinguishable from the button doing nothing at
// all. This can show real status throughout, and use a normal Bearer
// header instead of a token in the URL.
$('download-photos-btn').addEventListener('click', async () => {
  const night = currentNight();
  const msg = $('download-photos-msg');
  msg.classList.remove('error');
  msg.textContent = t('download_photos_in_progress');
  try {
    const res = await fetch(`/api/admin/outfit/${encodeURIComponent(night)}/photos.zip`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ? t(data.error) : `Error ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snatch-${night}-photos.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    msg.textContent = t('download_photos_done');
    setTimeout(() => { if (msg.textContent === t('download_photos_done')) msg.textContent = ''; }, 3000);
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

function renderContestants() {
  const term = foldAccents($('contestant-search').value.trim().toLowerCase());
  const contestants = term
    ? allContestants.filter((c) => foldAccents(c.name.toLowerCase()).includes(term))
    : allContestants;
  $('contestants-table').innerHTML = contestants.length
    ? `<tr><th></th><th>${t('col_name')}</th><th>${t('col_registered_by')}</th><th></th></tr>` + contestants.map((c) => {
        const who = c.partner_name
          ? `${esc(c.registered_by)} &amp; ${esc(c.partner_name)}`
          : c.registered_by ? esc(c.registered_by) : '-';
        const isSolo = !c.partner_name;
        // Unlike the guest-facing voting list, the roster deliberately
        // shows entries the partner hasn't confirmed - they're exactly
        // what the owner needs to chase before opening the voting.
        const pending = c.confirmed ? '' : ` <span class="badge">${esc(t('contestant_pending_label'))}</span>`;
        // Admins can see any entry's photo any time (moderation), unlike
        // guests who only get it once results are revealed - see GET
        // /outfit/contestants/:id/photo.
        const photo = c.hasPhoto
          ? `<img class="entry-photo-preview" src="/api/outfit/contestants/${c.id}/photo?token=${encodeURIComponent(getToken())}" alt="" />`
          : '';
        return `
        <tr class="contestant-${isSolo ? 'solo' : 'duo'}">
          <td>${photo}</td>
          <td><span class="contestant-name-edit" data-edit-contestant="${c.id}" data-name="${esc(c.name)}" role="button" tabindex="0">${esc(c.name)}</span>${pending}</td>
          <td class="muted">${who}</td>
          <td style="text-align:right">${isOwner ? `<button class="small danger" data-del-contestant="${c.id}">${t('remove')}</button>` : ''}</td>
        </tr>`;
      }).join('')
    : `<tr><td class="muted">${t('no_contestants')}</td></tr>`;

  $('contestants-table').querySelectorAll('[data-del-contestant]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await showConfirm(t('confirm_remove_contestant')))) return;
      await api(`/admin/contestants/${b.dataset.delContestant}`, { method: 'DELETE' });
      loadContestants();
    });
  });

  // Click a contestant's name to rename it in place - e.g. fixing a typo in
  // a self-registered entry while reviewing submissions before opening
  // voting. Same click-to-act convention as the access-key reveal toggle
  // in the Users tab.
  $('contestants-table').querySelectorAll('[data-edit-contestant]').forEach((el) => {
    const startEdit = () => {
      const currentName = el.dataset.name;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName;
      input.maxLength = 60;
      el.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const commit = async () => {
        if (settled) return;
        settled = true;
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
          try {
            await api(`/admin/contestants/${el.dataset.editContestant}`, { method: 'PATCH', body: { name: newName } });
          } catch (err) {
            await showAlert(err.message);
          }
        }
        loadContestants();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { settled = true; loadContestants(); }
      });
    };
    el.addEventListener('click', startEdit);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
    });
  });
}

$('contestant-search').addEventListener('input', renderContestants);

// Same registration capability as the public candidatura form in app.js
// (renderRegistration() there) - solo or teamed up with a partner - just
// admin-facing: an extra search-and-pick field up front for WHO this entry
// is for, since (unlike the public form) there's no implicit "self" here.
let adminRegisterUsersCache = null;
async function ensureAdminRegisterUsersCache() {
  // /users/basic excludes the caller (see loadConsequences() for why) - the
  // admin filling this in might be registering themselves, so add self back.
  if (!adminRegisterUsersCache) {
    const others = await api('/users/basic');
    adminRegisterUsersCache = [...others, { id: myUserId, name: myName }].sort((a, b) => a.name.localeCompare(b.name));
  }
  return adminRegisterUsersCache;
}

// Wires a search input to a results container: type to filter
// /users/basic by name, click a result to pick it (calling onPick with the
// chosen user's id). Used twice below (participant, partner) - identical
// behaviour to app.js's own partner-search, just parameterized so it's not
// duplicated per field.
function wireAdminUserSearch(inputEl, resultsEl, onPick) {
  inputEl.addEventListener('input', async () => {
    onPick(null);
    const term = foldAccents(inputEl.value.trim().toLowerCase());
    if (term.length < 2) { resultsEl.innerHTML = ''; return; }
    const users = await ensureAdminRegisterUsersCache();
    const matches = users.filter((u) => foldAccents(u.name.toLowerCase()).includes(term)).slice(0, 6);
    resultsEl.innerHTML = matches.map((u) => `<button type="button" class="small ghost" data-user-id="${u.id}">${esc(u.name)}</button>`).join('');
    resultsEl.querySelectorAll('[data-user-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onPick(Number(btn.dataset.userId));
        inputEl.value = btn.textContent;
        resultsEl.innerHTML = '';
      });
    });
  });
}

let adminRegisterMode = 'solo';
let adminRegisterParticipantId = null;
let adminRegisterPartnerId = null;
let adminRegisterPhotoDataUrl = null;

// Same styled-button-over-hidden-input pattern as the guest form in app.js,
// and deliberately no `capture` attribute for the same reason: iOS should
// offer its picker sheet rather than jump straight to the camera. Unlike
// the guest form the photo stays optional here - an organiser fixing the
// roster may not have a photo of that person to hand, and can add one
// later via "mudar foto" (see the admin route's requirePhoto, left off).
$('admin-register-photo-btn').addEventListener('click', () => $('admin-register-photo-input').click());
$('admin-register-photo-input').addEventListener('change', async () => {
  const file = $('admin-register-photo-input').files[0];
  const preview = $('admin-register-photo-preview');
  if (!file) {
    adminRegisterPhotoDataUrl = null;
    preview.classList.add('hidden');
    return;
  }
  try {
    adminRegisterPhotoDataUrl = await resizePhotoToJpeg(file);
    preview.querySelector('img').src = adminRegisterPhotoDataUrl;
    preview.classList.remove('hidden');
  } catch (err) {
    adminRegisterPhotoDataUrl = null;
    preview.classList.add('hidden');
    await showAlert(err.message);
  }
});

function resetAdminRegisterPhoto() {
  adminRegisterPhotoDataUrl = null;
  $('admin-register-photo-input').value = '';
  $('admin-register-photo-preview').classList.add('hidden');
}

wireAdminUserSearch(
  $('admin-register-participant-search'),
  $('admin-register-participant-results'),
  (id) => { adminRegisterParticipantId = id; },
);
wireAdminUserSearch(
  $('admin-register-partner-search'),
  $('admin-register-partner-results'),
  (id) => { adminRegisterPartnerId = id; },
);

$('admin-register-mode-switch').querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    adminRegisterMode = b.dataset.mode;
    $('admin-register-mode-switch').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    $('admin-register-partner-wrap').classList.toggle('hidden', adminRegisterMode !== 'duo');
    $('admin-register-name').placeholder = t(adminRegisterMode === 'duo' ? 'admin_register_name_ph_duo' : 'admin_register_name_ph');
    if (adminRegisterMode === 'solo') {
      adminRegisterPartnerId = null;
      $('admin-register-partner-search').value = '';
      $('admin-register-partner-results').innerHTML = '';
    }
  });
});

$('admin-register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('admin-register-msg').textContent = '';
  const name = $('admin-register-name').value.trim();
  if (!name) return;
  if (!adminRegisterParticipantId) {
    $('admin-register-msg').textContent = t('admin_register_participant_required');
    return;
  }
  if (adminRegisterMode === 'duo' && !adminRegisterPartnerId) {
    $('admin-register-msg').textContent = t('outfit_register_partner_required');
    return;
  }
  try {
    await api('/admin/contestants/register', {
      method: 'POST',
      body: {
        userId: adminRegisterParticipantId,
        partnerUserId: adminRegisterMode === 'duo' ? adminRegisterPartnerId : null,
        name,
        night: currentNight(),
        photoBase64: adminRegisterPhotoDataUrl,
      },
    });
  } catch (err) {
    $('admin-register-msg').textContent = err.message;
    return;
  }
  $('admin-register-name').value = '';
  $('admin-register-participant-search').value = '';
  $('admin-register-partner-search').value = '';
  adminRegisterParticipantId = null;
  adminRegisterPartnerId = null;
  resetAdminRegisterPhoto();
  loadContestants();
});

/* --------------------------------- Votos --------------------------------- */

// Same pairing as app.js's own contestantLabel() - a character name alone
// doesn't tell an admin (or a live crowd they're reading results out to)
// who's actually behind it.
function contestantLabel(c) {
  if (!c.registeredBy) return c.name;
  const who = c.partnerName ? `${c.registeredBy} & ${c.partnerName}` : c.registeredBy;
  return `${c.name} (${who})`;
}

async function loadVotes() {
  // votes (who voted for whom) is owner-only - a regular admin only gets
  // results (the same tally that goes public on Best Look later), so
  // `votes` is simply absent from the response for them. Shown as two
  // separate cards: Results (everyone with admin access) and Voting logs
  // (owner-only, kept last on the page). Scoped by the same admin-night-switch
  // as voting control/contestants above - one night picker for the whole tab.
  const { votes, results } = await api(`/admin/votes?night=${encodeURIComponent(currentNight())}`);
  $('results-table').innerHTML = results.length
    ? `<tr><th>${t('ranking')}</th><th>${t('col_votes')}</th></tr>` +
      results.map((r) => `<tr><td>${esc(contestantLabel(r))}</td><td>${r.votes}</td></tr>`).join('')
    : `<tr><td class="muted">${t('no_votes')}</td></tr>`;

  // The night's other round, in the same card - it comes from
  // GET /admin/voting (already cached per night), not /admin/votes.
  const congResults = votingStateCache[currentNight()]?.congenialityResults ?? [];
  $('congeniality-results-table').innerHTML = congResults.length
    ? `<tr><th>${t('ranking')}</th><th>${t('col_votes')}</th></tr>` +
      congResults.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.votes}</td></tr>`).join('')
    : `<tr><td class="muted">${t('no_votes')}</td></tr>`;

  // The runoff button only makes sense once voting's closed, there's
  // already a runoff going and it also closed (tie could recur), and the
  // top spot is a genuine tie (0-0 across the board doesn't count - that's
  // just nobody having voted yet, not a real tie to break).
  const status = votingStateCache[currentNight()]?.status;
  const isTie = results.length >= 2 && results[0].votes > 0 && results[0].votes === results[1].votes;
  $('voting-runoff-btn').classList.toggle('hidden', !(status === 'closed' && isTie));

  renderCongenialityAdmin();

  $('voter-log-card').classList.toggle('hidden', !votes);
  if (votes) {
    $('voter-log-table').innerHTML = votes.length
      ? `<tr><th>${t('col_voter')}</th><th>${t('col_contestant')}</th><th>${t('col_time')}</th></tr>` +
        votes.map((v) => `<tr><td>${esc(v.voter)}</td><td>${esc(v.contestant)}</td><td class="muted">${esc(formatEuDateTime(v.created_at))}</td></tr>`).join('')
      : `<tr><td class="muted">${t('no_votes')}</td></tr>`;
  }
}

/* --------------------------- Miss Congeniality ---------------------------- */
// Same control shape as the outfit vote above - one advancing button that
// relabels itself through the phases, plus a reset - rather than three
// separate phase buttons. Reads from the same votingStateCache, which
// GET /admin/voting fills with this round's phase and live standings.

// closed -> open -> revealed. "closed" is both the start state and the
// mid-state (voting shut, winner not out yet), so the label depends on
// whether any vote has actually been cast.
function congenialityAdvance(status, hasVotes) {
  if (status === 'open') return { action: 'closed', label: 'congeniality_close_btn', confirm: 'confirm_congeniality_close' };
  if (status === 'closed' && hasVotes) return { action: 'revealed', label: 'congeniality_reveal_btn', confirm: 'confirm_congeniality_reveal' };
  if (status === 'closed') return { action: 'open', label: 'congeniality_start_btn', confirm: 'confirm_congeniality_open' };
  return null; // revealed - nowhere left to go
}

function renderCongenialityAdmin() {
  const state = votingStateCache[currentNight()];
  const status = state?.congenialityStatus ?? 'closed';
  const results = state?.congenialityResults ?? [];
  const hasVotes = results.some((r) => r.votes > 0);

  const label = $('congeniality-state');
  label.textContent = t(`congeniality_state_${status}`);
  label.classList.toggle('is-open', status === 'open');
  label.classList.toggle('is-closed', status !== 'open');

  const btn = $('congeniality-advance-btn');
  const next = congenialityAdvance(status, hasVotes);
  // Same word as Best Outfit's own terminal state (reveal_next_btn_done),
  // not this round's status label - one finished round should not read
  // as 'revealed' next to another reading as 'done'.
  btn.textContent = next ? t(next.label) : t('reveal_next_btn_done');
  btn.dataset.action = next ? next.action : '';
  btn.dataset.confirm = next ? next.confirm : '';
  btn.disabled = !next;

  // The Wall post carries both rounds, so it can only go out once both are
  // finished. Disabled rather than left tappable to fail: the server
  // refuses it either way, and a button that only tells you no after you
  // press it is worse than one that shows it is not ready.
  const podiumReady = state?.resultsPhase === 'first' || state?.resultsPhase === 'all';
  const congBusy = status === 'open' || (status === 'closed' && hasVotes);
  $('publish-podium-btn').disabled = !podiumReady || congBusy;
}

$('congeniality-advance-btn').addEventListener('click', async () => {
  const btn = $('congeniality-advance-btn');
  const action = btn.dataset.action;
  if (!action) return;
  const msg = $('congeniality-msg');
  msg.classList.remove('error');
  msg.textContent = '';
  // Same reasoning as the outfit vote's own confirms: every one of these
  // changes what the whole party sees at once, and revealing can't be undone.
  if (!(await showConfirm(t(btn.dataset.confirm)))) return;
  try {
    await api(`/admin/voting/${currentNight()}/congeniality`, { method: 'POST', body: { status: action } });
    await loadVotingState();
    await loadVotes();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

// Clears the votes but leaves the round open - the same "reiniciar votação"
// the outfit vote has. The danger button below is the full reset.
$('congeniality-reset-votes-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_congeniality_reset_votes')))) return;
  const msg = $('congeniality-msg');
  msg.classList.remove('error');
  msg.textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/congeniality/reset-votes`, { method: 'POST' });
    await loadVotingState();
    await loadVotes();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

$('congeniality-reset-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_congeniality_reset')))) return;
  const msg = $('congeniality-msg');
  msg.classList.remove('error');
  msg.textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/congeniality/reset`, { method: 'POST' });
    await loadVotingState();
    await loadVotes();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

// One post carrying the whole night: every revealed tier with photos and
// medals, and the congeniality winner underneath (see createPodiumPost()).
$('publish-podium-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_publish_podium')))) return;
  const msg = $('congeniality-msg');
  msg.classList.remove('error');
  msg.textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/publish-podium`, { method: 'POST' });
    msg.textContent = t('publish_podium_done');
    setTimeout(() => { if (msg.textContent === t('publish_podium_done')) msg.textContent = ''; }, 4000);
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

/* ------------------------------ Rata Game -------------------------------- */

// Fixed position next to the status filter, above the (filtered) list -
// same spot regardless of what's currently revealed or filtered, so it's
// never a moving target.
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-reveal-next]')) return;
  $('reveal-msg').textContent = '';
  try {
    await api('/admin/consequences/reveal', { method: 'POST' });
    loadConsequences();
  } catch (err) {
    $('reveal-msg').textContent = err.message;
  }
});

// Four states a consequence moves through: fila (queued, not revealed) ->
// atribuir (revealed, needs the owner to pick who's responsible) ->
// pendente (assigned, awaiting the assignee's self-report then the
// owner's approval - both count as "pendente", no separate tag for each
// half) -> feita (approved, final). All derived from columns that already
// exist - nothing about this is stored as a literal status string.
function rataStatus(c) {
  if (c.status !== 'used') return { state: 'fila', key: 'rata_status_fila', cls: 'rata-status-fila' };
  if (c.approved_at) return { state: 'feita', key: 'rata_status_feita', cls: 'rata-status-feita' };
  if (!c.assigned_user_id) return { state: 'atribuir', key: 'rata_status_atribuir', cls: 'rata-status-atribuir' };
  return { state: 'pendente', key: 'rata_status_pendente', cls: 'rata-status-pendente' };
}

// Cumulative OR toggle, same pattern as Manage Users' own role filter -
// narrows the Histórico view only, never affects the data itself. Only
// covers fila/pendente/feita - atribuir isn't filterable, it always shows
// in full in the Consequências card above (see renderConsequences()). All
// three start selected (matches the pills' own default "active" state in
// the HTML) - deselecting one hides it, rather than starting from
// "nothing picked means show everything".
// Same order as the filter chips in settings.html - the lifecycle order.
const RATA_STATES = ['fila', 'atribuir', 'pendente', 'feita'];
const rataStatusFilter = new Set(RATA_STATES);
let rataRows = [];
let rataAssignableUsers = [];

async function loadConsequences() {
  rataRows = await api('/admin/consequences');
  // Any admin (not owner-only) records who was actually holding the rata
  // for each revealed consequence, entered by hand since it can't be
  // inferred from anything in the app - not "right now", can be set any
  // time after the reveal. Uses the basic (id+name only, no tokens) user
  // list, same one Best Look's team-up picker uses - the admin-only
  // /admin/users list is owner-gated for everyone else, since it also
  // carries plaintext access keys. /users/basic excludes the caller
  // (that picker never needs to team up with yourself), but here the
  // admin filling this in might themselves be who had it - add self back.
  const others = await api('/users/basic');
  rataAssignableUsers = [...others, { id: myUserId, name: myName }].sort((a, b) => a.name.localeCompare(b.name));
  renderConsequences();
}

// The one place the app's global lowercase rule can't be done in CSS: iOS
// renders an OPEN <select> as a native OS picker that ignores page styles
// entirely, so `text-transform: lowercase` (styles.css) only reaches the
// closed control and the expanded list comes out capitalised. Lowercasing
// the option text itself is what holds the rule here - everywhere else,
// keep using the CSS.
const lower = (s) => String(s).toLowerCase();

function userOptionsHtml(selectedId) {
  return `<option value="">${esc(lower(t('rata_assign_placeholder')))}</option>` +
    rataAssignableUsers.map((u) => `<option value="${u.id}"${u.id === selectedId ? ' selected' : ''}>${esc(lower(u.name))}</option>`).join('');
}

// Card list, not a grid: same shape as the user-facing rata-history-item
// (see loadRataHistory in app.js) - a table forced this text into a
// narrow column and wrapped it one word per line, and combining italic +
// small + serif + grey on top of that made it worse. Text first, full
// width; everything else drops to a second, plainer meta line. Shared
// between the Consequências (atribuir only) and Histórico (everything
// else) cards - same row shape either way, just a different subset of
// rows feeds each one (see renderConsequences()).
function renderConsequenceCard(c, revealed) {
  // Hours and minutes here (this is the admin view) - only revealed items
  // have a revealed_at to show one for at all.
  const time = c.revealed_at ? formatTimeInZone(c.revealed_at) : '';
  const byline = `${esc(c.author)} · ${esc(formatEuDate(c.day))}${time ? ` · ${time}` : ''}`;
  const status = rataStatus(c);
  if (c.status !== 'used') {
    return `<div class="rata-history-item">
      <p class="rata-history-text">${esc(c.text)}</p>
      <div class="rata-history-meta">
        <span class="muted">${byline}</span>
        <span class="rata-badge ${status.cls}">${t(status.key)}</span>
      </div>
    </div>`;
  }
  // The current consequence used to also get a separate, much louder
  // .highlight box duplicating the exact same text - now it's just this
  // one card with a subtler tint (.rata-current) wherever it ends up
  // rendering (Consequências if still unassigned, Histórico otherwise).
  const isCurrent = revealed && c.id === revealed.id;
  const canApprove = isOwner && c.done_at && !c.approved_at;
  return `<div class="rata-history-item${isCurrent ? ' rata-current' : ''}">
    <p class="rata-history-text">${esc(c.text)}</p>
    <div class="rata-history-meta">
      <span class="muted">${byline}</span>
      <span class="rata-badge ${status.cls}">${t(status.key)}</span>
      <select data-assign-id="${c.id}"${c.done_at ? ' disabled' : ''}>${userOptionsHtml(c.assigned_user_id)}</select>
      ${canApprove ? `<button type="button" class="small ghost" data-approve-id="${c.id}">${t('rata_approve_btn')}</button>` : ''}
    </div>
  </div>`;
}

function renderConsequences() {
  // rows are sorted most-recently-touched first (see GET /admin/consequences),
  // so the first 'used' one encountered is simply the current one.
  const revealed = rataRows.find((c) => c.status === 'used');

  // Freshly revealed consequences used to get their own box above the
  // history. They live in the history now (top of it, since it sorts by most
  // recently touched) and carry the same assign control there, so the same
  // row is not rendered twice on one page.
  // 'atribuir' rows show here too, not only in the assign box above: the list
  // is the running history, and a consequence that was just revealed is the
  // most recently touched thing there is - leaving it out made a fresh reveal
  // look like nothing had happened.
  // Purely most-recently-touched first. This was briefly grouped by state
  // instead, because sorting on time alone buried freshly revealed rows
  // among older finished ones - but that was a missing timestamp, not a
  // sorting problem: assignments recorded no time at all until
  // consequences.assigned_at existed. Now that every transition stamps
  // something, recency puts whatever just happened on top on its own, and
  // grouping only got in the way (a newly assigned row became 'pendente'
  // and sank below the entire queue).
  const getLatestTime = (c) => c.approved_at || c.done_at || c.assigned_at || c.revealed_at || '';
  const historyRows = rataRows
    .filter((c) => rataStatusFilter.has(rataStatus(c).state))
    .sort((a, b) => getLatestTime(b).localeCompare(getLatestTime(a)));
  renderKeepingPlace($('consequences-table'), () => {
    $('consequences-table').innerHTML = historyRows.length
      ? historyRows.map((c) => renderConsequenceCard(c, revealed)).join('')
      : `<p class="muted">${t('no_consequences')}</p>`;
  }, rataStatusFilter.size < RATA_STATES.length);
}

$('rata-status-filter').querySelectorAll('.role-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (rataStatusFilter.has(btn.dataset.status)) rataStatusFilter.delete(btn.dataset.status);
    else rataStatusFilter.add(btn.dataset.status);
    btn.classList.toggle('active', rataStatusFilter.has(btn.dataset.status));
    renderConsequences();
  });
});

// Delegated on document, not #consequences-table - an assign select can
// render in the history list (atribuir rows) or
// #consequences-table (Histórico, once it's moved past atribuir).
document.addEventListener('change', async (e) => {
  const select = e.target.closest('[data-assign-id]');
  if (!select) return;
  const userId = select.value ? Number(select.value) : null;
  try {
    await api(`/admin/consequences/${select.dataset.assignId}/assign`, { method: 'PATCH', body: { userId } });
    // Assigning moves it from atribuir to pendente (and from the
    // Consequências card into Histórico) - re-render so that happens
    // immediately instead of waiting for the next poll.
    loadConsequences();
  } catch (err) {
    await showAlert(err.message);
    loadConsequences();
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-approve-id]');
  if (!btn) return;
  try {
    await api(`/admin/consequences/${btn.dataset.approveId}/approve`, { method: 'PATCH' });
    loadConsequences();
  } catch (err) {
    await showAlert(err.message);
  }
});

// Older pseudonyms stay listed (not just the current one) - a re-roll
// doesn't erase who was who for messages already posted under the old one.
function formatPseudonymHistory(pseudonyms) {
  const older = pseudonyms.slice(0, -1);
  const current = pseudonyms[pseudonyms.length - 1];
  const olderHtml = older.length ? `<span class="muted">${older.map(esc).join(', ')}, </span>` : '';
  return `${olderHtml}${esc(current)}`;
}

async function loadWallPseudonyms() {
  const rows = await api('/admin/wall-pseudonyms');
  $('wall-pseudonyms-table').innerHTML = rows.length
    ? `<tr><th>${t('col_name')}</th><th>${t('col_pseudonym')}</th><th></th></tr>` +
      rows.map((r) => `<tr>
        <td>${esc(r.name)}</td>
        <td>${formatPseudonymHistory(r.pseudonyms)}</td>
        <td style="text-align:right"><button class="small" data-reset-pseudonym="${r.id}">${t('wall_reset_pseudonym_btn')}</button></td>
      </tr>`).join('')
    : `<tr><td class="muted">${t('no_wall_pseudonyms')}</td></tr>`;

  $('wall-pseudonyms-table').querySelectorAll('[data-reset-pseudonym]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await showConfirm(t('confirm_reset_pseudonym')))) return;
      try {
        await api(`/admin/users/${b.dataset.resetPseudonym}/wall-pseudonym/reset`, { method: 'POST' });
        loadWallPseudonyms();
      } catch (err) {
        await showAlert(err.message);
      }
    });
  });
}

/* --------------------------------- Plaza ---------------------------------- */
// Owner/admin-authored feed on everyone's Plaza landing page (see GET
// /plaza-posts in app.js). Two post types: a plain announcement, or a poll
// with 2-6 options. Publishing broadcasts a notification. Pinning a post,
// either type (owner-only), floats it to the top of the feed for everyone.

const MAX_POLL_OPTIONS = 6;
let plazaPostType = 'announcement';

$('plaza-post-type').querySelectorAll('.role-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    plazaPostType = btn.dataset.postType;
    $('plaza-post-type').querySelectorAll('.role-pill').forEach((b) => b.classList.toggle('active', b === btn));
    // Poll mode shows only poll-building tools (question + options) - the
    // plain message field is announcement-only, not shared with polls.
    $('plaza-poll-options').classList.toggle('hidden', plazaPostType !== 'poll');
    $('plaza-post-text').classList.toggle('hidden', plazaPostType === 'poll');
  });
});

$('plaza-add-option-btn').addEventListener('click', () => {
  const inputs = $('plaza-poll-options').querySelectorAll('.plaza-poll-option-input');
  if (inputs.length >= MAX_POLL_OPTIONS) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'plaza-poll-option-input';
  input.placeholder = t('plaza_option_ph');
  input.maxLength = 60;
  input.style.marginTop = '8px';
  $('plaza-add-option-btn').before(input);
});

const PLAZA_ADMIN_LABEL = {
  poll: 'plaza_type_poll',
  announcement: 'plaza_type_announcement',
  podium: 'plaza_type_podium',
  video: 'plaza_type_video',
};
const PLAZA_ADMIN_BADGE = {
  poll: ' type-poll',
  announcement: ' type-announcement',
  podium: ' type-podium',
  video: ' type-podium',
};

// A published result's text is a JSON snapshot (see createPodiumPost() in
// plaza.js), not prose - printing it raw here dumped the whole object into
// the history list. Rendered as the placings it actually represents.
function adminPodiumSummary(p) {
  let snap;
  try { snap = JSON.parse(p.text); } catch { return ''; }
  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const rows = (snap.podium ?? [])
    .map((r) => `<li><span>${medal[r.rank] ?? ''} ${esc(r.name)}</span> <strong>${r.votes}</strong></li>`)
    .join('');
  const cong = snap.congeniality
    ? `<li><span>👑 ${esc(snap.congeniality.name)}</span> <strong>${snap.congeniality.votes}</strong></li>`
    : '';
  return `<p class="muted" style="margin:8px 0 0">${esc(t(`theme_${snap.night}`))}</p>
    <ul class="admin-post-options">${rows}${cong}</ul>`;
}

async function loadPlazaPosts() {
  const { posts } = await api('/admin/plaza-posts');
  $('plaza-posts-list').innerHTML = posts.length
    ? posts.map((p) => `
      <div class="user-row">
        <div class="user-row-top">
          <div class="user-row-name">
            <span class="badge${PLAZA_ADMIN_BADGE[p.type] ?? ' type-announcement'}">${t(PLAZA_ADMIN_LABEL[p.type] ?? 'plaza_type_announcement')}</span>
            ${p.pinnedAt ? `<span class="plaza-pinned-badge">${t('plaza_post_pinned_label')}</span>` : ''}
          </div>
        </div>
        <p class="muted" style="margin:10px 0 0">${esc(p.author)} · ${esc(formatEuDateTime(p.created_at))}</p>
        ${p.type === 'video' ? `<p class="muted" style="margin:8px 0 0">${esc(formatEuDate(p.text))}</p>`
          : p.type === 'podium' ? adminPodiumSummary(p) : `<p class="plaza-post-text" style="margin:8px 0 0;border-left:none;padding-left:0;font-weight:600">${linkify(esc(p.text))}</p>`}
        ${p.type === 'poll' ? `
        <ul class="admin-post-options">
          ${p.options.map((o) => {
            const names = p.voters.filter((v) => v.option === o.label).map((v) => esc(v.name));
            return `<li><span>${esc(o.label)}</span> <strong>${o.votes}</strong>${names.length ? ` <span class="muted">(${names.join(', ')})</span>` : ''}</li>`;
          }).join('')}
        </ul>` : ''}
        <div class="row-actions">
          ${isOwner ? `<button class="small" data-pin-post="${p.id}" data-pinned="${!!p.pinnedAt}">${t(p.pinnedAt ? 'plaza_unpin_btn' : 'plaza_pin_btn')}</button>` : ''}
          ${isOwner ? `<button class="small danger" data-del-post="${p.id}">${t('remove')}</button>` : ''}
        </div>
      </div>`).join('')
    : `<p class="muted">${t('plaza_no_posts')}</p>`;

  $('plaza-posts-list').querySelectorAll('[data-del-post]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await showConfirm(t('plaza_confirm_delete_post')))) return;
      try {
        await api(`/admin/plaza-posts/${b.dataset.delPost}`, { method: 'DELETE' });
        loadPlazaPosts();
      } catch (err) {
        await showAlert(err.message);
      }
    });
  });

  // Owner-only (see requireOwner on PATCH .../pin) - button only rendered
  // for the owner above, matching the backend gate rather than a new check.
  $('plaza-posts-list').querySelectorAll('[data-pin-post]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api(`/admin/plaza-posts/${b.dataset.pinPost}/pin`, {
          method: 'PATCH',
          body: { pinned: b.dataset.pinned !== 'true' },
        });
        loadPlazaPosts();
      } catch (err) {
        await showAlert(err.message);
      }
    });
  });
}

$('plaza-post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('plaza-post-msg').textContent = '';
  const text = plazaPostType === 'poll' ? $('plaza-poll-question').value : $('plaza-post-text').value;
  const options = plazaPostType === 'poll'
    ? [...$('plaza-poll-options').querySelectorAll('.plaza-poll-option-input')].map((i) => i.value)
    : undefined;
  try {
    await api('/admin/plaza-posts', { method: 'POST', body: { type: plazaPostType, text, options } });
    $('plaza-post-text').value = '';
    $('plaza-poll-question').value = '';
    $('plaza-poll-options').querySelectorAll('.plaza-poll-option-input').forEach((i) => (i.value = ''));
    $('plaza-post-msg').textContent = t('saved');
    setTimeout(() => ($('plaza-post-msg').textContent = ''), 2000);
    loadPlazaPosts();
  } catch (err) {
    $('plaza-post-msg').textContent = err.message;
  }
});

/* ---------------------------------- Memo ---------------------------------- */

// A day with nothing uploaded gets no buttons at all: the zip would 404 and
// publishing would fail with err_memo_no_photos, so offering either is just
// an invitation to hit an error. The download-video button additionally
// waits until a video actually exists.
async function loadMemoDays() {
  try {
    const { days } = await api('/admin/memo/days');
    $('memo-days-list').innerHTML = days.length
      ? days.map((d) => `
        <div class="user-row">
          <div class="user-row-top">
            <div class="user-row-name">${esc(formatEuDate(d.day))}</div>
          </div>
          <p class="muted" style="margin:6px 0 0">${d.uploadedCount}/${d.totalSlots} · ${d.hasRecap ? t('memo_admin_has_recap') : t('memo_admin_no_recap')}</p>
          ${d.uploadedCount > 0 ? `
          <div class="row-actions">
            <button type="button" class="small" data-memo-download-day="${esc(d.day)}">${esc(t('memo_admin_download_btn'))}</button>
            ${d.hasRecap ? `<button type="button" class="small" data-memo-download-video="${esc(d.day)}">${esc(t('memo_admin_download_video_btn'))}</button>` : ''}
            <button type="button" class="small publish-wide" data-memo-publish-day="${esc(d.day)}">${esc(t('memo_admin_publish_btn'))}</button>
          </div>` : ''}
          <span class="muted" data-memo-day-msg="${esc(d.day)}"></span>
        </div>`).join('')
      : `<p class="muted">${t('memo_admin_no_days')}</p>`;
  } catch { /* transient network hiccup */ }
}

// Delegated (days list is fully rebuilt on every load) - same
// fetch-blob-and-download pattern as download-photos-btn above, and the
// same hidden-file-input-behind-a-button pattern as the guest checklist
// in app.js, just per-day instead of per-slot.
async function downloadMemoFile(url, filename, msg, doneKey) {
  msg.classList.remove('error');
  msg.textContent = t('download_photos_in_progress');
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ? t(data.error) : `Error ${res.status}`);
    }
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
    msg.textContent = t(doneKey);
    setTimeout(() => { if (msg.textContent === t(doneKey)) msg.textContent = ''; }, 3000);
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
}

$('memo-days-list').addEventListener('click', async (e) => {
  const dayMsg = (day) => $('memo-days-list').querySelector(`[data-memo-day-msg="${day}"]`);

  const dlBtn = e.target.closest('[data-memo-download-day]');
  if (dlBtn) {
    const day = dlBtn.dataset.memoDownloadDay;
    await downloadMemoFile(
      `/api/admin/memo/${encodeURIComponent(day)}/uploads.zip`,
      `memo-${day}.zip`, dayMsg(day), 'download_photos_done'
    );
    return;
  }

  const videoBtn = e.target.closest('[data-memo-download-video]');
  if (videoBtn) {
    const day = videoBtn.dataset.memoDownloadVideo;
    await downloadMemoFile(
      `/api/memo/recaps/${encodeURIComponent(day)}`,
      `memo-${day}.mp4`, dayMsg(day), 'download_photos_done'
    );
    return;
  }

  // Generating the video and publishing it are the same action - the Wall
  // it also lands on the Wall as a post (see createVideoPost() in plaza.js),
  // so there's nothing to "publish" separately afterwards.
  const pubBtn = e.target.closest('[data-memo-publish-day]');
  if (pubBtn) {
    const day = pubBtn.dataset.memoPublishDay;
    const msg = dayMsg(day);
    msg.classList.remove('error');
    // Stitching a full day of photos is not instant - say so, and stop a
    // second click from kicking off a duplicate encode.
    msg.textContent = t('memo_admin_publishing');
    pubBtn.disabled = true;
    try {
      const r = await api(`/admin/memo/${encodeURIComponent(day)}/recap/generate`, { method: 'POST' });
      // Reload first, then write the message: the reload rebuilds every row
      // (that's what makes the download-video button appear), so setting the
      // text before it would just be thrown away with the old element.
      await loadMemoDays();
      const fresh = dayMsg(day);
      if (fresh) fresh.textContent = t('memo_admin_published', { n: r.photoCount });
    } catch (err) {
      msg.classList.add('error');
      msg.textContent = err.message;
    } finally {
      pubBtn.disabled = false;
    }
  }
});

wireWipeButton('memo-wipe-btn', 'memo-wipe-msg', '/admin/memo/wipe', 'confirm_memo_wipe', 'memo_wipe_done_msg', loadMemoDays);

// Owner-only (card hidden otherwise, see boot()). Confirmed first because
// it notifies every guest at once - the same reason the voting phase
// buttons confirm.
$('memo-trigger-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_memo_trigger')))) return;
  const msg = $('memo-trigger-msg');
  msg.classList.remove('error');
  msg.textContent = '';
  try {
    await api('/admin/memo/trigger-next', { method: 'POST' });
    msg.textContent = t('memo_trigger_done');
    loadMemoDays();
    setTimeout(() => { if (msg.textContent === t('memo_trigger_done')) msg.textContent = ''; }, 4000);
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

/* --------------------------------- Tabs ---------------------------------- */

function selectAdminTab(tab) {
  document.querySelectorAll('#admin-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === tab));
  ['settings', 'plaza', 'wall', 'memo', 'rata', 'outfit', 'votelog'].forEach((name) => {
    $(`atab-${name}`).classList.toggle('hidden', name !== tab);
  });
  applyAdminTheme(tab);
  if (tab === 'wall' && isOwner) loadWallPseudonyms();
  if (tab === 'plaza' && isAdmin) loadPlazaPosts();
  if (tab === 'memo' && isAdmin) loadMemoDays();
  if (tab === 'votelog' && isOwner) loadVotes();
}

document.querySelectorAll('#admin-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => selectAdminTab(btn.dataset.atab));
});

// The star's whole point is being easy to miss - clicking straight into
// the tab it unlocks rather than first unhiding the nav button it replaced.
$('wall-secret-btn').addEventListener('click', () => selectAdminTab('wall'));
// Same idea for the voting logs - the diamond at the end of the Snatch tab.
$('votelog-secret-btn').addEventListener('click', () => selectAdminTab('votelog'));

// The top-left logo used to do nothing here - now it's "go home", same as
// clicking a site's logo anywhere else: back to the landing admin tab from
// wherever you've wandered off to (Rata, Wall, Users...).
const brandLogo = document.querySelector('.brand-name');
if (brandLogo) {
  brandLogo.style.cursor = 'pointer';
  brandLogo.addEventListener('click', () => selectAdminTab('settings'));
}

/* ------------------------------ Change key -------------------------------- */
// Self-service, open to every logged-in user (not admin-gated) - requires
// the current key as confirmation, new key is letters/numbers only.

function wireChangeKeyForm() {
  wirePasswordToggle('current-key-input', 'current-key-toggle');
  wirePasswordToggle('new-key-input', 'new-key-toggle');
  $('change-key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentToken = $('current-key-input').value.trim();
    const newToken = $('new-key-input').value.trim();
    $('change-key-msg').textContent = '';
    try {
      await api('/me/change-token', { method: 'POST', body: { currentToken, newToken } });
      setToken(newToken);
      refreshAccountToken();
      $('current-key-input').value = '';
      $('new-key-input').value = '';
      $('change-key-msg').textContent = t('key_changed_msg');
    } catch (err) {
      $('change-key-msg').textContent = err.message;
    }
  });
}

boot();

