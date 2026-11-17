'use strict';

// The translations of the Flow cards and widgets live in one table per language, i18n/manifest/<lang>.json (English
// text -> translation), instead of being edited in each of the ~50 JSON files. This script writes them into every
// `{ "en": ... }` text of .homeycompose/ and widgets/*/widget.compose.json, which Homey's compose step needs as they are.
//
//   npm run i18n           fill every text from the tables (after adding or changing an English text, and its rows)
//   npm run i18n -- check  change nothing; fail if a file is not what the tables say, a translation is missing or a
//                          row is no longer used
//   npm run i18n -- extract  add the texts the sources have and the tables lack, with the translation the sources carry
//
// A text written in English only is never filled with English: `npm run i18n` lists it as missing and writes nothing
// until every table has its row.
//
// test/manifest-i18n.test.js runs the check, so a text changed by hand in one file and not in the table fails the tests.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TABLES = path.join(ROOT, 'i18n', 'manifest');
const LANGUAGES = ['da', 'de', 'es', 'fr', 'it', 'nl', 'no', 'sv']; // besides en; Homey has no Portuguese

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (file.endsWith('.json')) files.push(file);
    }
  };
  walk(path.join(ROOT, '.homeycompose'));
  for (const widget of fs.readdirSync(path.join(ROOT, 'widgets')).sort()) {
    const file = path.join(ROOT, 'widgets', widget, 'widget.compose.json');
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

// A translatable text: an object whose keys are all language codes, English among them.
const isText = (value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.en === 'string'
  && Object.keys(value).every((key) => /^[a-z]{2}$/.test(key));

// Calls fn(text, replace) for every translatable text in a parsed JSON value.
function eachText(value, fn, replace = () => {}) {
  if (Array.isArray(value)) return value.forEach((item, i) => eachText(item, fn, (next) => { value[i] = next; }));
  if (!value || typeof value !== 'object') return;
  if (isText(value)) return fn(value, replace);
  for (const key of Object.keys(value)) eachText(value[key], fn, (next) => { value[key] = next; });
}

function readTables() {
  const tables = {};
  for (const language of LANGUAGES) {
    const file = path.join(TABLES, `${language}.json`);
    tables[language] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  return tables;
}

const format = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Fills every file from the tables. Returns what is out of line; writes only when `write` is set and nothing is missing.
function sync({ write = false } = {}) {
  const tables = readTables();
  const missing = new Set(); const used = new Set(); const changed = [];
  const outputs = [];
  for (const file of sourceFiles()) {
    const before = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(before);
    eachText(json, (text, replace) => {
      used.add(text.en);
      const filled = { en: text.en };
      for (const language of LANGUAGES) {
        const translation = tables[language][text.en];
        if (typeof translation !== 'string' || !translation.trim()) missing.add(`${language}: ${text.en}`);
        filled[language] = translation ?? text[language];
      }
      replace(filled);
    });
    const after = format(json);
    if (after !== before) { changed.push(path.relative(ROOT, file)); outputs.push([file, after]); }
  }
  const unused = [...new Set(LANGUAGES.flatMap((language) => Object.keys(tables[language])))].filter((text) => !used.has(text));
  if (write && !missing.size) outputs.forEach(([file, text]) => fs.writeFileSync(file, text));
  return { changed, missing: [...missing], unused };
}

// Adds to the tables the texts they lack, with the translation the sources carry now.
function extract() {
  const tables = readTables();
  let added = 0;
  for (const file of sourceFiles()) {
    eachText(JSON.parse(fs.readFileSync(file, 'utf8')), (text) => {
      for (const language of LANGUAGES) {
        if (tables[language][text.en] === undefined && typeof text[language] === 'string') { tables[language][text.en] = text[language]; added += 1; }
      }
    });
  }
  fs.mkdirSync(TABLES, { recursive: true });
  for (const language of LANGUAGES) fs.writeFileSync(path.join(TABLES, `${language}.json`), format(tables[language]));
  return added;
}

if (require.main === module) {
  const mode = process.argv[2] || 'write';
  if (mode === 'extract') {
    console.log(`added ${extract()} translations to i18n/manifest/`);
  } else {
    const result = sync({ write: mode === 'write' });
    result.missing.forEach((line) => console.log(`missing ${line}`));
    result.unused.forEach((text) => console.log(`unused in the tables: ${text}`));
    if (mode === 'check') result.changed.forEach((file) => console.log(`not as the tables say: ${file}`));
    else if (!result.missing.length) result.changed.forEach((file) => console.log(`wrote ${file}`));
    if (result.missing.length || (mode === 'check' && (result.changed.length || result.unused.length))) process.exitCode = 1;
  }
}

module.exports = { sync, extract, LANGUAGES };
