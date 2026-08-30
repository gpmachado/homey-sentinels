'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityEngine, ACTIVE, STANDBY, median, average, humanDuration } = require('../lib/activity-engine');

function monitor(overrides) {
  return Object.assign({ threshold: 50, continuityMinutes: 0, minConfirmationSeconds: 0, state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null, cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 } }, overrides);
}
test('classifies a threshold exactly as standby', () => { const e = new ActivityEngine(); const m = monitor(); e.processSample(m, { power: 50, timestamp: 0 }); assert.equal(m.state, STANDBY); });
test('records a complete active cycle', () => { const e = new ActivityEngine(); const m = monitor(); e.processSample(m, { power: 10, timestamp: 0 }); assert.equal(e.processSample(m, { power: 100, timestamp: 60000 })[0].type, 'started'); const events = e.processSample(m, { power: 10, timestamp: 180000 }); assert.equal(m.state, STANDBY); assert.equal(m.totals.cycleCount, 1); assert.equal(m.totals.activeSeconds, 120); assert.equal(events[0].duration, 120); });
test('keeps timestamped periods for trend comparisons', () => { const e = new ActivityEngine(); const m = monitor(); e.processSample(m, { power: 10, timestamp: 0 }); e.processSample(m, { power: 100, timestamp: 60000 }); assert.equal(m.periods.length, 1); assert.equal(m.periods[0].state, STANDBY); });
test('a negative energy delta (meter reset) is flagged on the period and still clamped to zero, not counted as negative consumption', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.processSample(m, { power: 10, energy: 100, timestamp: 0 });
  e.processSample(m, { power: 10, energy: 3, timestamp: 60000 }); // meter was reset/replaced between these two reads
  assert.equal(m.periods[0].meterReset, true);
  assert.equal(m.periods[0].energy, 0); // clamped, not -97
  assert.equal(m.totals.standbyEnergy, 0);
});
test('a normal, positive energy delta is not flagged as a meter reset', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.processSample(m, { power: 10, energy: 100, timestamp: 0 });
  e.processSample(m, { power: 10, energy: 100.05, timestamp: 60000 });
  assert.equal(m.periods[0].meterReset, false);
  assert.ok(Math.abs(m.periods[0].energy - 0.05) < 1e-9);
});
test('discards a multi-hour gap instead of counting it as standby time', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.processSample(m, { power: 10, timestamp: 0 });
  const sixHoursLater = 6 * 60 * 60 * 1000;
  e.processSample(m, { power: 10, timestamp: sixHoursLater });
  assert.equal(m.totals.standbySeconds, 0);
  assert.equal(m.periods.length, 0);
});
test('restarts an active cycle after a gap instead of reporting a multi-hour duration', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.processSample(m, { power: 10, timestamp: 0 });
  e.processSample(m, { power: 100, timestamp: 60000 }); // activity_started at t=60s
  const sixHoursLater = 60000 + 6 * 60 * 60 * 1000;
  e.processSample(m, { power: 100, timestamp: sixHoursLater }); // still active after the gap
  const events = e.processSample(m, { power: 10, timestamp: sixHoursLater + 60000 }); // finishes 1 minute after reconnecting
  assert.equal(events[0].type, 'finished');
  assert.equal(events[0].duration, 60);
});
test('reports average and peak power/current for a finished cycle', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.processSample(m, { power: 10, current: 0.1, timestamp: 0 });
  e.processSample(m, { power: 100, current: 1, timestamp: 60000 }); // started
  e.processSample(m, { power: 200, current: 2, timestamp: 120000 }); // still active, opens a period at power=100/current=1
  const events = e.processSample(m, { power: 10, current: 0.1, timestamp: 180000 }); // finished, closes a period at power=200/current=2
  const finished = events[0];
  assert.equal(finished.type, 'finished');
  assert.equal(finished.average_power, 150);
  assert.equal(finished.max_power, 200);
  assert.equal(finished.average_current, 1.5);
  assert.equal(finished.max_current, 2);
});
test('a brief drop within the continuity window does not end the session', () => {
  const e = new ActivityEngine(); const m = monitor({ continuityMinutes: 5 });
  e.processSample(m, { power: 10, timestamp: 0 });
  e.processSample(m, { power: 100, timestamp: 60000 }); // started
  const dropEvents = e.processSample(m, { power: 10, timestamp: 120000 }); // drops, but within the 5min window
  assert.equal(dropEvents.length, 1);
  assert.equal(dropEvents[0].type, 'continuity_pending');
  assert.equal(m.state, ACTIVE);
  const recoverEvents = e.processSample(m, { power: 100, timestamp: 180000 }); // recovers before the window expires
  assert.equal(recoverEvents.length, 0);
  assert.equal(m.state, ACTIVE);
  assert.equal(m.pendingStandbySince, null);
});
test('finalizes the cycle once the continuity window actually expires, backdated to when power dropped', () => {
  const e = new ActivityEngine(); const m = monitor({ continuityMinutes: 5 });
  e.processSample(m, { power: 10, timestamp: 0 });
  e.processSample(m, { power: 100, timestamp: 60000 }); // started at t=60s
  e.processSample(m, { power: 10, timestamp: 120000 }); // drops at t=120s, pending
  const events = e.processSample(m, { power: 10, timestamp: 120000 + 6 * 60000 }); // still low 6min later — past the 5min window
  assert.equal(events[0].type, 'finished');
  assert.equal(events[0].duration, 60); // 120s - 60s = 60s, not counting the wait
  assert.equal(m.state, STANDBY);
});
test('finalizePendingStandby resolves a stuck pending state via a timer, with no further sample', () => {
  const e = new ActivityEngine(); const m = monitor({ continuityMinutes: 5 });
  e.processSample(m, { power: 10, timestamp: 0 });
  e.processSample(m, { power: 100, timestamp: 60000 }); // started
  e.processSample(m, { power: 10, timestamp: 120000 }); // drops, pending
  const tooEarly = e.finalizePendingStandby(m, 120000 + 60000); // only 1 of 5 minutes elapsed
  assert.equal(tooEarly.length, 0);
  assert.equal(m.state, ACTIVE);
  const events = e.finalizePendingStandby(m, 120000 + 6 * 60000); // 6 minutes elapsed
  assert.equal(events[0].type, 'finished');
  assert.equal(events[0].duration, 60);
  assert.equal(m.state, STANDBY);
});
test('a brief spike above threshold within the confirmation window is ignored as noise', () => {
  const e = new ActivityEngine(); const m = monitor({ minConfirmationSeconds: 30 });
  e.processSample(m, { power: 10, timestamp: 0 });
  const spikeEvents = e.processSample(m, { power: 100, timestamp: 5000 }); // spikes, but under the 30s window
  assert.equal(spikeEvents.length, 0);
  assert.equal(m.state, STANDBY);
  const dropEvents = e.processSample(m, { power: 10, timestamp: 10000 }); // drops back before confirming — was noise
  assert.equal(dropEvents.length, 0);
  assert.equal(m.state, STANDBY);
  assert.equal(m.pendingActiveSince, null);
});
test('confirms activity once the crossing holds past the confirmation window, backdated to the original crossing', () => {
  const e = new ActivityEngine(); const m = monitor({ minConfirmationSeconds: 30 });
  e.processSample(m, { power: 10, timestamp: 0 });
  e.processSample(m, { power: 100, timestamp: 5000 }); // crosses at t=5s, pending
  const events = e.processSample(m, { power: 100, timestamp: 40000 }); // still high 35s later — past the 30s window
  assert.equal(events[0].type, 'started');
  assert.equal(events[0].timestamp, 5000); // backdated to the original crossing, not to the confirmation instant
  assert.equal(m.state, ACTIVE);
  assert.equal(m.pendingActiveSince, null);
});
test('combined continuity and confirmation thresholds: the longer one governs the standby transition', () => {
  const e = new ActivityEngine(); const m = monitor({ continuityMinutes: 1, minConfirmationSeconds: 300 }); // 60s vs 300s
  e.processSample(m, { power: 10, timestamp: 0 });
  e.processSample(m, { power: 100, timestamp: 1000 }); // crosses, pending confirmation (also gated by minConfirmationSeconds)
  e.processSample(m, { power: 100, timestamp: 1000 + 301000 }); // held past the 300s confirmation window — now ACTIVE
  assert.equal(m.state, ACTIVE);
  const dropAt = 1000 + 301000 + 1000;
  e.processSample(m, { power: 10, timestamp: dropAt }); // drops, pending standby
  const tooEarly = e.processSample(m, { power: 10, timestamp: dropAt + 61000 }); // past the 60s continuity window, but not the 300s confirmation
  assert.equal(tooEarly.length, 0);
  assert.equal(m.state, ACTIVE);
  const events = e.processSample(m, { power: 10, timestamp: dropAt + 301000 }); // past both
  assert.equal(events[0].type, 'finished');
  assert.equal(m.state, STANDBY);
});

