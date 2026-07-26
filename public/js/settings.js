import { api, getToken, setToken } from './api.js';
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
    wireLogoEasterEgg(me.name);
  } catch (err) {
    $('auth-error').textContent = err.message;
    return;
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
  // plain user only gets the "Settings" tab (change their own key); the
  // rest of this scoping matches the main admin panel's existing rules.
  if (!isAdmin) {
    ['users', 'outfit', 'rata', 'wall'].forEach((tab) => {
      document.querySelector(`#admin-tabs [data-atab="${tab}"]`).classList.add('hidden');
    });
  } else if (!isOwner) {
    document.querySelector('#admin-tabs [data-atab="users"]').classList.add('hidden');
    document.querySelector('#admin-tabs [data-atab="wall"]').classList.add('hidden');
    // A regular admin can run voting and reveal consequences, but broader
    // configuration (timezone) stays owner-only.
    $('timezone-card').classList.add('hidden');
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
  if (isOwner) loadUsers();
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

$('lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'pt' ? 'en' : 'pt');
  applyI18n();
  updateLangUI();
  if (!$('admin-content').classList.contains('hidden')) reloadAll();
});

/* ------------------------------ Votacao ---------------------------------- */

// Night currently selected in the panel (scope of controls/contestants/votes).
function currentNight() {
  return $('admin-night')?.value || 'furnished';
}

$('admin-night').addEventListener('change', () => {
  loadVotingState();
  loadContestants();
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

async function loadVotingState() {
  const { nights } = await api('/admin/voting');
  const night = currentNight();
  const info = nights.find((n) => n.night === night);
  const status = info?.status || 'closed';
  const label = $('voting-state-label');
  label.textContent = t(VOTING_STATE_LABEL[status]);
  label.classList.toggle('is-registration', status === 'registration');
  label.classList.toggle('is-open', status === 'open');
  label.classList.toggle('is-closed', status === 'closed');

  const phase = info?.resultsPhase || 'hidden';
  const revealBtn = $('reveal-next-btn');
  revealBtn.textContent = t(NEXT_REVEAL_LABEL[phase]);
  revealBtn.disabled = phase === 'all' || status !== 'closed';
}

async function setVoting(action) {
  $('voting-msg').textContent = '';
  await api(`/admin/voting/${currentNight()}/${action}`, { method: 'POST' });
  loadVotingState();
  loadVotes();
  loadContestants();
}

$('voting-registration-btn').addEventListener('click', () => setVoting('registration'));
$('voting-open-btn').addEventListener('click', () => setVoting('open'));
$('voting-close-btn').addEventListener('click', () => setVoting('close'));
$('voting-reset-btn').addEventListener('click', async () => {
  if (!(await showConfirm(t('confirm_reset')))) return;
  setVoting('reset');
});

$('reveal-next-btn').addEventListener('click', async () => {
  $('reveal-phase-msg').textContent = '';
  try {
    await api(`/admin/voting/${currentNight()}/reveal-next`, { method: 'POST' });
    loadVotingState();
  } catch (err) {
    $('reveal-phase-msg').textContent = err.message;
  }
});

/* ------------------------------ Definicoes ------------------------------- */

async function loadSettings() {
  const s = await api('/admin/settings');
  $('timezone').value = s.timezone;
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/settings', {
      method: 'PUT',
      body: {
        timezone: $('timezone').value.trim(),
      },
    });
    $('settings-msg').textContent = t('saved');
    setTimeout(() => ($('settings-msg').textContent = ''), 2000);
  } catch (err) {
    $('settings-msg').textContent = err.message;
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
            ${esc(u.name)}
            ${u.is_owner ? '<span class="badge role-owner">owner</span>' : u.is_admin ? '<span class="badge role-admin">admin</span>' : '<span class="badge role-user">user</span>'}
          </div>
          <div class="user-row-token censored" data-token="${esc(u.token)}" data-reveal-token role="button" tabindex="0">••••••••••••</div>
        </div>
        <div class="row-actions">
          <button class="small ghost" data-copy-user="${esc(u.token)}">${t('copy')}</button>
          <button class="small ghost" data-regen-user="${u.id}">${t('regen_key')}</button>
          ${adminPromotionEnabled && !u.is_owner ? `<button class="small ghost" data-toggle-admin="${u.id}" data-next="${u.is_admin ? '0' : '1'}">${u.is_admin ? t('remove_admin_role') : t('make_admin')}</button>` : ''}
          ${u.is_owner ? '' : `<button class="small danger" data-del-user="${u.id}">${t('remove')}</button>`}
        </div>
      </div>`).join('')
    : `<p class="muted">${t('no_users')}</p>`;

  $('users-list').querySelectorAll('[data-copy-user]').forEach((b) => {
    b.addEventListener('click', () => copyToClipboard(b.dataset.copyUser, b));
  });

  // Keys are censored by default (someone glancing at a screen share
  // shouldn't see everyone's access keys) - click to reveal/hide. Copy
  // always works with the real value regardless of this toggle.
  $('users-list').querySelectorAll('[data-reveal-token]').forEach((el) => {
    const toggle = () => {
      const revealed = el.classList.toggle('censored') === false;
      el.textContent = revealed ? el.dataset.token : '••••••••••••';
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  $('users-list').querySelectorAll('[data-regen-user]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await showConfirm(t('confirm_regen_key')))) return;
      try {
        const u = await api(`/admin/users/${b.dataset.regenUser}/regenerate-token`, { method: 'POST' });
        await showAlert(t('key_regenerated', { name: u.name, token: u.token }));
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
        loadUsers();
      } catch (err) {
        await showAlert(err.message);
      }
    });
  });
}

// The name input doubles as a live search: below 4 characters it's treated
// as "not enough to judge yet" (full list shown, create disabled). At 4+
// characters it filters the list; if nothing matches, this is clearly a
// new person rather than someone already here, so create becomes the only
// sensible action. If something DOES match, creating is disabled on
// purpose - act on the existing user via its row buttons instead (copy,
// rename, remove, etc.), rather than risking an accidental duplicate.
function applyUserSearch() {
  const term = $('user-name-input').value.trim();
  const createBtn = $('user-form').querySelector('button[type="submit"]');

  if (term.length <= 3) {
    renderUsersList(allUsers);
    $('user-search-hint').classList.add('hidden');
    createBtn.disabled = true;
    return;
  }

  const matches = allUsers.filter((u) => u.name.toLowerCase().includes(term.toLowerCase()));
  renderUsersList(matches);

  const noMatch = matches.length === 0;
  $('user-search-hint').classList.toggle('hidden', !noMatch);
  createBtn.disabled = !noMatch;
}

async function loadUsers() {
  allUsers = await api('/admin/users');
  applyUserSearch();
}

$('user-name-input').addEventListener('input', applyUserSearch);

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('user-name-input').value.trim();
  if (!name) return;
  try {
    const u = await api('/admin/users', { method: 'POST', body: { name } });
    $('user-name-input').value = '';
    $('user-search-hint').classList.add('hidden');
    $('user-form').querySelector('button[type="submit"]').disabled = true;
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

// Night selected in the votes card sub-tabs (independent of the one at the top).
let votesNight = 'furnished';

async function loadVotes() {
  const { votes, results } = await api(`/admin/votes?night=${encodeURIComponent(votesNight)}`);
  const votesHtml = votes.length
    ? `<tr><th>${t('col_voter')}</th><th>${t('col_contestant')}</th><th>${t('col_time')}</th></tr>` +
      votes.map((v) => `<tr><td>${esc(v.voter)}</td><td>${esc(v.contestant)}</td><td class="muted">${esc(formatEuDateTime(v.created_at))}</td></tr>`).join('')
    : `<tr><td class="muted">${t('no_votes')}</td></tr>`;
  const resultsHtml = results.length
    ? `<tr><th>${t('ranking')}</th><th>${t('col_votes')}</th></tr>` +
      results.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.votes}</td></tr>`).join('')
    : '';
  $('votes-table').innerHTML = votesHtml + resultsHtml;
}

