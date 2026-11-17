'use strict';
// The Flow cards, widget names and widget settings come in every language Homey offers that the app supports:
// a text added in English only would show up in English to everyone else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LANGUAGES = ['en', 'nl', 'de', 'fr', 'it', 'es', 'sv', 'no', 'da'];

test('every text in the manifest sources has all the languages', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) walk(file); else if (file.endsWith('.json')) files.push(file); } };
  walk(path.join(root, '.homeycompose'));
  for (const widget of fs.readdirSync(path.join(root, 'widgets'))) {
    const file = path.join(root, 'widgets', widget, 'widget.compose.json');
    if (fs.existsSync(file)) files.push(file);
  }
  const missing = [];
  const visit = (value, file) => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, file));
    if (!value || typeof value !== 'object') return;
    if (typeof value.en === 'string' && Object.keys(value).every((key) => /^[a-z]{2}$/.test(key))) {
      for (const language of LANGUAGES) if (typeof value[language] !== 'string' || !value[language].trim()) missing.push(`${path.relative(root, file)}: "${value.en.slice(0, 40)}" lacks ${language}`);
      return;
    }
    Object.values(value).forEach((item) => visit(item, file));
  };
  for (const file of files) visit(JSON.parse(fs.readFileSync(file, 'utf8')), file);
  assert.deepEqual(missing, []);
});

test('every Flow card and widget text is what the tables in i18n/manifest/ say, with no row missing or left over', () => {
  const { sync } = require('../scripts/manifest-i18n');
  const result = sync(); // writes nothing
  assert.deepEqual(result.missing, [], 'add the translation to i18n/manifest/<lang>.json');
  assert.deepEqual(result.changed, [], 'a text was edited in the JSON and not in i18n/manifest/: change the table, then npm run i18n');
  assert.deepEqual(result.unused, [], 'remove these rows from i18n/manifest/ (no card or widget uses them any more)');
});
