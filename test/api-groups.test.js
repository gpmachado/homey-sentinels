'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const { assertGroupDevice } = require('../lib/groups');
const api = require('../api');

function fakeSettings() { const data = {}; return { get: (key) => data[key], set: async (key, value) => { data[key] = value; } }; }

async function fakeHomey(devices, loaded = true) {
  const store = new SentinelStore(fakeSettings());
  await store.load();
  const directory = { requested: 0, hasLoaded: () => loaded, request() { this.requested += 1; }, list: () => devices };
  // The live watch is what the app starts after a create/update; here it is only recorded.
  const watched = [];
  const app = {
    store, directory, watched, _assertGroupDevice: assertGroupDevice,
    inAppContext: (fn) => Promise.resolve().then(fn),
    _startGroupWatch: (group) => watched.push(group.id),
    _unwatchGroup: () => {},
    error: () => {}
  };
  return { app };
}
const light = (id) => ({ id, name: id, capabilities: ['onoff'] });
const contact = (id) => ({ id, name: id, capabilities: ['alarm_contact'] });

test('api.createGroup creates a group from at least two compatible devices', async () => {
  const homey = await fakeHomey([light('d1'), light('d2')]);
  const group = await api.createGroup({ homey, body: { name: 'Luzes', type: 'light', expectedState: true, deviceIds: ['d1', 'd2'] } });
  assert.equal(group.type, 'light');
  assert.equal(group.devices.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(homey.app.watched, [group.id]); // the group starts being watched live
  await assert.rejects(api.createGroup({ homey, body: { name: 'X', type: 'light', deviceIds: ['d1'] } }), /at least two/);
});

test('api.updateGroup leaves the group untouched when the new type is incompatible with its devices', async () => {
  const homey = await fakeHomey([light('d1'), light('d2'), contact('c1'), contact('c2')]);
  const group = await api.createGroup({ homey, body: { name: 'Luzes', type: 'light', expectedState: true, deviceIds: ['d1', 'd2'] } });
  await assert.rejects(api.updateGroup({ homey, params: { id: group.id }, body: { name: 'Novo', type: 'contact' } }), /isn't compatible/);
  assert.equal(group.type, 'light');
  assert.equal(group.name, 'Luzes');
  await assert.rejects(api.updateGroup({ homey, params: { id: group.id }, body: { type: 'contact', deviceIds: ['d1', 'c1'] } }), /isn't compatible/);
  assert.equal(group.type, 'light');
  const updated = await api.updateGroup({ homey, params: { id: group.id }, body: { name: 'Portas', type: 'contact', deviceIds: ['c1', 'c2'] } });
  assert.equal(updated.type, 'contact');
  assert.equal(updated.name, 'Portas');
  assert.deepEqual(updated.devices.map((d) => d.id), ['c1', 'c2']);
});

test('group create/update ask for the device list and say so when it has not loaded yet', async () => {
  const homey = await fakeHomey([], false);
  await assert.rejects(api.createGroup({ homey, body: { name: 'X', type: 'light', deviceIds: ['d1', 'd2'] } }), /still loading/);
  assert.equal(homey.app.directory.requested, 1);
});

test('clearGroupMismatch: unsticks a mismatch the poll already reported', async () => {
  const data = {};
  const settings = { get: (k) => data[k], set: async (k, v) => { data[k] = v; } };
  const store = new SentinelStore(settings);
  await store.load();
  const group = store.createGroup({ name: 'Fontes', type: 'switch', expectedState: true, devices: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  group.mismatchSince = Date.now() - 900000; // stuck from an earlier poll/restart
  store.clearGroupMismatch(group);
  assert.equal(group.mismatchSince, null);
  await store.save();
  const reloaded = new SentinelStore(settings);
  await reloaded.load();
  assert.equal(reloaded.data.groups[group.id].mismatchSince, null);
});
