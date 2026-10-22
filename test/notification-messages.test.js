'use strict';
// Notification sentences (availability, calibration, the weekly trend) come out in the Default message language.
const test = require('node:test');
const assert = require('node:assert/strict');
const monitorAdmin = require('../lib/app/monitor-admin');
const { weeklyTrend, trendSummary } = require('../lib/statistics');
const { wordingFor } = require('../lib/wording');

const appIn = (language) => Object.assign({
  store: { getMessageSettings: () => ({ messageLanguage: language }) }, homey: { i18n: { getLanguage: () => 'en' } }
}, monitorAdmin);

test('availability sentences in Portuguese, with the numbers in', () => {
  const app = appIn('pt');
  assert.equal(app._say('stale', { device: 'Sensor', hours: 12 }), 'Sensor não reporta há mais de 12 h');
  assert.equal(app._say('unavailable', { device: 'Sensor' }), 'Sensor ficou indisponível');
  assert.equal(app._say('available', { device: 'Sensor', downtime: '5 h 29 min' }), 'Sensor voltou a ficar disponível depois de 5 h 29 min');
  assert.equal(app._say('batteryLow', { device: 'Sensor', battery: '9%' }), 'A bateria de Sensor está baixa (9%)');
  assert.equal(app._say('scanMany', { count: 2, names: 'A, B' }), '2 dispositivos precisam de atenção: A, B');
  assert.equal(app._say('scanManyMore', { count: 5, names: 'A, B, C', more: 2 }), '5 dispositivos precisam de atenção: A, B, C e mais 2');
  assert.equal(app._say('calibrated', { monitor: 'Bomba', threshold: 40, standby: 2, active: 500 }), 'Bomba calibrou: limiar em ~40 W (espera ~2 W, ligado ~500 W).');
});

test('the same sentences in English, and English when the language is not covered', () => {
  assert.equal(appIn('en')._say('scanStale', { device: 'Lamp' }), 'Lamp has stopped reporting');
  assert.equal(appIn('en')._say('scanLowBattery', { device: 'Lamp', battery: '8%' }), 'Lamp has a low battery (8%)');
  assert.equal(appIn('zz')._say('unavailable', { device: 'Lamp' }), 'Lamp became unavailable'); // Homey reports en: falls back to English
});

test('the weekly trend sentence keeps its English form in the statistics and can be said in Portuguese', () => {
  const trend = weeklyTrend({ periods: [], cycles: [] }, Date.UTC(2026, 9, 10));
  assert.equal(trend.summary, 'This week vs. previous: activity no prior baseline, cycles no prior baseline, energy no prior baseline.');
  assert.equal(trendSummary(trend, wordingFor('pt').notificationMessages), 'Esta semana contra a anterior: tempo ligado sem semana anterior para comparar, ciclos sem semana anterior para comparar, energia sem semana anterior para comparar.');
});

test('the text report in Portuguese, for each kind of monitor', () => {
  const { generateTextReport } = require('../lib/statistics');
  const messages = wordingFor('pt').reportMessages;
  const now = Date.UTC(2026, 9, 10, 12);
  const data = {
    monitors: { a: { name: 'Bomba', periods: [], cycles: [] } },
    voltageMonitors: { v: { name: 'Fase A', periods: [], dailySummaries: [] } },
    stateMonitors: { s: { name: 'Porta', trueLabel: 'Aberta', periods: [], cycles: [], dailySummaries: [] } }
  };
  assert.equal(generateTextReport('a', 'week', data, 'UTC', now, messages), 'Bomba (últimos 7 dias): ciclos 0, energia 0 Wh, ligado 0s.');
  assert.equal(generateTextReport('v', 'month', data, 'UTC', now, messages), 'Fase A (últimos 30 dias): média 0.0 V, faixa 0.0-0.0 V, ocorrências 0.');
  assert.equal(generateTextReport({ data: { id: 's' } }, 'day', data, 'UTC', now, messages), 'Porta (hoje): sessões 0, Aberta 0s.');
});

test('the event-log sentences about groups, deleted devices and batteries follow the language too', () => {
  const pt = appIn('pt');
  assert.equal(pt._say('groupBackToNormal', { group: 'Portas' }), 'Portas voltou ao normal');
  assert.equal(pt._say('groupMembersRemoved', { names: 'Porta A, Porta B', group: 'Portas' }), 'Porta A, Porta B não está mais no Homey e foi removido do grupo Portas');
  assert.equal(pt._say('watchdogDeviceGone', { device: 'Sensor' }), 'Sensor não está mais no Homey - o watchdog dele pode ser removido');
  assert.equal(pt._say('batteryBackToNormal', { device: 'Sensor' }), 'A bateria de Sensor voltou ao normal');
  assert.equal(pt._say('monitorDeviceGone', { monitor: 'Bomba', device: 'Tomada 3' }), 'Bomba: o dispositivo Tomada 3 não está mais no Homey');
  assert.equal(appIn('en')._say('groupMismatch', { group: 'Doors' }), 'Doors has a mismatch');
});
