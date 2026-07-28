import { api, getToken, setToken, clearToken } from './api.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode } from './theme.js';
import { registerServiceWorker, refreshNotifButton, wireNotifButton } from './push.js';
import { wireLogoEasterEgg } from './logoEasterEgg.js';
import { wirePasswordToggle } from './passwordToggle.js';
import { wireVersionBadge } from './version.js';
import { showAlert, showConfirm } from './modal.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// European date order everywhere: "YYYY-MM-DD[ HH:MM:SS]" -> "DD-MM-YYYY[ HH:MM]".
function formatEuDate(dateStr) {
  const [y, m, d] = String(dateStr).split(' ')[0].split('-');
  return `${d}-${m}-${y}`;
}
function formatEuDateTime(dateTimeStr) {
  const [datePart, timePart = ''] = String(dateTimeStr).split(' ');
  return `${formatEuDate(datePart)} ${timePart.slice(0, 5)}`.trim();
}

/** Copia texto para o clipboard e dá feedback breve no botão. */
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
    myUserId = me.id;
    myName = me.name;
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

  // This page is now open to every logged-in user, not just admins - a
  // plain user only gets the "Settings" tab (change their own key, no
  // user-management section); the rest of this scoping matches the main
  // admin panel's existing rules.
  if (!isAdmin) {
    ['plaza', 'outfit', 'rata', 'wall'].forEach((tab) => {
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
    if (!isOwner) {
      // The Wall tab (pseudonym mapping + its timezone card) was opened up to
      // regular admins temporarily so testers could see it existed - that's
      // done now, so it's owner-only again, whole tab hidden rather than just
      // the sensitive card within it.
      document.querySelector('#admin-tabs [data-atab="wall"]').classList.add('hidden');
      // Any admin - not just the owner - can post to Plaza (see requireAdmin
      // on POST /admin/plaza-posts), so the tab stays visible.
      // Per-feature kill switches (see POST /admin/consequences/wipe etc.)
      // are owner-only, same golden rule as everything else destructive.
      // chat-wipe-card doesn't need listing here - it lives inside the
      // wall tab, already hidden above.
      ['rata-wipe-card', 'outfit-wipe-card', 'plaza-wipe-card'].forEach((id) => {
        $(id).classList.add('hidden');
      });
    }
  }
  // Whoever you are, tapping the settings icon should always land you on
  // "Settings" first - admins/owner can still switch to their other tabs.
  selectAdminTab('settings');
  $('admin-content').classList.remove('hidden');
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

$('admin-night-switch').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('admin-night-switch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
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

$('voting-advance-btn').addEventListener('click', async () => {
  const action = $('voting-advance-btn').dataset.action;
  if (!action) return;
  $('voting-msg').textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/${action}`, { method: 'POST' });
    loadVotingState();
    loadVotes();
    loadContestants();
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
        <div class="user-row-top">
          <div class="user-row-name">
            <span class="user-row-name-text${isOwner ? ' name-edit' : ''}"${isOwner ? ` data-rename-user="${u.id}" data-current-name="${esc(u.name)}" role="button" tabindex="0"` : ''}>${esc(u.name)}</span>
            ${u.is_owner ? '<span class="badge role-owner">owner</span>' : u.is_admin ? '<span class="badge role-admin">admin</span>' : '<span class="badge role-user">user</span>'}
          </div>
          <div class="user-row-token censored" data-token="${esc(u.token)}" data-reveal-token role="button" tabindex="0">••••••••••••</div>
        </div>
        ${isOwner ? `
        <div class="row-actions">
          ${adminPromotionEnabled && !u.is_owner ? `<button class="small ghost" data-toggle-admin="${u.id}" data-next="${u.is_admin ? '0' : '1'}">${u.is_admin ? 'user' : 'admin'}</button>` : ''}
          <button class="small ghost" data-regen-user="${u.id}">${t('regen_key')}</button>
          ${u.is_owner ? '' : `<button class="small danger" data-del-user="${u.id}">${t('remove')}</button>`}
        </div>` : ''}
      </div>`).join('')
    : `<p class="muted">${t('no_users')}</p>`;

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
    };
    b.addEventListener('click', startEdit);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
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
// empty). An empty set (none picked) already means "show everyone" -
// no separate "all roles" button needed for that.
const roleFilter = new Set();
function byRole(users) {
  return roleFilter.size === 0 ? users : users.filter((u) => roleFilter.has(roleOf(u)));
}

function applyUserSearch() {
  const term = $('user-name-input').value.trim();
  const createBtn = $('user-form').querySelector('button[type="submit"]');

  if (term.length < 3) {
    renderUsersList(withRecentFirst(byRole(allUsers)));
    $('user-search-hint').classList.add('hidden');
    createBtn.disabled = true;
    return;
  }

  const foldedTerm = foldAccents(term.toLowerCase());
  const nameMatches = allUsers.filter((u) => foldAccents(u.name.toLowerCase()).includes(foldedTerm));
  renderUsersList(withRecentFirst(byRole(nameMatches)));

  const noMatch = nameMatches.length === 0;
  $('user-search-hint').classList.toggle('hidden', !noMatch);
  createBtn.disabled = !noMatch;
}

async function loadUsers() {
  allUsers = await api('/admin/users');
  applyUserSearch();
}

$('user-name-input').addEventListener('input', applyUserSearch);

$('user-role-filter').querySelectorAll('.role-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (roleFilter.has(btn.dataset.role)) {
      roleFilter.delete(btn.dataset.role);
    } else {
      roleFilter.add(btn.dataset.role);
    }
    $('user-role-filter').querySelectorAll('.role-pill').forEach((b) => {
      b.classList.toggle('active', roleFilter.has(b.dataset.role));
    });
    applyUserSearch();
  });
});

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('user-name-input').value.trim();
  if (!name) return;
  try {
    const u = await api('/admin/users', { method: 'POST', body: { name } });
    $('user-name-input').value = '';
    $('user-search-hint').classList.add('hidden');
    $('user-form').querySelector('button[type="submit"]').disabled = true;
    markRecent(u.id);
    await showAlert(t('user_created', { name: u.name, token: u.token }));
    loadUsers();
  } catch (err) {
    await showAlert(err.message);
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

function renderContestants() {
  const term = foldAccents($('contestant-search').value.trim().toLowerCase());
  const contestants = term
    ? allContestants.filter((c) => foldAccents(c.name.toLowerCase()).includes(term))
    : allContestants;
  $('contestants-table').innerHTML = contestants.length
    ? `<tr><th>${t('col_name')}</th><th>${t('col_registered_by')}</th><th></th></tr>` + contestants.map((c) => {
        const who = c.partner_name
          ? `${esc(c.registered_by)} &amp; ${esc(c.partner_name)}`
          : c.registered_by ? esc(c.registered_by) : '-';
        return `
        <tr>
          <td><span class="contestant-name-edit" data-edit-contestant="${c.id}" data-name="${esc(c.name)}" role="button" tabindex="0">${esc(c.name)}</span></td>
          <td class="muted">${who}</td>
          <td style="text-align:right"><button class="small danger" data-del-contestant="${c.id}">${t('remove')}</button></td>
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
  if (!adminRegisterUsersCache) adminRegisterUsersCache = await api('/users/basic');
  return adminRegisterUsersCache;
}

// Wires a search input to a results container: type to filter
// /users/basic by name, click a result to pick it (calling onPick with the
// chosen user's id). Used twice below (participant, partner) - identical
// behavior to app.js's own partner-search, just parameterized so it's not
// duplicated per field.
function wireAdminUserSearch(inputEl, resultsEl, onPick) {
  inputEl.addEventListener('input', async () => {
    onPick(null);
    const term = inputEl.value.trim().toLowerCase();
    if (term.length < 2) { resultsEl.innerHTML = ''; return; }
    const users = await ensureAdminRegisterUsersCache();
    const matches = users.filter((u) => u.name.toLowerCase().includes(term)).slice(0, 6);
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

  $('voter-log-card').classList.toggle('hidden', !votes);
  if (votes) {
    $('voter-log-table').innerHTML = votes.length
      ? `<tr><th>${t('col_voter')}</th><th>${t('col_contestant')}</th><th>${t('col_time')}</th></tr>` +
        votes.map((v) => `<tr><td>${esc(v.voter)}</td><td>${esc(v.contestant)}</td><td class="muted">${esc(formatEuDateTime(v.created_at))}</td></tr>`).join('')
      : `<tr><td class="muted">${t('no_votes')}</td></tr>`;
  }
}

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
const rataStatusFilter = new Set(['fila', 'pendente', 'feita']);
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

function userOptionsHtml(selectedId) {
  return `<option value="">${t('rata_assign_placeholder')}</option>` +
    rataAssignableUsers.map((u) => `<option value="${u.id}"${u.id === selectedId ? ' selected' : ''}>${esc(u.name)}</option>`).join('');
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
  const time = c.revealed_at ? String(c.revealed_at).split(' ')[1].slice(0, 5) : '';
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
      <select data-assign-id="${c.id}">${userOptionsHtml(c.assigned_user_id)}</select>
      ${canApprove ? `<button type="button" class="small ghost" data-approve-id="${c.id}">${t('rata_approve_btn')}</button>` : ''}
    </div>
  </div>`;
}

function renderConsequences() {
  // rows are sorted most-recently-touched first (see GET /admin/consequences),
  // so the first 'used' one encountered is simply the current one.
  const revealed = rataRows.find((c) => c.status === 'used');

  const assignRows = rataRows.filter((c) => rataStatus(c).state === 'atribuir');
  $('consequences-assign-list').innerHTML = assignRows.length
    ? assignRows.map((c) => renderConsequenceCard(c, revealed)).join('')
    : `<p class="muted">${t('rata_admin_assign_empty')}</p>`;

  const historyRows = rataRows.filter((c) => {
    const state = rataStatus(c).state;
    return state !== 'atribuir' && rataStatusFilter.has(state);
  });
  $('consequences-table').innerHTML = historyRows.length
    ? historyRows.map((c) => renderConsequenceCard(c, revealed)).join('')
    : `<p class="muted">${t('no_consequences')}</p>`;
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
// now render in either #consequences-assign-list (atribuir) or
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

async function loadPlazaPosts() {
  const { posts } = await api('/admin/plaza-posts');
  $('plaza-posts-list').innerHTML = posts.length
    ? posts.map((p) => `
      <div class="user-row">
        <div class="user-row-top">
          <div class="user-row-name">
            <span class="badge${p.type === 'poll' ? ' type-poll' : ' type-announcement'}">${p.type === 'poll' ? t('plaza_type_poll') : t('plaza_type_announcement')}</span>
            ${p.pinnedAt ? `<span class="plaza-pinned-badge">${t('plaza_post_pinned_label')}</span>` : ''}
          </div>
        </div>
        <p class="muted" style="margin:10px 0 0">${esc(p.author)} · ${esc(formatEuDateTime(p.created_at))}</p>
        <p style="margin:8px 0 0">${esc(p.text)}</p>
        ${p.type === 'poll' ? `
        <ul class="muted" style="margin:8px 0 0;padding-left:0;list-style:none">
          ${p.options.map((o) => {
            const names = p.voters.filter((v) => v.option === o.label).map((v) => esc(v.name));
            return `<li>${esc(o.label)} - ${o.votes}${names.length ? ` <span class="muted">(${names.join(', ')})</span>` : ''}</li>`;
          }).join('')}
        </ul>` : ''}
        <div class="row-actions">
          ${isOwner ? `<button class="small ghost" data-pin-post="${p.id}" data-pinned="${!!p.pinnedAt}">${t(p.pinnedAt ? 'plaza_unpin_btn' : 'plaza_pin_btn')}</button>` : ''}
          <button class="small danger" data-del-post="${p.id}">${t('remove')}</button>
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

/* --------------------------------- Tabs ---------------------------------- */

function selectAdminTab(tab) {
  document.querySelectorAll('#admin-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === tab));
  ['plaza', 'outfit', 'rata', 'wall', 'settings'].forEach((name) => {
    $(`atab-${name}`).classList.toggle('hidden', name !== tab);
  });
  if (tab === 'wall' && isOwner) loadWallPseudonyms();
  if (tab === 'plaza' && isAdmin) loadPlazaPosts();
}

document.querySelectorAll('#admin-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => selectAdminTab(btn.dataset.atab));
});

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

