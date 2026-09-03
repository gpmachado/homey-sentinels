'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');

function fakeSettings() { const data = {}; return { get: (key) => data[key], set: async (key, value) => { data[key] = value; } }; }

test('resetMonitor wipes cycles/periods/totals/live state but keeps device, capability, threshold and name', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50, continuityMinutes: 5 });
  monitor.cycles = [{ startedAt: 0, endedAt: 1000, duration: 1 }];
  monitor.periods = [{ startedAt: 0, endedAt: 1000, state: 'ACTIVE', seconds: 1 }];
  monitor.totals = { cycleCount: 3, activeSeconds: 900, standbySeconds: 100, activeEnergy: 1.2, standbyEnergy: 0.1 };
  monitor.state = 'ACTIVE'; monitor.activeSince = 500; monitor.lastSample = { power: 999, timestamp: 500 };
  store.resetMonitor(monitor);
  assert.deepEqual(monitor.cycles, []);
  assert.deepEqual(monitor.periods, []);
  assert.equal(monitor.totals.cycleCount, 0);
  assert.equal(monitor.state, 'STANDBY');
  assert.equal(monitor.activeSince, null);
  assert.equal(monitor.lastSample, null);
  // configuration untouched
  assert.equal(monitor.deviceId, 'dev-1');
  assert.equal(monitor.threshold, 50);
  assert.equal(monitor.continuityMinutes, 5);
  assert.equal(monitor.name, 'Freezer');
});

test('resetVoltageMonitor wipes periods/events/live state but keeps range and message templates', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  store.updateVoltageMonitor(monitor, { messageTemplateUndervoltage: '%monitor% low' });
  monitor.periods = [{ startedAt: 0, endedAt: 1000, voltage: 999 }];
  monitor.events = [{ type: 'UNDERVOLTAGE', startedAt: 0, endedAt: 1000, duration: 1 }];
  monitor.state = 'UNDERVOLTAGE'; monitor.eventSince = 0; monitor.lastSample = { voltage: 999, timestamp: 0 };
  store.resetVoltageMonitor(monitor);
  assert.deepEqual(monitor.periods, []);
  assert.deepEqual(monitor.events, []);
  assert.equal(monitor.state, 'NORMAL');
  assert.equal(monitor.eventSince, null);
  assert.equal(monitor.lastSample, null);
  // configuration untouched
  assert.equal(monitor.minVoltage, 110);
  assert.equal(monitor.maxVoltage, 130);
  assert.equal(monitor.messageTemplateUndervoltage, '%monitor% low');
});

test('creates a monitor with a custom capability, defaulting to measure_power', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Bomba' }, threshold: 100 });
  assert.equal(monitor.capability, 'measure_power');
  const other = store.createMonitor({ device: { id: 'dev-2', name: 'Freezer' }, threshold: 50, capability: 'measure_current' });
  assert.equal(other.capability, 'measure_current');
});

test('createMonitor without a threshold falls back to DEFAULT_ACTIVITY_THRESHOLD and flags the monitor as calibrating', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Forno' } });
  assert.equal(monitor.threshold, 40);
  assert.equal(monitor.calibrating, true);
});

test('createMonitor with an explicit threshold is not flagged as calibrating', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Bomba' }, threshold: 100 });
  assert.equal(monitor.threshold, 100);
  assert.equal(monitor.calibrating, false);
});

test('upsertMonitor re-run without a threshold does not reset an already-calibrated monitor back to calibrating', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { monitor: created } = store.upsertMonitor({ device: { id: 'dev-1', name: 'Forno' } });
  assert.equal(created.calibrating, true);
  created.threshold = 250;
  created.calibrating = false; // simulates _maybeAutoCalibrate finding a real value
  const { monitor: updated, created: wasCreatedAgain } = store.upsertMonitor({ device: { id: 'dev-1', name: 'Forno' } });
  assert.equal(wasCreatedAgain, false);
  assert.equal(updated.threshold, 250);
  assert.equal(updated.calibrating, false);
});

