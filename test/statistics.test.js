'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  periodStatistics, weeklyTrend, statistics, stateStatistics, voltageStatistics,
  binaryEventStatistics, dailyBreakdown, stateDailyBreakdown, binaryDailyBreakdown,
  suggestedThreshold, generateTextReport
} = require('../lib/statistics');

const DAY = 24 * 60 * 60 * 1000;
const TZ = 'UTC';

function activityMonitor(overrides) {
  return Object.assign({ periods: [], cycles: [], dailySummaries: [] }, overrides);
}

test('periodStatistics counts cycles by endedAt within [start, end), sums active/standby seconds from periods', () => {
  const monitor = activityMonitor({
    periods: [
      { startedAt: 0, endedAt: 1000, seconds: 1, state: 'ACTIVE', energy: 0.01 },
      { startedAt: 1000, endedAt: 3000, seconds: 2, state: 'STANDBY', energy: 0 }
    ],
    cycles: [
      { startedAt: 0, endedAt: 1000, duration: 1, energy: 0.01, averagePower: 100, maxPower: 120, averageCurrent: 1, maxCurrent: 1.2 }
    ]
  });
  const stats = periodStatistics(monitor, 0, 3000);
  assert.equal(stats.cycle_count, 1);
  assert.equal(stats.active_duration, 1);
  assert.equal(stats.standby_duration, 2);
  assert.equal(stats.total_energy, 0.01);
  assert.equal(stats.average_power, 100);
  assert.equal(stats.max_power, 120);
});

test('periodStatistics reports median_duration as null below MEDIAN_MIN_CYCLES, a real value once there are enough', () => {
  const fewCycles = activityMonitor({ cycles: [{ endedAt: 100, duration: 10 }, { endedAt: 200, duration: 20 }] });
  assert.equal(periodStatistics(fewCycles, 0, 1000).median_duration, null);

  const cycles = [10, 20, 30, 40, 50].map((duration, i) => ({ endedAt: (i + 1) * 100, duration, energy: duration / 100 }));
  const enoughCycles = activityMonitor({ cycles });
  assert.equal(periodStatistics(enoughCycles, 0, 1000).median_duration, 30);
});

test('periodStatistics flags energy_quality as meter_reset when any period in range saw one', () => {
  const monitor = activityMonitor({ periods: [{ startedAt: 0, endedAt: 100, seconds: 0.1, state: 'ACTIVE', energy: 0, meterReset: true }] });
  assert.equal(periodStatistics(monitor, 0, 100).energy_quality, 'meter_reset');
  const clean = activityMonitor({ periods: [{ startedAt: 0, endedAt: 100, seconds: 0.1, state: 'ACTIVE', energy: 0, meterReset: false }] });
  assert.equal(periodStatistics(clean, 0, 100).energy_quality, null);
});

test('periodStatistics folds in dailySummaries for anything outside the granular window', () => {
  const monitor = activityMonitor({ dailySummaries: [{ date: '2026-01-01', activeSeconds: 500, standbySeconds: 100, activeEnergy: 1.5, standbyEnergy: 0, meterResetCount: 0 }] });
  const dayStart = Date.parse('2026-01-01T00:00:00Z');
  const stats = periodStatistics(monitor, dayStart, dayStart + DAY);
  assert.equal(stats.active_duration, 500);
  assert.equal(stats.total_energy, 1.5);
});

test('weeklyTrend reports "no prior baseline" when the previous week had zero of a metric', () => {
  const now = Date.parse('2026-01-15T00:00:00Z');
  const monitor = activityMonitor({ cycles: [{ endedAt: now - DAY, duration: 100, energy: 1 }] });
  const trend = weeklyTrend(monitor, now);
  assert.equal(trend.cycleCount.hasBaseline, false);
  assert.match(trend.summary, /no prior baseline/);
});

test('weeklyTrend computes a real percent change when both weeks have data', () => {
  const now = Date.parse('2026-01-15T00:00:00Z');
  const week = 7 * DAY;
  const monitor = activityMonitor({
    cycles: [
      { endedAt: now - 2 * DAY, duration: 100, energy: 1 }, // this week
      { endedAt: now - week - 2 * DAY, duration: 100, energy: 1 } // previous week
    ]
  });
  const trend = weeklyTrend(monitor, now);
  assert.equal(trend.cycleCount.hasBaseline, true);
  assert.equal(trend.cycleCount.percent, 0); // 1 vs 1 cycle = no change
});

