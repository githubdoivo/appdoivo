// Easter egg: triple-click the "appdoivo" logo (any page) to swap it for
// "appde<firstname>", e.g. "appdediogo" for Fábio Nunes. Click three more
// times to revert. Shared between app.js and settings.js since both have
// their own .brand-name logo.
//
// The swapped state is kept in sessionStorage rather than a plain JS var,
// so it survives navigating between app.js and settings.js (each is its
// own page load) and browser/PWA reloads - but resets once the tab/app is
// actually closed, since sessionStorage doesn't outlive that.
const STORAGE_KEY = 'appivo_logo_egg';
let wired = false;

export function wireLogoEasterEgg(name) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  const slug = firstName
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z]/g, '');
  if (!slug || wired) return;
  wired = true;

  const logo = document.querySelector('.brand-name');
  if (!logo) return;

  if (sessionStorage.getItem(STORAGE_KEY) === slug) {
    logo.textContent = `appde${slug}`;
  }

  let clicks = 0;
  let timer = null;
  logo.addEventListener('click', () => {
    clicks++;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 600);
    if (clicks === 3) {
      clicks = 0;
      const swapped = logo.textContent !== 'appdoivo';
      logo.textContent = swapped ? 'appdoivo' : `appde${slug}`;
      if (swapped) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, slug);
    }
  });
}
