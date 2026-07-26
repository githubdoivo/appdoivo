// Easter egg: triple-click the "appdoivo" logo (any page) to swap it for
// "appde<firstname>", e.g. "appdediogo" for Fábio Nunes. Click three more
// times to revert. Shared between app.js and admin.js since both have
// their own .brand-name logo.
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
  let clicks = 0;
  let timer = null;
  logo.addEventListener('click', () => {
    clicks++;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 600);
    if (clicks === 3) {
      clicks = 0;
      logo.textContent = logo.textContent === 'appdoivo' ? `appde${slug}` : 'appdoivo';
    }
  });
}
