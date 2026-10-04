'use strict';
// A new Activity monitor with no threshold starts from what Homey's Insights logged for the device, instead of a fixed
// default, and keeps calibrating from its own readings afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const SentinelStore = require('../lib/store');
const activity = require('../lib/app/activity');
const { thresholdFromReadings } = require('../lib/statistics');

const standbyAndActive = (standby, active, standbyCount = 120, activeCount = 40) => [
  ...Array.from({ length: standbyCount }, (_, i) => standby + (i % 3) * 0.1),
  ...Array.from({ length: activeCount }, (_, i) => active + (i % 5))
];

async function fakeApp(answers) {
  const store = new SentinelStore({ get: () => undefined, set: async () => {}, unset: () => {} });
  await store.load();
  const { monitor } = store.upsertMonitor({ device: { id: 'pump', name: 'Pump' }, name: 'Bomba do poco' });
  const calls = []; const logs = [];
  const app = Object.assign({
    store, calls, logs, log: (m) => logs.push(m),
    gateway: {
      async getInsightValues(deviceId, capability, resolution) {
        calls.push([deviceId, capability, resolution]);
        const answer = answers[resolution];
        if (answer instanceof Error) throw answer;
        return answer || [];
      }
    }
  }, activity);
  return { app, monitor };
}

test('thresholdFromReadings: two clear levels give a threshold between them, too few or flat readings give none', () => {
  const suggestion = thresholdFromReadings(standbyAndActive(2, 500));
  assert.ok(suggestion.threshold > 5 && suggestion.threshold < 400, `threshold ${suggestion.threshold}`);
  assert.equal(thresholdFromReadings(standbyAndActive(2, 500, 5, 4)), null); // fewer than 15 readings
  assert.equal(thresholdFromReadings(Array.from({ length: 100 }, () => 55)), null); // nothing separates them
  assert.equal(thresholdFromReadings([null, undefined, 'x', NaN]), null);
  assert.equal(thresholdFromReadings(undefined), null);
});

test('the threshold is read from the last 24 hours of Insights and the monitor keeps calibrating', async () => {
  const { app, monitor } = await fakeApp({ last24Hours: standbyAndActive(2, 500) });
  assert.equal(monitor.threshold, 40);
  assert.equal(monitor.calibrating, true);
  assert.equal(await app._seedThresholdFromInsights(monitor), true);
  assert.ok(monitor.threshold !== 40 && monitor.threshold > 5 && monitor.threshold < 400);
  assert.equal(monitor.calibrating, true); // its own readings can still replace the starting value
  assert.deepEqual(app.calls, [['pump', 'measure_power', 'last24Hours']]); // no need to ask for 7 days
  assert.match(app.logs.at(-1), /starting threshold .* from Homey Insights \(last24Hours/);
});

test('when the last 24 hours show no split the last 7 days are tried', async () => {
  const { app, monitor } = await fakeApp({ last24Hours: Array.from({ length: 50 }, () => 3), last7Days: standbyAndActive(1, 800) });
  assert.equal(await app._seedThresholdFromInsights(monitor), true);
  assert.deepEqual(app.calls.map((c) => c[2]), ['last24Hours', 'last7Days']);
  assert.ok(monitor.threshold > 3 && monitor.threshold < 800);
});

test('without a usable history the default stays, and says so', async () => {
  const { app, monitor } = await fakeApp({});
  assert.equal(await app._seedThresholdFromInsights(monitor), false);
  assert.equal(monitor.threshold, 40);
  assert.match(app.logs.at(-1), /no clear standby\/active split yet; keeping the default/);
});

test('an Insights error (no such log, no API) leaves the monitor alone and stops asking', async () => {
  const { app, monitor } = await fakeApp({ last24Hours: new Error('Not Found: log') });
  assert.equal(await app._seedThresholdFromInsights(monitor), false);
  assert.equal(monitor.threshold, 40);
  assert.equal(app.calls.length, 1);
  assert.match(app.logs.at(-1), /no Insights history to start from \(Not Found: log\)/);
});

test('a monitor deleted, or already calibrated on its own, while Insights was answering is not touched', async () => {
  const gone = await fakeApp({ last24Hours: standbyAndActive(2, 500) });
  delete gone.app.store.data.monitors[gone.monitor.id];
  assert.equal(await gone.app._seedThresholdFromInsights(gone.monitor), false);
  assert.equal(gone.monitor.threshold, 40);

  const done = await fakeApp({ last24Hours: standbyAndActive(2, 500) });
  done.monitor.calibrating = false; done.monitor.threshold = 77;
  assert.equal(await done.app._seedThresholdFromInsights(done.monitor), false);
  assert.equal(done.monitor.threshold, 77);
});
