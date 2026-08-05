import { api, getToken, setToken, clearToken } from './api.js';
import { registerServiceWorker, refreshNotifButton, wireNotifButton } from './push.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode } from './theme.js';
import { wireLogoEasterEgg } from './logoEasterEgg.js';
import { wirePasswordToggle } from './passwordToggle.js';
import { wireVersionBadge } from './version.js';
import { showAlert, showConfirm } from './modal.js';
import { formatHourInZone } from './time.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
// Strips accents so "cesar" matches "César" - typing the plain-ASCII form
// of a name should always find it, not just the exact accented spelling.
const foldAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

let currentTab = 'plaza';
// Set from /me in showApp() - lets the Rata history tell "assigned to
// me" apart from "assigned to someone else" so only the actual assignee
// sees a mark-as-done button on their own entry.
let myUserId = null;
// Set from /me in showApp() - Plaza is mid-rebuild (single note -> real
// posts feed), so it's QA-only until that's done (see ENABLE_PLAZA in
// src/routes.js and fly.qa.toml). Defaults true so nothing flashes/hides
// before /me resolves; showApp() corrects it immediately after.
let plazaEnabled = true;
// Set from /me in showApp() - gates the tutorial's skip button (see
// startTutorial()): only admin/owner accounts can skip, everyone else
// has to read through it.
let isAdmin = false;
let isOwner = false;

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
  myUserId = me.id;
  isAdmin = !!me.isAdmin;
  isOwner = !!me.isOwner;
  plazaEnabled = !!me.plazaEnabled;
  document.querySelector('[data-tab="plaza"]').classList.toggle('hidden', !plazaEnabled);
  // Reopens on whatever tab was last open, not always Wall - a stored tab
  // that's no longer valid (e.g. Wall while plazaEnabled is now false)
  // falls back to the plazaEnabled check right after, same as before.
  const storedTab = localStorage.getItem(TAB_KEY);
  if (TABS.includes(storedTab) && storedTab !== currentTab) selectTab(storedTab);
  if (!plazaEnabled && currentTab === 'plaza') selectTab('rata');
  applyNight();
  wireLogoEasterEgg(me.name, me.logo_customized);
  // No role badge in the main app's topbar - every tab is open to
  // everyone regardless of role, and it was fighting the logo-swap
  // easter egg for space. Settings still shows a role badge, where it's
  // actually informative (explains which admin tabs are visible).
  $('settings-link').classList.remove('hidden');
  refreshNotifButton();
  // Plaza/Wall is the default landing tab (see currentTab above) - starts
  // polling immediately, same as any other tab does once it's the one
  // showing. A Rata's own load below is just a preload for a smooth first
  // switch, not polling - it isn't the visible tab yet.
  if (plazaEnabled) startPlazaPolling();
  loadConsequences();
  loadRataHistory();
  // Best Look's own data loads when its tab is actually selected (see
  // selectTab()) - not here too. It used to double-load unconditionally,
  // which was harmless when the outfit tab was just static vote buttons,
  // but now that it has a live registration form, a late-resolving response
  // from this redundant call could silently wipe out text someone's mid-
  // typing (the newer selectTab() load re-renders the same DOM nodes).
  // Always opens on the announcements feed (internally "plaza", now
  // labelled "Wall" - see the tab nav comment in index.html) - a
  // notification's own ?tab= (handled right after) is the only thing
  // allowed to land somewhere else.
  applyDeepLinkParams();
  if (!me.tutorialSeen) startTutorial();
  startSessionWatcher();
}

// Polls /me every 30s to catch an account being deleted or its key
// regenerated while this session is already open, logging out
// automatically rather than continuing to silently fail every request.
// No role-based UI to sync here (the main app has no role badge - see
// showApp() - and every tab is open to everyone regardless of role), so
// there's nothing else for this to watch for.
let sessionWatchTimer = null;
function startSessionWatcher() {
  if (sessionWatchTimer) return;
  sessionWatchTimer = setInterval(async () => {
    try {
      await api('/me');
    } catch (err) {
      if (err.status === 401) {
        clearToken();
        location.reload();
      }
      // other errors are transient - next poll retries
    }
  }, 30000);
}

/* ------------------------------- Tutorial --------------------------------- */
// First-session walkthrough. Tied to the account (tutorial_seen on the
// user row), not localStorage, so it doesn't repeat on a new device and
// doesn't reappear just because storage got cleared.

