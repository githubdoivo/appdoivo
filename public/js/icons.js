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
  // Ring widened and the teeth shortened: at r=3.4 with long teeth this read
  // as a lighter drawing than the icons either side of it, which is what
  // Ivo spotted - the weight has to match, not just the stroke width.
  key: svg('<circle cx="8.5" cy="12" r="3.9"/><path d="M12.4 12H20.5M18.2 12v3M15.3 12v2.4"/>'),
  // Tick - "approve".
  approve: svg('<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>'),
  // Arrow curling back on itself - "reset to a new one".
  reset: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>'),
  // The same arrow with a cross through it - "reset everything, contestants
  // included". Deliberately the reset icon plus something, so the pair
  // reads as the smaller and the larger version of one action.
  resetAll: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/><path d="M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8"/>'),
  // A triangle - "begin". The one phase step that is not "carry on".
  start: svg('<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke-linejoin="round"/>'),
  // Forward - "next phase". The card names the phase it is in right above
  // this, so the button only has to mean "advance", which it means at every
  // stage. That is the whole reason an arrow works here where a picture of
  // each phase would not: three different icons for start/close/reveal
  // would each have to be learnt, and getting one wrong mid-party is
  // expensive.
  advance: svg('<path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5"/>'),
  // Forward into a wall - "end this phase". The transport-control reading
  // everyone already has: play to begin, arrow to carry on, arrow-into-a-bar
  // to stop. Three shapes from one family, so the row says "move the night
  // along" and only the direction of travel changes.
  close: svg('<path d="M3.5 12h11M10 6.5l5.5 5.5L10 17.5M20 5v14"/>'),
  // The role a button hands out, as two different drawings rather than one
  // drawing in two states: a shield to make someone an admin, a plain
  // person to make them a guest again. Filled-versus-outline needs both
  // versions side by side to be read, and a list shows one at a time.
  // Note these name the role being GIVEN, not the one the row currently
  // holds - see the toggle in settings.js.
  roleAdmin: svg('<path d="M12 3l7 3v5.5c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5V6z"/>'),
  roleUser: svg('<circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>'),
  // Scales - "break the tie". Only ever shown when there is one.
  runoff: svg('<path d="M12 4.5V20M7.5 20h9M4 9h16M4 9l-2.4 5a2.9 2.9 0 0 0 4.8 0Zm16 0l2.4 5a2.9 2.9 0 0 1-4.8 0Z"/><path d="M9 6.6l6-1.4"/>'),
};

/* The two lead actions get artwork from their own section rather than a
   generic control glyph - they are the one thing their card is for, and
   both sections already have a world to draw from. Solid rather than
   outlined: at this size a filled shape reads as an object, an outline
   reads as another button. */
export const LEAD_ICONS = {
  // A rat's paw - the Rata's own mark, and the reveal is the whole game.
  paw: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<ellipse cx="6.6" cy="10.4" rx="2.1" ry="2.6"/>'
    + '<ellipse cx="10.4" cy="7.2" rx="2.1" ry="2.7"/>'
    + '<ellipse cx="14.6" cy="7.4" rx="2.1" ry="2.7"/>'
    + '<ellipse cx="18.2" cy="10.8" rx="2" ry="2.5"/>'
    + '<path d="M12.4 11.6c3.3 0 5.6 2.2 5.6 4.7 0 2.2-1.9 3.5-4 3.5-1 0-1.4-.3-2.2-.3s-1.2.3-2.2.3c-2.1 0-3.9-1.3-3.9-3.5 0-2.5 2.3-4.7 5.6-4.7Z"/>'
    + '</svg>',
  // A camera's shutter release - ring and core. Chosen over the aperture
  // and over Memo's own lens-and-frames motif for being unmistakably a
  // thing you press: this button throws the next moment open to fifty
  // people at once, and is not the place to make anyone work out what the
  // drawing means.
  shutter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9.2"/>'
    + '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>'
    + '</svg>',
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
