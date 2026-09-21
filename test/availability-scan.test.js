'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanDevices } = require('../lib/availability-scan');
const { normalizeAvailabilitySettings } = require('../lib/availability');
const { watchdogsWidgetSummary } = require('../lib/widget-summaries');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const settings = normalizeAvailabilitySettings({ defaultThresholdHours: 12, batteryWarnPercent: 30 });
const device = (id, extra = {}) => ({ id, name: `Device ${id}`, zoneName: 'Sala', available: true, lastSeenAt: hoursAgo(1), capabilitiesObj: {}, ...extra });
const battery = (value) => ({ measure_battery: { value } });

test('scan: a quiet device, an unavailable one and a low battery are problems; healthy ones are only counted', () => {
  const result = scanDevices([
    device('ok'),
    device('quiet', { lastSeenAt: hoursAgo(20) }),
    device('gone', { available: false }),
    device('weak', { capabilitiesObj: battery(12) })
  ], { settings, now: NOW });
  assert.equal(result.monitored, 4);
  assert.deepEqual(result.counts, { stale: 1, unavailable: 1, lowBattery: 1 });
  assert.deepEqual(result.problems.map((p) => [p.id, p.reason, p.lowBattery]).sort(), [['gone', 'unavailable', false], ['quiet', 'stale', false], ['weak', null, true]]);
  assert.equal(result.state.ok, undefined); // nothing is remembered about a healthy device
});

test('scan: devices with a watchdog, excluded devices and excluded zones are left out', () => {
  const result = scanDevices([
    device('watched', { lastSeenAt: hoursAgo(50) }),
    device('skipped', { lastSeenAt: hoursAgo(50) }),
    device('zoned', { lastSeenAt: hoursAgo(50), zoneName: 'Garagem' }),
    device('counted', { lastSeenAt: hoursAgo(50) })
  ], { settings, now: NOW, watchedIds: new Set(['watched']), exclusions: { devices: { skipped: 'Skipped' }, zones: { Garagem: true } } });
  assert.equal(result.monitored, 1);
  assert.deepEqual(result.problems.map((p) => p.id), ['counted']);
});

test('scan: a problem is new once, then known; a restart with the saved state announces nothing again', () => {
  const list = [device('quiet', { lastSeenAt: hoursAgo(20) })];
  const first = scanDevices(list, { settings, now: NOW });
  assert.equal(first.problems[0].isNew, true);
  const second = scanDevices(list, { settings, now: NOW + 3600000, previous: first.state });
  assert.equal(second.problems[0].isNew, false);
  assert.equal(second.problems[0].since, first.problems[0].since); // "since" stays what it was when first seen
  const recovered = scanDevices([device('quiet')], { settings, now: NOW + 7200000, previous: second.state });
  assert.equal(recovered.problems.length, 0);
  const again = scanDevices(list, { settings, now: NOW + 10800000, previous: recovered.state });
  assert.equal(again.problems[0].isNew, true); // it went wrong again: announced again
});

test('scan: the unavailable delay is kept across scans', () => {
  const delayed = normalizeAvailabilitySettings({ unavailableDelaySeconds: 300 });
  const list = [device('blip', { available: false })];
  const first = scanDevices(list, { settings: delayed, now: NOW });
  assert.equal(first.problems.length, 0);
  assert.equal(first.state.blip.u, NOW); // waiting out the delay, remembered
  const later = scanDevices(list, { settings: delayed, now: NOW + 301000, previous: first.state });
  assert.deepEqual(later.problems.map((p) => p.reason), ['unavailable']);
});

test('widget summary: scanned problems are listed with the watchdogs, healthy scanned devices count as OK', () => {
  const summary = watchdogsWidgetSummary(
    [{ deviceId: 'w', name: 'Watched', thresholdHours: 6, wentUnavailableAt: null, available: true }],
    NOW,
    { monitored: 10, thresholdHours: 12, problems: [{ id: 'q', name: 'Quiet', reason: 'stale', since: NOW - 60000, lastSeenAt: hoursAgo(20) }, { id: 'b', name: 'Weak', reason: null, lowBattery: true, battery: 10 }] }
  );
  assert.equal(summary.total, 11);
  assert.deepEqual([summary.staleCount, summary.unavailableCount, summary.lowBatteryCount, summary.okCount], [1, 0, 1, 10]);
  assert.equal(summary.scanning, true);
  assert.equal(summary.items[0].name, 'Quiet');
  assert.equal(summary.items[0].downSeconds, 60);
  assert.equal(summary.items.find((item) => item.deviceId === 'b').down, false);
});

test('scan: every device of an ignored app is left out (virtual devices that never report)', () => {
  const virtual = (id) => device(id, { ownerUri: 'homey:app:gpm.linked.switches', lastSeenAt: hoursAgo(90) });
  const result = scanDevices([virtual('a'), virtual('b'), device('real', { lastSeenAt: hoursAgo(90), ownerUri: 'homey:app:com.x' })], { settings, now: NOW, exclusions: { apps: { 'homey:app:gpm.linked.switches': true } } });
  assert.equal(result.monitored, 1);
  assert.deepEqual(result.problems.map((p) => p.id), ['real']);
  assert.equal(result.problems[0].ownerUri, 'homey:app:com.x');
});

test('announceable: silence alone is not announced unless asked for; unavailable and low battery always are', () => {
  const { announceable } = require('../lib/availability-scan');
  const problems = [
    { id: 'quiet', reason: 'stale', lowBattery: false, isNew: true },
    { id: 'gone', reason: 'unavailable', lowBattery: false, isNew: true },
    { id: 'quiet-weak', reason: 'stale', lowBattery: true, isNew: true },
    { id: 'old', reason: 'unavailable', lowBattery: false, isNew: false }
  ];
  const off = announceable(problems, normalizeAvailabilitySettings({}));
  assert.deepEqual(off.map((p) => [p.id, p.reason]), [['gone', 'unavailable'], ['quiet-weak', null]]);
  const on = announceable(problems, normalizeAvailabilitySettings({ scanAnnounceSilent: true }));
  assert.deepEqual(on.map((p) => p.id), ['quiet', 'gone', 'quiet-weak']);
});

test('scan: an app can have its own silence limit (solar panels are quiet all night)', () => {
  const solar = (id, hours) => device(id, { ownerUri: 'homey:app:solar', lastSeenAt: hoursAgo(hours) });
  const list = [solar('night', 13), solar('dead', 40), device('plain', { lastSeenAt: hoursAgo(13) })];
  const result = scanDevices(list, { settings, now: NOW, exclusions: { appHours: { 'homey:app:solar': 36 } } });
  assert.deepEqual(result.problems.map((p) => p.id).sort(), ['dead', 'plain']); // 13 h passes for the solar app, not for the rest
  assert.equal(result.problems.find((p) => p.id === 'dead').thresholdHours, 36);
});

test('store: an app limit is kept, clamped, and removed by an empty value', async () => {
  const SentinelStore = require('../lib/store');
  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; } });
  await store.load();
  store.setAppHours('homey:app:solar', 36.4);
  assert.equal(store.data.availabilityExclusions.appHours['homey:app:solar'], 36);
  store.setAppHours('homey:app:solar', 999999);
  assert.equal(store.data.availabilityExclusions.appHours['homey:app:solar'], 24 * 90);
  store.setAppHours('homey:app:solar', 0);
  assert.equal(store.data.availabilityExclusions.appHours['homey:app:solar'], undefined);
});
