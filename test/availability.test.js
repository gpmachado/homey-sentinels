'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const { watchdogVerdict, evaluateWatchdog, normalizeAvailabilitySettings, batteryLevel, isNotFoundError, DEFAULT_AVAILABILITY_SETTINGS } = require('../lib/availability');

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

const settingsWith = (patch) => normalizeAvailabilitySettings({ ...DEFAULT_AVAILABILITY_SETTINGS, ...patch });
const withBattery = (value, extra = {}) => ({ available: true, lastSeenAt: hoursAgo(1), capabilitiesObj: { measure_battery: { value } }, ...extra });

test('settings: gaps get the defaults and values are clamped', () => {
  assert.deepEqual(normalizeAvailabilitySettings(undefined), DEFAULT_AVAILABILITY_SETTINGS);
  const clamped = normalizeAvailabilitySettings({ defaultThresholdHours: -5, startupGraceMinutes: 9999, batteryWarnPercent: 250, unavailableDelaySeconds: 'abc', timelineNotifications: 'false' });
  assert.equal(clamped.defaultThresholdHours, 1);
  assert.equal(clamped.startupGraceMinutes, 60);
  assert.equal(clamped.batteryWarnPercent, 100);
  assert.equal(clamped.unavailableDelaySeconds, 0);
  assert.equal(clamped.timelineNotifications, false);
});

test('unavailable delay: the device only counts as down after staying unavailable that long', () => {
  const settings = settingsWith({ unavailableDelaySeconds: 300 });
  const gone = { available: false, lastSeenAt: hoursAgo(1) };
  const first = evaluateWatchdog({ thresholdHours: 12 }, gone, settings, NOW);
  assert.equal(first.isDown, false);
  assert.equal(first.unavailableSince, NOW);
  assert.equal(first.recheckInMs, 300000); // asks to be looked at again when the wait is over
  const later = evaluateWatchdog({ thresholdHours: 12, unavailableSince: NOW }, gone, settings, NOW + 301000);
  assert.deepEqual([later.isDown, later.reason, later.recheckInMs], [true, 'unavailable', null]);
  const back = evaluateWatchdog({ thresholdHours: 12, unavailableSince: NOW }, { available: true, lastSeenAt: hoursAgo(1) }, settings, NOW + 60000);
  assert.equal(back.unavailableSince, null); // a blip that recovered resets the clock
});

test('unavailable delay: silence past the threshold is not delayed', () => {
  const result = evaluateWatchdog({ thresholdHours: 12 }, { available: false, lastSeenAt: hoursAgo(20) }, settingsWith({ unavailableDelaySeconds: 600 }), NOW);
  assert.deepEqual([result.isDown, result.reason], [true, 'stale']);
});

test('battery: low at or below the warning level, only after the delay, and off at 0', () => {
  assert.equal(batteryLevel({ capabilitiesObj: { measure_battery: { value: 42 } } }), 42);
  assert.equal(batteryLevel({ capabilitiesObj: {} }), null);
  const low = evaluateWatchdog({ thresholdHours: 12 }, withBattery(25), settingsWith({ batteryWarnPercent: 30 }), NOW);
  assert.deepEqual([low.lowBattery, low.battery], [true, 25]);
  assert.equal(evaluateWatchdog({ thresholdHours: 12 }, withBattery(31), settingsWith({ batteryWarnPercent: 30 }), NOW).lowBattery, false);
  const delayed = settingsWith({ batteryWarnPercent: 30, batteryDelaySeconds: 120 });
  const pending = evaluateWatchdog({ thresholdHours: 12 }, withBattery(10), delayed, NOW);
  assert.deepEqual([pending.lowBattery, pending.lowBatterySince, pending.recheckInMs], [false, NOW, 120000]);
  assert.equal(evaluateWatchdog({ thresholdHours: 12, lowBatterySince: NOW }, withBattery(10), delayed, NOW + 121000).lowBattery, true);
  assert.equal(evaluateWatchdog({ thresholdHours: 12 }, withBattery(1), settingsWith({ batteryWarnPercent: 0 }), NOW).lowBattery, false);
  assert.equal(evaluateWatchdog({ thresholdHours: 12 }, { available: true, lastSeenAt: hoursAgo(1) }, settingsWith({}), NOW).lowBattery, false); // no battery: never low
});

test('not-found errors are told apart from a transient failure', () => {
  assert.equal(isNotFoundError({ statusCode: 404 }), true);
  assert.equal(isNotFoundError(new Error('Device Not Found')), true);
  assert.equal(isNotFoundError(new Error('socket hang up')), false);
  assert.equal(isNotFoundError(null), false);
});

test('the store: new watchdogs take the default threshold, and watchdogs of missing devices can be removed', async () => {
  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; } });
  await store.load();
  store.updateAvailabilitySettings({ defaultThresholdHours: 36 });
  assert.equal(store.upsertAvailabilityWatchdog({ deviceId: 'a', name: 'A' }).thresholdHours, 36);
  store.upsertAvailabilityWatchdog({ deviceId: 'b', name: 'B', thresholdHours: 6 });
  store.data.availabilityWatchdogs.b.missing = true;
  assert.equal(store.removeMissingWatchdogs(), 1);
  assert.deepEqual(Object.keys(store.data.availabilityWatchdogs), ['a']);
  await store.save();
  const reloaded = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; }, unset: () => {} });
  await reloaded.load();
  assert.equal(reloaded.getAvailabilitySettings().defaultThresholdHours, 36);
});
