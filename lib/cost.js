'use strict';

// Estimated cost of energy: kWh times a price per kWh the user sets once in Settings. Pure, so it is tested
// directly; the app feeds it the current settings. A price of 0 means "not configured": every cost is 0 and
// the text is empty, so a Flow token always has a value (Homey rejects undefined).
const { getDecimalComma } = require('./message-template');

// Money is kept to cents: rounding to 2 decimals hides float noise (0.1 + 0.2) and matches what is paid.
function costOf(kwh, pricePerKwh) {
  if (!Number.isFinite(kwh) || !Number.isFinite(pricePerKwh) || pricePerKwh <= 0) return 0;
  return Math.round(kwh * pricePerKwh * 100) / 100;
}

// "R$ 1,02" (or "R$ 1.02"): the currency symbol, then always two decimals, with the app's decimal separator.
// Empty when no price is configured, so a message reads cleanly without a "R$ 0,00" that means "unknown".
function costText(cost, pricePerKwh, currency) {
  if (!Number.isFinite(cost) || !Number.isFinite(pricePerKwh) || pricePerKwh <= 0) return '';
  const digits = cost.toFixed(2);
  const number = getDecimalComma() ? digits.replace('.', ',') : digits;
  return currency ? `${currency} ${number}` : number;
}

module.exports = { costOf, costText };
