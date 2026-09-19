'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const { encodeRows, decodeRows } = require('../lib/storage-format');

// Behaves like Homey's ManagerSettings: values are JSON-serialized on set and parsed on get, so a
// reloaded store never shares object references with the one that saved.
function homeySettings(initial = {}) {
  const data = {};
  for (const [key, value] of Object.entries(initial)) data[key] = JSON.stringify(value);
  const calls = { set: [], unset: [] };
  return {
    calls,
    raw: data,
    get: (key) => (key in data ? JSON.parse(data[key]) : undefined),
    set: async (key, value) => { calls.set.push(key); data[key] = JSON.stringify(value); },
    unset: (key) => { calls.unset.push(key); delete data[key]; },
    getKeys: () => Object.keys(data)
  };
}

const activityPeriod = (i, over = {}) => ({
  startedAt: 1000 + i * 60000, endedAt: 1000 + i * 60000 + 60000, state: i % 2 ? 'ACTIVE' : 'STANDBY', seconds: 60,
  energy: i % 3 ? 0.25 : null, minPower: 5, maxPower: 9, powerSum: 70, sampleCount: 10, maxCurrent: null, currentSum: 0,
  currentSampleCount: 0, current: null, meterReset: false, ...over
});
const voltagePeriod = (i, over = {}) => ({
  startedAt: 5000 + i * 300000, endedAt: 5000 + i * 300000 + 300000, seconds: 300, state: 'NORMAL',
  minVoltage: 218.3, maxVoltage: 222.1, voltageSum: 2640.5, sampleCount: 12, ...over
});
const cycle = (i) => ({ startedAt: 10 + i, endedAt: 500 + i, duration: 490, averagePower: 850.5, maxPower: 900, averageCurrent: null, maxCurrent: null, energy: 0.2 });

test('encodeRows/decodeRows round-trip regular rows exactly, including nulls and booleans', () => {
  const periods = [activityPeriod(0), activityPeriod(1), activityPeriod(2, { energy: 0.1 + 0.2, meterReset: true })];
  const encoded = encodeRows('activityPeriod', periods);
  assert.ok(encoded.every(Array.isArray));
  assert.deepEqual(decodeRows('activityPeriod', JSON.parse(JSON.stringify(encoded))), periods);
  const volts = [voltagePeriod(0), voltagePeriod(1, { state: 'UNDERVOLTAGE' })];
  assert.deepEqual(decodeRows('voltagePeriod', JSON.parse(JSON.stringify(encodeRows('voltagePeriod', volts)))), volts);
  const cycles = [cycle(0), cycle(1)];
  assert.deepEqual(decodeRows('cycle', JSON.parse(JSON.stringify(encodeRows('cycle', cycles)))), cycles);
});

test('rows that do not match the schema stay as objects and still round-trip', () => {
  const legacy = { startedAt: 1, endedAt: 2, state: 'ACTIVE', seconds: 1, energy: 0, power: 100 }; // pre-bucketing shape
  const missingField = (() => { const p = activityPeriod(1); delete p.current; return p; })();
  const extraKey = activityPeriod(2, { note: 'x' });
  const unknownState = activityPeriod(3, { state: 'MANUAL' });
  const rows = [activityPeriod(0), legacy, missingField, extraKey, unknownState];
  const encoded = encodeRows('activityPeriod', rows);
  assert.ok(Array.isArray(encoded[0]));
  assert.ok(encoded.slice(1).every((row) => !Array.isArray(row)));
  assert.deepEqual(decodeRows('activityPeriod', JSON.parse(JSON.stringify(encoded))), rows);
});

test('fractional-millisecond timestamps still round-trip exactly', () => {
  const rows = [activityPeriod(4, { endedAt: 1000.5 + 4 * 60000 + 60000 }), activityPeriod(5, { startedAt: 0.1, endedAt: 0.3 })];
  assert.deepEqual(decodeRows('activityPeriod', JSON.parse(JSON.stringify(encodeRows('activityPeriod', rows)))), rows);
});

test('tuple encoding is much smaller than the object form and stays ASCII-only', () => {
  const periods = Array.from({ length: 2000 }, (_, i) => voltagePeriod(i));
  const objects = JSON.stringify(periods);
  const tuples = JSON.stringify(encodeRows('voltagePeriod', periods));
  assert.ok(tuples.length * 2.5 < objects.length, `${tuples.length} vs ${objects.length}`);
  assert.equal(/[^\u0000-\u00ff]/.test(tuples), false);
});

