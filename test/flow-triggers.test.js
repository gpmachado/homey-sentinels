'use strict';
// The trigger cards: every argument list starts with an "Any ..." choice that matches every monitor, group or
// watched device, and each card's tokens are the ones its JSON declares.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const flowCards = require('../lib/app/flow-cards');
const groups = require('../lib/app/groups');
const availabilityWatchdogs = require('../lib/app/availability-watchdogs');

function fakeApp() {
  const cards = {};
  const card = (id) => (cards[id] ||= { id, run: null, autocomplete: {}, registerRunListener(fn) { this.run = fn; return this; }, registerArgumentAutocompleteListener(arg, fn) { this.autocomplete[arg] = fn; return this; }, trigger: async () => {} });
  const app = Object.assign({}, flowCards, groups, availabilityWatchdogs, {
    homey: { flow: { getTriggerCard: card, getConditionCard: card, getActionCard: card } },
    store: { data: { monitors: { m1: { id: 'm1', name: 'Bomba' } }, stateMonitors: { s1: { id: 's1', name: 'Porta' } }, voltageMonitors: { v1: { id: 'v1', name: 'Fase A' } }, groups: { g1: { id: 'g1', name: 'Portas', devices: [] } }, availabilityWatchdogs: { d1: { deviceId: 'd1', name: 'Sensor' } } } },
    directory: { ensure: async () => [] }, log() {}, error() {}, _debug() {},
    _calibrationAttempts: new Map([['m1', 5]]), _lastCalibrationAttempt: new Map([['m1', 1]]), saved: 0,
    _voltageStatistics: () => ({ average_voltage: null, min_voltage: null, max_voltage: null, undervoltage_count: 0, undervoltage_duration: 0, overvoltage_count: 0, overvoltage_duration: 0 })
  });
  app.store.save = async () => { app.saved += 1; };
  for (const key of ['cards', 'stateCards', 'voltageCards', 'groupCards', 'availabilityCards']) app[key] = new Proxy({}, { get: (_, name) => card(`${key}.${String(name)}`) });
  app._registerFlowCards();
  cards.app = app;
  return cards;
}

const filtered = [
  ['cards.started', 'monitor', 'm1', 'monitorId', 'Any activity monitor'],
  ['cards.finished', 'monitor', 'm1', 'monitorId', 'Any activity monitor'],
  ['cards.calibrated', 'monitor', 'm1', 'monitorId', 'Any activity monitor'],
  ['stateCards.started', 'monitor', 's1', 'monitorId', 'Any state monitor'],
  ['voltageCards.normalized', 'monitor', 'v1', 'monitorId', 'Any voltage monitor'],
  ['groupCards.mismatchDetected', 'group', 'g1', 'groupId', 'Any group'],
  ['availabilityCards.batteryLow', 'device', 'd1', 'deviceId', 'Any watched device']
];

test('every filtered trigger offers "Any ..." first, which runs for every one, while a picked one runs only for itself', async () => {
  const cards = fakeApp();
  for (const [id, arg, ownId, stateKey, label] of filtered) {
    const card = cards[id];
    const list = await card.autocomplete[arg]('');
    assert.equal(list[0].name, label, id);
    assert.equal(list.length, 2, id);
    const any = { [arg]: list[0] };
    const own = { [arg]: list[1] };
    assert.equal(await card.run(any, { [stateKey]: ownId }), true, id);
    assert.equal(await card.run(any, { [stateKey]: 'other' }), true, id);
    assert.equal(await card.run(own, { [stateKey]: ownId }), true, id);
    assert.equal(await card.run(own, { [stateKey]: 'other' }), false, id);
  }
  const cycles = cards['cards.cyclesReached'];
  const anyMonitor = (await cycles.autocomplete.monitor(''))[0];
  assert.equal(await cycles.run({ monitor: anyMonitor, cycles: 3 }, { monitorId: 'x', cycleCount: 3 }), true);
  assert.equal(await cycles.run({ monitor: anyMonitor, cycles: 3 }, { monitorId: 'x', cycleCount: 2 }), false);
});

