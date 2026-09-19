'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const { watchdogVerdict } = require('../lib/availability');

const NOW = Date.parse('2026-09-19T20:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('an unavailable device counts as down, with the reason "unavailable"', () => {
  const verdict = watchdogVerdict({ thresholdHours: 12 }, { available: false, lastSeenAt: hoursAgo(1) }, NOW);
  assert.deepEqual(verdict, { isDown: true, isStale: false, reason: 'unavailable' });
});

test('an available device is down only once it has been silent past the threshold', () => {
  assert.equal(watchdogVerdict({ thresholdHours: 12 }, { available: true, lastSeenAt: hoursAgo(11) }, NOW).isDown, false);
  assert.deepEqual(watchdogVerdict({ thresholdHours: 12 }, { available: true, lastSeenAt: hoursAgo(13) }, NOW), { isDown: true, isStale: true, reason: 'stale' });
  assert.equal(watchdogVerdict({ thresholdHours: 12 }, { available: true, lastSeenAt: null }, NOW).isDown, false); // never seen: no basis to call it stale
});

test('ignoreUnavailable: an appliance that is switched off does not alert until it has been silent too long', () => {
  const off = { available: false, lastSeenAt: hoursAgo(2) };
  assert.equal(watchdogVerdict({ thresholdHours: 12, ignoreUnavailable: true }, off, NOW).isDown, false);
  assert.deepEqual(watchdogVerdict({ thresholdHours: 12, ignoreUnavailable: true }, { available: false, lastSeenAt: hoursAgo(20) }, NOW), { isDown: true, isStale: true, reason: 'stale' });
  assert.equal(watchdogVerdict({ thresholdHours: 12 }, off, NOW).isDown, true); // without the option the same device alerts
});

test('the store keeps ignoreUnavailable on create and update, and old watchdogs default to false', async () => {
  const data = {};
  const settings = { get: (k) => data[k], set: async (k, v) => { data[k] = v; } };
  const store = new SentinelStore(settings);
  await store.load();
  const created = store.upsertAvailabilityWatchdog({ deviceId: 'd1', name: 'Washer', thresholdHours: 12, ignoreUnavailable: true });
  assert.equal(created.ignoreUnavailable, true);
  store.upsertAvailabilityWatchdog({ deviceId: 'd1', thresholdHours: 24, ignoreUnavailable: false });
  assert.equal(store.data.availabilityWatchdogs.d1.ignoreUnavailable, false);
  assert.equal(store.data.availabilityWatchdogs.d1.thresholdHours, 24);
  store.upsertAvailabilityWatchdog({ deviceId: 'd1', thresholdHours: 6 }); // omitted: unchanged
  assert.equal(store.data.availabilityWatchdogs.d1.ignoreUnavailable, false);
  const plain = store.upsertAvailabilityWatchdog({ deviceId: 'd2', name: 'Plug', thresholdHours: 12 });
  assert.equal(plain.ignoreUnavailable, false);
  const legacy = { sentinels: { monitors: {}, groups: {}, voltageMonitors: {}, availabilityWatchdogs: { old: { deviceId: 'old', name: 'Old', thresholdHours: 12 } } } };
  const migrated = new SentinelStore({ get: (k) => legacy[k], set: async () => {}, unset: () => {} });
  await migrated.load();
  assert.equal(migrated.data.availabilityWatchdogs.old.ignoreUnavailable, false);
});
