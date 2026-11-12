'use strict';

// How long history is kept and how old detail is condensed. Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { ACTIVE } = require('../activity-engine');
const { VOLTAGE_BUCKET_MS } = require('../voltage-engine');
const { startOfLocalDay, localDateKey } = require('../time');

// The local-midnight boundary a period is folded on is only ever a few hours after its own
// start (activity-engine discards any gap over 4h instead of recording a period for it), so
// a period spans at most one midnight — but crediting it whole to its start day would still
// misattribute a real chunk of an overnight standby/active period. Splits it at each local
// midnight it crosses and prorates seconds/energy by the time-fraction in each day.
function splitPeriodByLocalDay(period, timeZone) {
  const { startedAt, endedAt, seconds, energy } = period;
  const totalSeconds = seconds || Math.max(0, (endedAt - startedAt) / 1000);
  if (!(totalSeconds > 0)) return [{ date: localDateKey(new Date(startedAt), timeZone), seconds: 0, energy: 0 }];
  const segments = [];
  let cursor = startedAt;
  while (cursor < endedAt) {
    const nextMidnight = startOfLocalDay(new Date(cursor + 24 * 60 * 60 * 1000), timeZone).getTime();
    const segmentEnd = Math.min(endedAt, nextMidnight);
    const segmentSeconds = (segmentEnd - cursor) / 1000;
    segments.push({ date: localDateKey(new Date(cursor), timeZone), seconds: segmentSeconds, energy: (energy || 0) * (segmentSeconds / totalSeconds) });
    cursor = segmentEnd;
  }
  return segments;
}

// Time-Machine-style retention, not Home-Assistant-style indefinite raw history: full
// per-sample detail for the last week (never needed further back — "week" statistics are
// always a 7-day rolling window), condensed into one daily summary per calendar day beyond
// that, dropped entirely past 90 days. cycles[] (one entry per activity session, already
// compact) is never pruned — it's what keeps cycle_count and power/current stats exact for
// "month"/"all" queries regardless of how much period detail behind them has been condensed.
const GRANULAR_RETENTION_DAYS = 7;
const TOTAL_RETENTION_DAYS = 90;
// Cycles feed the power/median/cycle-count stats for month and "all" (see statistics.js), so they
// outlive the 90-day period summaries — but not forever: each one is ~150 bytes in the one blob
// rewritten on every save, and a busy monitor adds dozens per day. totals.cycleCount stays
// lifetime, so the "all" cycle count doesn't regress when old cycles are dropped.
const CYCLE_RETENTION_DAYS = 365;

// Merges adjacent same-state voltage periods that start within VOLTAGE_BUCKET_MS of the bucket's
// first period — the same rule VoltageEngine#processSample applies to new samples, applied to
// periods already stored under the older, finer bucket size so they shrink right away instead
// of only as they age out of the granular window. Periods in the legacy single-`voltage` shape
// (pre-bucketing) are left alone.
function compactVoltagePeriods(periods) {
  const merged = [];
  let current = null;
  for (const period of periods) {
    const bucketed = Number.isFinite(period.minVoltage) && Number.isFinite(period.maxVoltage) && Number.isFinite(period.voltageSum) && Number.isFinite(period.sampleCount);
    if (current && bucketed && current.bucketed && current.state === period.state && (period.startedAt - current.startedAt) < VOLTAGE_BUCKET_MS) {
      current.endedAt = Math.max(current.endedAt, period.endedAt);
      current.seconds += period.seconds;
      current.minVoltage = Math.min(current.minVoltage, period.minVoltage);
      current.maxVoltage = Math.max(current.maxVoltage, period.maxVoltage);
      current.voltageSum += period.voltageSum;
      current.sampleCount += period.sampleCount;
    } else {
      current = { ...period, bucketed };
      merged.push(current);
    }
  }
  return merged.map(({ bucketed, ...period }) => period);
}

