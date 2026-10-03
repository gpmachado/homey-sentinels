'use strict';
// What Activity, State and Voltage monitors share in lib/app/monitor-admin.js: remove, reset and change device /
// rename all go through one code path per step, so each kind is checked against the same expectations.
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const monitorAdmin = require('../lib/app/monitor-admin');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const KINDS = {
  activity: { collection: 'monitors', capability: 'measure_power', watch: '_watch', remove: 'removeMonitor', reset: 'resetMonitor', resetApp: 'resetMonitorStats', identity: 'updateActivityMonitorIdentity' },
  state: { collection: 'stateMonitors', capability: 'alarm_contact', watch: '_watchState', remove: 'removeStateMonitor', reset: 'resetStateMonitor', resetApp: 'resetStateMonitorStats', identity: 'updateStateMonitorIdentity' },
  voltage: { collection: 'voltageMonitors', capability: 'measure_voltage', watch: '_watchVoltage', remove: 'removeVoltageMonitor', reset: 'resetVoltageMonitor', resetApp: 'resetVoltageMonitorStats', identity: 'updateVoltageMonitorIdentity' }
};

async function fakeApp(devices = {}) {
  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; }, unset: () => {} });
  await store.load();
  const unsubscribed = []; const watched = []; const resets = [];
  const app = Object.assign({
    store, unsubscribed, watched, resets,
    log: () => {}, error: () => {}, _logEvent: () => {}, _scheduleSave: () => {},
    _lastCalibrationAttempt: new Map(), _calibrationAttempts: new Map(),
    homey: { setTimeout: (fn, ms) => setTimeout(fn, ms) },
    _watch: async (m) => { watched.push(m.id); }, _watchState: async (m) => { watched.push(m.id); }, _watchVoltage: async (m) => { watched.push(m.id); },
    gateway: {
      unsubscribeCapabilities: (owner, deviceId, capability, aux) => unsubscribed.push({ owner, deviceId, capability, aux }),
      getDevice: async (id) => devices[id]
    }
  }, monitorAdmin);
  for (const [kind, info] of Object.entries(KINDS)) {
    const original = store[info.reset].bind(store);
    store[info.reset] = (item) => { resets.push(kind); return original(item); };
  }
  return app;
}
const add = (app, kind, id, extra = {}) => {
  const info = KINDS[kind];
  app.store.data[info.collection][id] = { id, name: `${kind} ${id}`, deviceId: 'old', deviceName: 'Old device', capability: info.capability, auxiliaryCapabilities: ['measure_power', 'meter_power'], periods: [], cycles: [], events: [], totals: {}, ...extra };
  return app.store.data[info.collection][id];
};
const device = (id, capabilities, type = 'boolean') => ({ id, name: `Device ${id}`, capabilities, capabilitiesObj: Object.fromEntries(capabilities.map((c) => [c, { type: c.startsWith('measure') || c.startsWith('meter') ? 'number' : type }])) });

for (const [kind, info] of Object.entries(KINDS)) {
  test(`${kind}: removing unsubscribes the primary AND the auxiliary capabilities, then forgets the monitor`, async () => {
    const app = await fakeApp();
    const item = add(app, kind, 'a');
    await app[info.remove](item);
    assert.deepEqual(app.unsubscribed, [{ owner: 'a', deviceId: 'old', capability: info.capability, aux: ['measure_power', 'meter_power'] }]);
    assert.equal(app.store.data[info.collection].a, undefined);
  });

  test(`${kind}: resetting calls only that kind's store reset`, async () => {
    const app = await fakeApp();
    const item = add(app, kind, 'a');
    await app[info.resetApp](item);
    assert.deepEqual(app.resets, [kind]);
    assert.deepEqual(app.unsubscribed, []); // a reset never touches the subscription
  });

  test(`${kind}: a rename alone changes only the name`, async () => {
    const app = await fakeApp();
    const item = add(app, kind, 'a');
    await app[info.identity](item, { name: '  New name ' });
    assert.equal(item.name, 'New name');
    assert.equal(item.deviceId, 'old');
    assert.deepEqual(app.unsubscribed, []);
    await assert.rejects(() => app[info.identity](item, { name: '   ' }), /Enter a name/);
  });

  test(`${kind}: moving to a device drops the old subscriptions, takes the new device's auxiliary capabilities and starts watching it`, async () => {
    const caps = [info.capability, 'measure_current'];
    const app = await fakeApp({ fresh: device('fresh', caps) });
    const item = add(app, kind, 'a', { lastSample: { value: 1 }, deviceMissing: true });
    await app[info.identity](item, { deviceId: 'fresh' });
    assert.deepEqual(app.unsubscribed, [{ owner: 'a', deviceId: 'old', capability: info.capability, aux: ['measure_power', 'meter_power'] }]);
    assert.equal(item.deviceId, 'fresh');
    assert.deepEqual(item.auxiliaryCapabilities, ['measure_current']);
    assert.equal(item.lastSample, null);
    assert.equal(item.deviceMissing, false);
    await flush();
    assert.deepEqual(app.watched, ['a']);
  });

  test(`${kind}: moving is refused for a device without the capability, and for one another monitor of this kind already uses`, async () => {
    const app = await fakeApp({ nocap: device('nocap', ['onoff_other']), taken: device('taken', [info.capability]) });
    const item = add(app, kind, 'a');
    await assert.rejects(() => app[info.identity](item, { deviceId: 'nocap' }), /capability/);
    add(app, kind, 'b', { deviceId: 'taken' });
    await assert.rejects(() => app[info.identity](item, { deviceId: 'taken' }), /already uses this device and capability/);
    assert.equal(item.deviceId, 'old'); // nothing changed
    assert.deepEqual(app.unsubscribed, []);
  });
}

