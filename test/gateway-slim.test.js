'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const HomeyDeviceGateway = require('../lib/homey-device-gateway');

const gateway = new HomeyDeviceGateway({});

const rawDevice = {
  id: 'd1', name: 'Bomba', zone: 'z1', available: true, lastSeenAt: '2026-09-19T12:00:00Z', unavailableMessage: null,
  capabilities: ['onoff', 'measure_power', 'measure_voltage.phase_a', 'meter_power', 'dim', 'washer_state'],
  capabilitiesObj: {
    onoff: { type: 'boolean', title: 'On/off', value: true, iconObj: { url: 'x' }, options: { a: 1 }, insights: true },
    measure_power: { type: 'number', title: 'Power', value: 1521, units: 'W', decimals: 1 },
    'measure_voltage.phase_a': { type: 'number', title: 'Voltage A', value: 219.5 },
    meter_power: { type: 'number', title: 'Energy', value: 12.5 },
    dim: { type: 'number', title: 'Dim', value: 0.4 },
    washer_state: { type: 'enum', title: 'State', value: 'Running', values: [{ id: 'Running' }] }
  }
};

test('_slim keeps identity, zone, availability, capability ids, and per capability only type and title', () => {
  const slim = gateway._slim(rawDevice, { z1: { name: 'Area Servico' } });
  assert.equal(slim.id, 'd1');
  assert.equal(slim.zoneName, 'Area Servico');
  assert.equal(slim.available, true);
  assert.equal(slim.lastSeenAt, '2026-09-19T12:00:00Z');
  assert.deepEqual(slim.capabilities, rawDevice.capabilities);
  assert.equal(slim.capabilitiesObj.onoff.title, 'On/off');
  assert.equal('iconObj' in slim.capabilitiesObj.onoff, false);
  assert.equal('options' in slim.capabilitiesObj.onoff, false);
  assert.equal('units' in slim.capabilitiesObj.measure_power, false);
});

test('_slim keeps the value only where a value is what is used: state capabilities and power/energy/current/voltage', () => {
  const { capabilitiesObj } = gateway._slim(rawDevice, {});
  assert.equal(capabilitiesObj.onoff.value, true);
  assert.equal(capabilitiesObj.washer_state.value, 'Running');
  assert.equal(capabilitiesObj.measure_power.value, 1521);
  assert.equal(capabilitiesObj['measure_voltage.phase_a'].value, 219.5);
  assert.equal(capabilitiesObj.meter_power.value, 12.5);
  assert.equal('value' in capabilitiesObj.dim, false);
});

test('_slim tolerates missing pieces and marks a device available unless it says otherwise', () => {
  const slim = gateway._slim({ id: 'x', name: 'Bare', capabilities: ['onoff'], capabilitiesObj: {} }, {});
  assert.equal(slim.available, true);
  assert.equal(slim.zoneName, null);
  assert.deepEqual(slim.capabilitiesObj, {});
  assert.equal(gateway._slim({ id: 'y', name: 'Down', available: false }, {}).available, false);
});

test('the slim form of a 300-device Homey is a fraction of the raw payload', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ ...rawDevice, id: `d${i}`, capabilitiesObj: Object.fromEntries(Object.entries(rawDevice.capabilitiesObj).map(([id, c]) => [id, { ...c, iconObj: { url: 'https://example.invalid/icon/' + 'x'.repeat(80) }, options: { text: 'y'.repeat(200) }, title: c.title }])) }));
  const raw = JSON.stringify(many).length;
  const slim = JSON.stringify(many.map((d) => gateway._slim(d, {}))).length;
  assert.ok(slim * 3 < raw, `${slim} vs ${raw}`);
});