const TUTORIAL_STEPS = [
  ['tutorial_1_title', 'tutorial_1_text'],
  ['tutorial_plaza_title', 'tutorial_plaza_text'],
  ['tutorial_2_title', 'tutorial_2_text'],
  ['tutorial_3_title', 'tutorial_3_text'],
  ['tutorial_wall_title', 'tutorial_wall_text'],
  ['tutorial_4_title', 'tutorial_4_text'],
  ['tutorial_5_title', 'tutorial_5_text'],
  ['tutorial_6_title', 'tutorial_6_text'],
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
  // Regular users read through the whole thing (no skip) - admin/owner
  // accounts already know the app, so they can jump straight past it.
  $('tutorial-skip').classList.toggle('hidden', !(isAdmin || isOwner));
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
$('tutorial-skip').addEventListener('click', () => endTutorial());

$('tutorial-next').addEventListener('click', () => {
  if (tutorialStep < TUTORIAL_STEPS.length - 1) {
    tutorialStep++;
    renderTutorialStep();
  } else {
    endTutorial();
  }
});

/* -------------------------------- Idioma --------------------------------- */
// Single square button, like the theme toggle: shows the language that's
// currently active, not the one it switches to (that read as confusing -
// "en" showing while the app was in Portuguese).

function updateLangUI() {
  $('lang-toggle').textContent = getLang();
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
  if (findKeyMode) return;
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

// First-time key retrieval: for someone who's never logged in, find their
// own account by name (see GET /auth/unclaimed-users) and claim its key
// (see POST /auth/claim-key). Once claimed - by this flow or by ever
// logging in for real - the account no longer shows up here.
// Reuses the same #token-input slot in place (placeholder + type swap)
// instead of revealing a separate area below it, so clicking the link
// never shifts the page layout.
let findKeyMode = false;

function setFindKeyMode(on) {
  findKeyMode = on;
  const input = $('token-input');
  $('login-error').textContent = '';
  // Find-key mode never uses this line (no password to reject) - its
  // reserved empty-line height was pushing the results away from the
  // search bar they belong to.
  $('login-error').classList.toggle('hidden', on);
  $('find-key-results').innerHTML = '';
  input.value = '';
  input.type = on ? 'text' : 'password';
  input.setAttribute('data-i18n-ph', on ? 'find_key_ph' : 'access_key');
  input.placeholder = t(on ? 'find_key_ph' : 'access_key');
  $('token-toggle').classList.toggle('hidden', on);
  $('token-toggle').classList.remove('visible');
  $('login-submit-btn').classList.toggle('hidden', on);
  $('find-key-link').setAttribute('data-i18n', on ? 'find_key_back' : 'find_key_link');
  $('find-key-link').textContent = t(on ? 'find_key_back' : 'find_key_link');
  if (on) input.focus();
}

$('find-key-link').addEventListener('click', () => setFindKeyMode(!findKeyMode));

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* best effort */ }
    document.body.removeChild(ta);
  }
}

let findKeyTimer = null;
$('token-input').addEventListener('input', () => {
  if (!findKeyMode) return;
  clearTimeout(findKeyTimer);
  const name = $('token-input').value.trim();
  if (name.length < 3) {
    $('find-key-results').innerHTML = '';
    return;
  }
  findKeyTimer = setTimeout(async () => {
    try {
      const { users } = await api(`/auth/unclaimed-users?name=${encodeURIComponent(name)}`);
      $('find-key-results').innerHTML = users.length
        ? users.map((u) => `<button type="button" class="find-key-result" data-claim-user="${u.id}">${esc(u.name)}</button>`).join('')
        : `<p class="muted">${t('find_key_no_match')}</p>`;
      $('find-key-results').querySelectorAll('[data-claim-user]').forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            const r = await api('/auth/claim-key', { method: 'POST', body: { userId: Number(b.dataset.claimUser) } });
            await copyToClipboard(r.token);
            setFindKeyMode(false); // reset back to the normal login form for next time
            await showAlert(t('find_key_revealed_msg', { name: r.name, token: r.token }));
            setToken(r.token);
            const me = await api('/me');
            showApp(me);
          } catch (err) {
            await showAlert(err.message);
          }
        });
      });
    } catch { /* transient network hiccup - next keystroke retries */ }
  }, 300);
});

// Logout itself lives on the Settings page now (settings.js) - it's rare
// enough not to need a permanent topbar icon slot on every page.

