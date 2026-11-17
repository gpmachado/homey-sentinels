'use strict';
// The Diagnostics tab's data: built from what the app already has in memory, without touching the devices.
const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../lib/app/diagnostics');

function fakeApp() {
  const app = Object.assign(Object.create(diagnostics), {
    homey: { manifest: { version: '1.0.12' } },
    buildInfo: { commit: 'abc1234', dirty: true, subject: 'x', commitDate: '2026-11-16T22:00:00-03:00' },
    _startedAt: 1000,
    _history: { sizeBytes: () => 2048 },
    gateway: { instances: new Map([['d1:measure_power', {}], ['d2:measure_voltage', {}]]), getDevice() { throw new Error('must not read devices'); } },
    store: {
      historyUnavailable: false, warnings: ['removed a leftover sentinels:v2 key'], lastSave: { at: 5000, ms: 12 },
      data: {
        logSettings: { verbose: true }, groups: { g1: {} }, availabilityWatchdogs: {},
        monitors: { a1: { name: 'Pump', deviceName: 'Sonoff', calibrating: true, lastSample: { power: 3, timestamp: 4000 } } },
        stateMonitors: { s1: { name: 'Door', deviceName: 'Plug', deviceMissing: true, lastSample: null } },
        voltageMonitors: { v1: { name: 'Fase A', deviceName: 'Meter', calibrating: true, lastSample: { voltage: 127, timestamp: 4500 } } }
      }
    }
  });
  return app;
}

test('getDiagnostics reports build, storage, load and the last reading of each monitor', () => {
  const app = fakeApp();
  app._rememberWarning('cpu', { count: 1, limit: 12 });
  app._rememberError(['Failed to poll groups', new Error('timeout')]);
  const d = app.getDiagnostics();
  assert.equal(d.app.version, '1.0.12');
  assert.deepEqual(d.app.build, { commit: 'abc1234', dirty: true, subject: 'x', date: '2026-11-16T22:00:00-03:00' });
  assert.equal(d.app.startedAt, 1000);
  assert.deepEqual({ database: d.storage.database, sizeBytes: d.storage.sizeBytes, degraded: d.storage.degraded, lastSave: d.storage.lastSave }, { database: true, sizeBytes: 2048, degraded: false, lastSave: { at: 5000, ms: 12 } });
  assert.deepEqual(d.storage.warnings, ['removed a leftover sentinels:v2 key']);
  assert.equal(d.storage.lastConsolidation, null);
  assert.deepEqual({ count: d.load.cpuWarning.count, limit: d.load.cpuWarning.limit }, { count: 1, limit: 12 });
  assert.equal(d.load.memoryWarning, null);
  assert.ok(d.load.heapUsedBytes > 0 && d.load.rssBytes > 0);
  assert.equal(d.subscriptions, 2);
  assert.equal(d.detailedLog, true);
  assert.equal(d.lastError.message, 'Failed to poll groups timeout');
  assert.deepEqual(d.counts, { groups: 1, watchdogs: 0 });
  assert.deepEqual(d.monitors, [
    { kind: 'activity', name: 'Pump', deviceName: 'Sonoff', deviceMissing: false, calibrating: true, lastReadingAt: 4000 },
    { kind: 'state', name: 'Door', deviceName: 'Plug', deviceMissing: true, calibrating: false, lastReadingAt: null },
    // Only Activity monitors calibrate.
    { kind: 'voltage', name: 'Fase A', deviceName: 'Meter', deviceMissing: false, calibrating: false, lastReadingAt: 4500 }
  ]);
});

test('getDiagnostics says so when the history database did not open, and copes with an unstamped build', () => {
  const app = fakeApp();
  app._history = null; app.buildInfo = null; app.store.historyUnavailable = true;
  const d = app.getDiagnostics();
  assert.deepEqual({ database: d.storage.database, sizeBytes: d.storage.sizeBytes, degraded: d.storage.degraded }, { database: false, sizeBytes: null, degraded: true });
  assert.equal(d.app.build, null);
});

test('an error message is cut short and objects are written out', () => {
  const app = fakeApp();
  app._rememberError(['x'.repeat(400)]);
  assert.equal(app._lastError.message.length, 300);
  app._rememberError(['Bad', { code: 7 }]);
  assert.equal(app._lastError.message, 'Bad {"code":7}');
});
