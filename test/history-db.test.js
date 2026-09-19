'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SentinelStore = require('../lib/store');
const { openHistoryDb } = require('../lib/history-db');

function homeySettings(initial = {}) {
  const data = {};
  for (const [key, value] of Object.entries(initial)) data[key] = JSON.stringify(value);
  const calls = { set: [], unset: [] };
  return {
    calls, raw: data,
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

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinels-db-'));
  return { file: path.join(dir, 'history.sqlite'), dir };
}

async function populated(settings, history) {
  const store = new SentinelStore(settings, { history });
  await store.load();
  const activity = store.createMonitor({ device: { id: 'a', name: 'Bomba do poço' }, threshold: 50 });
  activity.periods = Array.from({ length: 50 }, (_, i) => activityPeriod(i));
  activity.cycles = [cycle(0), cycle(1)];
  const volt = store.createVoltageMonitor({ device: { id: 'v', name: 'Volt A' }, minVoltage: 200, maxVoltage: 240 });
  volt.periods = Array.from({ length: 100 }, (_, i) => voltagePeriod(i));
  return { store, activity, volt };
}

// counts the rows the store writes, by wrapping the database's transaction api
function countWrites(history) {
  const counts = { upsert: 0, clear: 0, dropMonitor: 0 };
  const realTransaction = history.transaction.bind(history);
  history.transaction = (work) => realTransaction((db) => work({
    upsert: (...a) => { counts.upsert += 1; return db.upsert(...a); },
    clear: (...a) => { counts.clear += 1; return db.clear(...a); },
    dropMonitor: (...a) => { counts.dropMonitor += 1; return db.dropMonitor(...a); }
  }));
  return counts;
}

test('the history database opens with WAL and reports null when it cannot be opened', () => {
  const { file } = tempDb();
  const logs = [];
  const db = openHistoryDb(file, { log: (m) => logs.push(m) });
  assert.ok(db);
  db.close();
  assert.equal(openHistoryDb('/nonexistent-dir/x/history.sqlite', { log: (m) => logs.push(m) }), null);
  assert.ok(logs.some((m) => m.includes('unavailable')));
});

test('series round-trip through the database and settings hold only the small meta', async () => {
  const { file } = tempDb();
  const settings = homeySettings();
  const history = openHistoryDb(file);
  const { store, activity, volt } = await populated(settings, history);
  await store.save();
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v3']);
  assert.ok(settings.raw['sentinels:v3'].length < 6000);
  history.close();
  const reopened = openHistoryDb(file);
  const reloaded = new SentinelStore(settings, { history: reopened });
  await reloaded.load();
  assert.equal(reloaded.migratedFrom, null);
  assert.deepEqual(reloaded.data.monitors[activity.id].periods, activity.periods);
  assert.deepEqual(reloaded.data.monitors[activity.id].cycles, activity.cycles);
  assert.deepEqual(reloaded.data.voltageMonitors[volt.id].periods, volt.periods);
  reopened.close();
});

test('a save writes only the changed tail rows, and nothing when nothing changed', async () => {
  const history = openHistoryDb(':memory:');
  const settings = homeySettings();
  const { store, volt, activity } = await populated(settings, history);
  await store.save();
  const counts = countWrites(history);
  settings.calls.set.length = 0;
  await store.save();
  assert.deepEqual(counts, { upsert: 0, clear: 0, dropMonitor: 0 });
  assert.deepEqual(settings.calls.set, []);
  // the engine extends the last period in place, then a new one is appended
  const last = volt.periods[volt.periods.length - 1];
  last.endedAt += 60000; last.seconds += 60; last.sampleCount += 12;
  await store.save();
  assert.deepEqual(counts, { upsert: 1, clear: 0, dropMonitor: 0 });
  volt.periods.push(voltagePeriod(500));
  activity.periods.push(activityPeriod(99));
  await store.save();
  assert.equal(counts.upsert, 1 + 2 + 2); // the re-written last row plus the new one, for each of the two series
  assert.equal(counts.clear, 0);
});

test('folding, reset and consolidation rewrite the affected series and stay correct', async () => {
  const history = openHistoryDb(':memory:');
  const settings = homeySettings();
  const { store, activity, volt } = await populated(settings, history);
  await store.save();
  activity.periods = activity.periods.slice(10); // old periods folded away from the front
  await store.save();
  let reloaded = new SentinelStore(settings, { history });
  await reloaded.load();
  assert.equal(reloaded.data.monitors[activity.id].periods.length, 40);
  assert.deepEqual(reloaded.data.monitors[activity.id].periods, activity.periods);
  store.resetMonitor(activity);
  await store.save();
  reloaded = new SentinelStore(settings, { history });
  await reloaded.load();
  assert.deepEqual(reloaded.data.monitors[activity.id].periods, []);
  assert.deepEqual(reloaded.data.monitors[activity.id].cycles, []);
  assert.deepEqual(reloaded.data.voltageMonitors[volt.id].periods, volt.periods);
});

test('a rolled-back save is retried in full on the next one', async () => {
  const history = openHistoryDb(':memory:');
  const settings = homeySettings();
  const { store, volt } = await populated(settings, history);
  await store.save();
  volt.periods.push(voltagePeriod(500));
  const realTransaction = history.transaction.bind(history);
  let fail = true;
  history.transaction = (work) => realTransaction((db) => { const result = work(db); if (fail) { fail = false; throw new Error('disk full'); } return result; });
  await assert.rejects(store.save(), /disk full/);
  await store.save();
  const reloaded = new SentinelStore(settings, { history });
  await reloaded.load();
  assert.equal(reloaded.data.voltageMonitors[volt.id].periods.length, 101);
});

test('deleting a monitor removes its rows, and orphan rows are cleaned on load', async () => {
  const history = openHistoryDb(':memory:');
  const settings = homeySettings();
  const { store, volt } = await populated(settings, history);
  await store.save();
  assert.ok(history.monitors().includes(volt.id));
  store.deleteVoltageMonitor(volt.id);
  await store.save();
  assert.equal(history.monitors().includes(volt.id), false);
  history.transaction((db) => db.upsert('ghost', 'p', 0, [1, 2]));
  const reloaded = new SentinelStore(settings, { history });
  await reloaded.load();
  assert.equal(history.monitors().includes('ghost'), false);
});

test('a v2 store (series inside the settings key) is migrated into the database', async () => {
  const { encodeRows } = require('../lib/storage-format');
  const meta = {
    monitors: { m1: { id: 'm1', name: 'Pump', deviceId: 'a', deviceName: 'Pump', capability: 'measure_power', threshold: 50, totals: { cycleCount: 1 } } },
    voltageMonitors: { v1: { id: 'v1', name: 'V', deviceId: 'v', deviceName: 'V', minVoltage: 200, maxVoltage: 240 } },
    groups: {}
  };
  const settings = homeySettings({ 'sentinels:v2': { schemaVersion: 2, meta, series: {
    m1: { periods: encodeRows('activityPeriod', [activityPeriod(0), activityPeriod(1)]), cycles: encodeRows('cycle', [cycle(0)]) },
    v1: { periods: encodeRows('voltagePeriod', [voltagePeriod(0)]) }
  } } });
  const history = openHistoryDb(':memory:');
  const store = new SentinelStore(settings, { history });
  await store.load();
  assert.match(store.migratedFrom, /history database/);
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v3']);
  const reloaded = new SentinelStore(settings, { history });
  await reloaded.load();
  assert.equal(reloaded.data.monitors.m1.periods.length, 2);
  assert.deepEqual(reloaded.data.monitors.m1.cycles, [cycle(0)]);
  assert.deepEqual(reloaded.data.voltageMonitors.v1.periods, [voltagePeriod(0)]);
});

test('the original single blob migrates straight into the database', async () => {
  const legacy = {
    monitors: { m1: { id: 'm1', name: 'Pump', deviceId: 'a', deviceName: 'Pump', capability: 'measure_power', threshold: 50, periods: [activityPeriod(0)], cycles: [cycle(0)], totals: { cycleCount: 1 } } },
    voltageMonitors: {}, groups: {}
  };
  const settings = homeySettings({ sentinels: legacy });
  const history = openHistoryDb(':memory:');
  const store = new SentinelStore(settings, { history });
  await store.load();
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v3']);
  assert.deepEqual(history.load('m1', 'p').length, 1);
});

test('without a database the store falls back to the settings key, and a v3 store loses its history but keeps its meta', async () => {
  const history = openHistoryDb(':memory:');
  const settings = homeySettings();
  const { store, activity } = await populated(settings, history);
  await store.save();
  const noDb = new SentinelStore(settings, { history: null });
  await noDb.load();
  assert.ok(noDb.warnings.length > 0);
  assert.equal(noDb.data.monitors[activity.id].name, 'Bomba do poço');
  assert.deepEqual(noDb.data.monitors[activity.id].periods, []);
  assert.deepEqual(Object.keys(settings.raw), ['sentinels:v2']);
});

test('a damaged database file is moved aside and a new one is started', () => {
  const { file, dir } = tempDb();
  fs.writeFileSync(file, 'this is not a sqlite database at all, just some text that is long enough to be read as a header'.repeat(20));
  const logs = [];
  const db = openHistoryDb(file, { log: (m) => logs.push(m) });
  assert.ok(db);
  db.close();
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
  assert.ok(logs.some((m) => m.includes('damaged')));
});

test('incremental writes keep the database identical to a full rewrite across many engine-like steps', async () => {
  const history = openHistoryDb(':memory:');
  const settings = homeySettings();
  const { store, volt, activity } = await populated(settings, history);
  await store.save();
  for (let step = 0; step < 60; step += 1) {
    const last = volt.periods[volt.periods.length - 1];
    if (step % 5 === 0) volt.periods.push(voltagePeriod(200 + step));
    else { last.endedAt += 1000; last.seconds += 1; last.sampleCount += 1; last.minVoltage = Math.min(last.minVoltage, 210 + (step % 3)); }
    if (step % 7 === 0) activity.periods.push(activityPeriod(300 + step));
    if (step % 11 === 0) activity.cycles.push(cycle(50 + step));
    if (step === 30) activity.periods = activity.periods.slice(5);
    await store.save();
  }
  const reloaded = new SentinelStore(settings, { history });
  await reloaded.load();
  assert.deepEqual(reloaded.data.voltageMonitors[volt.id].periods, volt.periods);
  assert.deepEqual(reloaded.data.monitors[activity.id].periods, activity.periods);
  assert.deepEqual(reloaded.data.monitors[activity.id].cycles, activity.cycles);
});

test('sizeBytes counts the WAL, and a checkpoint moves the data into the main file', async () => {
  const { file } = tempDb();
  const history = openHistoryDb(file);
  const settings = homeySettings();
  await populated(settings, history).then(({ store }) => store.save());
  const before = history.sizeBytes();
  assert.ok(before > 4096, `expected data to be counted, got ${before}`);
  assert.equal(history.checkpoint(), true);
  assert.equal(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0, 0);
  assert.ok(fs.statSync(file).size > 4096);
  history.close();
  assert.equal(history.checkpoint(), false); // closed: reports failure instead of throwing
});
