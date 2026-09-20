'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { watchdogsWidgetSummary, voltageWidgetSummary } = require('../lib/widget-summaries');

test('watchdogs: the ones that are down come first, with how long and why, then the rest by name', () => {
  const now = 1_000_000;
  const summary = watchdogsWidgetSummary([
    { deviceId: 'b', name: 'Zeta', thresholdHours: 12, wentUnavailableAt: null, available: true, lastSeenAt: 'x' },
    { deviceId: 'a', name: 'Alfa', thresholdHours: 12, wentUnavailableAt: null },
    { deviceId: 'c', name: 'Bomba', thresholdHours: 6, wentUnavailableAt: now - 90_000, reason: 'stale', ignoreUnavailable: true, available: false }
  ], now);
  assert.equal(summary.total, 3);
  assert.equal(summary.downCount, 1);
  assert.deepEqual([summary.staleCount, summary.unavailableCount, summary.okCount], [1, 0, 2]);
  assert.deepEqual(summary.items.map((item) => item.name), ['Bomba', 'Alfa', 'Zeta']);
  assert.equal(summary.items[0].reason, 'stale');
  assert.equal(summary.items[0].downSeconds, 90);
  assert.equal(summary.items[0].silenceOnly, true);
  assert.equal(summary.items[1].available, true); // unknown availability is not shown as down
  assert.equal(summary.items[1].down, false);
});

test('watchdogs: nothing configured gives an empty summary, not an error', () => {
  assert.deepEqual(watchdogsWidgetSummary(undefined), { total: 0, downCount: 0, staleCount: 0, unavailableCount: 0, okCount: 0, lowBatteryCount: 0, scanning: false, items: [] });
});

test('voltage: keeps the reading, today\'s range and episodes, and the configured band; missing numbers stay null', () => {
  const summary = voltageWidgetSummary([
    { id: 'v2', name: 'Voltagem B', state: 'NORMAL', currentVoltage: 220.4, minVoltage: 218.1, maxVoltage: 222.6, undervoltageCount: 0, overvoltageCount: 1, configuredMinVoltage: 200, configuredMaxVoltage: 240 },
    { id: 'v1', name: 'Voltagem A', state: 'UNDERVOLTAGE', currentVoltage: 190, minVoltage: 188, maxVoltage: 221, undervoltageCount: 2, overvoltageCount: 0, configuredMinVoltage: 200, configuredMaxVoltage: 240 },
    { id: 'v3', name: 'Voltagem C', state: 'NORMAL', currentVoltage: null, minVoltage: null, maxVoltage: null }
  ]);
  assert.deepEqual(summary.items.map((item) => item.name), ['Voltagem A', 'Voltagem B', 'Voltagem C']);
  assert.equal(summary.abnormalCount, 1);
  assert.equal(summary.items[0].undervoltageCount, 2);
  assert.equal(summary.items[1].overvoltageCount, 1);
  assert.equal(summary.items[1].bandMin, 200);
  assert.equal(summary.items[2].currentVoltage, null);
  assert.equal(summary.items[2].bandMin, null);
});