const retentionMethods = {
  // Folds periods older than GRANULAR_RETENTION_DAYS into one dailySummaries[] entry per
  // calendar day (in `timeZone`), then drops the now-redundant raw periods and anything in
  // dailySummaries past TOTAL_RETENTION_DAYS. Meant to run occasionally (once at startup, then
  // every few hours) — not on every sample, since it's a bulk pass over the whole array.
  // Shared by activity monitors and state monitors — both fold periods the same way (they're
  // the same engine, see activity-engine.js's stateFor()). A state monitor's periods just
  // never carry a meaningful energy value, so activeEnergy/standbyEnergy end up 0 for it,
  // same as if energy had genuinely been zero the whole time — harmless, and simpler than
  // maintaining a second fold shape for one missing field.
  _foldActivityLikeMonitors(monitors, granularCutoff, totalCutoffKey, timeZone, changed) {
    for (const monitor of Object.values(monitors)) {
      monitor.dailySummaries ||= [];
      const toFold = (monitor.periods || []).filter((period) => period.endedAt < granularCutoff);
      if (toFold.length) {
        const byDay = {};
        for (const period of toFold) {
          for (const segment of splitPeriodByLocalDay(period, timeZone)) {
            byDay[segment.date] ||= { date: segment.date, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0, meterResetCount: 0 };
            const bucket = byDay[segment.date];
            if (period.state === ACTIVE) { bucket.activeSeconds += segment.seconds; bucket.activeEnergy += segment.energy; }
            else { bucket.standbySeconds += segment.seconds; bucket.standbyEnergy += segment.energy; }
            // A reset is a property of the whole period, not something to prorate across a
            // midnight split — tag every day the period touches, same as the old app's
            // "credit the whole gap/reset to each day it spans" approach.
            if (period.meterReset) bucket.meterResetCount += 1;
          }
        }
        for (const key of Object.keys(byDay)) {
          const existing = monitor.dailySummaries.find((day) => day.date === key);
          if (existing) {
            existing.activeSeconds += byDay[key].activeSeconds; existing.standbySeconds += byDay[key].standbySeconds;
            existing.activeEnergy += byDay[key].activeEnergy; existing.standbyEnergy += byDay[key].standbyEnergy;
            existing.meterResetCount = (existing.meterResetCount || 0) + byDay[key].meterResetCount;
          } else {
            monitor.dailySummaries.push(byDay[key]);
          }
        }
        monitor.periods = (monitor.periods || []).filter((period) => period.endedAt >= granularCutoff);
        changed.add(monitor.id);
      }
      monitor.dailySummaries = monitor.dailySummaries.filter((day) => day.date >= totalCutoffKey);
    }
  },
  // Returns how many monitors had rows folded, dropped or merged. Only their series are rewritten at the next
  // save: rewriting every series on every pass (at each start and every 6 h) cost a full write of the history.
  consolidateHistory(timeZone, now = Date.now()) {
    const changed = new Set();
    const granularCutoff = now - GRANULAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const totalCutoffKey = localDateKey(new Date(now - TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000), timeZone);
    this._foldActivityLikeMonitors(this.data.monitors, granularCutoff, totalCutoffKey, timeZone, changed);
    this._foldActivityLikeMonitors(this.data.stateMonitors, granularCutoff, totalCutoffKey, timeZone, changed);
    const cycleCutoff = now - CYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const monitor of [...Object.values(this.data.monitors), ...Object.values(this.data.stateMonitors)]) {
      if (monitor.cycles?.length && monitor.cycles[0].endedAt < cycleCutoff) {
        monitor.cycles = monitor.cycles.filter((cycle) => cycle.endedAt >= cycleCutoff);
        changed.add(monitor.id);
      }
    }
    // Same retention shape as activity monitors, but simpler: a voltage sample is a single
    // point-in-time reading (no duration/energy to prorate across a midnight it might span),
    // so folding it just needs the min/max observed per calendar day — no per-sample average
    // tracking, which would otherwise mean carrying a sum+count pair for the life of the app.
    for (const monitor of Object.values(this.data.voltageMonitors)) {
      monitor.dailySummaries ||= [];
      if (monitor.periods?.length) {
        const compacted = compactVoltagePeriods(monitor.periods);
        if (compacted.length !== monitor.periods.length) changed.add(monitor.id);
        monitor.periods = compacted;
      }
      // minVoltage/maxVoltage per period (see VoltageEngine#processSample's bucketing) — falls
      // back to the older single-`voltage`-per-period shape for anything still stored that way.
      const toFold = (monitor.periods || []).filter((period) => period.endedAt < granularCutoff && (Number.isFinite(period.minVoltage) || Number.isFinite(period.voltage)));
      if (toFold.length) {
        const byDay = {};
        for (const period of toFold) {
          const key = localDateKey(new Date(period.startedAt), timeZone);
          const periodMin = period.minVoltage ?? period.voltage;
          const periodMax = period.maxVoltage ?? period.voltage;
          byDay[key] ||= { date: key, minVoltage: periodMin, maxVoltage: periodMax };
          byDay[key].minVoltage = Math.min(byDay[key].minVoltage, periodMin);
          byDay[key].maxVoltage = Math.max(byDay[key].maxVoltage, periodMax);
        }
        for (const key of Object.keys(byDay)) {
          const existing = monitor.dailySummaries.find((day) => day.date === key);
          if (existing) {
            existing.minVoltage = Math.min(existing.minVoltage, byDay[key].minVoltage);
            existing.maxVoltage = Math.max(existing.maxVoltage, byDay[key].maxVoltage);
          } else {
            monitor.dailySummaries.push(byDay[key]);
          }
        }
        monitor.periods = (monitor.periods || []).filter((period) => period.endedAt >= granularCutoff);
        changed.add(monitor.id);
      }
      monitor.dailySummaries = monitor.dailySummaries.filter((day) => day.date >= totalCutoffKey);
    }
    this.invalidateSeries([...changed]);
    return changed.size;
  },
};

module.exports = { GRANULAR_RETENTION_DAYS, TOTAL_RETENTION_DAYS, CYCLE_RETENTION_DAYS, compactVoltagePeriods, retentionMethods };
