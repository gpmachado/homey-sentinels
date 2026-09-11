'use strict';

// Pure statistics computation, extracted out of app.js — takes plain monitor/counter objects,
// an explicit period/timeZone/now, and (for generateTextReport only) the store's raw
// collections, instead of reaching into `this` for any of it. Matches the convention already
// used by lib/activity-engine.js and lib/voltage-engine.js: operate on a passed-in object, no
// Homey dependency, no logging — app.js keeps thin same-named delegating methods
// (`_statistics`, `_stateStatistics`, etc.) so every existing internal call site and api.js's
// contract with app.js are unaffected by this move.
const { ACTIVE, average, maximum, median, humanDuration } = require('./activity-engine');
const { UNDERVOLTAGE, OVERVOLTAGE } = require('./voltage-engine');
const { startOfLocalDay, localDateKey } = require('./time');

// A handful of cycles isn't enough for a median to mean anything (one long cycle would swing it
// wildly) — below this, median_duration/median_energy come back null ("still learning") rather
// than a misleadingly precise-looking number.
const MEDIAN_MIN_CYCLES = 5;
// Below this many raw power samples, a "gap" in the data is as likely to be sampling noise as a
// real standby/active split — _suggestedThreshold returns null (not yet confident) rather than
// guessing early.
const THRESHOLD_SUGGESTION_MIN_SAMPLES = 30;
// The suggested gap's high side must be at least this many times the low side to be treated as
// a genuine standby/active split, not two points that happen to differ within one noisy cluster.
const THRESHOLD_SUGGESTION_MIN_GAP_RATIO = 4;

// Small, local, pure formatting helpers — duplicated from app.js's own `num`/`formatEnergy`
// rather than imported back from it (this file has no dependency on app.js, and each is one
// line). generateTextReport is the only function here that needs to coerce nulls and format
// units for a human sentence; every other function in this file keeps returning raw
// possibly-null values, same as before this file existed — app.js's Flow-token boundary is
// still where `num()` gets applied to those.
const num = (value) => (Number.isFinite(value) ? value : 0);
const formatEnergy = (kwh) => (kwh < 1 ? `${Math.round(kwh * 1000)} Wh` : `${kwh.toFixed(2)} kWh`);

function periodStatistics(monitor, start, end) {
  const periods = (monitor.periods || []).filter((item) => item.endedAt > start && item.startedAt < end);
  const active = periods.filter((item) => item.state === ACTIVE);
  const standby = periods.filter((item) => item.state !== ACTIVE);
  const overlapSeconds = (item) => Math.max(0, Math.min(item.endedAt, end) - Math.max(item.startedAt, start)) / 1000;
  const sum = (items, field) => items.reduce((total, item) => total + (field === 'seconds' ? overlapSeconds(item) : (item[field] || 0)), 0);
  // Filtered by when the cycle ENDED, not started — a session that started before local
  // midnight and finished today (an AC left running overnight) must count as today's cycle.
  // Filtering by startedAt instead silently dropped it from every period's cycle_count/
  // average_power/max_power forever (it never started "today", so "today" always excluded
  // it, and by the time "yesterday" is queried the window has already moved on) — confirmed
  // live: a unit active since before midnight showed 0 cycles / no average power for the
  // entire day even after it turned off. periods[] doesn't have this problem since it's
  // filtered by overlap and prorated across the midnight split (see splitPeriodByLocalDay).
  const cycles = (monitor.cycles || []).filter((cycle) => cycle.endedAt > start && cycle.endedAt <= end);
  // Sourced from cycles (never pruned/condensed), not periods (condensed after ~7 days) —
  // keeps power/current stats accurate for "month"/"all" queries regardless of how much of
  // the raw period detail behind them has already been folded into daily summaries.
  const numeric = (items, field) => items.map((item) => item[field]).filter(Number.isFinite);
  const powers = numeric(cycles, 'averagePower');
  const currents = numeric(cycles, 'averageCurrent');
  const peakPowers = numeric(cycles, 'maxPower');
  const peakCurrents = numeric(cycles, 'maxCurrent');
  const hasEnoughCycles = cycles.length >= MEDIAN_MIN_CYCLES;
  const medianDuration = hasEnoughCycles ? median(numeric(cycles, 'duration')) : null;
  const medianEnergy = hasEnoughCycles ? median(numeric(cycles, 'energy')) : null;
  // Daily summaries (see SentinelStore#consolidateHistory) fill in duration/energy for
  // anything older than the granular period retention window.
  const daily = (monitor.dailySummaries || []).reduce((acc, day) => {
    const dayStart = new Date(`${day.date}T00:00:00Z`).getTime();
    if (dayStart >= start && dayStart < end) {
      acc.activeSeconds += day.activeSeconds; acc.standbySeconds += day.standbySeconds;
      acc.activeEnergy += day.activeEnergy; acc.standbyEnergy += day.standbyEnergy;
      acc.meterResetCount += day.meterResetCount || 0;
    }
    return acc;
  }, { activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0, meterResetCount: 0 });
  // A negative energy delta (meter replaced/reset) is already clamped to 0 above like
  // before — this only tells the difference between "genuinely measured zero" and "a
  // reset happened here," instead of the two silently looking identical. Sparse field:
  // absent when nothing was detected in the requested period, same convention as
  // getWidgetSummary's null-for-no-data fields.
  const hadMeterReset = periods.some((item) => item.meterReset) || daily.meterResetCount > 0;
  return {
    cycle_count: cycles.length, active_duration: sum(active, 'seconds') + daily.activeSeconds, standby_duration: sum(standby, 'seconds') + daily.standbySeconds,
    total_energy: sum(periods, 'energy') + daily.activeEnergy + daily.standbyEnergy, active_energy: sum(active, 'energy') + daily.activeEnergy, standby_energy: sum(standby, 'energy') + daily.standbyEnergy,
    average_power: average(powers), max_power: maximum(peakPowers), average_current: average(currents), max_current: maximum(peakCurrents),
    median_duration: medianDuration, median_duration_human: medianDuration !== null ? humanDuration(medianDuration) : null, median_energy: medianEnergy,
    energy_quality: hadMeterReset ? 'meter_reset' : null
  };
}

