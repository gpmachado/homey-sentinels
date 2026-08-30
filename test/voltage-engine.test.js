'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoltageEngine, NORMAL } = require('../lib/voltage-engine');

function monitor(overrides) {
  return Object.assign({ minVoltage: 110, maxVoltage: 130, stabilizedAt: null, state: NORMAL, eventSince: null, eventType: null, lastSample: null, events: [], periods: [] }, overrides);
}

test('the first-ever reading only establishes the reference, never fires an event', () => {
  const e = new VoltageEngine(); const m = monitor();
  const events = e.processSample(m, { voltage: 90, timestamp: 0 }); // already below the minimum
  assert.equal(events.length, 0);
  assert.equal(m.state, 'UNDERVOLTAGE');
});

test('fluctuating below the threshold fires "started" once, not on every sample', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 130, timestamp: 0 });
  const first = e.processSample(m, { voltage: 109, timestamp: 60000 });
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'started');
  const second = e.processSample(m, { voltage: 108, timestamp: 120000 });
  assert.equal(second.length, 0);
  const third = e.processSample(m, { voltage: 100, timestamp: 180000 });
  assert.equal(third.length, 0);
});

test('reports the min/max/average voltage observed across the whole episode on normalization', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 130, timestamp: 0 });
  e.processSample(m, { voltage: 109, timestamp: 60000 }); // started
  e.processSample(m, { voltage: 108, timestamp: 120000 });
  e.processSample(m, { voltage: 100, timestamp: 180000 });
  const events = e.processSample(m, { voltage: 125, timestamp: 240000 }); // normalized
  assert.equal(events[0].type, 'normalized');
  assert.equal(events[0].min_voltage, 100);
  assert.equal(events[0].max_voltage, 109);
  assert.equal(events[0].duration, 180);
});

test('a transition inside the stabilization window is silent but still tracked correctly', () => {
  const e = new VoltageEngine(); const m = monitor({ stabilizedAt: 100000 });
  e.processSample(m, { voltage: 130, timestamp: 0 });
  const duringStabilization = e.processSample(m, { voltage: 90, timestamp: 50000 }); // suppressed
  assert.equal(duringStabilization.length, 0);
  assert.equal(m.state, 'UNDERVOLTAGE');
  const afterStabilization = e.processSample(m, { voltage: 125, timestamp: 150000 }); // normalizes for real
  assert.equal(afterStabilization.length, 1);
  assert.equal(afterStabilization[0].type, 'normalized');
  assert.equal(afterStabilization[0].duration, 100);
});

test('overvoltage is tracked independently from undervoltage', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 120, timestamp: 0 });
  const events = e.processSample(m, { voltage: 140, timestamp: 60000 });
  assert.equal(events[0].eventType, 'OVERVOLTAGE');
});
