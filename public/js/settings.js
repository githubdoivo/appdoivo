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

async function boot() {
  applyMode();
  applyI18n();
  updateLangUI();
  wireVersionBadge();
  await registerServiceWorker().catch(() => {});
  if (!getToken()) {
    $('auth-error').textContent = t('admin_no_session');
    return;
  }
  let me;
  try {
    me = await api('/me');
    adminPromotionEnabled = !!me.adminPromotionEnabled;
    isOwner = !!me.isOwner;
    isAdmin = !!me.isAdmin;
    plazaEnabled = !!me.plazaEnabled;
    wireLogoEasterEgg(me.name);
  } catch (err) {
    $('auth-error').textContent = err.message;
    return;
  }

  // Plaza is mid-rebuild (single note -> real posts feed), so it's
  // QA-only for now (see ENABLE_PLAZA in src/routes.js) - hidden for
  // everyone, owner included, regardless of the role-based rules below.
  if (!plazaEnabled) {
    document.querySelector('#admin-tabs [data-atab="plaza"]').classList.add('hidden');
  }

  const roleBadge = $('role-badge');
  if (isAdmin) {
    roleBadge.textContent = isOwner ? 'owner' : 'admin';
    roleBadge.classList.toggle('role-owner', isOwner);
    roleBadge.classList.toggle('role-admin', !isOwner);
  } else {
    // Plain users get no badge near the logo, same as the main app.
    roleBadge.classList.add('hidden');
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
    // its own tab - any admin sees it, same as before.
    $('users-management').classList.remove('hidden');
    if (!isOwner) {
      // A regular admin can see the Users list too, but the API only ever
      // gives them their own row (see GET /admin/users) - so nobody else's
      // key is ever exposed here, they just get to see it exist and their
      // own entry in it. Creating users and resetting event content are
      // owner-only actions on the backend regardless, so hide both instead
      // of showing controls that would just 403 if clicked.
      $('user-search-card').classList.add('hidden');
      $('reset-content-card').classList.add('hidden');
      // The Wall tab (pseudonym mapping + its timezone card) was opened up to
      // regular admins temporarily so testers could see it existed - that's
      // done now, so it's owner-only again, whole tab hidden rather than just
      // the sensitive card within it.
      document.querySelector('#admin-tabs [data-atab="wall"]').classList.add('hidden');
      // Any admin - not just the owner - can post to Plaza (see requireAdmin
      // on POST /admin/plaza-posts), so the tab stays visible.
    }
  }
  // Whoever you are, tapping the settings icon should always land you on
  // "Settings" first - admins/owner can still switch to their other tabs.
  selectAdminTab('settings');
  $('admin-content').classList.remove('hidden');
  refreshNotifButton('notif-btn');
  wireChangeKeyForm();
  if (isAdmin) reloadAll();
}

function reloadAll() {
  loadSettings();
  loadVotingState();
  loadUsers();
  loadContestants();
  loadVotes();
  loadConsequences();
}

/* -------------------------------- Idioma --------------------------------- */
// Single square button, like the theme toggle: shows the language you'll
// switch TO, not the one that's active.

function updateLangUI() {
  $('lang-toggle').textContent = getLang() === 'pt' ? 'en' : 'pt';
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

/* ------------------------------ Definicoes ------------------------------- */

// There's only one timezone setting, but it's edited from two places now -
// A Rata (where it drives the day rollover) and Wall (added so any admin,
// not just the owner, can fix it without needing the A Rata tab). Both
// inputs always show the same value.
async function loadSettings() {
  const s = await api('/admin/settings');
  $('timezone').value = s.timezone;
  $('timezone-wall').value = s.timezone;
}

async function saveTimezone(value, msgEl) {
  try {
    await api('/admin/settings', { method: 'PUT', body: { timezone: value.trim() } });
    msgEl.textContent = t('saved');
    setTimeout(() => (msgEl.textContent = ''), 2000);
    loadSettings();
  } catch (err) {
    msgEl.textContent = err.message;
  }
}

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveTimezone($('timezone').value, $('settings-msg'));
});

