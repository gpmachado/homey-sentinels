'use strict';
// The Settings page in Homey's languages: every English text the page shows (its HTML, placeholders and titles, and every
// t('...') in its scripts) has a translation in each language, and the page runs in one of them without an error.
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const LANGUAGES = ['nl', 'de', 'fr', 'it', 'es', 'sv', 'no', 'da'];
// Texts the scripts pass to t() through a variable, so the scan below cannot see them.
const THROUGH_VARIABLES = ['Delete monitor "{name}"?', 'Delete voltage monitor "{name}"?', 'NORMAL', 'UNDERVOLTAGE', 'OVERVOLTAGE', 'activity', 'state',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'text', 'number', 'number (seconds)', 'number (kWh)', 'number (W)', 'number (A)', 'number (V)'];

function pageTexts() {
  const dom = new JSDOM(read('settings/index.html'));
  const { document, NodeFilter } = dom.window;
  const texts = new Set(THROUGH_VARIABLES);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (['SCRIPT', 'STYLE', 'CODE'].includes(node.parentNode.nodeName)) continue;
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (text) texts.add(text);
  }
  document.querySelectorAll('[placeholder], [title]').forEach((el) => ['placeholder', 'title'].forEach((name) => { if (el.getAttribute(name)) texts.add(el.getAttribute(name)); }));
  for (const file of fs.readdirSync(path.join(root, 'settings')).filter((name) => name.endsWith('.js') && !name.startsWith('i18n'))) {
    for (const match of read(`settings/${file}`).matchAll(/\bt\(\s*(?:[^'()]*\?\s*)?'((?:[^'\\]|\\.)*)'(?:\s*:\s*'((?:[^'\\]|\\.)*)')?/g)) {
      [match[1], match[2]].filter((text) => text !== undefined).forEach((text) => texts.add(text.replace(/\\'/g, "'")));
    }
  }
  return [...texts].filter((text) => /[A-Za-z]{2}/.test(text) && !/^%[^ ]*%$/.test(text) && text !== 'Sentinels');
}

test('every text of the Settings page has a translation in every Homey language, with the same {placeholders}', () => {
  const context = {};
  vm.runInNewContext(`${read('settings/i18n-strings.js')}; this.result = SETTINGS_TRANSLATIONS;`, context);
  const tables = context.result;
  const marks = (text) => (text.match(/\{\w+\}/g) || []).sort().join(' ');
  const missing = [];
  for (const language of LANGUAGES) {
    for (const text of pageTexts()) {
      const translated = tables[language] && tables[language][text];
      if (!translated) missing.push(`${language}: ${text}`);
      else if (marks(translated) !== marks(text)) missing.push(`${language}: placeholders differ in "${text}"`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the Settings page opens in German, translated, without an error or an alert', async () => {
  const harness = read('test/settings-harness/homey.js').replace("__: function (k) { return k; }", "__: function (k) { return k === 'settingsLanguage' ? 'de' : k; }");
  assert.notEqual(harness, read('test/settings-harness/homey.js'), 'the stand-in Homey changed: update this test');
  const html = read('settings/index.html')
    .replace(/<script[^>]*src="\/homey\.js"[^>]*><\/script>/, () => `<script>${harness}</script>`)
    .replace(/<script src="([\w-]+\.js)"><\/script>/g, (tag, file) => `<script>${read(`settings/${file}`)}</script>`);
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  try {
    dom.window.addEventListener('error', (event) => errors.push(event.message));
    if (dom.window.document.readyState !== 'complete') await new Promise((resolve) => dom.window.addEventListener('load', resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { document } = dom.window;
    assert.deepEqual(errors, []);
    assert.deepEqual(Array.from(dom.window.__log).filter((entry) => entry.alert), []);
    assert.equal(document.querySelector('.tab-btn[data-tab="availability"]').textContent, 'Verfügbarkeit');
    assert.equal(document.getElementById('add-activity-monitor-btn').textContent, 'Aktivitätsmonitor hinzufügen');
    assert.equal(document.getElementById('activity-add-search').getAttribute('placeholder'), 'Einen Teil des Namens eingeben');
    const actions = [...document.querySelectorAll('#monitors-body .btn-link')].map((button) => button.textContent);
    assert.ok(actions.includes('Bearbeiten'), `row actions: ${actions.join(', ')}`);

    // The Diagnostics tab: loads when opened, in German on screen, and the copied report stays in English without device names.
    document.querySelector('.tab-btn[data-tab="status"]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(document.querySelector('.tab-btn[data-tab="status"]').textContent, 'Diagnose');
    const rows = [...document.querySelectorAll('.status-row')].map((row) => row.textContent);
    assert.ok(rows.includes('Zuletzt gespeichertvor 10 s, in 25 ms'), rows.join(' / '));
    assert.ok(rows.includes('CPU-Warnungen von Homey1 von 12, vor 9 min'), rows.join(' / '));
    assert.ok(rows.includes('Pump · Aktivitätletzter Messwert vor 5 min, kalibriert'), rows.join(' / '));
    assert.equal(document.querySelectorAll('.status-warn').length, 2, 'the CPU warning and the missing device');
    document.getElementById('status-copy-btn').click();
    const report = document.getElementById('status-report').value;
    assert.match(report, /^Sentinels 1\.0\.12, build abc1234 \(2026-11-16\), Node v22\.23\.5, SQLite 3\.54\.1, running for 10 min/);
    assert.match(report, /CPU warnings 1\/12 \(9 min ago\)/);
    assert.match(report, /voltage #2: no reading yet, DEVICE MISSING/);
    assert.ok(!report.includes('Sonoff') && !report.includes('Pump'), 'no device or monitor names in the report');
    assert.deepEqual(errors, []);
  } finally {
    dom.window.close();
  }
});