test('activity monitor message templates come pre-filled with a working default, editable via updateMonitorMessages', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Bomba' }, threshold: 100 });
  assert.match(monitor.messageTemplateStarted, /%monitor%/);
  assert.match(monitor.messageTemplateFinished, /%monitor%/);
  store.updateMonitorMessages(monitor, { messageTemplateFinished: '%monitor% desligou %count% vezes hoje' });
  assert.equal(monitor.messageTemplateFinished, '%monitor% desligou %count% vezes hoje');
  assert.equal(monitor.threshold, 100); // untouched by a messages-only update
});

test('state monitor message templates come pre-filled with a working default, editable via updateStateMonitorMessages', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact' });
  assert.match(monitor.messageTemplateStarted, /%monitor%/);
  assert.match(monitor.messageTemplateFinished, /%monitor%/);
  store.updateStateMonitorMessages(monitor, { messageTemplateStarted: '%monitor% is now %label%' });
  assert.equal(monitor.messageTemplateStarted, '%monitor% is now %label%');
});

test('upsertManualMonitor creates a mode "manual" monitor with no threshold, and reuses it on a second call for the same device', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { monitor: first, created: firstCreated } = store.upsertManualMonitor({ device: { id: 'dev-1', name: 'Bomba' } });
  assert.equal(firstCreated, true);
  assert.equal(first.mode, 'manual');
  assert.equal(first.threshold, null);
  assert.equal(first.capability, 'measure_power');
  const { monitor: second, created: secondCreated } = store.upsertManualMonitor({ device: { id: 'dev-1', name: 'Bomba' } });
  assert.equal(secondCreated, false);
  assert.equal(first, second);
});

test('upsertManualMonitor adopting a pre-existing threshold monitor forces it into mode "manual"', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const thresholdMonitor = store.createMonitor({ device: { id: 'dev-1', name: 'Poço' }, threshold: 50 });
  assert.equal(thresholdMonitor.mode, undefined);
  const { monitor: adopted, created } = store.upsertManualMonitor({ device: { id: 'dev-1', name: 'Poço' }, name: 'Bomba Hidraulica' });
  assert.equal(created, false);
  assert.equal(adopted.id, thresholdMonitor.id);
  assert.equal(adopted.mode, 'manual');
  assert.equal(adopted.threshold, null);
  assert.equal(adopted.name, 'Bomba Hidraulica');
});

test('allows a device to be monitored on two different capabilities but not the same one twice', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  store.createMonitor({ device: { id: 'dev-1', name: 'Poço' }, threshold: 100, capability: 'measure_power' });
  assert.doesNotThrow(() => store.createMonitor({ device: { id: 'dev-1', name: 'Poço' }, threshold: 5, capability: 'measure_current' }));
  assert.throws(() => store.createMonitor({ device: { id: 'dev-1', name: 'Poço' }, threshold: 200, capability: 'measure_power' }));
});

test('stores minConfirmationSeconds and rejects a negative value', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50, minConfirmationSeconds: 30 });
  assert.equal(monitor.minConfirmationSeconds, 30);
  assert.throws(() => store.createMonitor({ device: { id: 'dev-2', name: 'Bomba' }, threshold: 50, minConfirmationSeconds: -1 }));
});

test('upsertMonitor updates the threshold and minConfirmationSeconds in place instead of throwing on a duplicate', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { monitor: created, created: wasCreated } = store.upsertMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50, minConfirmationSeconds: 10 });
  assert.equal(wasCreated, true);
  const { monitor: updated, created: wasCreatedAgain } = store.upsertMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 80, minConfirmationSeconds: 20 });
  assert.equal(wasCreatedAgain, false);
  assert.equal(updated.id, created.id);
  assert.equal(updated.threshold, 80);
  assert.equal(updated.minConfirmationSeconds, 20);
});

test('upsertMonitor adopting a pre-existing manual monitor puts it back into threshold mode', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { monitor: manual } = store.upsertManualMonitor({ device: { id: 'dev-1', name: 'Poço' } });
  assert.equal(manual.mode, 'manual');
  const { monitor: adopted, created } = store.upsertMonitor({ device: { id: 'dev-1', name: 'Poço' }, threshold: 50 });
  assert.equal(created, false);
  assert.equal(adopted.id, manual.id);
  assert.equal(adopted.mode, undefined);
  assert.equal(adopted.threshold, 50);
});

