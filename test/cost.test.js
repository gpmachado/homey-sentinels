'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { costOf, costText } = require('../lib/cost');
const { setDecimalComma } = require('../lib/message-template');
const SentinelStore = require('../lib/store');

test('costOf: kWh times the price, kept to cents, and zero when there is no price', () => {
  assert.equal(costOf(1.2, 0.85), 1.02);
  assert.equal(costOf(0.1 + 0.2, 1), 0.3); // float noise is rounded away
  assert.equal(costOf(1.2, 0), 0);
  assert.equal(costOf(NaN, 0.85), 0);
  assert.equal(costOf(1.2, -1), 0);
});

test('costText: currency, two decimals, the app decimal separator, and empty when no price is set', () => {
  try {
    assert.equal(costText(1.02, 0.85, 'R$'), 'R$ 1.02');
    assert.equal(costText(1.2, 0.85, 'R$'), 'R$ 1.20'); // money always shows two decimals
    assert.equal(costText(1.02, 0.85, ''), '1.02');
    assert.equal(costText(0, 0, 'R$'), '');
    setDecimalComma(true);
    assert.equal(costText(1.02, 0.85, 'R$'), 'R$ 1,02');
  } finally {
    setDecimalComma(false);
  }
});

test('the store keeps a price and a currency, accepts a comma, and drops characters that would double the settings memory', async () => {
  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; }, unset: () => {} });
  await store.load();
  assert.deepEqual([store.getMessageSettings().pricePerKwh, store.getMessageSettings().currency], [0, '']);
  store.updateMessageSettings({ pricePerKwh: '0,85', currency: 'R$' });
  assert.deepEqual([store.getMessageSettings().pricePerKwh, store.getMessageSettings().currency], [0.85, 'R$']);
  store.updateMessageSettings({ currency: String.fromCharCode(0x20ac) + 'EUR' }); // a euro sign is above U+00FF
  assert.equal(store.getMessageSettings().currency, 'EUR');
  store.updateMessageSettings({ pricePerKwh: 'abc' });
  assert.equal(store.getMessageSettings().pricePerKwh, 0);
  store.updateMessageSettings({ pricePerKwh: 99999 });
  assert.equal(store.getMessageSettings().pricePerKwh, 1000);
  assert.equal(store.getMessageSettings().decimalComma, false); // the other options are untouched
});

test('the finished-cycle tokens carry the cost, and are zero / empty while no price is set', () => {
  const { _costTokens } = require('../lib/app/summaries');
  const withPrice = { store: { getMessageSettings: () => ({ pricePerKwh: 0.85, currency: 'R$' }) } };
  assert.deepEqual(_costTokens.call(withPrice, 1.2, 3), { cost: 1.02, cost_today: 2.55, cost_text: 'R$ 1.02', cost_today_text: 'R$ 2.55' });
  const noPrice = { store: { getMessageSettings: () => ({ pricePerKwh: 0, currency: 'R$' }) } };
  assert.deepEqual(_costTokens.call(noPrice, 1.2, 3), { cost: 0, cost_today: 0, cost_text: '', cost_today_text: '' });
});