$('settings-form-wall').addEventListener('submit', (e) => {
  e.preventDefault();
  saveTimezone($('timezone-wall').value, $('settings-msg-wall'));
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
          ${u.is_owner ? `<button class="small ghost" data-change-own-key="${u.id}">${t('change_own_key_btn')}</button>` : ''}
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

  // Owner's own row: unlike "nova chave" (random) above, this lets the
  // owner type the exact key they want (e.g. "moss" -> "rock"), same as
  // the standalone change-key form everyone else uses - just inline here
  // instead of its own section, since the owner's tab is this list.
  $('users-list').querySelectorAll('[data-change-own-key]').forEach((b) => {
    b.addEventListener('click', () => {
      const row = b.closest('.user-row');
      if (row.querySelector('.own-key-form')) return;
      const form = document.createElement('form');
      form.className = 'own-key-form';
      form.style.marginTop = '10px';
      form.innerHTML = `
        <input type="password" class="own-key-current" placeholder="${esc(t('current_key_ph'))}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required />
        <input type="password" class="own-key-new" placeholder="${esc(t('new_key_ph'))}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required pattern="[A-Za-z0-9]+" style="margin-top:8px" />
        <div class="row-actions" style="justify-content:flex-start;margin-top:8px">
          <button type="submit" class="small">${t('save')}</button>
          <button type="button" class="small ghost own-key-cancel">${t('modal_cancel')}</button>
        </div>`;
      row.appendChild(form);
      form.querySelector('.own-key-current').focus();
      form.querySelector('.own-key-cancel').addEventListener('click', () => form.remove());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentToken = form.querySelector('.own-key-current').value.trim();
        const newToken = form.querySelector('.own-key-new').value.trim();
        try {
          await api('/me/change-token', { method: 'POST', body: { currentToken, newToken } });
          setToken(newToken);
          form.remove();
          await showAlert(t('key_changed_msg'));
          loadUsers();
        } catch (err) {
          await showAlert(err.message);
        }
      });
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
// empty). An empty set means no filter is active, same as "all roles".
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
    if (btn.dataset.role === 'all') {
      roleFilter.clear();
    } else if (roleFilter.has(btn.dataset.role)) {
      roleFilter.delete(btn.dataset.role);
    } else {
      roleFilter.add(btn.dataset.role);
    }
    $('user-role-filter').querySelectorAll('.role-pill').forEach((b) => {
      b.classList.toggle('active', b.dataset.role === 'all' ? roleFilter.size === 0 : roleFilter.has(b.dataset.role));
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

$('reset-content-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_reset_content'), { danger: true }))) return;
  try {
    await api('/admin/reset-content', { method: 'POST' });
    $('reset-content-msg').textContent = t('reset_content_done_msg');
    setTimeout(() => ($('reset-content-msg').textContent = ''), 3000);
    reloadAll();
  } catch (err) {
    $('reset-content-msg').textContent = err.message;
  }
});

/* ------------------------------ Concorrentes ----------------------------- */

async function loadContestants() {
  const { contestants } = await api(`/admin/contestants?night=${encodeURIComponent(currentNight())}`);
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

$('contestant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('contestant-name').value.trim();
  if (!name) return;
  await api('/admin/contestants', { method: 'POST', body: { name, night: currentNight() } });
  $('contestant-name').value = '';
  loadContestants();
});

/* --------------------------------- Votos --------------------------------- */

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
      results.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.votes}</td></tr>`).join('')
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

$('reveal-btn').addEventListener('click', async () => {
  $('reveal-msg').textContent = '';
  try {
    await api('/admin/consequences/reveal', { method: 'POST' });
    loadConsequences();
  } catch (err) {
    $('reveal-msg').textContent = err.message;
  }
});

async function loadConsequences() {
  const rows = await api('/admin/consequences');
  // rows are sorted most-recently-touched first (see GET /admin/consequences),
  // so the first 'used' one encountered is simply the current one.
  const revealed = rows.find((c) => c.status === 'used');
  $('revealed-consequence').classList.toggle('hidden', !revealed);
  if (revealed) $('revealed-consequence').textContent = revealed.text;

  $('consequences-table').innerHTML = rows.length
    ? `<tr><th>${t('col_text')}</th><th>${t('col_author')}</th><th>${t('col_day')}</th><th>${t('col_status')}</th></tr>` +
      rows.map((c) => `<tr>
        <td>${esc(c.text)}</td><td>${esc(c.author)}</td>
        <td class="muted">${esc(formatEuDate(c.day))}</td>
        <td>${c.status === 'used' ? t('status_used') : t('status_pending')}</td></tr>`).join('')
    : `<tr><td class="muted">${t('no_consequences')}</td></tr>`;
}

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
    $('plaza-poll-options').classList.toggle('hidden', plazaPostType !== 'poll');
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
            <span class="badge${p.type === 'poll' ? ' role-admin' : ' role-user'}">${p.type === 'poll' ? t('plaza_type_poll') : t('plaza_type_announcement')}</span>
            ${p.pinnedAt ? `<span class="plaza-pinned-badge">${t('plaza_post_pinned_label')}</span>` : ''}
            <span class="muted">${esc(p.author)} · ${esc(formatEuDateTime(p.created_at))}</span>
          </div>
        </div>
        <p style="margin:8px 0 0">${esc(p.text)}</p>
        ${p.type === 'poll' ? `
        <ul class="muted" style="margin:8px 0 0;padding-left:18px">
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
  const text = $('plaza-post-text').value;
  const options = plazaPostType === 'poll'
    ? [...$('plaza-poll-options').querySelectorAll('.plaza-poll-option-input')].map((i) => i.value)
    : undefined;
  try {
    await api('/admin/plaza-posts', { method: 'POST', body: { type: plazaPostType, text, options } });
    $('plaza-post-text').value = '';
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
      $('current-key-input').value = '';
      $('new-key-input').value = '';
      $('change-key-msg').textContent = t('key_changed_msg');
    } catch (err) {
      $('change-key-msg').textContent = err.message;
    }
  });
}

boot();