test('creates a group with an initial device list and rejects a group without a name', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const group = store.createGroup({ name: 'Portas', type: 'contact', expectedState: false, devices: [{ id: 'd1', name: 'Porta 1' }, { id: 'd2', name: 'Porta 2' }] });
  assert.equal(group.devices.length, 2);
  assert.equal(group.expectedState, false);
  assert.throws(() => store.createGroup({ name: '  ', type: 'contact' }));
});

test('updates group metadata and replaces its device membership', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const group = store.createGroup({ name: 'Luzes', type: 'light', expectedState: true, devices: [{ id: 'd1', name: 'Luz 1' }, { id: 'd2', name: 'Luz 2' }] });
  store.updateGroup(group, { name: 'Luzes Externas', expectedState: false });
  assert.equal(group.name, 'Luzes Externas');
  assert.equal(group.expectedState, false);
  store.setGroupDevices(group, [{ id: 'd3', name: 'Luz 3' }]);
  assert.deepEqual(group.devices, [{ id: 'd3', name: 'Luz 3' }]);
});

test('deletes a group', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const group = store.createGroup({ name: 'Portas', type: 'contact', expectedState: false, devices: [{ id: 'd1' }, { id: 'd2' }] });
  store.deleteGroup(group.id);
  assert.equal(store.data.groups[group.id], undefined);
});

test('creates a voltage monitor, defaulting to measure_voltage, and rejects an inverted range', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  assert.equal(monitor.capability, 'measure_voltage');
  assert.ok(monitor.stabilizedAt > Date.now());
  assert.throws(() => store.createVoltageMonitor({ device: { id: 'dev-2', name: 'X' }, minVoltage: 130, maxVoltage: 110 }));
});

test('updates a voltage monitor range and rejects an inverted update', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  store.updateVoltageMonitor(monitor, { minVoltage: 115 });
  assert.equal(monitor.minVoltage, 115);
  assert.equal(monitor.maxVoltage, 130);
  assert.throws(() => store.updateVoltageMonitor(monitor, { maxVoltage: 100 }));
});

test('voltage monitor message templates default to empty and can be updated independently of the range', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  assert.equal(monitor.messageTemplateUndervoltage, '');
  assert.equal(monitor.messageTemplateOvervoltage, '');
  assert.equal(monitor.messageTemplateNormalized, '');
  store.updateVoltageMonitor(monitor, { messageTemplateUndervoltage: '%monitor% low: %voltage% V' });
  assert.equal(monitor.messageTemplateUndervoltage, '%monitor% low: %voltage% V');
  assert.equal(monitor.minVoltage, 110); // untouched by a messages-only update
});

test('deletes a voltage monitor', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  store.deleteVoltageMonitor(monitor.id);
  assert.equal(store.data.voltageMonitors[monitor.id], undefined);
});

test('consolidateHistory folds periods older than 7 days into a daily summary and drops the raw periods', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  monitor.periods = [
    { startedAt: tenDaysAgo, endedAt: tenDaysAgo + 60000, state: 'ACTIVE', seconds: 60, energy: 0.05, power: 200, current: 1 },
    { startedAt: tenDaysAgo + 60000, endedAt: tenDaysAgo + 120000, state: 'STANDBY', seconds: 60, energy: 0.01, power: 10, current: 0.1 },
    { startedAt: now - 60000, endedAt: now, state: 'ACTIVE', seconds: 60, energy: 0.02, power: 200, current: 1 } // within the last 7 days, stays raw
  ];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.periods.length, 1); // only the recent one remains granular
  assert.equal(monitor.dailySummaries.length, 1);
  const day = monitor.dailySummaries[0];
  assert.equal(day.activeSeconds, 60);
  assert.equal(day.standbySeconds, 60);
  assert.ok(Math.abs(day.activeEnergy - 0.05) < 1e-9);
  assert.ok(Math.abs(day.standbyEnergy - 0.01) < 1e-9);
});

