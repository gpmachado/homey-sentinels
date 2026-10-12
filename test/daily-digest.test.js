'use strict';
// The daily digest: today's cycles and energy, the biggest user, flagged devices and groups, in one sentence.
const test = require('node:test');
const assert = require('node:assert/strict');
const summaries = require('../lib/app/summaries');
const { startOfLocalDay } = require('../lib/time');

const DAY_START = startOfLocalDay(new Date(), 'UTC').getTime();
const monitor = (name, kwh, cycles) => ({
  name, periods: kwh ? [{ startedAt: DAY_START + 1, endedAt: DAY_START + 2, state: 'ACTIVE', seconds: 1, energy: kwh, minPower: 1, maxPower: 1, powerSum: 1, sampleCount: 1 }] : [],
  cycles: Array.from({ length: cycles }, (_, i) => ({ startedAt: DAY_START + 1 + i, endedAt: DAY_START + 2 + i, duration: 1, averagePower: 1, maxPower: 1, energy: kwh / (cycles || 1) })), dailySummaries: []
});
const fakeApp = ({ monitors = {}, groups = {}, problems = null, language = 'en', price = 0 } = {}) => Object.assign({
  store: { data: { monitors, groups }, getMessageSettings: () => ({ pricePerKwh: price, currency: 'R$' }) },
  _getTimezone: () => 'UTC', _messageLanguage: () => language, _availabilityScan: problems === null ? null : { problems }
}, summaries);

test('adds up the day, names the biggest user, counts flagged devices and groups in a mismatch', () => {
  const digest = fakeApp({
    monitors: { a: monitor('Pump', 1.5, 3), b: monitor('Oven', 0.5, 1), c: monitor('Idle', 0, 0) },
    groups: { g1: { mismatchSince: 123 }, g2: { mismatchSince: null } }, problems: [{ id: 'x' }, { id: 'y' }]
  }).getDailyDigest();
  assert.equal(digest.cycles, 4);
  assert.equal(digest.energy, 2);
  assert.equal(digest.topName, 'Pump');
  assert.equal(digest.topEnergy, 1.5);
  assert.equal(digest.problems, 2);
  assert.equal(digest.groupsMismatch, 1);
  assert.equal(digest.message, 'Today: 4 cycles, 2.00 kWh. Most energy: Pump (1.50 kWh). Devices needing attention: 2. Groups out of place: 1.');
});

test('with a price the cost goes into the sentence, in the chosen language', () => {
  const digest = fakeApp({ monitors: { a: monitor('Bomba', 2, 2) }, language: 'pt', price: 0.5, problems: [] }).getDailyDigest();
  assert.equal(digest.cost, 1);
  assert.equal(digest.costText, 'R$ 1.00');
  assert.equal(digest.message, 'Hoje: 2 ciclos, 2.00 kWh (R$ 1.00). Maior consumo: Bomba (2.00 kWh (R$ 1.00)). Dispositivos com problema: 0. Grupos fora do lugar: 0.');
});

test('a quiet day, with the availability scan off, still gives every token a value', () => {
  const digest = fakeApp({ monitors: { a: monitor('Idle', 0, 0) } }).getDailyDigest();
  assert.deepEqual([digest.cycles, digest.energy, digest.topName, digest.topEnergy, digest.problems, digest.groupsMismatch], [0, 0, '', 0, 0, 0]);
  assert.equal(digest.message, 'Today: 0 cycles, 0 Wh. Most energy: -. Devices needing attention: 0. Groups out of place: 0.');
});
