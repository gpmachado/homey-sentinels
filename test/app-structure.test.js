'use strict';
// The app class is assembled from mixin modules under lib/app/. Nothing here starts the app; it only
// checks the wiring, which a plain syntax check can't: that every method the code calls on `this` (or the
// API routes and widgets call on homey.app) still exists after the split.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');

function loadApp() {
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'homey') return { App: class { log() {} error() {} } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(path.join(root, 'app.js')); } finally { Module._load = originalLoad; }
}

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const mixinFiles = fs.readdirSync(path.join(root, 'lib', 'app')).filter((f) => f.endsWith('.js') && f !== 'constants.js');
const appSources = ['app.js', ...mixinFiles.map((f) => `lib/app/${f}`)];
const callsOn = (text, receiver) => [...text.matchAll(new RegExp(`${receiver}\\.([A-Za-z_][A-Za-z0-9_]*)\\(`, 'g'))].map((m) => m[1]);

test('every method the app calls on `this` is defined on the class (or set up in onInit)', () => {
  const App = loadApp();
  // Objects created in onInit and callable methods placed on `this` there are properties, not prototype methods.
  const instanceProps = new Set(['log', 'error']);
  for (const file of appSources) {
    for (const name of callsOn(read(file), 'this')) {
      if (instanceProps.has(name)) continue;
      assert.equal(typeof App.prototype[name], 'function', `${file} calls this.${name}() but the class has no such method`);
    }
  }
});

test('every method the API routes and widgets call on homey.app exists', () => {
  const App = loadApp();
  const files = ['api.js', ...fs.readdirSync(path.join(root, 'widgets')).map((w) => `widgets/${w}/api.js`).filter((f) => fs.existsSync(path.join(root, f)))];
  for (const file of files) {
    for (const name of callsOn(read(file), 'homey\\.app')) {
      assert.equal(typeof App.prototype[name], 'function', `${file} calls homey.app.${name}() but the class has no such method`);
    }
  }
});

test('no method is defined twice across the mixins and the class body', () => {
  const declared = [...read('app.js').matchAll(/^  (?:async )?([A-Za-z_][A-Za-z0-9_]*)\(.*\) \{/gm)].map((m) => m[1]);
  const seen = new Map(declared.map((name) => [name, 'app.js']));
  for (const file of mixinFiles) {
    for (const name of Object.keys(require(path.join(root, 'lib', 'app', file)))) {
      assert.ok(!seen.has(name), `${name} is defined in both ${seen.get(name)} and lib/app/${file}`);
      seen.set(name, `lib/app/${file}`);
    }
  }
});