test('consolidateHistory folds a meterReset flag into the daily summary', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  monitor.periods = [
    { startedAt: tenDaysAgo, endedAt: tenDaysAgo + 60000, state: 'ACTIVE', seconds: 60, energy: 0, power: 200, current: 1, meterReset: true },
    { startedAt: tenDaysAgo + 60000, endedAt: tenDaysAgo + 120000, state: 'ACTIVE', seconds: 60, energy: 0.02, power: 200, current: 1, meterReset: false }
  ];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.dailySummaries[0].meterResetCount, 1);
});

test('consolidateHistory merges into an existing daily summary instead of duplicating it', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  monitor.periods = [{ startedAt: tenDaysAgo, endedAt: tenDaysAgo + 60000, state: 'ACTIVE', seconds: 60, energy: 0.05, power: 200, current: 1 }];
  store.consolidateHistory('UTC', now);
  monitor.periods = [{ startedAt: tenDaysAgo + 120000, endedAt: tenDaysAgo + 180000, state: 'ACTIVE', seconds: 60, energy: 0.05, power: 200, current: 1 }];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.dailySummaries.length, 1);
  assert.equal(monitor.dailySummaries[0].activeSeconds, 120);
});

test('consolidateHistory splits a period that crosses local midnight instead of crediting it all to the start day', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  // 22:00 -> 02:00 São Paulo local time (UTC-3), well over 7 days before `now`: starts on day N, ends on day N+1.
  const start = Date.parse('2026-08-19T01:00:00Z'); // 2026-08-18 22:00 local
  const end = Date.parse('2026-08-19T05:00:00Z'); // 2026-08-19 02:00 local, 4h later
  monitor.periods = [{ startedAt: start, endedAt: end, state: 'ACTIVE', seconds: 4 * 60 * 60, energy: 0.4, power: 200, current: 1 }];
  store.consolidateHistory('America/Sao_Paulo', now);
  assert.equal(monitor.dailySummaries.length, 2);
  const day18 = monitor.dailySummaries.find((d) => d.date === '2026-08-18');
  const day19 = monitor.dailySummaries.find((d) => d.date === '2026-08-19');
  assert.equal(day18.activeSeconds, 2 * 60 * 60); // 22:00-00:00
  assert.equal(day19.activeSeconds, 2 * 60 * 60); // 00:00-02:00
  assert.ok(Math.abs(day18.activeEnergy - 0.2) < 1e-9); // half the energy, proportional to time
  assert.ok(Math.abs(day19.activeEnergy - 0.2) < 1e-9);
});

test('consolidateHistory drops daily summaries past the 90-day total retention', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createMonitor({ device: { id: 'dev-1', name: 'Freezer' }, threshold: 50 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  monitor.dailySummaries = [{ date: '2026-01-01', activeSeconds: 10, standbySeconds: 10, activeEnergy: 0, standbyEnergy: 0 }];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.dailySummaries.length, 0);
});

test('consolidateHistory folds old voltage periods into a min/max-only daily summary and drops the raw periods', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  monitor.periods = [
    { startedAt: tenDaysAgo, endedAt: tenDaysAgo + 60000, voltage: 118 },
    { startedAt: tenDaysAgo + 60000, endedAt: tenDaysAgo + 120000, voltage: 121 },
    { startedAt: now - 60000, endedAt: now, voltage: 119 } // within the last 7 days, stays raw
  ];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.periods.length, 1);
  assert.equal(monitor.dailySummaries.length, 1);
  assert.equal(monitor.dailySummaries[0].minVoltage, 118);
  assert.equal(monitor.dailySummaries[0].maxVoltage, 121);
});

test('consolidateHistory merges a new voltage daily summary into an existing one by widening the min/max', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createVoltageMonitor({ device: { id: 'dev-1', name: 'Shelly 3EM' }, minVoltage: 110, maxVoltage: 130 });
  const now = Date.parse('2026-08-29T12:00:00Z');
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  monitor.periods = [{ startedAt: tenDaysAgo, endedAt: tenDaysAgo + 60000, voltage: 120 }];
  store.consolidateHistory('UTC', now);
  monitor.periods = [{ startedAt: tenDaysAgo + 120000, endedAt: tenDaysAgo + 180000, voltage: 105 }];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.dailySummaries.length, 1);
  assert.equal(monitor.dailySummaries[0].minVoltage, 105);
  assert.equal(monitor.dailySummaries[0].maxVoltage, 120);
});