function weeklyTrend(monitor, now) {
  const week = 7 * 24 * 60 * 60 * 1000;
  const current = periodStatistics(monitor, now - week, now);
  const previous = periodStatistics(monitor, now - 2 * week, now - week);
  const compare = (key) => {
    const value = current[key]; const baseline = previous[key];
    const hasBaseline = baseline !== 0;
    const percent = hasBaseline ? ((value - baseline) / baseline) * 100 : 0;
    return { current: value, previous: baseline, percent, hasBaseline };
  };
  const activeDuration = compare('active_duration'); const cycleCount = compare('cycle_count'); const energy = compare('total_energy');
  const label = (item) => !item.hasBaseline ? 'no prior baseline' : `${item.percent >= 0 ? '+' : ''}${item.percent.toFixed(1)}%`;
  return { activeDuration, cycleCount, energy, summary: `This week vs. previous: activity ${label(activeDuration)}, cycles ${label(cycleCount)}, energy ${label(energy)}.` };
}

function statistics(monitor, period = 'all', timeZone, now = Date.now()) {
  // "day" means since local midnight (matching how Home Assistant's Energy dashboard and
  // utility_meter roll over) — a rolling 24h window would answer a different question.
  const rollingWindowDays = { week: 7, month: 30 };
  const start = period === 'day'
    ? startOfLocalDay(new Date(now), timeZone).getTime()
    : rollingWindowDays[period] ? now - rollingWindowDays[period] * 24 * 60 * 60 * 1000 : 0;
  const current = periodStatistics(monitor, start, now);
  const trend = weeklyTrend(monitor, now);
  return { ...current, trend_active_duration_percent: trend.activeDuration.percent, trend_cycle_count_percent: trend.cycleCount.percent, trend_energy_percent: trend.energy.percent, trend_summary: trend.summary };
}

