'use strict';
// The Settings page, run for real in jsdom against the stand-in Homey of test/settings-harness (fixtures for every list, every
// API call recorded), and checked step by step against test/settings-harness/trace.snapshot.json. The scripted session in
// trace.js is the one that used to be run by hand in a browser: open and cancel every form, submit, stale submits, token
// inserters, Reset / Delete on every list, the Add forms, the Availability tab, the groups.
//
// The clock is frozen and dates are written in ISO form so the output does not depend on the day, the time zone or the
// locale. A step that changed shows up by name; UPDATE_SNAPSHOT=1 rewrites the snapshot after a change you meant to make,
// and DUMP_TRACE=<file> writes the whole trace to compare two versions by eye.
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const SNAPSHOT = path.join(__dirname, 'settings-harness', 'trace.snapshot.json');
const FIXED_NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

function freezeClock(window) {
  const RealDate = window.Date;
  const iso = (date) => date.toISOString().replace('T', ' ').slice(0, 19);
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED_NOW); else super(...args); }
    static now() { return FIXED_NOW; }
    toLocaleString() { return iso(this); }
    toLocaleDateString() { return iso(this).slice(0, 10); }
    toLocaleTimeString() { return iso(this).slice(11); }
  }
  window.Date = FrozenDate;
}

async function runPage() {
  // The two script tags become inline scripts: the stand-in for Homey's runtime, then the page's own script and the trace.
  const html = read('settings/index.html')
    .replace(/<script[^>]*src="\/homey\.js"[^>]*><\/script>/, () => `<script>${read('test/settings-harness/homey.js')}</script>`)
    .replace('<script src="settings.js"></script>', () => `<script>${read('settings/settings.js')}</script><script>${read('test/settings-harness/trace.js')}</script>`);
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse: freezeClock });
  try {
    dom.window.addEventListener('error', (event) => errors.push(event.message));
    if (dom.window.document.readyState !== 'complete') await new Promise((resolve) => dom.window.addEventListener('load', resolve));
    let timer;
    const tooLong = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('the scripted session did not finish in 60 s')), 60000); });
    const trace = await Promise.race([dom.window.runTrace(), tooLong]).finally(() => clearTimeout(timer));
    const alerts = Array.from(dom.window.__log).filter((entry) => entry.alert).map((entry) => entry.alert); // Array.from: the page's arrays come from another realm
    return { trace: JSON.parse(JSON.stringify(trace)), errors, alerts };
  } finally {
    dom.window.close(); // without this a failing run leaves the page's timers alive and the test process never ends
  }
}

const hashOf = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const summarize = (trace) => trace.map((step) => ({ name: step.name, hash: hashOf(step.data) }));

test('the Settings page runs its whole scripted session without an error or an alert, and every step is as it was', async () => {
  const { trace, errors, alerts } = await runPage();
  assert.deepEqual(errors, [], 'the page threw');
  assert.deepEqual(alerts, [], 'the page showed an alert');
  assert.ok(trace.length > 40, `only ${trace.length} steps ran`);
  if (process.env.DUMP_TRACE) fs.writeFileSync(process.env.DUMP_TRACE, JSON.stringify(trace, null, 2));
  const actual = summarize(trace);
  if (process.env.UPDATE_SNAPSHOT === '1') {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 1)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const known = new Map(expected.map((step) => [step.name, step.hash]));
  const changed = actual.filter((step) => known.has(step.name) && known.get(step.name) !== step.hash).map((step) => step.name);
  const added = actual.filter((step) => !known.has(step.name)).map((step) => step.name);
  const removed = expected.filter((step) => !actual.some((candidate) => candidate.name === step.name)).map((step) => step.name);
  assert.deepEqual({ changed, added, removed }, { changed: [], added: [], removed: [] },
    'steps of the Settings session differ from the snapshot; if that is intended run UPDATE_SNAPSHOT=1 npm test (DUMP_TRACE=<file> shows the whole trace)');
});
