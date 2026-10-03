'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LANGUAGES, isSupported, resolveLanguage, wordingFor } = require('../lib/wording');

const SECTIONS = ['messageWording', 'voltageMessageDefaults', 'activityMessageDefaults', 'stateMessageDefaults'];
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const placeholders = (text) => (String(text).match(/%[a-z_:|]+%/g) || []).sort();

test('the language chosen in Settings wins, then the one Homey reports, then English', () => {
  assert.equal(resolveLanguage('pt', 'de'), 'pt');
  assert.equal(resolveLanguage('', 'de'), 'de');
  assert.equal(resolveLanguage(undefined, 'fr'), 'fr');
  assert.equal(resolveLanguage('', 'ko'), 'en'); // a Homey language the wording does not cover
  assert.equal(resolveLanguage('xx', 'ru'), 'en');
  assert.equal(resolveLanguage(null, null), 'en');
  assert.equal(isSupported('pt'), true);
  assert.equal(isSupported('toString'), false); // not fooled by object prototype keys
});

test('every language offered in Settings has every sentence English has, with the same placeholders', () => {
  const english = wordingFor('en');
  const keys = SECTIONS.flatMap((section) => flatten({ [section]: english[section] }));
  for (const { code } of LANGUAGES) {
    const wording = wordingFor(code);
    for (const key of keys) {
      const path = key.split('.');
      const text = path.reduce((node, part) => node?.[part], wording);
      const reference = path.reduce((node, part) => node?.[part], english);
      assert.equal(typeof text, 'string', `${code} is missing ${key}`);
      // Wording may drop %group% (the contact sentences name the group in the item list) but never invent a placeholder.
      const unknown = placeholders(text).filter((p) => !placeholders(reference).includes(p) && !['%group%', '%count%'].includes(p));
      assert.deepEqual(unknown, [], `${code} ${key} uses a placeholder English does not`);
    }
  }
});

test('a sentence a language lacks falls back to the English one instead of coming back empty', () => {
  const only = { code: 'zz' };
  assert.equal(wordingFor(only.code).activityMessageDefaults.started, wordingFor('en').activityMessageDefaults.started);
  assert.equal(wordingFor('pt').activityMessageDefaults.finished, '%monitor% desligou - %duration_human%, %energy% kWh (%count% hoje)');
  assert.equal(wordingFor('pt').messageWording.contact.false.zero, 'Todas as portas e janelas estão fechadas.');
});

test('the wording stays plain enough for the settings store: no characters beyond Latin-1 in any sentence', () => {
  for (const { code } of LANGUAGES) {
    for (const key of SECTIONS.flatMap((section) => flatten({ [section]: wordingFor(code)[section] }))) {
      const text = key.split('.').reduce((node, part) => node?.[part], wordingFor(code));
      assert.ok(Array.from(text).every((c) => c.charCodeAt(0) <= 255), `${code} ${key} has a character above U+00FF`);
    }
  }
});
