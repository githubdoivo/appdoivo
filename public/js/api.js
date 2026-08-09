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

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
