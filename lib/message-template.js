'use strict';

// How numbers are written into a message: the Flow tokens of type number always keep a dot (Homey needs
// that), but the sentence a person reads can use a decimal comma ("1,5 kWh"). One setting for the whole
// app, set at startup and when the user changes it in Settings; every renderMessage caller follows it.
let decimalComma = false;
function setDecimalComma(enabled) { decimalComma = enabled === true; }
function formatNumber(value) {
  // A computed number (kWh from a sum of small steps) carries float noise, e.g. 0.5899999999999999;
  // three decimals is finer than any of these readings.
  const text = String(Math.round(value * 1000) / 1000);
  return decimalComma ? text.replace('.', ',') : text;
}

// Renders a free-text message template with %placeholder% substitution and inline
// pluralization (%count:word|word% picks the first word when count is exactly 1, the
// second otherwise). Kept as plain user-authored text — not Homey's own i18n system —
// because Homey ships without a pt locale; the user writes their own wording in whatever
// language they use, the same way they already type the placeholder syntax itself.
function renderMessage(template, data) {
  if (!template) return '';
  return template.replace(/%([a-zA-Z0-9_]+)(?::([^%|]*)\|([^%]*))?%/g, (match, key, singular, plural) => {
    if (singular !== undefined) {
      const count = Number(data[key]);
      return Number.isFinite(count) && count === 1 ? singular : plural;
    }
    const value = data[key];
    if (value === undefined || value === null) return '';
    return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : String(value);
  });
}

function formatList(names, conjunction = 'e') {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  const last = names[names.length - 1];
  const rest = names.slice(0, -1);
  return `${rest.join(', ')} ${conjunction} ${last}`;
}

module.exports = { renderMessage, formatList, setDecimalComma };
