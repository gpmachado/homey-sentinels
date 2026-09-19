'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceDirectory } = require('../lib/device-directory');

function setup(overrides = {}) {
  const calls = { list: 0 };
  let clock = 1000;
  const tasks = [];
  const gateway = { listDevices: async () => { calls.list += 1; return [{ id: 'a' }, { id: 'b' }]; }, ...overrides.gateway };
  const directory = new DeviceDirectory({
    gateway, now: () => clock, defer: (fn) => tasks.push(fn), log: () => {}, error: overrides.error || (() => {}), onRefreshed: overrides.onRefreshed || null
  });
  return { directory, calls, tasks, advance: (ms) => { clock += ms; } };
}

test('nothing is read until something asks, and request() never touches the gateway on the caller stack', () => {
  const { directory, calls, tasks } = setup();
  assert.deepEqual(directory.list(), []);
  assert.equal(directory.hasLoaded(), false);
  assert.equal(directory.request(), true);
  assert.equal(calls.list, 0); // deferred: the read has not started yet
  assert.equal(tasks.length, 1);
  assert.equal(directory.isLoading(), true);
});

test('a deferred read fills the list and marks it loaded; further requests are ignored while it is fresh', async () => {
  const { directory, calls, tasks, advance } = setup();
  directory.request();
  await tasks[0]();
  assert.equal(calls.list, 1);
  assert.equal(directory.list().length, 2);
  assert.equal(directory.hasLoaded(), true);
  assert.equal(directory.isLoading(), false);
  assert.equal(directory.request(), false);
  advance(60 * 1000);
  assert.equal(directory.request(2 * 60 * 1000), false);
  assert.equal(directory.request(30 * 1000), true); // asked for something fresher than what it has
});

test('concurrent requests share one read', async () => {
  const { directory, calls, tasks } = setup();
  assert.equal(directory.request(), true);
  assert.equal(directory.request(0), true);
  assert.equal(tasks.length, 1);
  await tasks[0]();
  assert.equal(calls.list, 1);
});

test('a failed read keeps the previous list, reports the error, and is retried by the next request', async () => {
  const errors = [];
  let fail = false;
  const { directory, tasks, advance } = setup({ error: (message) => errors.push(message), gateway: { listDevices: async () => { if (fail) throw new Error('offline'); return [{ id: 'a' }]; } } });
  directory.request();
  await tasks[0]();
  assert.equal(directory.list().length, 1);
  advance(11 * 60 * 1000); // the list is now stale
  fail = true;
  assert.equal(directory.request(), true);
  await tasks[1]();
  assert.equal(directory.list().length, 1); // the old list is kept
  assert.equal(errors.length, 1);
  assert.equal(directory.isLoading(), false);
  fail = false;
  assert.equal(directory.request(), true); // still stale, so the next request retries
});

test('ensure() waits for the read, and onRefreshed runs after each one', async () => {
  let refreshed = 0;
  let clock = 0;
  const directory = new DeviceDirectory({ gateway: { listDevices: async () => [{ id: 'x' }] }, defer: (fn) => setTimeout(fn, 0), now: () => clock, onRefreshed: () => { refreshed += 1; } });
  const list = await directory.ensure();
  assert.deepEqual(list, [{ id: 'x' }]);
  assert.equal(refreshed, 1);
  assert.deepEqual(await directory.ensure(), [{ id: 'x' }]);
  assert.equal(refreshed, 1); // still fresh: no second read
  assert.equal(directory.status().count, 1);
});
