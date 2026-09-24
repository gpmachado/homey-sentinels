'use strict';
// The live (event-driven) side of State Groups: a member's capability event re-judges the group at once.
// Uses the real mixin and store with a fake gateway that lets the test emit capability events.
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const groupsMixin = require('../lib/app/groups');

async function fakeApp({ initial = {}, groupType = 'switch', expectedState = true, deviceIds = ['a', 'b', 'c'], gone = [] } = {}) {
  const data = {};
  const store = new SentinelStore({ get: (k) => data[k], set: async (k, v) => { data[k] = v; }, unset: () => {} });
  await store.load();
  const group = store.createGroup({ name: 'Fontes', type: groupType, expectedState, devices: deviceIds.map((id) => ({ id, name: `Dev ${id}` })) });
  const handlers = new Map(); // `${owner}|${deviceId}` -> handler
  const values = { ...initial };
  const fired = { mismatch: [], matched: [] };
  const app = Object.assign({
    store,
    _groupLive: new Map(),
    _groupMissing: new Map(),
    log: () => {}, error: () => {}, _logEvent: () => {}, _scheduleSave: () => {}, _getTimezone: () => 'UTC',
    homey: { setTimeout: (fn, ms) => setTimeout(fn, ms) },
    groupCards: {
      mismatchDetected: { trigger: async (tokens, state) => { fired.mismatch.push({ tokens, state }); } },
      matchedAgain: { trigger: async (tokens, state) => { fired.matched.push({ tokens, state }); } }
    },
    gateway: {
      unsubscribed: [],
      async subscribeCapabilities(owner, deviceId, capability, aux, handler) {
        if (gone.includes(deviceId)) throw Object.assign(new Error(`Not Found: Device with ID ${deviceId}`), { statusCode: 404 });
        handlers.set(`${owner}|${deviceId}`, handler);
        if (typeof values[deviceId] === 'boolean') await handler(values[deviceId], Date.now(), {}); // the gateway calls back with the current value
      },
      unsubscribeCapabilities(owner, deviceId) { handlers.delete(`${owner}|${deviceId}`); this.unsubscribed.push(deviceId); },
      async getDevice(id) {
        if (gone.includes(id)) throw Object.assign(new Error(`Not Found: Device with ID ${id}`), { statusCode: 404 });
        return { id, name: `Dev ${id}`, capabilitiesObj: { [groupType === 'switch' ? 'onoff' : 'alarm_contact']: { value: values[id] } } };
      }
    }
  }, groupsMixin);
  const emit = (deviceId, value) => { values[deviceId] = value; return handlers.get(`group:${group.id}|${deviceId}`)(value, Date.now(), {}); };
  return { app, group, emit, fired, handlers, values };
}

test('a member turning off fires group_mismatch_detected immediately, and back on fires matched_again', async () => {
  const { app, group, emit, fired } = await fakeApp({ initial: { a: true, b: true, c: true } });
  await app._watchGroup(group);
  assert.equal(fired.mismatch.length, 0); // everything matches at the start
  await emit('b', false);
  assert.equal(fired.mismatch.length, 1);
  assert.equal(fired.mismatch[0].tokens.mismatch_count, 1);
  assert.equal(fired.mismatch[0].tokens.mismatch_list, 'Dev b');
  assert.deepEqual(fired.mismatch[0].state, { groupId: group.id });
  await emit('b', false); // same value again: already reported, nothing new
  assert.equal(fired.mismatch.length, 1);
  await emit('b', true);
  assert.equal(fired.matched.length, 1);
  assert.equal(group.mismatchSince, null);
});

test('rapid off / on / off is seen event by event, not lost between polls', async () => {
  const { app, group, emit, fired } = await fakeApp({ initial: { a: true, b: true, c: true } });
  await app._watchGroup(group);
  await emit('a', false); await emit('a', true); await emit('a', false);
  assert.equal(fired.mismatch.length, 2);
  assert.equal(fired.matched.length, 1);
});

test('a group that is already mismatched at start reports it once', async () => {
  const { app, group, fired } = await fakeApp({ initial: { a: true, b: false, c: true } });
  await app._watchGroup(group);
  assert.equal(fired.mismatch.length, 1);
  assert.equal(fired.mismatch[0].tokens.mismatch_list, 'Dev b');
});

test('while a member has no value yet, the group is not judged on partial data', async () => {
  const { app, group, emit, fired } = await fakeApp({ initial: { a: true, b: true } }); // c never reports at subscribe time
  await app._watchGroup(group);
  assert.equal(fired.mismatch.length, 0);
  await emit('a', false); // c is still unknown: leave it to the poll
  assert.equal(fired.mismatch.length, 0);
  await emit('c', true); // c reports: now all are known, and a is off
  assert.equal(fired.mismatch.length, 1);
});

test('the poll refreshes the live values and applies the same transitions', async () => {
  const { app, group, values, fired } = await fakeApp({ initial: { a: true, b: true, c: true } });
  await app._watchGroup(group);
  values.c = false; // changed without any event reaching us
  await app._pollGroups();
  assert.equal(fired.mismatch.length, 1);
  assert.equal(app._groupLive.get(group.id).values.get('c'), false);
  await app._pollGroups(); // nothing new
  assert.equal(fired.mismatch.length, 1);
});

