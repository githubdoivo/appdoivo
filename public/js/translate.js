// On-demand translation for admin-authored free text (Wall posts) - unlike
// the app's own UI chrome (buttons, labels, etc., all in i18n.js), post
// content is whatever the admin typed, in whatever language, with no
// built-in PT/EN pair. Uses MyMemory's free translation API (no API key
// needed at this volume - https://mymemory.translated.net) rather than
// building/hosting a translation service for a ~50-guest party app.
// Source language is auto-detected, so this works the same regardless of
// which language a given post was actually written in.

const cache = new Map();

/**
 * Translates `text` into `targetLang` ('pt' or 'en'), auto-detecting the
 * source language. Returns the original text unchanged if the request
 * fails (offline, rate-limited, etc.) - a failed translation should never
 * block reading the post itself.
 */
export async function translateText(text, targetLang) {
  const cacheKey = `${targetLang}:${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|${targetLang}`;
    const res = await fetch(url);
    if (!res.ok) return text;
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated || data.responseStatus !== 200) return text;
    cache.set(cacheKey, translated);
    return translated;
  } catch {
    return text;
  }
}
