import { api, getToken } from './api.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode } from './theme.js';
import { registerServiceWorker, refreshNotifButton, wireNotifButton } from './push.js';

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

async function boot() {
  applyMode();
  applyI18n();
  updateLangUI();
  await registerServiceWorker().catch(() => {});
  if (!getToken()) {
    $('auth-error').textContent = t('admin_no_session');
    return;
  }
  try {
    const me = await api('/me');
    if (!me.isAdmin) {
      $('auth-error').textContent = t('admin_only');
      return;
    }
    adminPromotionEnabled = !!me.adminPromotionEnabled;
    isOwner = !!me.isOwner;
  } catch (err) {
    $('auth-error').textContent = err.message;
    return;
  }
  const roleBadge = $('role-badge');
  roleBadge.textContent = isOwner ? 'owner' : 'admin';
  roleBadge.classList.toggle('role-owner', isOwner);
  roleBadge.classList.toggle('role-admin', !isOwner);
  if (!isOwner) {
    document.querySelector('#admin-tabs [data-atab="users"]').classList.add('hidden');
    selectAdminTab('rata');
  }
  $('admin-content').classList.remove('hidden');
  refreshNotifButton('notif-btn');
  reloadAll();
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
  $('lang-toggle').textContent = getLang() === 'pt' ? 'EN' : 'PT';
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

async function loadVotingState() {
  const { nights } = await api('/admin/voting');
  const night = currentNight();
  const info = nights.find((n) => n.night === night);
  const open = info?.status === 'open';
  const label = $('voting-state-label');
  label.textContent = open ? t('voting_is_open') : t('voting_is_closed');
  label.classList.toggle('is-open', open);
  label.classList.toggle('is-closed', !open);

  const phase = info?.resultsPhase || 'hidden';
  const revealBtn = $('reveal-next-btn');
  revealBtn.textContent = t(NEXT_REVEAL_LABEL[phase]);
  revealBtn.disabled = phase === 'all' || open;
}

async function setVoting(action) {
  $('voting-msg').textContent = '';
  await api(`/admin/voting/${currentNight()}/${action}`, { method: 'POST' });
  loadVotingState();
  loadVotes();
}

$('voting-open-btn').addEventListener('click', () => setVoting('open'));
$('voting-close-btn').addEventListener('click', () => setVoting('close'));
$('voting-reset-btn').addEventListener('click', () => {
  if (!confirm(t('confirm_reset'))) return;
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

async function loadUsers() {
  const users = await api('/admin/users');

  $('users-list').innerHTML = users.length
    ? users.map((u) => `
      <div class="user-row">
        <div class="user-row-top">
          <div class="user-row-name">
            ${esc(u.name)}
            ${u.is_owner ? '<span class="badge role-owner">owner</span>' : u.is_admin ? '<span class="badge role-admin">admin</span>' : '<span class="badge role-user">user</span>'}
          </div>
          <div class="user-row-token">${esc(u.token)}</div>
        </div>
        <div class="row-actions">
          <button class="small ghost" data-copy-user="${esc(u.token)}">${t('copy')}</button>
          ${adminPromotionEnabled && !u.is_owner ? `<button class="small ghost" data-toggle-admin="${u.id}" data-next="${u.is_admin ? '0' : '1'}">${u.is_admin ? t('remove_admin_role') : t('make_admin')}</button>` : ''}
          ${u.is_owner ? '' : `<button class="small danger" data-del-user="${u.id}">${t('remove')}</button>`}
        </div>
      </div>`).join('')
    : `<p class="muted">${t('no_users')}</p>`;

  $('users-list').querySelectorAll('[data-copy-user]').forEach((b) => {
    b.addEventListener('click', () => copyToClipboard(b.dataset.copyUser, b));
  });

  $('users-list').querySelectorAll('[data-del-user]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm(t('confirm_remove_user'))) return;
      await api(`/admin/users/${b.dataset.delUser}`, { method: 'DELETE' });
      loadUsers();
    });
  });

  $('users-list').querySelectorAll('[data-toggle-admin]').forEach((b) => {
    b.addEventListener('click', async () => {
      const makingAdmin = b.dataset.next === '1';
      if (!confirm(t(makingAdmin ? 'confirm_make_admin' : 'confirm_remove_admin_role'))) return;
      try {
        await api(`/admin/users/${b.dataset.toggleAdmin}/admin`, { method: 'PATCH', body: { isAdmin: makingAdmin } });
        loadUsers();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  $('copy-all-users').onclick = () => {
    const lines = users.filter((u) => !u.is_admin).map((u) => `${u.name}: ${u.token}`).join('\n');
    copyToClipboard(lines, $('copy-all-users'));
  };
}

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('user-name-input').value.trim();
  if (!name) return;
  try {
    const u = await api('/admin/users', { method: 'POST', body: { name } });
    $('user-name-input').value = '';
    alert(t('user_created', { name: u.name, token: u.token }));
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
});

$('reset-content-btn').addEventListener('click', async () => {
  if (!confirm(t('confirm_reset_content'))) return;
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
    ? `<tr><th>${t('col_name')}</th><th></th></tr>` + contestants.map((c) => `
        <tr><td>${esc(c.name)}</td>
        <td><button class="small danger" data-del-contestant="${c.id}">${t('remove')}</button></td></tr>`).join('')
    : `<tr><td class="muted">${t('no_contestants')}</td></tr>`;

  $('contestants-table').querySelectorAll('[data-del-contestant]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/admin/contestants/${b.dataset.delContestant}`, { method: 'DELETE' });
      loadContestants();
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

/* --------------------------------- Tabs ---------------------------------- */

function selectAdminTab(tab) {
  document.querySelectorAll('#admin-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === tab));
  ['users', 'outfit', 'rata'].forEach((name) => {
    $(`atab-${name}`).classList.toggle('hidden', name !== tab);
  });
}

document.querySelectorAll('#admin-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => selectAdminTab(btn.dataset.atab));
});

boot();

