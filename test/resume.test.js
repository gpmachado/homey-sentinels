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