test('startNow immediately confirms activity, bypassing minConfirmationSeconds — for on/off-only devices with no numeric signal', () => {
  const e = new ActivityEngine(); const m = monitor({ minConfirmationSeconds: 300 });
  const events = e.startNow(m, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'started');
  assert.equal(events[0].timestamp, 1000);
  assert.equal(events[0].power, null); // no numeric sample was ever recorded
  assert.equal(m.state, ACTIVE);
  assert.equal(m.totals.cycleCount, 1);
});
test('startNow does not retroactively tag the stale pre-transition gap as active — confirmed live: a manual start left a ~1000s mostly-standby gap flagged ACTIVE, inflating active_duration/active_energy 2-3x for a single cycle', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.processSample(m, { power: 9, energy: 1, timestamp: 0 }); // last real reading before a long quiet gap
  e.startNow(m, 900000); // manual start, 900s later — nothing sampled in between
  e.processSample(m, { power: 200, energy: 1.06, timestamp: 960000 }); // first real reading after start, genuinely active
  const events = e.processSample(m, { power: 9, energy: 1.09, timestamp: 1500000 }); // drops back to standby
  assert.equal(events[0].type, 'finished');
  // The 900s gap belongs to standby (that's what was actually true throughout it), not active.
  const gapPeriod = m.periods.find((p) => p.startedAt === 0 && p.endedAt === 900000);
  assert.equal(gapPeriod.state, STANDBY);
  assert.equal(gapPeriod.seconds, 900);
  // Active periods now cover exactly the cycle's own span (900000→1500000 = 600s),
  // matching cycles[0].duration/energy exactly instead of over-counting by the stale gap.
  const activePeriods = m.periods.filter((p) => p.state === ACTIVE);
  const activeSeconds = activePeriods.reduce((sum, p) => sum + p.seconds, 0);
  const activeEnergy = activePeriods.reduce((sum, p) => sum + (p.energy || 0), 0);
  assert.equal(activeSeconds, 600);
  assert.equal(m.cycles[0].duration, 600);
  assert.ok(Math.abs(activeEnergy - m.cycles[0].energy) < 1e-9);
});
test('startNow is a no-op when already active', () => {
  const e = new ActivityEngine(); const m = monitor();
  e.startNow(m, 1000);
  const events = e.startNow(m, 2000);
  assert.equal(events.length, 0);
  assert.equal(m.totals.cycleCount, 1); // did not start a second cycle
});
test('stopNow immediately finalizes the cycle, bypassing continuity/confirmation windows', () => {
  const e = new ActivityEngine(); const m = monitor({ continuityMinutes: 30, minConfirmationSeconds: 300 });
  e.startNow(m, 1000);
  const events = e.stopNow(m, 61000); // 60s later — would still be well within either grace window
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'finished');
  assert.equal(events[0].duration, 60);
  assert.equal(m.state, STANDBY);
});
test('stopNow is a no-op when already in standby', () => {
  const e = new ActivityEngine(); const m = monitor();
  const events = e.stopNow(m, 1000);
  assert.equal(events.length, 0);
  assert.equal(m.state, STANDBY);
});