// Same underlying period/cycle math as statistics() — a state monitor is just an activity
// monitor with no power/energy signal by default — but only the fields that mean something
// for a boolean capability are surfaced, so a door's stats card doesn't show "Peak power: 0
// W". When an auxiliary power capability IS being tracked (see app.js's _sampleState),
// periods/cycles already carry real wattage/energy — statistics() computes
// average_power/total_energy from them with no changes needed there, this just decides
// whether to surface them.
function stateStatistics(monitor, period = 'all', timeZone, now = Date.now()) {
  const stats = statistics(monitor, period, timeZone, now);
  const tracksPower = monitor.auxiliaryCapabilities?.length > 0;
  return {
    cycle_count: stats.cycle_count, true_duration: stats.active_duration, false_duration: stats.standby_duration,
    true_label: monitor.trueLabel, false_label: monitor.falseLabel,
    median_duration: stats.median_duration, median_duration_human: stats.median_duration_human,
    trend_active_duration_percent: stats.trend_active_duration_percent, trend_cycle_count_percent: stats.trend_cycle_count_percent,
    trend_summary: stats.trend_summary,
    ...(tracksPower ? {
      energy: stats.total_energy, average_power: stats.average_power, max_power: stats.max_power,
      average_current: stats.average_current, max_current: stats.max_current
    } : {})
  };
}

function voltageStatistics(monitor, period = 'all', timeZone, now = Date.now()) {
  const rollingWindowDays = { week: 7, month: 30 };
  const start = period === 'day'
    ? startOfLocalDay(new Date(now), timeZone).getTime()
    : rollingWindowDays[period] ? now - rollingWindowDays[period] * 24 * 60 * 60 * 1000 : 0;
  const periods = (monitor.periods || []).filter((item) => item.endedAt > start && item.startedAt < now);
  // minVoltage/maxVoltage/voltageSum/sampleCount per period (see VoltageEngine#processSample's
  // bucketing) — falls back to the older single-`voltage`-per-period shape for anything still
  // stored that way. average_voltage is sum-of-samples/count-of-samples rather than an
  // average-of-bucket-averages, so a long bucket doesn't get diluted to the same weight as a
  // short one.
  const periodMins = periods.map((item) => item.minVoltage ?? item.voltage).filter(Number.isFinite);
  const periodMaxes = periods.map((item) => item.maxVoltage ?? item.voltage).filter(Number.isFinite);
  const totalSampleCount = periods.reduce((sum, item) => sum + (item.sampleCount ?? (Number.isFinite(item.voltage) ? 1 : 0)), 0);
  const totalVoltageSum = periods.reduce((sum, item) => sum + (item.voltageSum ?? (Number.isFinite(item.voltage) ? item.voltage : 0)), 0);
  // Daily summaries (see SentinelStore#consolidateHistory) fill in min/max for anything
  // older than the granular period retention window. They don't track an average (only
  // min/max are kept once consolidated, to avoid carrying a running sum+count forever), so
  // average_voltage naturally only reflects the still-granular window.
  const daily = (monitor.dailySummaries || []).filter((day) => {
    const dayStart = new Date(`${day.date}T00:00:00Z`).getTime();
    return dayStart >= start && dayStart < now;
  });
  const mins = periodMins.concat(daily.map((day) => day.minVoltage)).filter(Number.isFinite);
  const maxes = periodMaxes.concat(daily.map((day) => day.maxVoltage)).filter(Number.isFinite);
  const events = (monitor.events || []).filter((event) => event.startedAt >= start && event.startedAt < now);
  const undervoltageEvents = events.filter((event) => event.type === UNDERVOLTAGE);
  const overvoltageEvents = events.filter((event) => event.type === OVERVOLTAGE);
  const sumDuration = (items) => items.reduce((total, item) => total + item.duration, 0);
  return {
    average_voltage: totalSampleCount ? totalVoltageSum / totalSampleCount : null, min_voltage: mins.length ? Math.min(...mins) : null, max_voltage: maxes.length ? Math.max(...maxes) : null,
    undervoltage_count: undervoltageEvents.length, undervoltage_duration: sumDuration(undervoltageEvents),
    overvoltage_count: overvoltageEvents.length, overvoltage_duration: sumDuration(overvoltageEvents)
  };
}

function binaryEventStatistics(counter, period = 'all', timeZone, now = Date.now()) {
  const lastEventAt = counter.lastEventAt ? new Date(counter.lastEventAt).toISOString() : null;
  if (period === 'all') return { event_count: counter.totalCount, last_event_at: lastEventAt };
  const rollingWindowDays = { week: 7, month: 30 };
  const start = period === 'day'
    ? startOfLocalDay(new Date(now), timeZone).getTime()
    : rollingWindowDays[period] ? now - rollingWindowDays[period] * 24 * 60 * 60 * 1000 : 0;
  const startKey = localDateKey(new Date(start), timeZone);
  const eventCount = (counter.dailyCounts || []).filter((day) => day.date >= startKey).reduce((total, day) => total + day.count, 0);
  return { event_count: eventCount, last_event_at: lastEventAt };
}

