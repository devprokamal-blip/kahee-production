// i18n.js — KAHE 360 shared localization engine
// Loaded AFTER /translations/id.js and /translations/en.js, BEFORE login.js/app.js.
// Language preference is a non-sensitive UI setting stored in localStorage —
// it has no bearing on server-side auth/session, which remains untouched.
window.KaheI18n = (function () {
  const STORAGE_KEY = 'kahe360.lang';
  const DEFAULT_LANG = 'id'; // KAHE 360 targets Indonesian internal users first.

  function getDict(lang) {
    return (window.KAHE_I18N && window.KAHE_I18N[lang]) || {};
  }

  function getLang() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'en' || stored === 'id' ? stored : DEFAULT_LANG;
  }

  function setLang(lang) {
    if (lang !== 'en' && lang !== 'id') return;
    localStorage.setItem(STORAGE_KEY, lang);
  }

  // Translate a key for the CURRENT language, falling back to the other
  // language, then to the key's last path segment (never a raw dotted key
  // reaching the screen with no HTML/label at all).
  function t(key) {
    const lang = getLang();
    const primary = getDict(lang);
    const fallback = getDict(lang === 'id' ? 'en' : 'id');
    if (Object.prototype.hasOwnProperty.call(primary, key)) return primary[key];
    if (Object.prototype.hasOwnProperty.call(fallback, key)) return fallback[key];
    return '';
  }

  function apply(root) {
    const scope = root || document;
    const lang = getLang();
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);

    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const value = t(key);
      if (value) el.innerHTML = value;
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      const value = t(key);
      if (value) el.setAttribute('placeholder', value);
    });
    scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria-label');
      const value = t(key);
      if (value) el.setAttribute('aria-label', value);
    });
    scope.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-lang-btn') === lang);
    });
  }

  // Wires every [data-lang-btn] on the page. `onChange(lang)` is called
  // after each switch so a page can re-render JS-generated content (e.g.
  // the permission-driven sidebar) that isn't reachable via simple
  // [data-i18n] attributes.
  function initToggle(onChange) {
    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang-btn');
        if (lang === getLang()) return;
        setLang(lang);
        apply(document);
        if (typeof onChange === 'function') onChange(lang);
      });
    });
  }

  return { getLang, setLang, t, apply, initToggle };
})();