test('median returns null for an empty list, the middle value for odd counts, and the average of the two middle values for even counts', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
test('median is robust to a single outlier, unlike average', () => {
  const typical = [100, 105, 98, 102, 101];
  const withOutlier = typical.concat([3600]); // one wildly long cycle
  assert.equal(median(withOutlier), 101.5);
  assert.ok(average(withOutlier) > 500); // the mean gets dragged far from what's actually typical
});

function stateMonitor(overrides) {
  return Object.assign(monitor({ threshold: undefined }), { mode: 'state' }, overrides);
}
function manualMonitor(overrides) {
  return Object.assign(monitor({ threshold: null }), { mode: 'manual' }, overrides);
}
test('a manual monitor never transitions on its own — even a huge power reading is ignored until startNow/stopNow', () => {
  const e = new ActivityEngine(); const m = manualMonitor();
  e.processSample(m, { power: 5000, timestamp: 0 });
  e.processSample(m, { power: 5000, timestamp: 60000 });
  assert.equal(m.state, STANDBY);
  assert.equal(m.totals.cycleCount, 0);
  const startEvents = e.startNow(m, 120000);
  assert.equal(startEvents[0].type, 'started');
  assert.equal(m.state, ACTIVE);
  // Still ignores power samples while active — a drop to 0 doesn't end the cycle on its own.
  e.processSample(m, { power: 0, timestamp: 180000 });
  assert.equal(m.state, ACTIVE);
  const stopEvents = e.stopNow(m, 240000);
  assert.equal(stopEvents[0].type, 'finished');
  assert.equal(m.state, STANDBY);
});
test('a manual monitor still tracks power/current/energy into periods while active, for stats', () => {
  const e = new ActivityEngine(); const m = manualMonitor();
  e.processSample(m, { power: 5, energy: 1, timestamp: 0 });
  e.startNow(m, 60000);
  e.processSample(m, { power: 500, current: 4, energy: 1.05, timestamp: 120000 });
  const events = e.stopNow(m, 180000);
  assert.equal(events[0].type, 'finished');
  assert.equal(m.cycles.length, 1);
  assert.ok(Math.abs(m.cycles[0].energy - 0.05) < 1e-9);
});
test('a state monitor ignores threshold entirely — true is active, false is standby', () => {
  const e = new ActivityEngine(); const m = stateMonitor();
  e.processSample(m, { power: false, timestamp: 0 });
  assert.equal(m.state, STANDBY);
  const events = e.processSample(m, { power: true, timestamp: 60000 });
  assert.equal(events[0].type, 'started');
  assert.equal(m.state, ACTIVE);
});
test('humanDuration shows seconds under a minute instead of always rounding to "0 min" — a door session is often shorter than that', () => {
  assert.equal(humanDuration(6), '6s');
  assert.equal(humanDuration(59), '59s');
  assert.equal(humanDuration(60), '1 min');
  assert.equal(humanDuration(90), '2 min');
  assert.equal(humanDuration(3660), '1 h 1 min');
});
test('a state monitor records a full session with duration, same as a power monitor cycle', () => {
  const e = new ActivityEngine(); const m = stateMonitor();
  e.processSample(m, { power: false, timestamp: 0 });
  e.processSample(m, { power: true, timestamp: 60000 }); // opened
  const events = e.processSample(m, { power: false, timestamp: 300000 }); // closed 4 minutes later
  assert.equal(events[0].type, 'finished');
  assert.equal(events[0].duration, 240);
  assert.equal(m.cycles.length, 1);
  assert.equal(m.totals.cycleCount, 1);
});
