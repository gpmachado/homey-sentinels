'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startMemoryGuard, createReclaimer, MIN_RECLAIM_INTERVAL_MS, STARTUP_RECLAIM_MS } = require('../lib/memory-guard');
const { punctuationToAscii } = require('../lib/text');

function fakeHomey() {
  const homey = new EventEmitter();
  homey.intervals = [];
  homey.timeouts = [];
  homey.setInterval = (fn, ms) => { homey.intervals.push({ fn, ms }); return homey.intervals.length; };
  homey.clearInterval = () => {};
  homey.setTimeout = (fn, ms) => { homey.timeouts.push({ fn, ms }); return homey.timeouts.length; };
  homey.clearTimeout = () => {};
  return homey;
}

test('a memwarn logs the warning and reclaims heap pages, at most once per interval', () => {
  const logs = [];
  let clock = 1000;
  let collections = 0;
  const reclaim = createReclaimer({ log: (m) => logs.push(m), now: () => clock, gc: () => () => { collections += 1; } });
  assert.equal(reclaim('memwarn'), true);
  clock += 5000;
  assert.equal(reclaim('memwarn'), false); // a storm of warnings: rationed
  clock += MIN_RECLAIM_INTERVAL_MS;
  assert.equal(reclaim('interval'), true);
  assert.equal(collections, 2);
  assert.ok(logs.some((m) => m.startsWith('heap reclaimed (memwarn)')));
});

test('an unavailable collector is reported once and never throws', () => {
  const logs = [];
  let clock = 0;
  const reclaim = createReclaimer({ log: (m) => logs.push(m), now: () => clock, gc: () => null });
  assert.equal(reclaim('memwarn'), false);
  clock += MIN_RECLAIM_INTERVAL_MS + 1;
  assert.equal(reclaim('memwarn'), false);
  assert.equal(logs.filter((m) => m.includes('unavailable')).length, 1);
});

test('startMemoryGuard listens for memwarn/cpuwarn, sets a backstop interval, and can be stopped', () => {
  const homey = fakeHomey();
  const logs = [];
  const stop = startMemoryGuard(homey, { log: (m) => logs.push(m) });
  assert.equal(homey.listenerCount('memwarn'), 1);
  assert.equal(homey.listenerCount('cpuwarn'), 1);
  assert.equal(homey.intervals.length, 1);
  assert.equal(homey.timeouts.length, 1); // the one-off startup reclaim
  assert.equal(homey.timeouts[0].ms, STARTUP_RECLAIM_MS);
  homey.emit('memwarn', { count: 2, limit: 5 });
  homey.emit('cpuwarn', { count: 1, limit: 5 });
  homey.emit('memwarn', undefined); // a malformed payload must not throw
  assert.ok(logs.some((m) => m.includes('memory warning 2/5')));
  assert.ok(logs.some((m) => m.includes('CPU warning 1/5')));
  stop();
  assert.equal(homey.listenerCount('memwarn'), 0);
  assert.equal(homey.listenerCount('cpuwarn'), 0);
});

test('punctuationToAscii maps typographic punctuation and leaves Latin-1 letters alone', () => {
  assert.equal(punctuationToAscii('Bomba do poço — desligada… “ok”'), 'Bomba do poço - desligada... "ok"');
  assert.equal(punctuationToAscii('plain'), 'plain');
  assert.equal(punctuationToAscii(undefined), undefined);
});