test('statistics("day") windows to local midnight and merges the weekly trend fields in', () => {
  const now = Date.parse('2026-01-15T18:00:00Z');
  const todayStart = Date.parse('2026-01-15T00:00:00Z');
  const monitor = activityMonitor({ cycles: [{ endedAt: todayStart + 3600000, duration: 60, energy: 0.5 }] });
  const stats = statistics(monitor, 'day', TZ, now);
  assert.equal(stats.cycle_count, 1);
  assert.ok('trend_summary' in stats);
  assert.ok('trend_cycle_count_percent' in stats);
});

test('stateStatistics renames duration fields and only includes power fields when the monitor tracks auxiliary power', () => {
  const plain = Object.assign(activityMonitor({ cycles: [{ endedAt: 1000, duration: 10, energy: 0 }] }), { trueLabel: 'Open', falseLabel: 'Closed' });
  const plainStats = stateStatistics(plain, 'all', TZ, 2000);
  assert.equal(plainStats.true_duration, 0);
  assert.equal('energy' in plainStats, false);

  const powered = Object.assign(
    activityMonitor({
      periods: [{ startedAt: 0, endedAt: 1000, seconds: 1, state: 'ACTIVE', energy: 0.2 }],
      cycles: [{ endedAt: 1000, duration: 10, energy: 0.2, averagePower: 50 }]
    }),
    { trueLabel: 'Running', falseLabel: 'Idle', auxiliaryCapabilities: ['measure_power'] }
  );
  const poweredStats = stateStatistics(powered, 'all', TZ, 2000);
  assert.equal(poweredStats.energy, 0.2);
  assert.equal(poweredStats.average_power, 50);
});

test('voltageStatistics computes sample-weighted average and true min/max across bucketed periods', () => {
  const monitor = {
    periods: [
      { startedAt: 0, endedAt: 60000, endedAt2: undefined, minVoltage: 118, maxVoltage: 122, voltageSum: 1200, sampleCount: 10 },
      { startedAt: 60000, endedAt: 120000, minVoltage: 115, maxVoltage: 121, voltageSum: 1180, sampleCount: 10 }
    ].map((p) => ({ startedAt: p.startedAt, endedAt: p.endedAt, minVoltage: p.minVoltage, maxVoltage: p.maxVoltage, voltageSum: p.voltageSum, sampleCount: p.sampleCount })),
    dailySummaries: [], events: []
  };
  const stats = voltageStatistics(monitor, 'all', TZ, 200000);
  assert.equal(stats.min_voltage, 115);
  assert.equal(stats.max_voltage, 122);
  assert.equal(stats.average_voltage, (1200 + 1180) / 20);
});

test('voltageStatistics falls back to the old single-voltage-per-period shape', () => {
  const monitor = { periods: [{ startedAt: 0, endedAt: 60000, voltage: 120 }], dailySummaries: [], events: [] };
  const stats = voltageStatistics(monitor, 'all', TZ, 200000);
  assert.equal(stats.min_voltage, 120);
  assert.equal(stats.max_voltage, 120);
  assert.equal(stats.average_voltage, 120);
});

test('voltageStatistics counts under/overvoltage events independently', () => {
  const monitor = {
    periods: [], dailySummaries: [],
    events: [
      { type: 'UNDERVOLTAGE', startedAt: 0, duration: 10 },
      { type: 'OVERVOLTAGE', startedAt: 100, duration: 20 },
      { type: 'OVERVOLTAGE', startedAt: 200, duration: 30 }
    ]
  };
  const stats = voltageStatistics(monitor, 'all', TZ, 1000);
  assert.equal(stats.undervoltage_count, 1);
  assert.equal(stats.undervoltage_duration, 10);
  assert.equal(stats.overvoltage_count, 2);
  assert.equal(stats.overvoltage_duration, 50);
});

test('binaryEventStatistics("all") reads counter.totalCount directly, ignoring dailyCounts', () => {
  const counter = { totalCount: 42, dailyCounts: [{ date: '2020-01-01', count: 999 }], lastEventAt: null };
  assert.equal(binaryEventStatistics(counter, 'all').event_count, 42);
});

