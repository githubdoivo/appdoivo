// Dark/light mode: a global UI-chrome preference, independent of the
// per-night Best Look/Rata theming (furnished/swamp/rata), which keeps
// its own decorative branding regardless of light/dark choice.
const KEY = 'appivo_mode';

export function getMode() {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
}

export function applyMode(mode = getMode()) {
  const isDark = mode === 'dark';
  document.documentElement.classList.toggle('mode-dark', isDark);
  document.documentElement.classList.toggle('mode-light', !isDark);
  return mode;
}

export function toggleMode() {
  const next = getMode() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEY, next);
  return applyMode(next);
}
