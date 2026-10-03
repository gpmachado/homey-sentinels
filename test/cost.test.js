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

test('the "Set energy price" action changes the price, keeps the currency unless one is given, and 0 turns it off', async () => {
  // Uses the real App class (with the `homey` module stubbed) and a fake flow manager that hands back the run
  // listener of the card, so the registered handler itself is what is exercised.
  const Module = require('node:module');
  const path = require('node:path');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'homey') return { App: class { log() {} error() {} } };
    return originalLoad.call(this, request, ...rest);
  };
  let App;
  try { App = require(path.join(__dirname, '..', 'app.js')); } finally { Module._load = originalLoad; }

  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; }, unset: () => {} });
  await store.load();
  store.updateMessageSettings({ pricePerKwh: 0.85, currency: 'R$' });
  let listener = null;
  const card = (id) => ({ registerRunListener: (fn) => { if (id === 'set_energy_price') listener = fn; }, registerArgumentAutocompleteListener() {} });
  const anyCards = new Proxy({}, { get: () => card('other') });
  const app = Object.create(App.prototype);
  Object.assign(app, {
    store, gateway: {}, directory: {}, log: () => {}, error: () => {},
    cards: anyCards, stateCards: anyCards, voltageCards: anyCards, groupCards: anyCards, availabilityCards: anyCards,
    homey: { flow: { getActionCard: card, getConditionCard: card, getTriggerCard: card } }
  });
  app._registerFlowCards();
  assert.equal(typeof listener, 'function', 'the set_energy_price card must be registered');

  await listener({ price: 1.2, currency: '' }, {});
  assert.deepEqual([store.getMessageSettings().pricePerKwh, store.getMessageSettings().currency], [1.2, 'R$']);
  await listener({ price: 0.6, currency: 'EUR' }, {});
  assert.deepEqual([store.getMessageSettings().pricePerKwh, store.getMessageSettings().currency], [0.6, 'EUR']);
  await listener({ price: 0 }, {});
  assert.equal(store.getMessageSettings().pricePerKwh, 0);
});

test('"Cost today exceeds" fires exactly for the amounts this cycle\'s cost crossed, not before and not again after', async () => {
  const Module = require('node:module');
  const path = require('node:path');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'homey') return { App: class { log() {} error() {} } };
    return originalLoad.call(this, request, ...rest);
  };
  let App;
  try { App = require(path.join(__dirname, '..', 'app.js')); } finally { Module._load = originalLoad; }

  let listener = null;
  const card = (id) => ({ registerRunListener: (fn) => { if (id === 'activity_cost_exceeded') listener = fn; }, registerArgumentAutocompleteListener() {} });
  const anyCards = new Proxy({}, { get: () => card('other') });
  const app = Object.create(App.prototype);
  Object.assign(app, {
    store: { data: { monitors: {} } }, gateway: {}, directory: {}, log: () => {}, error: () => {},
    // this.cards is built once in onInit (app.js), then reused by name in _registerFlowCards — a blanket proxy
    // for it (unlike the other card groups, never re-read by name below) would silently hand back a fresh dummy
    // for `this.cards.costExceeded` instead of the one this test needs to capture.
    cards: {
      started: card('activity_started'), finished: card('activity_finished'), calibrated: card('threshold_calibrated'),
      cyclesReached: card('activity_cycles_reached'), unusuallyLong: card('activity_cycle_unusually_long'), costExceeded: card('activity_cost_exceeded')
    },
    stateCards: anyCards, voltageCards: anyCards, groupCards: anyCards, availabilityCards: anyCards,
    homey: { flow: { getActionCard: card, getConditionCard: card, getTriggerCard: card } }
  });
  app._registerFlowCards();
  assert.equal(typeof listener, 'function');

  const state = (previousCost, costToday) => ({ monitorId: 'm1', previousCost, costToday });
  const args = (amount) => ({ monitor: { id: 'm1' }, amount });
  // A cycle that pushes today's cost from 8.40 to 12.90 crosses a 10 threshold, but not a 5 (already passed
  // on an earlier cycle) nor a 15 (not reached yet).
  assert.equal(await listener(args(10), state(8.4, 12.9)), true);
  assert.equal(await listener(args(5), state(8.4, 12.9)), false);
  assert.equal(await listener(args(15), state(8.4, 12.9)), false);
  // A brand new day (previousCost resets to 0) re-arms every threshold at or below the first cycle's cost.
  assert.equal(await listener(args(2), state(0, 3.1)), true);
  // A different monitor is never matched, however its numbers line up.
  assert.equal(await listener({ monitor: { id: 'other' }, amount: 10 }, state(8.4, 12.9)), false);
});

