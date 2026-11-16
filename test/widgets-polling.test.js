'use strict';
// Every widget refreshes every 30 s; one that keeps doing it while off screen wastes the Homey's CPU for nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every widget that polls stops while hidden and loads again when shown', () => {
  const dir = path.join(__dirname, '..', 'widgets');
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'public', 'index.html');
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    if (!/setInterval\(load,/.test(html)) continue;
    assert.match(html, /async function load\([a-z]*\) \{\s*if \(document\.hidden[ &!a-z]*\) return;/, `${name}: load() must return while hidden`);
    assert.match(html, /addEventListener\('visibilitychange'/, `${name}: must reload when shown again`);
  }
});