/* --------------------------------- Tabs ---------------------------------- */

function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  currentTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  $('tab-plaza').classList.toggle('hidden', currentTab !== 'plaza');
  $('tab-rata').classList.toggle('hidden', currentTab !== 'rata');
  $('tab-outfit').classList.toggle('hidden', currentTab !== 'outfit');
  $('tab-chat').classList.toggle('hidden', currentTab !== 'chat');
  applyNight();
  if (currentTab === 'plaza') startPlazaPolling(); else stopPlazaPolling();
  if (currentTab === 'rata') startRataPolling(); else stopRataPolling();
  if (currentTab === 'outfit') startOutfitPolling(); else stopOutfitPolling();
  if (currentTab === 'chat') startChatPolling(); else stopChatPolling();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});

document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.gotoTab));
});

// Logo doubles as a "go home" shortcut, one click from anywhere - lands
// on Wall, or Rata when Wall is disabled (matches the landing-tab choice
// showApp() already makes for that same case).
document.querySelector('.brand-name').addEventListener('click', () => {
  selectTab(plazaEnabled ? 'plaza' : 'rata');
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
            <span class="chat-msg-time">${esc(m.time)}</span>
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

// Shared by both deep-link paths below: a fresh page load reads its own
// ?tab=&night=, and the service worker message listener reads the same
// params out of a notification's url without a real navigation.
function applyTabAndNight(params) {
  const tab = params.get('tab');
  const night = params.get('night');
  if (!tab && !night) return;

  if (night && NIGHTS.includes(night)) {
    localStorage.setItem(NIGHT_KEY, night);
  }
  if (TABS.includes(tab) && (tab !== 'plaza' || plazaEnabled)) {
    selectTab(tab);
  }
}

// Notification taps land here with ?tab=&night= so the app opens straight
// on the result being announced, instead of just wherever it was left.
function applyDeepLinkParams() {
  applyTabAndNight(new URLSearchParams(location.search));
  history.replaceState({}, '', location.pathname);
}

// iOS Safari's service worker Client.navigate() often silently fails when
// the PWA is already open in the foreground (falls back to just focusing
// the existing window - see sw.js) - a real, documented WebKit limitation,
// not something fixable from the service worker side. Have the already-
// open page apply the deep link itself instead of depending on navigate()
// to reload it.
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type !== 'deep-link' || !event.data.url) return;
  const url = new URL(event.data.url, location.origin);
  applyTabAndNight(url.searchParams);
});

/* ----------------------------- Notificacoes ------------------------------ */

wireNotifButton('notif-btn');

/* --------------------------------- Plaza ---------------------------------- */
// Landing tab: a feed of owner/admin-authored posts (announcements + polls),
// pinned ones first. See renderPlazaPost() below.