async function populatedStore(settings) {
  const store = new SentinelStore(settings);
  await store.load();
  const activity = store.createMonitor({ device: { id: 'a', name: 'Bomba do poço' }, threshold: 50 });
  activity.periods = Array.from({ length: 50 }, (_, i) => activityPeriod(i));
  activity.cycles = [cycle(0), cycle(1)];
  activity.totals.cycleCount = 2;
  const state = store.createStateMonitor({ device: { id: 's', name: 'Door' }, capability: 'alarm_contact' });
  state.periods = Array.from({ length: 10 }, (_, i) => activityPeriod(i));
  const volt = store.createVoltageMonitor({ device: { id: 'v', name: 'Volt A' }, minVoltage: 200, maxVoltage: 240 });
  volt.periods = Array.from({ length: 100 }, (_, i) => voltagePeriod(i));
  return { store, activity, state, volt };
}

test('save writes ONE versioned key holding meta and every series, nothing else', async () => {
  const settings = homeySettings();
  const { store, activity, state, volt } = await populatedStore(settings);
  await store.save();
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v2']);
  const saved = settings.get('sentinels:v2');
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.meta.monitors[activity.id].periods, undefined);
  assert.equal(saved.meta.monitors[activity.id].cycles, undefined);
  assert.equal(saved.meta.voltageMonitors[volt.id].periods, undefined);
  assert.equal(saved.meta.monitors[activity.id].name, 'Bomba do po\u00e7o');
  assert.equal(saved.series[activity.id].periods.length, 50);
  assert.equal(saved.series[state.id].periods.length, 10);
  assert.equal(saved.series[volt.id].cycles, undefined);
  assert.ok(Array.isArray(saved.series[volt.id].periods[0])); // tuple-encoded
});

test('a reloaded store gets every monitor back with identical periods and cycles', async () => {
  const settings = homeySettings();
  const { store, activity, state, volt } = await populatedStore(settings);
  await store.save();
  const reloaded = new SentinelStore(settings);
  await reloaded.load();
  assert.equal(reloaded.migratedFrom, null);
  assert.deepEqual(reloaded.data.monitors[activity.id].periods, activity.periods);
  assert.deepEqual(reloaded.data.monitors[activity.id].cycles, activity.cycles);
  assert.deepEqual(reloaded.data.monitors[activity.id].totals, activity.totals);
  assert.deepEqual(reloaded.data.stateMonitors[state.id].periods, state.periods);
  assert.deepEqual(reloaded.data.voltageMonitors[volt.id].periods, volt.periods);
  assert.equal(reloaded.data.voltageMonitors[volt.id].minVoltage, 200);
});

test('an unchanged store is not written again, and every save is exactly one settings write', async () => {
  const settings = homeySettings();
  const { store, activity, volt } = await populatedStore(settings);
  await store.save();
  settings.calls.set.length = 0;
  await store.save();
  assert.deepEqual(settings.calls.set, []);
  const last = volt.periods[volt.periods.length - 1];
  last.endedAt += 60000; last.seconds += 60; last.sampleCount += 12; // the engines extend the last period in place
  await store.save();
  assert.deepEqual(settings.calls.set, ['sentinels:v2']);
  settings.calls.set.length = 0;
  activity.periods.push(activityPeriod(99));
  activity.lastSample = { power: 5, timestamp: 1 };
  volt.periods.push(voltagePeriod(500));
  await store.save();
  assert.deepEqual(settings.calls.set, ['sentinels:v2']); // several monitors changed, still ONE write
});

test('consolidating (fewer periods) and resetting are picked up as changes', async () => {
  const settings = homeySettings();
  const { store, activity } = await populatedStore(settings);
  await store.save();
  activity.periods = activity.periods.slice(10);
  await store.save();
  const reloaded = new SentinelStore(settings);
  await reloaded.load();
  assert.equal(reloaded.data.monitors[activity.id].periods.length, 40);
  store.resetMonitor(activity);
  await store.save();
  const again = new SentinelStore(settings);
  await again.load();
  assert.deepEqual(again.data.monitors[activity.id].periods, []);
  assert.deepEqual(again.data.monitors[activity.id].cycles, []);
});

test('a deleted monitor is gone from the next write', async () => {
  const settings = homeySettings();
  const { store, volt } = await populatedStore(settings);
  await store.save();
  store.deleteVoltageMonitor(volt.id);
  await store.save();
  assert.equal(settings.get('sentinels:v2').series[volt.id], undefined);
  assert.equal(settings.get('sentinels:v2').meta.voltageMonitors[volt.id], undefined);
});

