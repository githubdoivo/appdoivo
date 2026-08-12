/**
 * The line icons used by row actions across the admin pages.
 *
 * Drawn to match the topbar's existing icons (see index.html): 24x24 box,
 * no fill, `currentColor` stroke at 1.8 with round caps and joins, so an
 * icon inherits whatever colour the button it sits in already has - the
 * destructive ones go red without a second copy of the artwork.
 *
 * Every icon here replaces a word, so nothing may use one without an
 * accessible name: iconButton() below is the only intended way to build
 * one, and it always sets both aria-label and title.
 */

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" `
  + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  // Pencil, nib down - "edit".
  edit: svg('<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z"/>'),
  // Bin with a lid and two staves - "remove".
  remove: svg('<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  // Drawing pin seen head-on - "pin to the top".
  pin: svg('<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6ZM12 15v5"/>'),
  // The same pin struck through - "unpin". A different icon rather than a
  // state on the same one: the two actions are opposites, and a pinned
  // post's button is the one you press to undo it.
  unpin: svg('<path d="M9 4h6l-1 6 4 3v2h-5M12 15v5M8 15H6v-2l2.4-1.8M4 4l16 16"/>'),
  // A key - "issue a new access key".
  key: svg('<circle cx="8" cy="12" r="3.4"/><path d="M11.4 12H21M18 12v3.2M15 12v2.4"/>'),
  // Tick - "approve".
  approve: svg('<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>'),
  // Arrow curling back on itself - "reset to a new one".
  reset: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>'),
};

/**
 * Builds an icon-only action button. `label` is what the word used to say -
 * it becomes the button's accessible name and its tooltip, so the action is
 * never nameless just because it stopped being written out.
 *
 * `attrs` carries whatever data-* the handlers already look for.
 */
export function iconButton(icon, label, attrs = '', extraClass = '') {
  return `<button type="button" class="icon-action${extraClass ? ` ${extraClass}` : ''}" `
    + `aria-label="${label}" title="${label}" ${attrs}>${ICONS[icon]}</button>`;
}