test('creates a binary counter and rejects one with no name', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const counter = store.createBinaryCounter({ name: 'Campainha' });
  assert.equal(counter.name, 'Campainha');
  assert.equal(counter.totalCount, 0);
  assert.deepEqual(counter.dailyCounts, []);
  assert.throws(() => store.createBinaryCounter({ name: '  ' }));
});

test('upsertBinaryCounter matches by name (case-insensitive) instead of creating a duplicate', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { counter: first, created: firstCreated } = store.upsertBinaryCounter({ name: 'Campainha' });
  assert.equal(firstCreated, true);
  const { counter: second, created: secondCreated } = store.upsertBinaryCounter({ name: 'campainha' });
  assert.equal(secondCreated, false);
  assert.equal(second.id, first.id);
  assert.equal(Object.keys(store.data.binaryCounters).length, 1);
});

test('recordBinaryEvent bumps the total and the same day bucket for repeat events on one day', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const counter = store.createBinaryCounter({ name: 'Campainha' });
  const t1 = Date.parse('2026-08-29T10:00:00Z');
  const t2 = Date.parse('2026-08-29T15:00:00Z'); // same UTC day
  const todayCount1 = store.recordBinaryEvent(counter, t1, 'UTC');
  const todayCount2 = store.recordBinaryEvent(counter, t2, 'UTC');
  assert.equal(todayCount1, 1);
  assert.equal(todayCount2, 2);
  assert.equal(counter.totalCount, 2);
  assert.equal(counter.dailyCounts.length, 1);
  assert.equal(counter.dailyCounts[0].count, 2);
  assert.equal(counter.lastEventAt, t2);
});

test('recordBinaryEvent opens a new day bucket for an event on a different calendar day', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const counter = store.createBinaryCounter({ name: 'Campainha' });
  store.recordBinaryEvent(counter, Date.parse('2026-08-29T10:00:00Z'), 'UTC');
  store.recordBinaryEvent(counter, Date.parse('2026-08-30T10:00:00Z'), 'UTC');
  assert.equal(counter.dailyCounts.length, 2);
  assert.equal(counter.totalCount, 2);
});

test('resetBinaryCounter wipes counts and last-event but keeps name and message template', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const counter = store.createBinaryCounter({ name: 'Campainha' });
  store.updateBinaryCounter(counter, { messageTemplate: '%counter% tocou %count% vezes hoje' });
  store.recordBinaryEvent(counter, Date.now(), 'UTC');
  store.resetBinaryCounter(counter);
  assert.equal(counter.totalCount, 0);
  assert.deepEqual(counter.dailyCounts, []);
  assert.equal(counter.lastEventAt, null);
  assert.equal(counter.name, 'Campainha');
  assert.equal(counter.messageTemplate, '%counter% tocou %count% vezes hoje');
});

test('creates a state monitor with mode "state", default true/false labels, no threshold', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact' });
  assert.equal(monitor.mode, 'state');
  assert.equal(monitor.trueLabel, 'True');
  assert.equal(monitor.falseLabel, 'False');
  assert.equal(monitor.capability, 'alarm_contact');
  assert.equal(monitor.threshold, undefined);
});
test('creates a state monitor with custom true/false labels', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact', trueLabel: 'Open', falseLabel: 'Closed' });
  assert.equal(monitor.trueLabel, 'Open');
  assert.equal(monitor.falseLabel, 'Closed');
});

test('rejects a state monitor with no capability selected', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  assert.throws(() => store.createStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: '' }));
});

test('upsertStateMonitor updates labels in place instead of throwing on a duplicate device+capability', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { monitor: first, created: firstCreated } = store.upsertStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact', trueLabel: 'Open' });
  const { monitor: second, created: secondCreated } = store.upsertStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact', trueLabel: 'Detected' });
  assert.equal(firstCreated, true);
  assert.equal(secondCreated, false);
  assert.equal(first, second);
  assert.equal(second.trueLabel, 'Detected');
});

