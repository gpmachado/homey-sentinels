'use strict';
// /default-wording gives the Settings page every ready-made sentence it can fill a message box with.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api');
const monitorAdmin = require('../lib/app/monitor-admin');

const homeyIn = (language) => ({
  app: Object.assign({ store: { getMessageSettings: () => ({ messageLanguage: language }) }, homey: { i18n: { getLanguage: () => 'en' } } }, monitorAdmin)
});

test('getDefaultWording carries the group, Activity, State and Voltage sentences in the chosen language', async () => {
  const info = await api.getDefaultWording({ homey: homeyIn('pt') });
  assert.equal(info.language, 'pt');
  assert.ok(info.languages.some((language) => language.code === 'pt'));
  assert.equal(info.activityMessageDefaults.started, '%monitor% ligou (%power% W)');
  assert.equal(info.stateMessageDefaults.finished, '%monitor% agora está %label% (%count% hoje)');
  assert.match(info.voltageMessageDefaults.undervoltage, /subtensão/);
  assert.ok(info.messageWording.contact);
});

test('and in English when the language is not covered', async () => {
  const info = await api.getDefaultWording({ homey: homeyIn('') });
  assert.equal(info.activityMessageDefaults.started, '%monitor% turned on (%power% W)');
});
