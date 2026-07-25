import { api, getToken, setToken, clearToken } from './api.js';
import { registerServiceWorker, enablePush, pushSupport } from './push.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode } from './theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let currentTab = 'rata';

/* ------------------------------- Arranque -------------------------------- */

async function boot() {
  applyMode();
  applyI18n();
  updateLangUI();
  applyNight();
  await registerServiceWorker().catch(() => {});
  const token = getToken();
  if (!token) return showLogin();
  try {
    const me = await api('/me');
    showApp(me);
  } catch {
    clearToken();
    showLogin();
  }
}

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
}

function showApp(me) {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  if (me.isAdmin) {
    const adminBadge = $('admin-badge');
    adminBadge.textContent = me.isOwner ? 'owner' : 'admin';
    adminBadge.classList.toggle('role-owner', me.isOwner);
    adminBadge.classList.toggle('role-admin', !me.isOwner);
    adminBadge.classList.remove('hidden');
    $('admin-link').classList.remove('hidden');
  } else {
    const badge = $('user-badge');
    badge.textContent = me.adminPromotionEnabled ? t('tester_badge') : me.name;
    badge.classList.toggle('tester-badge', !!me.adminPromotionEnabled);
    badge.classList.remove('hidden');
  }
  refreshNotifButton();
  loadConsequences();
  loadVotes();
  applyDeepLinkParams();
}

/* -------------------------------- Idioma --------------------------------- */

function updateLangUI() {
  const lang = getLang();
  document.querySelectorAll('#lang-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
}

document.querySelectorAll('#lang-switch button').forEach((b) => {
  b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    applyI18n();
    updateLangUI();
    applyNight();
    refreshNotifButton();
    loadConsequences();
    loadVotes();
    closeMenu();
  });
});

/* --------------------------------- Menu ----------------------------------- */

function closeMenu() {
  $('menu-panel').classList.add('hidden');
  $('menu-toggle').setAttribute('aria-expanded', 'false');
}

$('theme-toggle').addEventListener('click', () => toggleMode());

$('menu-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const nowHidden = $('menu-panel').classList.toggle('hidden');
  $('menu-toggle').setAttribute('aria-expanded', String(!nowHidden));
});

document.addEventListener('click', (e) => {
  if (!$('menu-panel').contains(e.target) && e.target !== $('menu-toggle')) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

/* -------------------------------- Login ---------------------------------- */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token-input').value.trim();
  $('login-error').textContent = '';
  try {
    setToken(token);
    const me = await api('/me');
    showApp(me);
  } catch (err) {
    clearToken();
    $('login-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', () => {
  clearToken();
  location.reload();
});

/* --------------------------------- Tabs ---------------------------------- */

function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  currentTab = tab;
  $('tab-rata').classList.toggle('hidden', currentTab !== 'rata');
  $('tab-outfit').classList.toggle('hidden', currentTab !== 'outfit');
  applyNight();
  if (currentTab === 'rata') loadConsequences();
  if (currentTab === 'outfit') loadVotes();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});

// Notification taps land here with ?tab=&night= so the app opens straight
// on the result being announced, instead of just wherever it was left.
function applyDeepLinkParams() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  const night = params.get('night');
  if (!tab && !night) return;

  if (night && NIGHTS.includes(night)) {
    localStorage.setItem(NIGHT_KEY, night);
  }
  if (tab === 'rata' || tab === 'outfit') {
    selectTab(tab);
  }
  history.replaceState({}, '', location.pathname);
}

/* ----------------------------- Notificacoes ------------------------------ */

function refreshNotifButton() {
  const state = pushSupport();
  const notifBtn = $('notif-btn');

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

$('notif-btn').addEventListener('click', async () => {
  if (pushSupport() === 'granted') {
    alert(t('notif_already_on_msg'));
    return;
  }
  try {
    const ok = await enablePush();
    if (ok) alert(t('notif_enabled_msg'));
  } catch { /* mensagens tratadas em push.js */ }
  refreshNotifButton();
});

/* ------------------------------- Rata Game ------------------------------- */

async function loadConsequences() {
  try {
    const data = await api('/consequences/current');
    $('current-consequence').textContent = data.current ? data.current.text : t('rata_none');
    $('pending-line').textContent = t('rata_pending', { n: data.pending });

    if (data.mySuggestion) {
      $('suggest-area').innerHTML =
        `<p class="highlight">${t('rata_my')}<br><em>&ldquo;${esc(data.mySuggestion.text)}&rdquo;</em></p>`;
      $('suggest-msg').textContent = t('rata_one_per_day');
    } else {
      $('suggest-msg').textContent = '';
    }
  } catch (err) {
    $('current-consequence').textContent = err.message;
  }
}

$('suggest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('suggest-text').value.trim();
  if (!text) return;
  try {
    await api('/consequences', { method: 'POST', body: { text } });
    loadConsequences();
  } catch (err) {
    $('suggest-msg').textContent = err.message;
  }
});

