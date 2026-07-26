import { api, getToken, setToken, clearToken } from './api.js';
import { registerServiceWorker, refreshNotifButton, wireNotifButton } from './push.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode } from './theme.js';
import { wireLogoEasterEgg } from './logoEasterEgg.js';
import { wirePasswordToggle } from './passwordToggle.js';
import { wireVersionBadge } from './version.js';
import { showAlert } from './modal.js';

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
  wireVersionBadge();
  // applyNight() is deliberately NOT called here: it sets body.theme-rata,
  // and iOS Safari's rubber-band overscroll paints straight from body's
  // background - a region no child element (including #login's own white
  // background) can cover. Only apply it once the app itself is shown
  // (see showApp()), so the login screen never carries a night theme.
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
  applyNight();
  wireLogoEasterEgg(me.name);
  if (me.isAdmin) {
    const adminBadge = $('admin-badge');
    adminBadge.textContent = me.isOwner ? 'owner' : 'admin';
    adminBadge.classList.toggle('role-owner', me.isOwner);
    adminBadge.classList.toggle('role-admin', !me.isOwner);
    adminBadge.classList.remove('hidden');
  }
  // Plain (non-admin) users get no badge near the logo at all - only
  // owner/admin are flagged there. Manage Users still shows every role.
  // The settings link (change my own key, plus admin tabs if applicable)
  // is open to everyone now, not just admins.
  $('settings-link').classList.remove('hidden');
  refreshNotifButton();
  loadConsequences();
  // Best Outfit's own data loads when its tab is actually selected (see
  // selectTab()) - not here too. It used to double-load unconditionally,
  // which was harmless when the outfit tab was just static vote buttons,
  // but now that it has a live registration form, a late-resolving response
  // from this redundant call could silently wipe out text someone's mid-
  // typing (the newer selectTab() load re-renders the same DOM nodes).
  applyDeepLinkParams();
  if (!me.tutorialSeen) startTutorial();
}

/* ------------------------------- Tutorial --------------------------------- */
// First-session walkthrough. Tied to the account (tutorial_seen on the
// user row), not localStorage, so it doesn't repeat on a new device and
// doesn't reappear just because storage got cleared.

const TUTORIAL_STEPS = [
  ['tutorial_1_title', 'tutorial_1_text'],
  ['tutorial_2_title', 'tutorial_2_text'],
  ['tutorial_3_title', 'tutorial_3_text'],
  ['tutorial_wall_title', 'tutorial_wall_text'],
  ['tutorial_4_title', 'tutorial_4_text'],
  ['tutorial_5_title', 'tutorial_5_text'],
];
let tutorialStep = 0;

function renderTutorialStep() {
  const [titleKey, textKey] = TUTORIAL_STEPS[tutorialStep];
  $('tutorial-title').textContent = t(titleKey);
  $('tutorial-text').textContent = t(textKey);
  $('tutorial-next').textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? t('tutorial_done') : t('tutorial_next');
  $('tutorial-dots').innerHTML = TUTORIAL_STEPS
    .map((_, i) => `<span class="dot${i === tutorialStep ? ' active' : ''}"></span>`)
    .join('');
}

function startTutorial() {
  // Ask for the app's language first (not just the tour's) - it becomes
  // the app-wide preselected language and can still be changed later.
  $('tutorial-lang-step').classList.remove('hidden');
  $('tutorial-content-step').classList.add('hidden');
  $('tutorial-overlay').classList.remove('hidden');
}

function beginTutorialContent(lang) {
  setLang(lang);
  applyI18n();
  updateLangUI();
  $('tutorial-lang-step').classList.add('hidden');
  $('tutorial-content-step').classList.remove('hidden');
  tutorialStep = 0;
  renderTutorialStep();
}

async function endTutorial() {
  $('tutorial-overlay').classList.add('hidden');
  try { await api('/me/tutorial-seen', { method: 'POST' }); } catch { /* not critical */ }
}