test('a search that does not match "Any" leaves it out', async () => {
  const cards = fakeApp();
  const list = await cards['cards.started'].autocomplete.monitor('bomba');
  assert.deepEqual(list.map((item) => item.name), ['Bomba']);
});

test('every event trigger declares timestamp and time, and every filtered one says how to pick all', () => {
  const dir = path.join(__dirname, '..', '.homeycompose', 'flow', 'triggers');
  for (const file of fs.readdirSync(dir)) {
    const card = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const names = card.tokens.map((token) => token.name);
    assert.ok(names.includes('timestamp') && names.includes('time'), `${file} lacks timestamp/time`);
    for (const arg of card.args || []) if (arg.type === 'autocomplete') assert.match(arg.hint.en, /Any /, file);
  }
});

test('Recalibrate starts afresh, and refuses a manual monitor', async () => {
  const cards = fakeApp();
  const { app } = cards;
  await cards.calibrate_threshold.run({ monitor: { id: 'm1' } });
  assert.equal(app.store.data.monitors.m1.calibrating, true);
  assert.equal(app._calibrationAttempts.has('m1'), false);
  app.store.data.monitors.m1.mode = 'manual';
  await assert.rejects(cards.calibrate_threshold.run({ monitor: { id: 'm1' } }), /no threshold/);
});

test('voltage statistics never hand a null to a number token', async () => {
  const cards = fakeApp();
  const result = await cards.get_voltage_statistics.run({ monitor: { id: 'v1' }, period: 'day' });
  for (const value of Object.values(result)) assert.equal(typeof value, 'number');
});

test('a state monitor also fires the cycle triggers, and "running longer than" accepts it', async () => {
  const state = require('../lib/app/state');
  const activity = require('../lib/app/activity');
  const fired = [];
  const recorder = (name) => ({ trigger: async (tokens, filter) => { fired.push([name, tokens, filter]); } });
  const door = { id: 's1', name: 'Porta', deviceName: 'Sensor', falseLabel: 'Closed', trueLabel: 'Open', messageTemplateFinished: '', state: 'STANDBY' };
  const app = Object.assign({}, activity, state, {
    stateCards: { started: recorder('state_started'), finished: recorder('state_finished') },
    cards: { cyclesReached: recorder('cycles_reached'), unusuallyLong: recorder('unusually_long') },
    _stateStatistics: () => ({ cycle_count: 5, energy: 0 }), _statistics: () => ({ median_duration: 60 }),
    _getTimezone: () => 'UTC', _scheduleSave() {}, _logEvent() {}, log() {}
  });
  await app._handleStateEvents(door, [{ type: 'finished', timestamp: Date.UTC(2026, 10, 1), duration: 600, duration_human: '10 min' }]);
  assert.deepEqual(fired.map(([name]) => name), ['state_finished', 'cycles_reached', 'unusually_long']);
  assert.deepEqual(fired[1][2], { monitorId: 's1', cycleCount: 5 });
  assert.equal(fired[2][2].ratio, 10);

  const cards = fakeApp();
  cards.app.store.data.stateMonitors.s1 = { id: 's1', name: 'Porta', state: 'ACTIVE', activeSince: Date.now() - 11 * 60000 };
  assert.equal(await cards.activity_running_longer_than.run({ monitor: { id: 's1' }, minutes: 10 }), true);
  const list = await cards.activity_running_longer_than.autocomplete.monitor('');
  assert.deepEqual(list.map((item) => item.name).sort(), ['Bomba', 'Porta']);
});

