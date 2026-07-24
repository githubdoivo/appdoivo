// Nights of the current edition (v1.0). Each night has its own aesthetic/theme
// and its own independent vote. To change year, edit this list (names/themes)
// and create a new version of the app.
//
// The "key" is also the visual theme name used in the frontend (styles.css:
// body.theme-<key>). Keep in sync with public/js and styles.css.
export const NIGHTS = ['furnished', 'swamp'];

/** True if the key matches a valid night. */
export function isNight(key) {
  return NIGHTS.includes(key);
}

/** Default night (the first in the list). */
export const DEFAULT_NIGHT = NIGHTS[0];