// "5 seconds ago" style, from a raw "YYYY-MM-DD HH:MM:SS[.mmm]" UTC
// timestamp (see formatTimeInZone() server-side for the equivalent
// HH:MM version - this one needs the actual elapsed time instead).
function timeAgo(dbTimestamp) {
  const iso = `${String(dbTimestamp).replace(' ', 'T')}Z`;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return t('time_just_now');
  if (sec < 60) return t('time_ago_seconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t(min === 1 ? 'time_ago_minute' : 'time_ago_minutes', { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t(hr === 1 ? 'time_ago_hour' : 'time_ago_hours', { n: hr });
  const day = Math.round(hr / 24);
  return t(day === 1 ? 'time_ago_day' : 'time_ago_days', { n: day });
}

// Renders one post as either a plain-announcement "torn column" or a poll
// "magazine card" (see .plaza-post-announcement/.plaza-post-poll in
// styles.css) - the two banner styles so a glance tells announcements and
// polls apart by shape (a poll's options make that obvious on their own),
// without needing a type label spelling it out. Pinned announcements
// (owner-only, see the admin Plaza page) already sort first from the API -
// this just marks them visually so a pin doesn't blend into the rest of
// the feed.
function renderPlazaPost(post) {
  const byline = t('plaza_post_byline', { author: post.author, time: timeAgo(post.created_at) });
  const pinnedBadge = post.pinnedAt ? `<span class="plaza-pinned-badge">${esc(t('plaza_post_pinned_label'))}</span>` : '';

  if (post.type !== 'poll') {
    return `
      <article class="plaza-post plaza-post-announcement${post.pinnedAt ? ' pinned' : ''}">
        ${pinnedBadge}
        <p class="plaza-post-text">${esc(post.text)}</p>
        <p class="plaza-byline">${esc(byline)}</p>
      </article>`;
  }

  const totalVotes = post.options.reduce((sum, o) => sum + o.votes, 0);
  const alreadyVoted = post.myOptionId != null;
  // A vote is final the instant it's submitted (see castPlazaVote() server-
  // side) - picking an option here only stages it locally in
  // pendingPollSelections; nothing reaches the server until "votar" below
  // is pressed, so a misclick before then costs nothing.
  const pendingOptionId = pendingPollSelections.get(post.id);
  const optionsHtml = post.options.map((o) => {
    const pct = totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0;
    const isMine = post.myOptionId === o.id;
    const isPending = !alreadyVoted && pendingOptionId === o.id;
    const classes = `plaza-poll-option${isMine ? ' voted' : ''}${isPending ? ' pending' : ''}${alreadyVoted ? ' readonly' : ''}`;
    const body = `
        <span class="plaza-poll-option-fill" style="width:${pct}%"></span>
        <span class="plaza-poll-option-label">${esc(o.label)}</span>
        <span class="plaza-poll-option-pct">${pct}%</span>`;
    // Once you've voted, the choice is locked - render plain divs instead of
    // buttons so there's nothing left to click, rather than disabling a
    // button and having to fight its default styles.
    return alreadyVoted
      ? `<div class="${classes}">${body}</div>`
      : `<button type="button" class="${classes}" data-select-post="${post.id}" data-select-option="${o.id}">${body}</button>`;
  }).join('');

  const submitHtml = alreadyVoted ? '' : `
      <button type="button" class="small plaza-poll-submit" data-vote-submit="${post.id}" data-vote-option="${pendingOptionId ?? ''}"${pendingOptionId == null ? ' disabled' : ''}>${esc(t('plaza_vote_btn'))}</button>`;

  return `
    <article class="plaza-post plaza-post-poll${post.pinnedAt ? ' pinned' : ''}">
      ${pinnedBadge}
      <p class="plaza-post-text">${esc(post.text)}</p>
      <div class="plaza-poll-options">${optionsHtml}</div>
      ${submitHtml}
      <p class="plaza-byline">${esc(byline)} · ${t(totalVotes === 1 ? 'plaza_post_vote_count_one' : 'plaza_post_vote_count_other', { n: totalVotes })}</p>
    </article>`;
}

// Poll option picked but not yet submitted, per post id - local-only until
// "votar" is pressed (see renderPlazaPost()). Cleared once the vote lands.
const pendingPollSelections = new Map();
// Last feed rendered, so picking an option can re-render locally (just
// updating pendingPollSelections) without a round-trip to the server.
let lastPlazaPosts = [];

function renderPlazaFeed(posts) {
  lastPlazaPosts = posts;
  $('plaza-feed').innerHTML = posts.map(renderPlazaPost).join('');
  $('plaza-feed-empty').classList.toggle('hidden', posts.length > 0);

  $('plaza-feed').querySelectorAll('[data-select-post]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingPollSelections.set(Number(btn.dataset.selectPost), Number(btn.dataset.selectOption));
      renderPlazaFeed(lastPlazaPosts);
    });
  });

  $('plaza-feed').querySelectorAll('[data-vote-submit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const postId = Number(btn.dataset.voteSubmit);
      const optionId = Number(btn.dataset.voteOption);
      try {
        const { posts: updated } = await api(`/plaza-posts/${postId}/vote`, {
          method: 'POST',
          body: { optionId },
        });
        pendingPollSelections.delete(postId);
        renderPlazaFeed(updated);
      } catch (err) {
        await showAlert(err.message);
        pendingPollSelections.delete(postId);
        // A second tab/click can lose the race against the vote that just
        // landed - resync from the server so the UI locks to read-only
        // instead of leaving stale, still-selectable options on screen.
        loadPlaza();
      }
    });
  });
}

// Polled while the tab is open, same as chat, so a new/pinned post or a
// poll's live tally shows up without a manual reload.
let plazaPollTimer = null;

function startPlazaPolling() {
  loadPlaza();
  if (plazaPollTimer) return;
  plazaPollTimer = setInterval(loadPlaza, 4000);
}