$('tutorial-lang-pt').addEventListener('click', () => beginTutorialContent('pt'));
$('tutorial-lang-en').addEventListener('click', () => beginTutorialContent('en'));

$('tutorial-next').addEventListener('click', () => {
  if (tutorialStep < TUTORIAL_STEPS.length - 1) {
    tutorialStep++;
    renderTutorialStep();
  } else {
    endTutorial();
  }
});

$('tutorial-skip').addEventListener('click', () => endTutorial());

/* -------------------------------- Idioma --------------------------------- */
// Single square button, like the theme toggle: it shows the language you'll
// switch TO, not the one that's active.

function updateLangUI() {
  $('lang-toggle').textContent = getLang() === 'pt' ? 'en' : 'pt';
}

$('lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'pt' ? 'en' : 'pt');
  applyI18n();
  updateLangUI();
  applyNight();
  refreshNotifButton();
  loadConsequences();
  loadVotes();
});

$('theme-toggle').addEventListener('click', () => toggleMode());

/* -------------------------------- Login ---------------------------------- */

wirePasswordToggle('token-input', 'token-toggle');

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

// Logout itself lives on the Settings page now (settings.js) - it's rare
// enough not to need a permanent topbar icon slot on every page.

/* --------------------------------- Tabs ---------------------------------- */

function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  currentTab = tab;
  $('tab-rata').classList.toggle('hidden', currentTab !== 'rata');
  $('tab-outfit').classList.toggle('hidden', currentTab !== 'outfit');
  $('tab-chat').classList.toggle('hidden', currentTab !== 'chat');
  applyNight();
  if (currentTab === 'rata') loadConsequences();
  if (currentTab === 'outfit') loadVotes();
  if (currentTab === 'chat') startChatPolling();
  else stopChatPolling();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});

/* --------------------------------- Chat ----------------------------------- */
// Open, ephemeral group chat. Polled (not real-time/websocket) - simplest
// fit for this app's minimal-stack style. Messages expire server-side.

let chatPollTimer = null;

function startChatPolling() {
  loadChat();
  if (chatPollTimer) return;
  chatPollTimer = setInterval(loadChat, 3000);
}

