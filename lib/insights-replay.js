'use strict';

// Rebuilds what an Activity monitor would have recorded from the power readings Homey's Insights logged before the
// monitor existed (or while the app was not running). The same ActivityEngine that watches the device live is run
// over the logged readings, on a scratch monitor with the real one's threshold, continuity and confirmation settings,
// so the cycles and periods come out by exactly the same rules. Insights keeps coarser readings than the live
// listener sees, so the result is an ESTIMATE: short cycles can be missed or merged, and energy is the power
// integrated over time, since Insights holds no meter reading here.
const { ActivityEngine, STANDBY } = require('./activity-engine');

const KWH_PER_WATT_SECOND = 1 / 3600000;

function scratchMonitorLike(monitor) {
  return {
    mode: undefined, threshold: monitor.threshold, continuityMinutes: monitor.continuityMinutes || 0, minConfirmationSeconds: monitor.minConfirmationSeconds || 0,
    state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
    cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 }
  };
}

// `entries` are { timestamp (ms), value (W) } oldest first; only those before `until` are used. Returns the rows to
// put in front of the monitor's own history, plus the totals they add. A cycle still open at the last entry is left
// out: the live listener is the one that knows whether it is still running.
function replayInsights(monitor, entries, until) {
  const scratch = scratchMonitorLike(monitor);
  const engine = new ActivityEngine();
  let energy = 0;
  let previous = null;
  let used = 0;
  for (const entry of entries) {
    if (!(entry.timestamp < until) || !Number.isFinite(entry.value)) continue;
    if (previous) {
      const seconds = (entry.timestamp - previous.timestamp) / 1000;
      if (seconds > 0) energy += Math.max(0, previous.value) * seconds * KWH_PER_WATT_SECOND;
    }
    engine.processSample(scratch, { power: entry.value, energy, timestamp: entry.timestamp });
    previous = entry;
    used += 1;
  }
  const totals = { ...scratch.totals, cycleCount: scratch.cycles.length };
  return { periods: scratch.periods, cycles: scratch.cycles, totals, readings: used, from: used ? scratch.periods[0]?.startedAt ?? entries[0].timestamp : null, to: previous ? previous.timestamp : null };
}

// Where the monitor's own recorded history starts: nothing from Insights may reach into it.
function liveHistoryStart(monitor, now = Date.now()) {
  const starts = [now, monitor.activeSince, monitor.lastSample?.timestamp, monitor.periods?.[0]?.startedAt, monitor.cycles?.[0]?.startedAt];
  return Math.min(...starts.filter(Number.isFinite));
}

const TOTAL_FIELDS = ['cycleCount', 'activeSeconds', 'standbySeconds', 'activeEnergy', 'standbyEnergy'];

// Applies a replay to the monitor, synchronously (nothing may change the monitor between reading where its history
// starts and writing in front of it). Once only, until the monitor is reset: the rows it adds age into the daily
// summaries like any other, so they could not be taken out again for a second run.
function applyBackfill(monitor, entries, { now = Date.now(), resolution } = {}) {
  if (monitor.insightsBackfill) throw new Error('This monitor already has history rebuilt from Homey Insights. Reset the monitor to do it again.');
  const result = replayInsights(monitor, entries, liveHistoryStart(monitor, now));
  if (!result.periods.length && !result.cycles.length) return { ...result, applied: false };
  monitor.periods = result.periods.concat(monitor.periods || []);
  monitor.cycles = result.cycles.concat(monitor.cycles || []);
  monitor.totals ||= { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 };
  for (const field of TOTAL_FIELDS) monitor.totals[field] = (monitor.totals[field] || 0) + result.totals[field];
  monitor.insightsBackfill = { from: result.from, to: result.to, at: now, resolution, cycles: result.cycles.length, totals: result.totals };
  return { ...result, applied: true };
}

module.exports = { replayInsights, liveHistoryStart, applyBackfill };