function stopPlazaPolling() {
  if (plazaPollTimer) {
    clearInterval(plazaPollTimer);
    plazaPollTimer = null;
  }
}

async function loadPlaza() {
  try {
    const { posts } = await api('/plaza-posts');
    renderPlazaFeed(posts);
  } catch { /* transient - leaves whatever was last shown */ }
}

/* ------------------------------- Rata Game ------------------------------- */
// Polled while the tab is open, so a consequence revealed by the
// scheduled cron (or an admin's manual reveal) shows up without a manual reload.
let rataPollTimer = null;

async function loadRataHistory() {
  try {
    const { consequences } = await api('/consequences/revealed');
    $('rata-history').innerHTML = consequences.length
      ? consequences.map((c) => {
        // No status tags/assign jargon here (that's admin-only, see
        // renderConsequenceCard() in settings.js) - just plain "done by X"
        // / "pending by X", or bare "pending" if nobody's confirmed
        // holding it yet (revealed but unassigned).
        const line = c.approved_at
          ? t('rata_public_done_by', { name: esc(c.assignedName) })
          : c.assignedName
            ? t('rata_public_pending_by', { name: esc(c.assignedName) })
            : t('rata_public_pending_unassigned');
        const canMarkDone = c.assigned_user_id === myUserId && !c.done_at;
        // Just the hour here (this is the guest-facing view) - the admin
        // side shows hours and minutes, this one only needs to say
        // roughly when.
        const hour = c.revealed_at ? `${formatHourInZone(c.revealed_at)}h` : '';
        return `<div class="rata-history-item">
          <p class="rata-history-text">${esc(c.text)}</p>
          <div class="rata-history-meta">
            <span class="muted">${line}${hour ? ` · ${hour}` : ''}</span>
          </div>
          ${canMarkDone ? `<button type="button" class="small ghost" data-mark-done="${c.id}" style="margin-top:8px">${t('rata_mark_done_btn')}</button>` : ''}
        </div>`;
      }).join('')
      : `<p class="muted">${t('rata_history_empty')}</p>`;
  } catch { /* transient - leaves whatever was last shown */ }
}

$('rata-history').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-mark-done]');
  if (!btn) return;
  if (!(await showConfirm(t('rata_mark_done_confirm')))) return;
  try {
    await api(`/consequences/${btn.dataset.markDone}/mark-done`, { method: 'POST' });
    loadRataHistory();
  } catch (err) {
    await showAlert(err.message);
  }
});

function startRataPolling() {
  loadConsequences();
  loadRataHistory();
  if (rataPollTimer) return;
  rataPollTimer = setInterval(() => { loadConsequences(); loadRataHistory(); }, 5000);
}

