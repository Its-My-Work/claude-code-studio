// Translation loader for Claude Code Studio
// Loads translations from JSON files in locales/ directory

const TRANSLATIONS_CACHE = new Map();
let CURRENT_TRANSLATIONS = {};
let _initialized = false;

function clearCache() {
  TRANSLATIONS_CACHE.clear();
  _initialized = false;
}

async function loadTranslations(lang) {
  console.log('[i18n] loadTranslations:', lang);
  // Check cache first
  if (TRANSLATIONS_CACHE.has(lang)) {
    console.log('[i18n] Using cache for:', lang);
    return TRANSLATIONS_CACHE.get(lang);
  }

  try {
    const response = await fetch(`locales/${lang}.json`);
    console.log('[i18n] Fetch response:', response.status);
    if (!response.ok) {
      throw new Error(`Failed to load translations for ${lang}: ${response.status}`);
    }
    const translations = await response.json();
    console.log('[i18n] Loaded keys:', Object.keys(translations).length);
    TRANSLATIONS_CACHE.set(lang, translations);
    return translations;
  } catch (error) {
    console.error('[i18n] Load error:', error);
    // Fallback to Russian if English fails
    if (lang !== 'ru') {
      return loadTranslations('ru');
    }
    return null;
  }
}

async function initializeTranslations(lang = 'ru') {
  console.log('[i18n] initializeTranslations:', lang);
  // Clear cache if switching to different language
  const currentLang = localStorage.getItem('lang') || 'ru';
  if (TRANSLATIONS_CACHE.has(currentLang) && currentLang !== lang) {
    console.log('[i18n] Clearing cache for language switch');
    clearCache();
  }
  
  const translations = await loadTranslations(lang);
  console.log('[i18n] Loaded:', translations ? Object.keys(translations).length : 0, 'keys');
  if (translations) {
    CURRENT_TRANSLATIONS = translations;
    _initialized = true;
  }
  return CURRENT_TRANSLATIONS;
}

// Synchronous translation function
function t(key) {
  return CURRENT_TRANSLATIONS[key] || key;
}

// Apply translations to DOM elements
function applyTranslations() {
  const lang = localStorage.getItem('lang') || 'ru';
  
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (CURRENT_TRANSLATIONS[k]) el.textContent = CURRENT_TRANSLATIONS[k];
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const k = el.getAttribute('data-i18n-html');
    if (CURRENT_TRANSLATIONS[k]) el.innerHTML = CURRENT_TRANSLATIONS[k];
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const k = el.getAttribute('data-i18n-ph');
    if (CURRENT_TRANSLATIONS[k]) el.placeholder = CURRENT_TRANSLATIONS[k];
  });
  document.querySelectorAll('[data-i18n-tip]').forEach(el => {
    const k = el.getAttribute('data-i18n-tip');
    if (CURRENT_TRANSLATIONS[k]) el.setAttribute('data-tip', CURRENT_TRANSLATIONS[k]);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (CURRENT_TRANSLATIONS[k]) el.title = CURRENT_TRANSLATIONS[k];
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const k = el.getAttribute('data-i18n-aria');
    if (CURRENT_TRANSLATIONS[k]) el.setAttribute('aria-label', CURRENT_TRANSLATIONS[k]);
  });
  
  // Update lang selector value
  const sel = document.getElementById('langSel');
  if (sel) sel.value = lang;
}

// Export for global use
window.TranslationLoader = {
  loadTranslations,
  initializeTranslations,
  applyTranslations,
  clearCache,
  t,
  get CURRENT_TRANSLATIONS() { return CURRENT_TRANSLATIONS; },
  get isInitialized() { return _initialized; }
};