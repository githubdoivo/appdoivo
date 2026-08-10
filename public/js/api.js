// API and session helpers (token stored in the browser).
import { t } from './i18n.js';

const TOKEN_KEY = 'appivo_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Request to the API with the token in the header. Throws an Error with the
 * server's message. The server returns a stable error CODE (e.g.
 * "err_token_missing"), not literal text - it has no idea which language
 * the caller wants, so translation happens here, client-side, same as
 * every other piece of text in the app. A code with no matching i18n key
 * (shouldn't happen, but not fatal if it does) falls back to itself via
 * t()'s own fallback behaviour.
 */
// A 401 on a request that carried a token means the session is over - the
// key was regenerated, the account removed, or (on QA) the database reset
// underneath us. Ending it here, once, is what stops the feature polls from
// spinning: chat, plaza, votes and memo all poll every few seconds and all
// swallow their errors as "transient", so a dead token used to produce a
// burst of failed auths. Each one counts against the per-IP brute-force
// budget (see checkAuthAttempt in rateLimit.js), so within seconds the
// budget was gone and every response became 429 instead of 401 - which the
// session watcher does not recognise, so it never logged anyone out. The
// visible result was "too many attempts. try again later." forever, with no
// way back except clearing site data.
let sessionEnded = false;

// ...except where a 401 is a normal answer rather than a dead session:
// change-token rejects a wrong *current* key that way, and logging someone
// out for mistyping it would be absurd.
const KEEPS_SESSION_ON_401 = ['/me/change-token', '/auth/login', '/auth/claim-key'];

// Every poller in app.js swallows its own failures - deliberately, because
// one dropped request during a party on house wifi is not worth a message.
// The cost was that a *sustained* outage looked identical to nothing
// happening: the screen simply stopped changing, with no way to tell a quiet
// party from a broken connection. So the reachability signal lives here, at
// the single point every request already passes through, rather than in nine
// separate catch blocks.
//
// Two in a row, not one: a single failure is genuinely common on a phone
// moving between rooms, and flashing a warning at it would cry wolf all
// night.
const FAILURES_BEFORE_OFFLINE = 2;
let consecutiveFailures = 0;
let offline = false;
const offlineListeners = new Set();

/** Notified with true/false whenever the connection state actually changes. */
export function onConnectionChange(fn) {
  offlineListeners.add(fn);
  fn(offline);
  return () => offlineListeners.delete(fn);
}

function setOffline(next) {
  if (next === offline) return;
  offline = next;
  for (const fn of offlineListeners) fn(offline);
}

/**
 * /me, with a couple of retries - shared by both pages' boot().
 *
 * The startup call is the one request whose failure the app cannot shrug
 * off: it decides between "you are logged in" and "you are not", so a
 * single dropped one on a phone changing rooms used to read as "logged
 * out" and take the stored key with it. A refusal from the server is
 * passed straight back untouched - that is an answer, not a connectivity
 * problem, and only it should end a session.
 */
export async function fetchMe(attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api('/me');
    } catch (err) {
      if (err?.status || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    // Only a genuine transport failure lands here. An HTTP error means the
    // server answered, so it says nothing about reachability and must not
    // count towards it.
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURES_BEFORE_OFFLINE) setOffline(true);
    throw networkError;
  }
  consecutiveFailures = 0;
  setOffline(false);

  if (res.status === 401 && token && !sessionEnded
      && !KEEPS_SESSION_ON_401.some((p) => path.startsWith(p))) {
    sessionEnded = true;
    clearToken();
    location.reload();
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ? t(data.error) : `Error ${res.status}`);
    err.status = res.status;
    // Some failures carry more than a code - e.g. closing the voting with
    // duo proposals still pending returns how many, so the caller can say
    // so in the confirmation instead of just "there are some".
    err.data = data;
    throw err;
  }
  return data;
}
