// Wires a show/hide eye-icon button next to a password input. Shared by
// the login screen (token-input) and the change-key form (current/new key)
// so the toggle behaves identically everywhere.
export function wirePasswordToggle(inputId, toggleId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(toggleId);
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('visible', !showing);
    const label = showing ? 'Mostrar' : 'Ocultar';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  });
}