test('resetStateMonitor wipes cycles/periods/totals/live state but keeps device, capability and labels', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact', trueLabel: 'Open', falseLabel: 'Closed' });
  monitor.cycles = [{ startedAt: 0, endedAt: 1000, duration: 1 }];
  monitor.periods = [{ startedAt: 0, endedAt: 1000, state: 'ACTIVE', seconds: 1 }];
  monitor.totals = { cycleCount: 3, activeSeconds: 900, standbySeconds: 100 };
  monitor.state = 'ACTIVE'; monitor.activeSince = 500; monitor.lastSample = { power: 1, timestamp: 500 };
  store.resetStateMonitor(monitor);
  assert.deepEqual(monitor.cycles, []);
  assert.equal(monitor.totals.cycleCount, 0);
  assert.equal(monitor.state, 'STANDBY');
  assert.equal(monitor.lastSample, null);
  assert.equal(monitor.deviceId, 'dev-1');
  assert.equal(monitor.capability, 'alarm_contact');
  assert.equal(monitor.trueLabel, 'Open');
  assert.equal(monitor.falseLabel, 'Closed');
  assert.equal(monitor.totals.activeEnergy, 0);
  assert.equal(monitor.totals.standbyEnergy, 0);
});

test('createStateMonitor with activeValues stores them; without, defaults to null (plain boolean behavior)', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const enumMonitor = store.createStateMonitor({ device: { id: 'dev-1', name: 'Washer' }, capability: 'DEVICE-state', activeValues: ['Running', 'Rinse'] });
  assert.deepEqual(enumMonitor.activeValues, ['Running', 'Rinse']);
  const boolMonitor = store.createStateMonitor({ device: { id: 'dev-2', name: 'Garage door' }, capability: 'alarm_contact' });
  assert.equal(boolMonitor.activeValues, null);
});

test('createStateMonitor stores auxiliaryCapabilities as given, defaulting to an empty array', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const withPower = store.createStateMonitor({ device: { id: 'dev-1', name: 'Washer' }, capability: 'DEVICE-state', activeValues: ['Running'], auxiliaryCapabilities: ['measure_power', 'meter_power'] });
  assert.deepEqual(withPower.auxiliaryCapabilities, ['measure_power', 'meter_power']);
  const plain = store.createStateMonitor({ device: { id: 'dev-2', name: 'Garage door' }, capability: 'alarm_contact' });
  assert.deepEqual(plain.auxiliaryCapabilities, []);
});

test('upsertStateMonitor updates activeValues in place without resetting live state, and leaves it untouched when omitted', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const { monitor: created } = store.upsertStateMonitor({ device: { id: 'dev-1', name: 'Washer' }, capability: 'DEVICE-state', activeValues: ['Running'] });
  created.state = 'ACTIVE'; created.cycles = [{ startedAt: 0, endedAt: 1000, duration: 1 }];
  const { monitor: updated, created: wasCreatedAgain } = store.upsertStateMonitor({ device: { id: 'dev-1', name: 'Washer' }, capability: 'DEVICE-state', activeValues: ['Running', 'Rinse'] });
  assert.equal(wasCreatedAgain, false);
  assert.deepEqual(updated.activeValues, ['Running', 'Rinse']);
  assert.equal(updated.state, 'ACTIVE'); // live state untouched by the upsert
  assert.equal(updated.cycles.length, 1);
  const { monitor: unchanged } = store.upsertStateMonitor({ device: { id: 'dev-1', name: 'Washer' }, capability: 'DEVICE-state' });
  assert.deepEqual(unchanged.activeValues, ['Running', 'Rinse']); // omitted on this call — left as-is
});

test('consolidateHistory folds a state monitor\'s periods into a daily summary, same as an activity monitor', async () => {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const monitor = store.createStateMonitor({ device: { id: 'dev-1', name: 'Garage door' }, capability: 'alarm_contact' });
  const now = Date.parse('2026-08-29T12:00:00Z');
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  monitor.periods = [{ startedAt: tenDaysAgo, endedAt: tenDaysAgo + 60000, state: 'ACTIVE', seconds: 60 }];
  store.consolidateHistory('UTC', now);
  assert.equal(monitor.periods.length, 0);
  assert.equal(monitor.dailySummaries.length, 1);
  assert.equal(monitor.dailySummaries[0].activeSeconds, 60);
});