function stopChatPolling() {
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

function formatChatTime(dateTimeStr) {
  return (String(dateTimeStr).split(' ')[1] || '').slice(0, 5);
}

async function loadChat() {
  try {
    const { messages } = await api('/chat/messages');
    const el = $('chat-messages');
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    el.innerHTML = messages.length
      ? messages.map((m) => `
        <div class="chat-msg">
          <div class="chat-msg-head">
            <span class="chat-msg-author">${esc(m.author)}</span>
            <span class="chat-msg-time">${formatChatTime(m.created_at)}</span>
          </div>
          <div class="chat-msg-text">${esc(m.text)}</div>
        </div>`).join('')
      : `<p class="chat-empty">${t('chat_empty')}</p>`;
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch { /* transient network hiccup - the next poll will retry */ }
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-text');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/chat/messages', { method: 'POST', body: { text } });
    input.value = '';
    await loadChat();
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  } catch (err) {
    await showAlert(err.message);
  }
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

wireNotifButton('notif-btn');

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
  document.body.classList.toggle('theme-mural', currentTab === 'chat');
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

/* --------------------------- Candidatura (Best Outfit) ------------------- */
// Self-registration, only shown while the admin has this night in the
// 'registration' phase (see nightStatus() in src/time.js). Solo or teamed up
// with another user picked from /users/basic - a duo shares one contestant
// entry and one combined vote for the night (see castVote() server-side).

let registerMode = 'solo';
let registerPartnerId = null;
let usersCache = null;

async function ensureUsersCache() {
  if (!usersCache) usersCache = await api('/users/basic');
  return usersCache;
}

function renderRegistration(data) {
  const card = $('register-card');
  const area = $('register-area');
  if (data.status !== 'registration') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  if (data.myContestant) {
    const msg = data.myContestant.partnerName
      ? t('outfit_registered_with', { name: esc(data.myContestant.name), partner: esc(data.myContestant.partnerName) })
      : t('outfit_registered_as', { name: esc(data.myContestant.name) });
    area.innerHTML = `<p class="highlight">${msg}</p>`;
    return;
  }

  registerMode = 'solo';
  registerPartnerId = null;
  area.innerHTML = `
    <form id="register-form">
      <div class="theme-switch" id="register-mode-switch">
        <button type="button" data-mode="solo" class="active">${t('outfit_register_solo')}</button>
        <button type="button" data-mode="duo">${t('outfit_register_duo')}</button>
      </div>
      <div id="register-partner-wrap" class="hidden" style="margin-top:10px">
        <input id="register-partner-search" type="text" placeholder="${esc(t('outfit_register_partner_ph'))}" autocomplete="off" />
        <div id="register-partner-results" class="partner-results"></div>
      </div>
      <input id="register-name" type="text" maxlength="60" placeholder="${esc(t('outfit_register_ph'))}" style="margin-top:10px" autocomplete="off" />
      <button type="submit" style="margin-top:10px">${t('outfit_register_btn')}</button>
    </form>`;

  const modeButtons = area.querySelectorAll('#register-mode-switch button');
  modeButtons.forEach((b) => {
    b.addEventListener('click', () => {
      registerMode = b.dataset.mode;
      modeButtons.forEach((x) => x.classList.toggle('active', x === b));
      $('register-partner-wrap').classList.toggle('hidden', registerMode !== 'duo');
      // Duo entries register both people under one name, so the field asks
      // for "your (both's)" name instead of "your" name.
      $('register-name').placeholder = t(registerMode === 'duo' ? 'outfit_register_ph_duo' : 'outfit_register_ph');
      if (registerMode === 'solo') {
        registerPartnerId = null;
        $('register-partner-search').value = '';
        $('register-partner-results').innerHTML = '';
      }
    });
  });

  const searchInput = $('register-partner-search');
  const resultsEl = $('register-partner-results');
  searchInput.addEventListener('input', async () => {
    registerPartnerId = null;
    const term = searchInput.value.trim().toLowerCase();
    if (term.length < 2) { resultsEl.innerHTML = ''; return; }
    const users = await ensureUsersCache();
    const matches = users.filter((u) => u.name.toLowerCase().includes(term)).slice(0, 6);
    resultsEl.innerHTML = matches.map((u) => `<button type="button" class="small ghost" data-partner-id="${u.id}">${esc(u.name)}</button>`).join('');
    resultsEl.querySelectorAll('[data-partner-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        registerPartnerId = Number(btn.dataset.partnerId);
        searchInput.value = btn.textContent;
        resultsEl.innerHTML = '';
      });
    });
  });

  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('register-name').value.trim();
    if (!name) return;
    if (registerMode === 'duo' && !registerPartnerId) {
      await showAlert(t('outfit_register_partner_required'));
      return;
    }
    try {
      await api('/outfit/register', {
        method: 'POST',
        body: { name, night: getNight(), partnerUserId: registerMode === 'duo' ? registerPartnerId : null },
      });
      loadVotes();
    } catch (err) {
      await showAlert(err.message);
    }
  });
}

async function loadVotes() {
  const area = $('vote-area');
  const night = getNight();
  try {
    const data = await api(`/votes/status?night=${encodeURIComponent(night)}`);
    const results = Array.isArray(data.results) ? data.results : [];

    renderRegistration(data);

    // Status controlled by the admin: registration / open / closed-pending-reveal / closed.
    let statusKey;
    if (data.status === 'registration') statusKey = 'outfit_registration_open';
    else if (data.status === 'open') statusKey = 'outfit_open';
    else if (!data.started) statusKey = 'outfit_wait';
    else if (data.status === 'closed' && data.resultsPhase === 'hidden') statusKey = 'outfit_results_pending';
    else statusKey = 'outfit_closed';
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
    await showAlert(err.message);
  }
}

boot();
