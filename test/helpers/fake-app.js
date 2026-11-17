'use strict';
// A stand-in for the running app, for tests. It has the real class's methods (app.js and every mixin under lib/app/), so a
// method added later is simply there, instead of a hand-built fake missing it ("this._debug is not a function"). On top
// come quiet defaults for what onInit would have set up; a test passes only what it is about, and its values win.
//
//   const app = fakeApp({ store: await memoryStore(), gateway: { ... } });
//   app.logs, app.errors   what the app logged
const Module = require('node:module');
const path = require('node:path');
const SentinelStore = require('../../lib/store');

// Loads app.js with a stand-in for the 'homey' module, which only exists on a Homey.
function loadApp() {
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'homey') return { App: class { log() {} error() {} } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(path.join(__dirname, '..', '..', 'app.js')); } finally { Module._load = originalLoad; }
}

const App = loadApp();

// The settings key/value store a SentinelStore writes to, kept in an object (`saved`, to look at or share between stores).
function memorySettings(saved = {}) {
  return { saved, get: (key) => saved[key], set: async (key, value) => { saved[key] = value; }, unset: (key) => { delete saved[key]; } };
}

// A real store, empty and loaded, without a history database.
async function memoryStore(saved = {}) {
  const store = new SentinelStore(memorySettings(saved));
  await store.load();
  return store;
}

function fakeApp(overrides = {}) {
  const app = Object.create(App.prototype);
  const logs = []; const errors = [];
  Object.assign(app, {
    logs, errors,
    log: (...args) => { logs.push(args.join(' ')); },
    error: (...args) => { errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')); },
    _debug() {},
    _scheduleSave() {},
    _getTimezone: () => 'UTC',
    homey: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer), i18n: { getLanguage: () => 'en' }, __: (key) => key },
    _lastCalibrationAttempt: new Map(),
    _calibrationAttempts: new Map(),
    _summaryCache: new Map(),
    _groupLive: new Map(),
    _groupWatchGeneration: new Map(),
    _groupMissing: new Map()
  }, overrides);
  return app;
}

module.exports = { App, loadApp, fakeApp, memoryStore, memorySettings };
