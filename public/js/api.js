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
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