test('"has a reading in the last minutes" works for every kind of monitor', async () => {
  const cards = fakeApp();
  const { data } = cards.app.store;
  data.voltageMonitors.v1.lastSample = { voltage: 230, timestamp: Date.now() - 5 * 60000 };
  data.monitors.m1.lastSample = { power: 0, timestamp: Date.now() - 90 * 60000 };
  const run = (id, minutes) => cards.monitor_has_recent_reading.run({ monitor: { id }, minutes });
  assert.equal(await run('v1', 10), true);
  assert.equal(await run('m1', 60), false);
  assert.equal(await run('s1', 60), false); // never had one
  await assert.rejects(run('nope', 60), /not found/);
});

test('"battery OK again" offers Any watched device like the other availability triggers', async () => {
  const cards = fakeApp();
  const list = await cards['availabilityCards.batteryOk'].autocomplete.device('');
  assert.equal(list[0].name, 'Any watched device');
});

test('one "Monitor is active" and one "Reset monitor statistics" serve every kind', async () => {
  const cards = fakeApp();
  const { app } = cards;
  app.store.data.stateMonitors.s1.state = 'ACTIVE';
  assert.equal(await cards.is_monitor_active.run({ monitor: { id: 's1' } }), true);
  assert.equal(await cards.is_monitor_active.run({ monitor: { id: 'm1' } }), false);
  const reset = [];
  app.resetMonitorStats = async (m) => reset.push(m.id);
  app.resetStateMonitorStats = async (m) => reset.push(m.id);
  app.resetVoltageMonitorStats = async (m) => reset.push(m.id);
  for (const id of ['m1', 's1', 'v1']) await cards.reset_monitor.run({ monitor: { id } });
  assert.deepEqual(reset, ['m1', 's1', 'v1']);
  await assert.rejects(cards.reset_monitor.run({ monitor: { id: 'x' } }), /not found/);
});

test('the usage pattern of a state monitor reports no peak power, since its "power" is only its on/off value', async () => {
  const cards = fakeApp();
  const pattern = (id) => ({ id, enough: true, cycleCount: 10, peakPowerHour: 20, peakPowerHourLabel: '20:00-21:00', peakPower: 1, totalEnergy: 0 });
  cards.app.getUsagePattern = (monitor) => pattern(monitor.id);
  const state = await cards.get_usage_pattern.run({ monitor: { id: 's1' }, period: 'month' });
  assert.equal(state.peak_power, 0);
  assert.equal(state.peak_power_hour, -1);
  assert.equal(state.peak_power_hour_label, '');
  const activity = await cards.get_usage_pattern.run({ monitor: { id: 'm1' }, period: 'month' });
  assert.equal(activity.peak_power, 1);
  assert.equal(activity.peak_power_hour, 20);
});

test('the detailed log shows a long text token by its length, not its contents', async () => {
  const lines = [];
  const cards = fakeApp();
  Object.assign(cards.app, { _debug: (build) => lines.push(build()), _summarizeArgs: () => ({}) });
  cards.app.store.data.big = 'x'.repeat(2000);
  await cards.export_data.run({});
  const logged = lines.find((line) => line[0] === '[action] export_data ok')[1];
  assert.match(logged.json, /^<\d+ characters>$/);
  assert.equal(typeof logged.size_bytes, 'number');
});

test('a group member whose name ends in a space does not leave a space before the full stop', () => {
  const { evaluateGroup } = require('../lib/groups');
  const group = { name: 'Portas', type: 'contact', expectedState: false, conjunction: 'e', devices: [{ id: 'a', name: 'Porta ' }, { id: 'b', name: 'Janela' }], messageTemplateOne: '%items% está aberta.', messageTemplateMany: 'Abertas: %items%.', messageTemplateZero: 'Tudo fechado.' };
  const open = { capabilitiesObj: { alarm_contact: { value: true } } };
  const result = evaluateGroup(group, [{ name: 'Porta ', ...open }, { name: 'Janela', ...open }]);
  assert.equal(result.message, 'Abertas: Porta e Janela.');
  assert.equal(result.mismatchList, 'Porta\nJanela');
});
