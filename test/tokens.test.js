'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roundTokens } = require('../lib/app/constants');

test('roundTokens: float noise in number tokens goes away, everything else is left as it is', () => {
  const out = roundTokens({ energy_today: 3.9199999999999997, average_power: 1480.12345, count: 3, voltage: 228.5, message: 'x 0.1234567', flag: true, none: null });
  assert.deepEqual(out, { energy_today: 3.92, average_power: 1480.123, count: 3, voltage: 228.5, message: 'x 0.1234567', flag: true, none: null });
  assert.equal(roundTokens(0.1 + 0.2), 0.30000000000000004); // not an object: untouched (an action returning true / a condition's boolean)
  assert.equal(roundTokens(true), true);
  assert.equal(roundTokens(undefined), undefined);
});

test('roundTokens does not change the object it was given', () => {
  const input = { energy: 0.5899999999999999 };
  roundTokens(input);
  assert.equal(input.energy, 0.5899999999999999);
});
