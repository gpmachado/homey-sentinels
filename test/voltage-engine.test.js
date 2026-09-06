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

test('samples within the bucket window and the same state merge into one period, preserving true min/max', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 121, timestamp: 5000 }); // creates the period (holds 120 for [0,5000))
  e.processSample(m, { voltage: 119, timestamp: 10000 }); // same state, within 60s of the period's start — merges
  e.processSample(m, { voltage: 122, timestamp: 55000 }); // still within 60s of the period's start — merges
  assert.equal(m.periods.length, 1);
  assert.deepEqual(m.periods[0], { startedAt: 0, endedAt: 55000, seconds: 55, state: 'NORMAL', minVoltage: 119, maxVoltage: 121, voltageSum: 360, sampleCount: 3 });
});

test('a sample past the bucket window starts a new period instead of merging', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 121, timestamp: 5000 });
  e.processSample(m, { voltage: 122, timestamp: 65000 }); // 65s after the period started — past the 60s bucket
  assert.equal(m.periods.length, 2);
  assert.equal(m.periods[1].startedAt, 5000);
});

test('once the abnormal reading itself gets attributed to a period, it starts a fresh one instead of extending into the NORMAL history before it', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 121, timestamp: 5000 }); // still NORMAL — 120/121 may coalesce, neither was ever the anomalous reading
  const started = e.processSample(m, { voltage: 90, timestamp: 8000 }); // UNDERVOLTAGE starts (eventSince = 8000)
  assert.equal(started[0].type, 'started');
  // The 90V reading itself only becomes part of a period on the *next* sample (a period always
  // represents how long the *previous* reading was held) — that's where the boundary actually
  // has to hold: this new period must start exactly at eventSince, not merge into whatever
  // came before the transition.
  e.processSample(m, { voltage: 88, timestamp: 9000 });
  const lastPeriod = m.periods[m.periods.length - 1];
  assert.equal(lastPeriod.state, 'UNDERVOLTAGE');
  assert.equal(lastPeriod.startedAt, 8000);
  assert.equal(lastPeriod.minVoltage, 90);
});

test('an episode\'s reported min/max reflects the true extreme even when readings inside it get bucketed together', () => {
  const e = new VoltageEngine(); const m = monitor();
  e.processSample(m, { voltage: 120, timestamp: 0 });
  e.processSample(m, { voltage: 105, timestamp: 5000 }); // UNDERVOLTAGE starts
  e.processSample(m, { voltage: 90, timestamp: 8000 }); // sharp dip, same episode, bucketed together
  e.processSample(m, { voltage: 108, timestamp: 10000 }); // recovers a bit but still under — still bucketed
  const normalized = e.processSample(m, { voltage: 125, timestamp: 15000 }); // back to normal, closes immediately (no stabilization configured)
  assert.equal(normalized[0].type, 'normalized');
  assert.equal(normalized[0].min_voltage, 90); // the true dip, not an averaged-away value
  assert.equal(normalized[0].max_voltage, 108);
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
