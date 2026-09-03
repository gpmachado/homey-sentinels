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

test('entering an abnormal state fires immediately even with a stabilization window configured — only the return to normal waits', () => {
  const e = new VoltageEngine(); const m = monitor({ stabilizationMinutes: 5 });
  e.processSample(m, { voltage: 120, timestamp: 0 });
  const events = e.processSample(m, { voltage: 140, timestamp: 60000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'started');
  assert.equal(m.state, 'OVERVOLTAGE');
});

test('a reading back in range does not close the episode until it holds for stabilizationMinutes', () => {
  const e = new VoltageEngine(); const m = monitor({ stabilizationMinutes: 5 });
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 140, timestamp: 60000 }); // overvoltage starts
  const backInRange = e.processSample(m, { voltage: 125, timestamp: 120000 });
  assert.equal(backInRange.length, 1);
  assert.equal(backInRange[0].type, 'continuity_pending');
  assert.equal(m.state, 'OVERVOLTAGE'); // episode stays open during the wait
});

test('a bounce back out of range during the grace window cancels the pending confirmation instead of closing the episode', () => {
  const e = new VoltageEngine(); const m = monitor({ stabilizationMinutes: 5 });
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 140, timestamp: 60000 }); // overvoltage starts
  e.processSample(m, { voltage: 125, timestamp: 120000 }); // pending confirmation starts
  const bounceBack = e.processSample(m, { voltage: 140, timestamp: 150000 }); // still overvoltage — noise, not recovery
  assert.equal(bounceBack.length, 0);
  assert.equal(m.pendingNormalSince, null);
  assert.equal(m.state, 'OVERVOLTAGE');
});

test('closing after the grace window elapses backdates duration/min/max to the actual recovery instant, excluding the confirmation wait', () => {
  const e = new VoltageEngine(); const m = monitor({ stabilizationMinutes: 5 });
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 140, timestamp: 60000 }); // overvoltage starts (eventSince = 60000)
  e.processSample(m, { voltage: 125, timestamp: 120000 }); // recovery reading, pendingNormalSince = 120000
  // Still just a normal-range confirmation sample, not yet counted as part of the episode.
  const stillWaiting = e.processSample(m, { voltage: 128, timestamp: 300000 }); // 3 min after pending — not 5 yet
  assert.equal(stillWaiting.length, 0);
  const closed = e.processSample(m, { voltage: 129, timestamp: 420000 }); // 5 min after pending (120000 + 300000)
  assert.equal(closed.length, 1);
  assert.equal(closed[0].type, 'normalized');
  assert.equal(closed[0].duration, 60); // 120000 - 60000, not inflated by the 5-minute wait
  assert.equal(closed[0].max_voltage, 140);
  assert.equal(m.state, 'NORMAL');
});

test('finalizePendingNormal closes a stuck pending confirmation via a timer, with no further sample', () => {
  const e = new VoltageEngine(); const m = monitor({ stabilizationMinutes: 5 });
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 140, timestamp: 60000 });
  e.processSample(m, { voltage: 125, timestamp: 120000 }); // pendingNormalSince = 120000
  const tooSoon = e.finalizePendingNormal(m, 300000); // only 3 minutes later
  assert.equal(tooSoon.length, 0);
  const events = e.finalizePendingNormal(m, 420000); // 5 minutes after pendingNormalSince
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'normalized');
  assert.equal(m.state, 'NORMAL');
});