test('garage groups keep their inverted polarity live', async () => {
  const { app, group, emit, fired } = await fakeApp({ groupType: 'garage', expectedState: false, deviceIds: ['g1', 'g2'], initial: { g1: true, g2: true } });
  // garagedoor_closed true = closed; expected "closed" (expectedState false) means target raw value true
  await app._watchGroup(group);
  assert.equal(fired.mismatch.length, 0);
  await emit('g2', false); // opened
  assert.equal(fired.mismatch.length, 1);
});

test('unwatching removes the subscriptions and ignores later events', async () => {
  const { app, group, emit, fired, handlers } = await fakeApp({ initial: { a: true, b: true, c: true } });
  await app._watchGroup(group);
  const handler = handlers.get(`group:${group.id}|a`);
  app._unwatchGroup(group.id);
  assert.equal(handlers.size, 0);
  await handler(false, Date.now(), {}); // a late event from a subscription that was just removed
  assert.equal(fired.mismatch.length, 0);
});

test('changing the members starts the watch over with the new ones', async () => {
  const { app, group, handlers } = await fakeApp({ initial: { a: true, b: true, c: true, d: true } });
  await app._watchGroup(group);
  group.devices = [{ id: 'a', name: 'Dev a' }, { id: 'd', name: 'Dev d' }];
  await app._watchGroup(group);
  assert.deepEqual([...handlers.keys()].sort(), [`group:${group.id}|a`, `group:${group.id}|d`]);
});

test('a member removed from the group no longer counts', async () => {
  const { app, group, emit, fired } = await fakeApp({ initial: { a: true, b: true, c: true } });
  await app._watchGroup(group);
  group.devices = group.devices.filter((d) => d.id !== 'c');
  await emit('c', false); // an old event for a device that left the group
  assert.equal(fired.mismatch.length, 0);
});

// ---- A member that was deleted from Homey --------------------------------------------------------------
test('a deleted member does not stop the others from being watched, and is not a mismatch', async () => {
  const { app, group, emit, fired, handlers } = await fakeApp({ initial: { a: true, b: true, c: true }, gone: ['c'] });
  await app._watchGroup(group); // used to throw Not Found for the whole group
  assert.deepEqual([...handlers.keys()].sort(), [`group:${group.id}|a`, `group:${group.id}|b`]);
  assert.equal(fired.mismatch.length, 0);
  await emit('a', false);
  assert.equal(fired.mismatch.length, 1);
  assert.equal(fired.mismatch[0].tokens.mismatch_list, 'Dev a'); // only the real one, not the deleted device
  assert.equal(fired.mismatch[0].tokens.match_count, 1);
});

test('the poll survives a deleted member and removes it after three polls in a row', async () => {
  const { app, group, fired } = await fakeApp({ initial: { a: true, b: true, c: true }, gone: ['c'] });
  await app._watchGroup(group);
  await app._pollGroups();
  await app._pollGroups();
  assert.deepEqual(group.devices.map((d) => d.id), ['a', 'b', 'c']); // two polls: still waiting
  await app._pollGroups();
  assert.deepEqual(group.devices.map((d) => d.id), ['a', 'b']);
  assert.equal(fired.mismatch.length, 0); // no false alarm at any point
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app._groupLive.get(group.id)); // watching again with the remaining members
});

test('a member that comes back before the third poll is kept', async () => {
  const { app, group } = await fakeApp({ initial: { a: true, b: true, c: true } });
  const state = { gone: true };
  const original = app.gateway.getDevice.bind(app.gateway);
  app.gateway.getDevice = async (id) => { if (id === 'c' && state.gone) throw Object.assign(new Error('Not Found'), { statusCode: 404 }); return original(id); };
  await app._pollGroups(); await app._pollGroups();
  state.gone = false; // e.g. Homey was still starting up
  await app._pollGroups(); await app._pollGroups(); await app._pollGroups();
  assert.equal(group.devices.length, 3);
});

test('a transient failure is never taken for a deleted device', async () => {
  const { app, group } = await fakeApp({ initial: { a: true, b: true, c: true } });
  app.gateway.getDevice = async () => { throw new Error('socket hang up'); };
  for (let i = 0; i < 5; i += 1) await app._pollGroups(); // the poll logs the error and moves on
  assert.equal(group.devices.length, 3);
});

test('Clean up removes deleted members at once and reports them', async () => {
  const { app, group } = await fakeApp({ initial: { a: true, b: true, c: true, d: true }, deviceIds: ['a', 'b', 'c', 'd'], gone: ['c'] });
  const result = await app.cleanupGroupMissing(group);
  assert.deepEqual(result, { removed: ['Dev c'], remaining: 3 });
  assert.deepEqual(group.devices.map((d) => d.id), ['a', 'b', 'd']);
  assert.deepEqual(await app.cleanupGroupMissing(group), { removed: [], remaining: 3 }); // nothing left to clean
});

test('a group left with fewer than two devices is kept but no longer checked', async () => {
  const { app, group } = await fakeApp({ initial: { a: true, b: true }, deviceIds: ['a', 'b'], gone: ['b'] });
  const result = await app.cleanupGroupMissing(group);
  assert.equal(result.remaining, 1);
  await app._pollGroups(); // skipped: needs two devices, and must not throw
  assert.equal(group.devices.length, 1);
});