// One energy total per calendar day for the last `days` days (oldest first), for the
// widget's sparkline. Reuses periodStatistics per day rather than a separate aggregation
// path, so it stays consistent with whatever the stat cards show for the same range.
function dailyBreakdown(monitor, days, timeZone, now = Date.now()) {
  const todayStart = startOfLocalDay(new Date(now), timeZone).getTime();
  const result = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = todayStart - i * 24 * 60 * 60 * 1000;
    const dayEnd = startOfLocalDay(new Date(dayStart + 25 * 60 * 60 * 1000), timeZone).getTime();
    const stats = periodStatistics(monitor, dayStart, Math.min(dayEnd, now));
    result.push({ date: localDateKey(new Date(dayStart), timeZone), energy: stats.total_energy });
  }
  return result;
}

// Same idea as dailyBreakdown, for state monitors — active seconds per day instead of energy.
function stateDailyBreakdown(monitor, days, timeZone, now = Date.now()) {
  const todayStart = startOfLocalDay(new Date(now), timeZone).getTime();
  const result = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = todayStart - i * 24 * 60 * 60 * 1000;
    const dayEnd = startOfLocalDay(new Date(dayStart + 25 * 60 * 60 * 1000), timeZone).getTime();
    const stats = periodStatistics(monitor, dayStart, Math.min(dayEnd, now));
    result.push({ date: localDateKey(new Date(dayStart), timeZone), trueDuration: stats.active_duration });
  }
  return result;
}

// Same idea again, for the widget's binary-counter sparkline — reads straight off
// dailyCounts (already one bucket per calendar day, see SentinelStore#recordBinaryEvent)
// instead of recomputing anything, padding in a zero for any day with no event.
function binaryDailyBreakdown(counter, days, timeZone, now = Date.now()) {
  const todayStart = startOfLocalDay(new Date(now), timeZone).getTime();
  const result = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dateKey = localDateKey(new Date(todayStart - i * 24 * 60 * 60 * 1000), timeZone);
    const day = (counter.dailyCounts || []).find((d) => d.date === dateKey);
    result.push({ date: dateKey, count: day ? day.count : 0 });
  }
  return result;
}

// Finds a threshold by locating the widest gap in the monitor's raw power sample history —
// works well for appliances with a clearly separated standby draw (clock/display
// electronics, a few watts) and active draw (heating element/motor, much higher), which is
// the common shape a device like this actually has. `minClusterSize` samples are required
// on both sides of the split so a single outlier reading can't be mistaken for "the gap".
// Reports the observed low/high bounds alongside the suggestion so the user can judge how
// convincing the gap really is, instead of trusting a bare number.
function suggestedThreshold(monitor) {
  const periods = monitor.periods || [];
  // Cheap length check before the sort below — called on every sample while a monitor is
  // still calibrating (see app.js's _maybeAutoCalibrate), so skipping the sort for the
  // common below-the-minimum case matters more here than it did as a Settings-page-load-only
  // call. Each period contributes up to 2 values below (min+max), so this only needs half as
  // many periods as the real threshold to be worth sorting for.
  if (periods.length * 2 < THRESHOLD_SUGGESTION_MIN_SAMPLES) return null;
  // minPower/maxPower per period (see ActivityEngine#_recordPeriod's bucketing) — falls back to
  // the older single-`power`-per-period shape for anything still stored that way. Using both
  // extremes (not just one) keeps the gap search seeing genuine outliers even when several raw
  // samples get bucketed into one period.
  const values = periods.flatMap((period) => [period.minPower ?? period.power, period.maxPower ?? period.power]).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length < THRESHOLD_SUGGESTION_MIN_SAMPLES) return null;
  // A flat 10% share excluded the real gap entirely for a lopsided duty cycle — confirmed
  // live: a freezer whose compressor runs most of the time has a "standby" cluster (the
  // brief off periods) well under 10% of its sample history, so the search below never even
  // considered the boundary between it and the "active" cluster, and picked some meaningless
  // split deep inside the active cluster instead (a threshold landing right next to the
  // freezer's own normal running wattage). A small, capped minimum still guards against a
  // single outlier looking like a cluster, without scaling up indefinitely for a device
  // that's active far more often than idle — verified against a simulated duty cycle down to
  // 2% idle samples (10x more skewed than the freezer case that exposed this).
  const minClusterSize = Math.max(3, Math.min(10, Math.floor(values.length * 0.02)));
  let bestGap = -1;
  let bestIndex = -1;
  for (let i = minClusterSize; i < values.length - minClusterSize; i += 1) {
    const gap = values[i] - values[i - 1];
    if (gap > bestGap) { bestGap = gap; bestIndex = i; }
  }
  if (bestIndex === -1 || bestGap <= 0) return null;
  const low = values[bestIndex - 1];
  const high = values[bestIndex];
  // Reject a gap that's real but not convincingly a standby/active split — see
  // THRESHOLD_SUGGESTION_MIN_GAP_RATIO's comment above.
  if (high < Math.max(low, 0.1) * THRESHOLD_SUGGESTION_MIN_GAP_RATIO) return null;
  // Geometric mean lands the suggestion proportionally inside the gap rather than at its
  // arithmetic midpoint — standby and active are often an order of magnitude apart (5 W vs
  // 1000 W), where a straight average (502 W) would sit absurdly close to full load instead
  // of comfortably above standby noise.
  const threshold = Math.sqrt(Math.max(low, 0.1) * high);
  return { threshold: Math.round(threshold * 10) / 10, low, high, sampleCount: values.length };
}

