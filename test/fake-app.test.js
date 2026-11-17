'use strict';
// The shared test app (test/helpers/fake-app.js): real methods, and a `homey` that keeps its defaults when a test adds to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeApp } = require('./helpers/fake-app');

test('fakeApp has the real methods, and a partial homey keeps the default timers and translations', () => {
  const flow = {};
  const app = fakeApp({ homey: { flow } });
  assert.equal(typeof app.getDiagnostics, 'function');
  assert.equal(typeof app._handleStateEvents, 'function');
  assert.equal(app.homey.flow, flow);
  assert.equal(typeof app.homey.setTimeout, 'function');
  assert.equal(app.homey.__('anyChoice.monitor'), 'anyChoice.monitor');
  app.error('Failed', new Error('boom'));
  assert.deepEqual(app.errors, ['Failed boom']);
});
