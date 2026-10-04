'use strict';
// A monitor's history from before it existed is estimated from Homey's Insights by replaying the live detection rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const activity = require('../lib/app/activity');
const { replayInsights, applyBackfill, liveHistoryStart } = require('../lib/insights-replay');
const { ActivityEngine } = require('../lib/activity-engine');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

// One reading every 10 minutes for `days` days; each day the device runs at 500 W from 08:00 for two hours, otherwise 2 W.
function sevenDays(days = 7, end = NOW) {
  const entries = [];
  for (let t = end - days * DAY; t < end; t += 10 * MINUTE) {
    const minuteOfDay = ((t % DAY) + DAY) % DAY / MINUTE;
    entries.push({ timestamp: t, value: minuteOfDay >= 8 * 60 && minuteOfDay < 10 * 60 ? 500 : 2 });
  }
  return entries;
}

async function fakeStore() {
  const saved = {};
  const settings = { get: (key) => saved[key], set: async (key, value) => { saved[key] = value; }, unset: (key) => { delete saved[key]; } };
  const store = new SentinelStore(settings);
  await store.load();
  const { monitor } = store.upsertMonitor({ device: { id: 'pump', name: 'Pump' }, name: 'Bomba', threshold: 40 });
  return { store, monitor, settings, saved };
}

test('replay finds one cycle a day with about 1 kWh each and leaves nothing open', async () => {
  const { monitor } = await fakeStore();
  const result = replayInsights(monitor, sevenDays(), NOW);
  assert.equal(result.cycles.length, 7);
  for (const cycle of result.cycles) {
    assert.ok(Math.abs(cycle.duration - 2 * 3600) <= 10 * 60, `duration ${cycle.duration}`);
    assert.ok(cycle.energy > 0.9 && cycle.energy < 1.2, `energy ${cycle.energy}`);
  }
  assert.equal(result.totals.cycleCount, 7);
  assert.ok(result.totals.activeSeconds > 6 * 2 * 3600 && result.totals.activeSeconds < 8 * 2 * 3600);
  assert.equal(monitor.cycles.length, 0); // the real monitor is untouched by a replay
});

test('readings at or after where the live history starts are not used', async () => {
  const { monitor } = await fakeStore();
  const cutoff = NOW - 3 * DAY;
  const result = replayInsights(monitor, sevenDays(), cutoff);
  assert.equal(result.cycles.length, 4);
  assert.ok(result.to < cutoff);
  assert.ok(result.periods.every((period) => period.endedAt < cutoff));
});

test('a cycle still running at the last reading is left for the live listener', async () => {
  const { monitor } = await fakeStore();
  const entries = [{ timestamp: NOW - 40 * MINUTE, value: 2 }, { timestamp: NOW - 30 * MINUTE, value: 500 }, { timestamp: NOW - 20 * MINUTE, value: 500 }, { timestamp: NOW - 10 * MINUTE, value: 500 }];
  const result = replayInsights(monitor, entries, NOW);
  assert.equal(result.cycles.length, 0);
});

test('the monitor settings decide: a higher threshold sees nothing, continuity bridges a pause', async () => {
  const { monitor } = await fakeStore();
  monitor.threshold = 800;
  assert.equal(replayInsights(monitor, sevenDays(), NOW).cycles.length, 0);
  monitor.threshold = 40;
  const withPause = [];
  for (let i = 0; i < 12; i += 1) withPause.push({ timestamp: NOW - DAY + i * 10 * MINUTE, value: i === 5 ? 2 : 500 });
  for (let i = 12; i < 16; i += 1) withPause.push({ timestamp: NOW - DAY + i * 10 * MINUTE, value: 2 });
  assert.equal(replayInsights(monitor, withPause, NOW).cycles.length, 2);
  monitor.continuityMinutes = 15;
  assert.equal(replayInsights(monitor, withPause, NOW).cycles.length, 1);
});

