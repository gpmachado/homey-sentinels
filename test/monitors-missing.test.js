'use strict';
// Monitors whose device was deleted from Homey: flagged (and no longer retried for ever), started again if the
// device comes back, and named in the startup summary. Uses the real mixins with a fake app around them.
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const monitorAdmin = require('../lib/app/monitor-admin');
const memory = require('../lib/app/memory');

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function fakeApp() {
  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; }, unset: () => {} });
  await store.load();
  const logs = []; const events = []; const timers = []; const watched = [];
  const app = Object.assign({
    store, logs, events, watched, timers,
    log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`), _logEvent: (m) => events.push(m), _scheduleSave: () => {},
    homey: { setTimeout: (fn, ms) => timers.push({ fn, ms }) },
    _watch: async (m) => { watched.push(m.id); }, _watchVoltage: async (m) => { watched.push(m.id); }, _watchState: async (m) => { watched.push(m.id); }
  }, monitorAdmin, memory);
  return app;
}
const monitor = (app, id, deviceId = 'dev1') => { app.store.data.monitors[id] = { id, name: `M ${id}`, deviceId, deviceName: `Device ${deviceId}` }; return app.store.data.monitors[id]; };

test('the scan flags a monitor whose device is not in the list, and clears it (and restarts it) when the device is back', async () => {
  const app = await fakeApp();
  const gone = monitor(app, 'a', 'gone'); const fine = monitor(app, 'b', 'here');
  app._checkMonitorDevices([{ id: 'here' }]);
  assert.equal(gone.deviceMissing, true);
  assert.equal(Boolean(fine.deviceMissing), false);
  assert.equal(app.events.length, 1);
  app._checkMonitorDevices([{ id: 'here' }]); // still gone: said once, not at every scan
  assert.equal(app.events.length, 1);
  app._checkMonitorDevices([{ id: 'here' }, { id: 'gone' }]);
  await flush();
  assert.equal(gone.deviceMissing, false);
  assert.deepEqual(app.watched, ['a']); // started watching again
});

test('an empty device list (it could not be read) changes nothing', async () => {
  const app = await fakeApp();
  const m = monitor(app, 'a', 'gone');
  app._checkMonitorDevices([]);
  assert.equal(Boolean(m.deviceMissing), false);
});

test('a monitor whose device keeps answering Not Found is flagged after the attempts, and other errors are only retried', async () => {
  const app = await fakeApp();
  const m = monitor(app, 'a', 'gone');
  app._watch = async () => { throw Object.assign(new Error('Not Found: Device with ID gone'), { statusCode: 404 }); };
  app._resumeMonitor('monitor', 'monitors', m);
  for (let i = 0; i < 5; i += 1) { await flush(); if (app.timers[i]) app.timers[i].fn(); }
  await flush();
  assert.equal(m.deviceMissing, true);
  assert.equal(app.timers.length, 4); // 4 waits, the 5th failure gave up

  const other = monitor(app, 'b', 'busy');
  app.timers.length = 0;
  app._watch = async () => { throw new Error('socket hang up'); };
  app._resumeMonitor('monitor', 'monitors', other);
  for (let i = 0; i < 8; i += 1) { await flush(); if (app.timers[i]) app.timers[i].fn(); }
  assert.equal(Boolean(other.deviceMissing), false);
  assert.ok(app.timers.length >= 8); // it keeps trying
});

test('the startup summary says what is running, and how many monitors have lost their device', async () => {
  const app = await fakeApp();
  monitor(app, 'a'); const gone = monitor(app, 'b'); gone.deviceMissing = true;
  app.store.data.groups.g = { id: 'g', name: 'Doors', devices: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] };
  const line = app._startupSummary();
  assert.match(line, /2 activity, 0 state and 0 voltage monitors \(1 with a missing device\)/);
  assert.match(line, /1 groups \(3 devices\)/);
  assert.match(line, /availability scan every 60 min/);
});