/* ------------------------------ Best Outfit ------------------------------ */

// Voting is per NIGHT. Each night has its own aesthetic (theme) and its own
// independent vote. The selector below picks the active night, re-skins the
// WHOLE page and shows that night's vote. Nights this edition: furnished | swamp.
const NIGHTS = ['furnished', 'swamp'];
const NIGHT_KEY = 'appivo_night';

function getNight() {
  const n = localStorage.getItem(NIGHT_KEY);
  return NIGHTS.includes(n) ? n : NIGHTS[0];
}

function applyNight() {
  const night = getNight();
  // The night's theme re-skins the WHOLE page, but only when Best Outfit is active.
  const onOutfit = currentTab === 'outfit';
  NIGHTS.forEach((n) => {
    document.body.classList.toggle(`theme-${n}`, onOutfit && night === n);
  });
  document.body.classList.toggle('theme-rata', currentTab === 'rata');
  document.querySelectorAll('#theme-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === night);
  });
  const label = $('outfit-theme-name');
  if (label) label.textContent = t(night === 'swamp' ? 'theme_swamp' : 'theme_furnished');
}

document.querySelectorAll('#theme-switch button').forEach((b) => {
  b.addEventListener('click', () => {
    localStorage.setItem(NIGHT_KEY, b.dataset.theme);
    applyNight();
    loadVotes();
  });
});

async function loadVotes() {
  const area = $('vote-area');
  const night = getNight();
  try {
    const data = await api(`/votes/status?night=${encodeURIComponent(night)}`);
    const results = Array.isArray(data.results) ? data.results : [];

    // Status controlled by the admin: open / closed-pending-reveal / closed.
    let statusKey;
    if (data.status === 'open') statusKey = 'outfit_open';
    else if (data.status === 'closed' && data.resultsPhase === 'hidden') statusKey = 'outfit_results_pending';
    else if (data.status === 'closed') statusKey = 'outfit_closed';
    else statusKey = 'outfit_wait';
    $('voting-status').textContent = t(statusKey);

    if (data.status === 'open' && !data.myVote) {
      area.innerHTML = data.contestants.length
        ? data.contestants.map((c) => `<button class="vote-option" data-id="${c.id}">${esc(c.name)}</button>`).join('')
        : `<p class="muted">${t('outfit_no_contestants')}</p>`;
      area.querySelectorAll('.vote-option').forEach((b) => {
        b.addEventListener('click', () => vote(Number(b.dataset.id)));
      });
    } else if (data.status === 'open' && data.myVote) {
      const chosen = data.contestants.find((c) => c.id === data.myVote.contestant_id);
      const msg = chosen ? t('outfit_voted_name', { name: esc(chosen.name) }) : t('outfit_voted');
      area.innerHTML = `<p class="highlight">${msg}</p>`;
    } else {
      area.innerHTML = '';
    }

    const revealing = data.status === 'closed' && data.resultsPhase && data.resultsPhase !== 'hidden';
    if (revealing && results.length) {
      $('results-card').classList.remove('hidden');
      const list = $('results-list');
      // Before "all", show just what's been revealed so far, labeled by its
      // actual rank (not the tier list's auto-numbering, which would be
      // wrong for a partial set) - e.g. "3rd place" appearing alone first.
      list.classList.toggle('podium-reveal', data.resultsPhase !== 'all');
      list.innerHTML = results.map((r) => {
        const label = data.resultsPhase === 'all' ? esc(r.name) : `${t(`rank_${r.rank}`)} · ${esc(r.name)}`;
        return `<li><span class="name">${label}</span><span class="votes">${r.votes} ${t(r.votes === 1 ? 'vote_one' : 'votes_short')}</span></li>`;
      }).join('');
    } else {
      $('results-card').classList.add('hidden');
    }
  } catch (err) {
    $('voting-status').textContent = err.message;
  }
}

async function vote(contestantId) {
  try {
    await api('/votes', { method: 'POST', body: { contestantId, night: getNight() } });
    loadVotes();
  } catch (err) {
    alert(err.message);
  }
}

boot();