document.querySelectorAll('#votes-night-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#votes-night-tabs .tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    votesNight = btn.dataset.vnight;
    loadVotes();
  });
});

/* ------------------------------ Rata Game -------------------------------- */

$('reveal-btn').addEventListener('click', async () => {
  try {
    const r = await api('/admin/consequences/reveal', { method: 'POST' });
    $('reveal-msg').textContent = t('revealed_msg', { text: r.revealed.text });
    loadConsequences();
  } catch (err) {
    $('reveal-msg').textContent = err.message;
  }
});

async function loadConsequences() {
  const rows = await api('/admin/consequences');
  $('consequences-table').innerHTML = rows.length
    ? `<tr><th>${t('col_text')}</th><th>${t('col_author')}</th><th>${t('col_day')}</th><th>${t('col_status')}</th></tr>` +
      rows.map((c) => `<tr>
        <td>${esc(c.text)}</td><td>${esc(c.author)}</td>
        <td class="muted">${esc(formatEuDate(c.day))}</td>
        <td>${c.status === 'used' ? t('status_used') : t('status_pending')}</td></tr>`).join('')
    : `<tr><td class="muted">${t('no_consequences')}</td></tr>`;
}

async function loadWallPseudonyms() {
  const rows = await api('/admin/wall-pseudonyms');
  $('wall-pseudonyms-table').innerHTML = rows.length
    ? `<tr><th>${t('col_name')}</th><th>${t('col_pseudonym')}</th></tr>` +
      rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.pseudonym)}</td></tr>`).join('')
    : `<tr><td class="muted">${t('no_wall_pseudonyms')}</td></tr>`;
}

/* --------------------------------- Tabs ---------------------------------- */

function selectAdminTab(tab) {
  document.querySelectorAll('#admin-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === tab));
  ['users', 'outfit', 'rata', 'wall', 'settings'].forEach((name) => {
    $(`atab-${name}`).classList.toggle('hidden', name !== tab);
  });
  if (tab === 'wall' && isOwner) loadWallPseudonyms();
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