test('applyBackfill puts the rows in front of the live ones, adds the totals and remembers it happened', async () => {
  const { monitor } = await fakeStore();
  const engine = new ActivityEngine();
  const liveStart = NOW - 2 * DAY;
  engine.processSample(monitor, { power: 2, timestamp: liveStart });
  engine.processSample(monitor, { power: 500, timestamp: liveStart + 30 * MINUTE });
  engine.processSample(monitor, { power: 500, timestamp: liveStart + 150 * MINUTE });
  engine.processSample(monitor, { power: 2, timestamp: liveStart + 160 * MINUTE });
  engine.processSample(monitor, { power: 2, timestamp: liveStart + 170 * MINUTE });
  assert.equal(monitor.cycles.length, 1);
  const liveCycle = monitor.cycles[0];
  const livePeriods = monitor.periods.length;
  assert.equal(liveHistoryStart(monitor, NOW), liveStart);

  const result = applyBackfill(monitor, sevenDays(), { now: NOW, resolution: 'last7Days' });
  assert.equal(result.applied, true);
  assert.equal(monitor.cycles.length, 1 + 5);
  assert.deepEqual(monitor.cycles.at(-1), liveCycle);
  assert.ok(monitor.cycles.slice(0, -1).every((cycle) => cycle.endedAt < liveStart));
  assert.ok(monitor.periods.length > livePeriods);
  assert.equal(monitor.periods.at(-1).startedAt >= liveStart, true);
  for (let i = 1; i < monitor.cycles.length; i += 1) assert.ok(monitor.cycles[i].startedAt > monitor.cycles[i - 1].startedAt);
  assert.equal(monitor.totals.cycleCount, 1 + 1 + 5 - 1); // live: 1 started; replay: 5
  assert.equal(monitor.insightsBackfill.cycles, 5);
  assert.throws(() => applyBackfill(monitor, sevenDays(), { now: NOW }), /already has history rebuilt/);
});

test('nothing to add leaves the monitor unmarked', async () => {
  const { monitor } = await fakeStore();
  const result = applyBackfill(monitor, [{ timestamp: NOW - DAY, value: 2 }], { now: NOW });
  assert.equal(result.applied, false);
  assert.equal(monitor.insightsBackfill, undefined);
});

test('Reset drops the rebuilt history and allows another rebuild', async () => {
  const { store, monitor } = await fakeStore();
  applyBackfill(monitor, sevenDays(), { now: NOW });
  assert.ok(monitor.insightsBackfill);
  store.resetMonitor(monitor);
  assert.equal(monitor.insightsBackfill, undefined);
  assert.equal(monitor.cycles.length, 0);
  assert.equal(applyBackfill(monitor, sevenDays(), { now: NOW }).applied, true);
});

test('the rebuilt history and the marker survive a save and a load', async () => {
  const { store, monitor, settings } = await fakeStore();
  applyBackfill(monitor, sevenDays(), { now: NOW, resolution: 'last7Days' });
  store.invalidateSeries();
  await store.save();
  const again = new SentinelStore(settings);
  await again.load();
  const loaded = again.data.monitors[monitor.id];
  assert.equal(loaded.cycles.length, 7);
  assert.equal(loaded.insightsBackfill.cycles, 7);
  assert.equal(loaded.periods.length, monitor.periods.length);
});

async function fakeApp(entriesOrError) {
  const { store, monitor } = await fakeStore();
  const logs = [];
  const app = Object.assign({
    store, logs, log: (message) => logs.push(message),
    gateway: { async getInsightEntries() { if (entriesOrError instanceof Error) throw entriesOrError; return entriesOrError; } }
  }, activity);
  return { app, monitor };
}

test('rebuildHistoryFromInsights reports what it added and logs it', async () => {
  const { app, monitor } = await fakeApp(sevenDays(7, Date.now()));
  const result = await app.rebuildHistoryFromInsights(monitor);
  assert.equal(result.cycles, 7);
  assert.match(app.logs.at(-1), /history rebuilt from Homey Insights \(last7Days\).*7 cycles/);
  await assert.rejects(() => app.rebuildHistoryFromInsights(monitor), /already has history rebuilt/);
});

test('rebuildHistoryFromInsights says why nothing happened', async () => {
  const none = await fakeApp([]);
  await assert.rejects(() => none.app.rebuildHistoryFromInsights(none.monitor), /no readings from before/);
  const broken = await fakeApp(new Error('Not Found: log'));
  await assert.rejects(() => broken.app.rebuildHistoryFromInsights(broken.monitor), /no usable history for this device \(Not Found: log\)/);
  const manual = await fakeApp([]);
  manual.monitor.mode = 'manual';
  await assert.rejects(() => manual.app.rebuildHistoryFromInsights(manual.monitor), /Only monitors that decide by a power threshold/);
  const deleted = await fakeApp(sevenDays(7, Date.now()));
  delete deleted.app.store.data.monitors[deleted.monitor.id];
  await assert.rejects(() => deleted.app.rebuildHistoryFromInsights(deleted.monitor), /deleted meanwhile/);
});
