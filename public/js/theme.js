// Dark/light mode: a global UI-chrome preference, independent of the
// per-night Snatch/Rata theming (furnished/swamp/rata), which keeps
// its own decorative branding regardless of light/dark choice.
const KEY = 'appivo_mode';

export function getMode() {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
}

/**
 * Points <meta name="theme-color"> at whatever the page is actually
 * painted with, so iOS tints the status bar to match the theme on screen
 * instead of sitting on one fixed colour through all of them.
 *
 * Reads the computed background back off the page rather than repeating
 * the palette here. A hardcoded value cannot survive a retune - the one
 * this replaces was #e7e3d6, a cream from before the lilac base that no
 * longer appeared anywhere in styles.css. Every theme sets its own body
 * background, so there is nothing to keep in sync by hand.
 */
export function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.body).backgroundColor;
  // Skip transparent/empty - better to leave the last real colour up than
  // to hand the browser something it will fall back to white on.
  if (bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0)')) {
    meta.setAttribute('content', bg);
  }
}

// body animates its background over 0.45s (see styles.css), so the read
// above - taken the instant a theme class flips - returns the colour being
// animated away from rather than the new one, leaving the bar a full theme
// behind on every switch. Re-reading once the animation lands is what
// actually gets the destination colour; the call at switch time still runs,
// so a theme change with no transition to wait for is covered too.
document.addEventListener('transitionend', (event) => {
  if (event.target === document.body && event.propertyName === 'background-color') {
    syncThemeColor();
  }
});

export function applyMode(mode = getMode()) {
  const isDark = mode === 'dark';
  document.documentElement.classList.toggle('mode-dark', isDark);
  document.documentElement.classList.toggle('mode-light', !isDark);
  syncThemeColor();
  return mode;
}

export function toggleMode() {
  const next = getMode() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEY, next);
  return applyMode(next);
}