test('the original single-blob format is migrated to the versioned key and then removed', async () => {
  const legacy = {
    monitors: { m1: { id: 'm1', name: 'Pump', deviceId: 'a', deviceName: 'Pump', capability: 'measure_power', threshold: 50, periods: [activityPeriod(0), activityPeriod(1)], cycles: [cycle(0)], totals: { cycleCount: 1 } } },
    voltageMonitors: { v1: { id: 'v1', name: 'V', deviceId: 'v', deviceName: 'V', minVoltage: 200, maxVoltage: 240, periods: [voltagePeriod(0)] } },
    groups: {}
  };
  const settings = homeySettings({ sentinels: legacy });
  const store = new SentinelStore(settings);
  await store.load();
  assert.equal(store.migratedFrom, 'single blob');
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v2']);
  const reloaded = new SentinelStore(settings);
  await reloaded.load();
  assert.deepEqual(reloaded.data.monitors.m1.periods, legacy.monitors.m1.periods);
  assert.deepEqual(reloaded.data.monitors.m1.cycles, legacy.monitors.m1.cycles);
  assert.deepEqual(reloaded.data.voltageMonitors.v1.periods, legacy.voltageMonitors.v1.periods);
});

test('the per-monitor-keys layout is migrated to the versioned key and its keys removed', async () => {
  const { encodeRows: enc } = require('../lib/storage-format');
  const meta = {
    monitors: { m1: { id: 'm1', name: 'Pump', deviceId: 'a', deviceName: 'Pump', capability: 'measure_power', threshold: 50, totals: { cycleCount: 1 } } },
    voltageMonitors: { v1: { id: 'v1', name: 'V', deviceId: 'v', deviceName: 'V', minVoltage: 200, maxVoltage: 240 } },
    groups: {}
  };
  const settings = homeySettings({
    'sentinels:meta': meta,
    'sentinels:periods:m1': { periods: enc('activityPeriod', [activityPeriod(0)]), cycles: enc('cycle', [cycle(0)]) },
    'sentinels:periods:v1': { periods: enc('voltagePeriod', [voltagePeriod(0), voltagePeriod(1)]) },
    'sentinels:periods:ghost': { periods: [] }
  });
  const store = new SentinelStore(settings);
  await store.load();
  assert.equal(store.migratedFrom, 'per-monitor keys');
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v2']);
  assert.equal(store.data.monitors.m1.periods.length, 1);
  assert.equal(store.data.voltageMonitors.v1.periods.length, 2);
});

test('a failed write surfaces to the caller and the next save retries it', async () => {
  const settings = homeySettings();
  const { store, volt } = await populatedStore(settings);
  const realSet = settings.set;
  let failNext = true;
  settings.set = async (key, value) => { if (failNext) { failNext = false; throw new Error('disk'); } return realSet(key, value); };
  await assert.rejects(store.save(), /disk/);
  await store.save();
  const reloaded = new SentinelStore(settings);
  await reloaded.load();
  assert.equal(reloaded.data.voltageMonitors[volt.id].periods.length, 100);
});

test('store.revision changes on every save so cached summaries can be dropped', async () => {
  const settings = homeySettings();
  const { store } = await populatedStore(settings);
  const before = store.revision;
  await store.save();
  assert.equal(store.revision, before + 1);
});

test('the old default "turned off" message (with an em dash) is migrated to the ASCII default; a customised one is left alone', async () => {
  const oldDefault = '%monitor% turned off \u2014 %duration_human%, %energy% kWh (%count% today)';
  const settings = homeySettings({ sentinels: { monitors: {
    a: { id: 'a', name: 'A', deviceId: 'x', deviceName: 'A', capability: 'measure_power', threshold: 5, messageTemplateFinished: oldDefault },
    b: { id: 'b', name: 'B', deviceId: 'y', deviceName: 'B', capability: 'measure_power', threshold: 5, messageTemplateFinished: 'B stopped \u2014 custom' }
  }, groups: {}, voltageMonitors: {}, eventLog: [{ timestamp: 1, message: 'Pump turned off \u2014 5 min' }] } });
  const store = new SentinelStore(settings);
  await store.load();
  assert.equal(store.data.monitors.a.messageTemplateFinished, '%monitor% turned off - %duration_human%, %energy% kWh (%count% today)');
  assert.equal(store.data.monitors.b.messageTemplateFinished, 'B stopped \u2014 custom');
  assert.equal(store.data.eventLog[0].message, 'Pump turned off - 5 min');
});

test('metaStats reports the size and whether any stored text is above Latin-1', async () => {
  const settings = homeySettings();
  const { store, activity } = await populatedStore(settings);
  assert.equal(store.metaStats().twoByte, false); // 'poço' is Latin-1
  activity.name = 'Pump \u2014 well';
  assert.equal(store.metaStats().twoByte, true);
});