test('activity: moving also clears the calibration back-off the old device had built up', async () => {
  const app = await fakeApp({ fresh: device('fresh', ['measure_power']) });
  const item = add(app, 'activity', 'a');
  app._lastCalibrationAttempt.set('a', 1); app._calibrationAttempts.set('a', 3);
  await app.updateActivityMonitorIdentity(item, { deviceId: 'fresh' });
  assert.equal(app._lastCalibrationAttempt.has('a'), false);
  assert.equal(app._calibrationAttempts.has('a'), false);
});

test('state: moving a multi-state monitor needs its active values, and the check says so', async () => {
  const app = await fakeApp({ fresh: device('fresh', ['machine_state'], 'enum') });
  const item = add(app, 'state', 'a', { capability: 'machine_state', activeValues: null });
  await assert.rejects(() => app.updateStateMonitorIdentity(item, { deviceId: 'fresh' }), /multiple states/);
  item.activeValues = ['Running'];
  await app.updateStateMonitorIdentity(item, { deviceId: 'fresh' });
  assert.equal(item.deviceId, 'fresh');
});

test('voltage: moving needs a measure_voltage capability even if the device has the id', async () => {
  const app = await fakeApp({ fresh: device('fresh', ['measure_power']) });
  const item = add(app, 'voltage', 'a', { capability: 'measure_power' });
  await assert.rejects(() => app.updateVoltageMonitorIdentity(item, { deviceId: 'fresh' }), /voltage capability/);
});

// ---- default wording: the language a new monitor's sentences come in
const api = require('../api');

async function wordingApp({ chosen = '', homeyLanguage = 'en', brokenI18n = false } = {}) {
  const devices = {
    meter: { id: 'meter', name: 'Meter', capabilities: ['measure_power', 'measure_voltage', 'meter_power'], capabilitiesObj: { measure_power: {}, measure_voltage: {}, meter_power: {} } },
    door: { id: 'door', name: 'Door', capabilities: ['alarm_contact'], capabilitiesObj: { alarm_contact: { type: 'boolean' } } }
  };
  const app = await fakeApp(devices);
  app.store.updateMessageSettings({ messageLanguage: chosen });
  app.homey.i18n = brokenI18n ? {} : { getLanguage: () => homeyLanguage };
  app.log = () => {};
  return app;
}

test('new monitors of every kind start with the wording of the language chosen in Settings, Portuguese included', async () => {
  const app = await wordingApp({ chosen: 'pt', homeyLanguage: 'de' });
  const activity = await app._createActivityMonitor({ deviceId: 'meter', threshold: 50 });
  assert.equal(activity.messageTemplateFinished, '%monitor% desligou - %duration_human%, %energy% kWh (%count% hoje)');
  const state = await app._createStateMonitor({ deviceId: 'door', capability: 'alarm_contact' });
  assert.equal(state.messageTemplateStarted, '%monitor% agora está %label%');
  const voltage = await app._createVoltageMonitor({ deviceId: 'meter', capability: 'measure_voltage', minVoltage: 210, maxVoltage: 240 });
  assert.equal(voltage.messageTemplateUndervoltage, '%monitor% está em subtensão - %voltage% V.');
});

test('with no language chosen the language Homey reports is used, and English when the app has no wording for it', async () => {
  let app = await wordingApp({ chosen: '', homeyLanguage: 'de' });
  assert.equal((await app._createActivityMonitor({ deviceId: 'meter', threshold: 50 })).messageTemplateStarted, '%monitor% eingeschaltet (%power% W)');
  app = await wordingApp({ chosen: '', homeyLanguage: 'ko' });
  assert.equal((await app._createActivityMonitor({ deviceId: 'meter', threshold: 50 })).messageTemplateStarted, '%monitor% turned on (%power% W)');
  app = await wordingApp({ brokenI18n: true }); // a firmware without homey.i18n
  assert.equal(app._messageLanguage(), 'en');
});

test('choosing a language never touches the wording of a monitor that already exists', async () => {
  const app = await wordingApp({ chosen: 'pt' });
  const existing = add(app, 'activity', 'old', { messageTemplateStarted: 'my own text', messageTemplateFinished: 'my own finish' });
  await app._createActivityMonitor({ deviceId: 'meter', threshold: 50 });
  assert.deepEqual([existing.messageTemplateStarted, existing.messageTemplateFinished], ['my own text', 'my own finish']);
});

test('api.getDefaultWording offers the languages, says which is in use and serves the group sentences in it', async () => {
  const app = await wordingApp({ chosen: 'pt' });
  const homey = { app };
  const info = await api.getDefaultWording({ homey });
  assert.equal(info.language, 'pt');
  assert.ok(info.languages.some((language) => language.code === 'pt' && language.name === 'Português'));
  assert.equal(info.messageWording.contact.false.zero, 'Todas as portas e janelas estão fechadas.');
  const saved = await api.setMessageSettings({ homey, body: { messageLanguage: 'de' } });
  assert.equal(saved.messageLanguage, 'de');
  assert.equal((await api.getDefaultWording({ homey })).messageWording.light.false.zero, 'Alle Lichter (%group%) sind aus.');
});