function stopRataPolling() {
  if (rataPollTimer) {
    clearInterval(rataPollTimer);
    rataPollTimer = null;
  }
}

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
  } catch {
    // Never surface a raw error/status code here - it used to leak "Erro
    // 500" straight into the card on a server-side crash (see app.js's
    // new global error handler + the timezone validation that caused it).
    $('current-consequence').textContent = t('rata_load_error');
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

/* ------------------------------ Best Look ------------------------------- */

// Voting is per NIGHT. Each night has its own aesthetic (theme) and its own
// independent vote. The selector below picks the active night, re-skins the
// WHOLE page and shows that night's vote. Nights this edition: furnished | swamp.
const NIGHTS = ['furnished', 'swamp'];
const NIGHT_KEY = 'appivo_night';
const TABS = ['plaza', 'rata', 'outfit', 'chat'];
const TAB_KEY = 'appivo_tab';

function getNight() {
  const n = localStorage.getItem(NIGHT_KEY);
  return NIGHTS.includes(n) ? n : NIGHTS[0];
}

function applyNight() {
  const night = getNight();
  // The night's theme re-skins the WHOLE page, but only when Best Look is active.
  const onOutfit = currentTab === 'outfit';
  NIGHTS.forEach((n) => {
    document.body.classList.toggle(`theme-${n}`, onOutfit && night === n);
  });
  document.body.classList.toggle('theme-rata', currentTab === 'rata');
  // Theme classes follow the DISPLAYED name, not the internal tab id: the
  // chat feature is now labelled "Plaza" and gets the plaza-motif
  // background (city-square/agora), while the old plaza/announcements
  // feature is now labelled "Wall" and gets the mural texture that used to
  // belong to the chat tab - swapped on purpose, see index.html's tab nav
  // comment for the full "plaza"/"chat" internal-vs-displayed mapping.
  document.body.classList.toggle('theme-mural', currentTab === 'plaza');
  document.body.classList.toggle('theme-plaza', currentTab === 'chat');
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

/* ---------------------------- Candidatura (Best Look) -------------------- */
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

  // Now that Best Look polls for updates (see startOutfitPolling()), a
  // refresh landing mid-keystroke would otherwise wipe out whatever the
  // user is typing into the name/partner-search fields below - skip the
  // re-render entirely while focus is inside this form, nothing about
  // their own not-yet-submitted entry could have changed anyway.
  if (area.contains(document.activeElement)) return;

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
    const term = foldAccents(searchInput.value.trim().toLowerCase());
    if (term.length < 2) { resultsEl.innerHTML = ''; return; }
    const users = await ensureUsersCache();
    const matches = users.filter((u) => foldAccents(u.name.toLowerCase()).includes(term)).slice(0, 6);
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

// Polled while the tab is open, so the admin opening/closing voting or
// advancing the results reveal shows up without a manual reload. Skips
// clobbering an in-progress registration entry - see the activeElement
// guard in renderRegistration().
let outfitPollTimer = null;

function startOutfitPolling() {
  loadVotes();
  if (outfitPollTimer) return;
  outfitPollTimer = setInterval(loadVotes, 4000);
}

function stopOutfitPolling() {
  if (outfitPollTimer) {
    clearInterval(outfitPollTimer);
    outfitPollTimer = null;
  }
}

// Character names are often improvised at submission time, so pairing the
// real registrant's name alongside it is the only way a voter can actually
// tell who they're voting for. Admin-added contestants have no registrant,
// so they just show the bare character name.
function contestantLabel(c) {
  if (!c.registeredBy) return c.name;
  const who = c.partnerName ? `${c.registeredBy} & ${c.partnerName}` : c.registeredBy;
  return `${c.name} (${who})`;
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
        ? data.contestants.map((c) => `<button class="vote-option" data-id="${c.id}" data-label="${esc(contestantLabel(c))}">${esc(contestantLabel(c))}</button>`).join('')
        : `<p class="muted">${t('outfit_no_contestants')}</p>`;
      area.querySelectorAll('.vote-option').forEach((b) => {
        b.addEventListener('click', () => vote(Number(b.dataset.id), b.dataset.label));
      });
    } else if (data.myVote) {
      // Once cast, a vote is final (see castVote() server-side) and this
      // stays the vote area's content for the rest of the night - closed/
      // pending-results no longer overwrites it with a generic status
      // message, so "who did I vote for" stays visible throughout.
      const chosen = data.contestants.find((c) => c.id === data.myVote.contestant_id);
      const msg = chosen ? t('outfit_voted_name', { name: esc(contestantLabel(chosen)) }) : t('outfit_voted');
      area.innerHTML = `<p class="highlight">${msg}</p>`;
    } else {
      area.innerHTML = '';
    }

    const revealing = data.status === 'closed' && data.resultsPhase && data.resultsPhase !== 'hidden';
    if (revealing && results.length) {
      $('results-card').classList.remove('hidden');
      const list = $('results-list');
      // Before "all", show just what's been revealed so far, labelled by its
      // actual rank (not the tier list's auto-numbering, which would be
      // wrong for a partial set) - e.g. "3rd place" appearing alone first.
      list.classList.toggle('podium-reveal', data.resultsPhase !== 'all');
      list.innerHTML = results.map((r) => {
        const name = esc(contestantLabel(r));
        const label = data.resultsPhase === 'all' ? name : `${t(`rank_${r.rank}`)} · ${name}`;
        return `<li><span class="name">${label}</span><span class="votes">${r.votes} ${t(r.votes === 1 ? 'vote_one' : 'votes_short')}</span></li>`;
      }).join('');
    } else {
      $('results-card').classList.add('hidden');
    }
  } catch (err) {
    $('voting-status').textContent = err.message;
  }
}

async function vote(contestantId, name) {
  // A vote is final the moment it's submitted (see castVote() server-side,
  // same rule as Plaza polls) - confirm first, since there's no changing
  // your mind after.
  if (!(await showConfirm(t('outfit_confirm_vote', { name })))) return;
  try {
    await api('/votes', { method: 'POST', body: { contestantId, night: getNight() } });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
  }
}

boot();