test('binaryEventStatistics("day") sums only dailyCounts on/after the window start', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const counter = { totalCount: 100, lastEventAt: now, dailyCounts: [{ date: '2026-01-14', count: 5 }, { date: '2026-01-15', count: 3 }] };
  assert.equal(binaryEventStatistics(counter, 'day', TZ, now).event_count, 3);
});

test('dailyBreakdown returns one entry per day, oldest first, with that day\'s energy', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const dayStart = Date.parse('2026-01-15T00:00:00Z');
  const monitor = activityMonitor({ periods: [{ startedAt: dayStart, endedAt: dayStart + 1000, seconds: 1, state: 'ACTIVE', energy: 0.3 }] });
  const breakdown = dailyBreakdown(monitor, 3, TZ, now);
  assert.equal(breakdown.length, 3);
  assert.equal(breakdown[2].date, '2026-01-15');
  assert.equal(breakdown[2].energy, 0.3);
  assert.equal(breakdown[0].energy, 0);
});

test('stateDailyBreakdown reports trueDuration instead of energy', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const dayStart = Date.parse('2026-01-15T00:00:00Z');
  const monitor = activityMonitor({ periods: [{ startedAt: dayStart, endedAt: dayStart + 500000, state: 'ACTIVE', energy: 0 }] });
  const breakdown = stateDailyBreakdown(monitor, 1, TZ, now);
  assert.equal(breakdown[0].trueDuration, 500);
});

test('binaryDailyBreakdown pads zero for days with no recorded event', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const counter = { dailyCounts: [{ date: '2026-01-15', count: 4 }] };
  const breakdown = binaryDailyBreakdown(counter, 2, TZ, now);
  assert.equal(breakdown[0].count, 0);
  assert.equal(breakdown[1].count, 4);
});

test('suggestedThreshold returns null below THRESHOLD_SUGGESTION_MIN_SAMPLES', () => {
  const monitor = { periods: Array.from({ length: 10 }, (_, i) => ({ power: i })) };
  assert.equal(suggestedThreshold(monitor), null);
});

test('suggestedThreshold finds the widest gap and lands the suggestion between the two clusters', () => {
  const standby = Array.from({ length: 40 }, () => 5 + Math.random());
  const active = Array.from({ length: 40 }, () => 500 + Math.random());
  const monitor = { periods: [...standby, ...active].map((power) => ({ power })) };
  const suggestion = suggestedThreshold(monitor);
  assert.ok(suggestion);
  assert.ok(suggestion.threshold > 6 && suggestion.threshold < 500);
});

test('suggestedThreshold rejects a gap that doesn\'t clear the min ratio (all-standby noise)', () => {
  const monitor = { periods: Array.from({ length: 50 }, () => ({ power: 5 + Math.random() * 0.5 })) };
  assert.equal(suggestedThreshold(monitor), null);
});

test('suggestedThreshold reads minPower/maxPower from bucketed periods (see ActivityEngine#_recordPeriod), not just the legacy single power field', () => {
  const standby = Array.from({ length: 20 }, () => ({ minPower: 5, maxPower: 6 })); // 40 values once expanded
  const active = Array.from({ length: 20 }, () => ({ minPower: 499, maxPower: 501 })); // 40 values once expanded
  const monitor = { periods: [...standby, ...active] };
  const suggestion = suggestedThreshold(monitor);
  assert.ok(suggestion);
  assert.ok(suggestion.threshold > 6 && suggestion.threshold < 499);
});

test('generateTextReport builds one sentence per entity kind and throws for an unknown id', () => {
  const data = {
    monitors: { m1: { id: 'm1', name: 'Freezer', periods: [], cycles: [{ endedAt: 1000, duration: 60, energy: 0.1 }] } },
    voltageMonitors: {}, stateMonitors: {}, binaryCounters: { c1: { id: 'c1', name: 'Doorbell', totalCount: 3, dailyCounts: [{ date: '1970-01-01', count: 3 }] } }
  };
  const report = generateTextReport('m1', 'day', data, TZ, 2000);
  assert.match(report, /Freezer:/);
  const counterReport = generateTextReport('c1', 'day', data, TZ, 2000);
  assert.match(counterReport, /Doorbell: 3 events/);
  assert.throws(() => generateTextReport('nope', 'day', data, TZ, 2000), /not found/);
});