// One canned sentence per monitor/counter kind, built from the exact same stats functions
// each type's own "Get statistics" Flow card already calls — for a push notification or chat
// message without concatenating a dozen tokens by hand in the Flow itself. Unlike every other
// function in this file, this one needs to *resolve* an id across all 4 collections first, so
// it takes the store's raw data dicts (`{ monitors, voltageMonitors, stateMonitors,
// binaryCounters }`) explicitly rather than a single already-looked-up monitor.
function generateTextReport(rawId, rawPeriod, data, timeZone, now = Date.now()) {
  const id = rawId && typeof rawId === 'object' ? (rawId.data?.id || rawId.id) : rawId;
  const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
  const periodLabel = period === 'week' ? 'the last 7 days' : period === 'month' ? 'the last 30 days' : 'today';
  const activityMonitor = data.monitors[id];
  if (activityMonitor) {
    const s = statistics(activityMonitor, period, timeZone, now);
    return `${activityMonitor.name}: ${s.cycle_count} cycle${s.cycle_count === 1 ? '' : 's'}, ${formatEnergy(num(s.total_energy))}, active ${humanDuration(num(s.active_duration))} (${periodLabel}).`;
  }
  const voltageMonitor = data.voltageMonitors[id];
  if (voltageMonitor) {
    const s = voltageStatistics(voltageMonitor, period, timeZone, now);
    const incidents = (s.undervoltage_count || 0) + (s.overvoltage_count || 0);
    return `${voltageMonitor.name}: avg ${num(s.average_voltage).toFixed(1)} V, range ${num(s.min_voltage).toFixed(1)}–${num(s.max_voltage).toFixed(1)} V, ${incidents} incident${incidents === 1 ? '' : 's'} (${periodLabel}).`;
  }
  const stateMonitor = data.stateMonitors[id];
  if (stateMonitor) {
    const s = stateStatistics(stateMonitor, period, timeZone, now);
    return `${stateMonitor.name}: ${s.cycle_count} session${s.cycle_count === 1 ? '' : 's'}, ${humanDuration(num(s.true_duration))} ${stateMonitor.trueLabel} (${periodLabel}).`;
  }
  const counter = data.binaryCounters[id];
  if (counter) {
    const s = binaryEventStatistics(counter, period, timeZone, now);
    return `${counter.name}: ${s.event_count} event${s.event_count === 1 ? '' : 's'} (${periodLabel}).`;
  }
  throw new Error('Monitor or counter not found.');
}

module.exports = {
  MEDIAN_MIN_CYCLES, THRESHOLD_SUGGESTION_MIN_SAMPLES, THRESHOLD_SUGGESTION_MIN_GAP_RATIO,
  statistics, periodStatistics, weeklyTrend, stateStatistics, voltageStatistics, binaryEventStatistics,
  dailyBreakdown, stateDailyBreakdown, binaryDailyBreakdown, suggestedThreshold, generateTextReport
};
