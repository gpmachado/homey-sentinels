'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resumeWithRetry, DEFAULT_DELAYS_MS } = require('../lib/resume');

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a start that works is not retried and logs nothing extra', async () => {
  const logs = [];
  const scheduled = [];
  resumeWithRetry({ label: '[A]', start: async () => {}, schedule: (fn, ms) => scheduled.push({ fn, ms }), log: (m) => logs.push(m) });
  await flush();
  assert.deepEqual(scheduled, []);
  assert.deepEqual(logs, []);
});

test('a failing start is retried with growing waits until it works, then reports how many retries it took', async () => {
  const logs = [];
  const errors = [];
  const scheduled = [];
  let failures = 3;
  resumeWithRetry({
    label: '[Voltagem A]', start: async () => { if (failures > 0) { failures -= 1; throw new Error('device not ready'); } },
    schedule: (fn, ms) => scheduled.push({ fn, ms }), log: (m) => logs.push(m), error: (m) => errors.push(m)
  });
  await flush();
  for (let i = 0; i < 3; i += 1) { assert.equal(scheduled.length, i + 1); scheduled[i].fn(); await flush(); }
  assert.deepEqual(scheduled.map((s) => s.ms), DEFAULT_DELAYS_MS.slice(0, 3));
  assert.equal(errors.length, 3);
  assert.match(errors[0], /device not ready.*retrying in 10 s/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /after 3 retries/);
  assert.equal(scheduled.length, 3); // no further attempt once it worked
});

test('the wait stops growing at the last value', async () => {
  const scheduled = [];
  resumeWithRetry({ label: '[X]', start: async () => { throw new Error('down'); }, schedule: (fn, ms) => scheduled.push({ fn, ms }), delays: [1000, 2000] });
  await flush();
  for (let i = 0; i < 4; i += 1) { scheduled[i].fn(); await flush(); }
  assert.deepEqual(scheduled.map((s) => s.ms), [1000, 2000, 2000, 2000, 2000]);
});

test('retries end when the monitor was deleted in the meantime', async () => {
  const scheduled = [];
  let wanted = true;
  resumeWithRetry({ label: '[Gone]', start: async () => { throw new Error('nope'); }, isStillWanted: () => wanted, schedule: (fn, ms) => scheduled.push({ fn, ms }) });
  await flush();
  assert.equal(scheduled.length, 1);
  wanted = false;
  scheduled[0].fn();
  await flush();
  assert.equal(scheduled.length, 1);
});

test('a device that stays "not found" stops the retries after the configured attempts and reports it once', async () => {
  const errors = [];
  const scheduled = [];
  const gaveUp = [];
  const notFound = () => Object.assign(new Error('Not Found: Device with ID x'), { statusCode: 404 });
  resumeWithRetry({
    label: '[Bomba]', start: async () => { throw notFound(); },
    schedule: (fn, ms) => scheduled.push({ fn, ms }), error: (m) => errors.push(m),
    shouldGiveUp: (failure, attempt) => failure.statusCode === 404 && attempt >= 2, onGiveUp: () => gaveUp.push(true)
  });
  await flush();
  for (let i = 0; i < 2; i += 1) { scheduled[i].fn(); await flush(); }
  assert.equal(scheduled.length, 2); // retried twice, then the third failure gave up: no third wait
  assert.deepEqual(gaveUp, [true]);
  assert.match(errors[errors.length - 1], /gave up watching.*after 3 attempts/);
});

test('other failures are retried without limit, and onStarted is called when the start works', async () => {
  const scheduled = [];
  let started = 0;
  let failures = 6;
  resumeWithRetry({
    label: '[A]', start: async () => { if (failures > 0) { failures -= 1; throw new Error('busy'); } },
    schedule: (fn, ms) => scheduled.push({ fn, ms }), shouldGiveUp: (failure) => failure.statusCode === 404, onStarted: () => { started += 1; }
  });
  await flush();
  for (let i = 0; i < 6; i += 1) { scheduled[i].fn(); await flush(); }
  assert.equal(started, 1);
  assert.equal(scheduled.length, 6);
});
