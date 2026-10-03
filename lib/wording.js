'use strict';

// Default message wording, per language. The sentences live in locales/<code>.json (the folder Homey uses for
// translations) and are read here directly instead of through Homey's own translation call, for one reason:
// Homey has no Portuguese, and a user who wants Portuguese defaults has to be able to ask for them whatever
// language their Homey is set to. So the language used is, in order: the one chosen in Settings (Default message
// language), else the language Homey reports, else English; and any sentence missing in that language falls back
// to the English one. Pure, so it is tested directly.
const FILES = {
  en: require('../locales/en.json'),
  pt: require('../locales/pt.json'),
  nl: require('../locales/nl.json'),
  de: require('../locales/de.json'),
  fr: require('../locales/fr.json'),
  it: require('../locales/it.json'),
  sv: require('../locales/sv.json'),
  no: require('../locales/no.json'),
  es: require('../locales/es.json'),
  da: require('../locales/da.json')
};

// The choices offered in Settings, each in its own language.
const LANGUAGES = [
  { code: 'en', name: 'English' }, { code: 'pt', name: 'Português' }, { code: 'nl', name: 'Nederlands' },
  { code: 'de', name: 'Deutsch' }, { code: 'fr', name: 'Français' }, { code: 'it', name: 'Italiano' },
  { code: 'sv', name: 'Svenska' }, { code: 'no', name: 'Norsk' }, { code: 'es', name: 'Español' }, { code: 'da', name: 'Dansk' }
];

function isSupported(code) { return typeof code === 'string' && Object.prototype.hasOwnProperty.call(FILES, code); }

function resolveLanguage(preferred, homeyLanguage) {
  if (isSupported(preferred)) return preferred;
  if (isSupported(homeyLanguage)) return homeyLanguage;
  return 'en';
}

function mergeOver(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeOver(base[key] || {}, value) : value;
  }
  return out;
}

// All the default sentences for a language, with English filling anything that language lacks.
function wordingFor(language) {
  const code = isSupported(language) ? language : 'en';
  return code === 'en' ? FILES.en : mergeOver(FILES.en, FILES[code]);
}

module.exports = { LANGUAGES, isSupported, resolveLanguage, wordingFor };