test('voltage_phase_imbalance condition compares the two monitors\' current readings against the given percent', async () => {
  const Module = require('node:module');
  const path = require('node:path');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'homey') return { App: class { log() {} error() {} } };
    return originalLoad.call(this, request, ...rest);
  };
  let App;
  try { App = require(path.join(__dirname, '..', 'app.js')); } finally { Module._load = originalLoad; }

  const conditions = {};
  const card = () => ({ registerRunListener() {}, registerArgumentAutocompleteListener() {} });
  const app = Object.create(App.prototype);
  Object.assign(app, {
    store: { data: { voltageMonitors: {
      a: { id: 'a', name: 'Fase A', lastSample: { voltage: 220 } },
      b: { id: 'b', name: 'Fase B', lastSample: { voltage: 240 } },
      c: { id: 'c', name: 'Fase C', lastSample: null },
      d: { id: 'd', name: 'Fase D', lastSample: { voltage: 220 } }
    } } },
    gateway: {}, directory: {}, log: () => {}, error: () => {},
    cards: new Proxy({}, { get: () => card() }), stateCards: new Proxy({}, { get: () => card() }),
    voltageCards: new Proxy({}, { get: () => card() }),
    groupCards: new Proxy({}, { get: () => card() }), availabilityCards: new Proxy({}, { get: () => card() }),
    homey: {
      flow: {
        getActionCard: () => card(), getTriggerCard: () => card(),
        getConditionCard: (id) => {
          const c = card();
          c.registerRunListener = (fn) => { conditions[id] = fn; };
          return c;
        }
      }
    }
  });
  app._registerFlowCards();
  const run = conditions.voltage_phase_imbalance;
  assert.equal(typeof run, 'function');
  assert.equal(await run({ monitor_a: { id: 'a' }, monitor_b: { id: 'b' }, percent: 5 }), true); // ~8.7% apart
  assert.equal(await run({ monitor_a: { id: 'a' }, monitor_b: { id: 'b' }, percent: 10 }), false);
  assert.equal(await run({ monitor_a: { id: 'a' }, monitor_b: { id: 'c' }, percent: 0 }), false); // c has no reading yet
  assert.equal(await run({ monitor_a: { id: 'a' }, monitor_b: { id: 'd' }, percent: 0 }), false); // identical readings are not "more than 0 %" apart
});

test('_costBeforeCycle prices the energy from before the cycle, rounded once, not cost_today minus cost', () => {
  const { _costBeforeCycle } = require('../lib/app/summaries');
  const app = { store: { getMessageSettings: () => ({ pricePerKwh: 1, currency: '' }) } };
  // Today's total was already 1.00 before this 0.006 kWh cycle (0.998 kWh rounds to 1.00); subtracting the
  // rounded costs gave 0.99, so a Flow set to exactly 1.00 would have fired a second time on this cycle.
  assert.equal(costOf(1.004, 1) - costOf(0.006, 1), 0.99);
  assert.equal(_costBeforeCycle.call(app, 0.006, 1.004), 1);
  // Float noise or a first cycle of the day never goes below zero, and no price means 0.
  assert.equal(_costBeforeCycle.call(app, 0.5, 0.5), 0);
  assert.equal(_costBeforeCycle.call(app, 0.6, 0.5), 0);
  assert.equal(_costBeforeCycle.call({ store: { getMessageSettings: () => ({ pricePerKwh: 0 }) } }, 0.2, 1), 0);
});
