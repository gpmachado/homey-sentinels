'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GROUP_TYPES, assertGroupDevice, checkGroup, groupStatistics } = require('../lib/groups');

function fakeGateway(devicesById) {
  return { async getDevice(id) { return devicesById[id] || null; } };
}

test('GROUP_TYPES maps each group type to its capability and polarity', () => {
  assert.equal(GROUP_TYPES.contact.capability, 'alarm_contact');
  assert.equal(GROUP_TYPES.contact.invert, false);
  // garagedoor_closed reports true when CLOSED — inverted so "Open" as the expected state
  // means "capability should read false", not a silent polarity mixup.
  assert.equal(GROUP_TYPES.garage.capability, 'garagedoor_closed');
  assert.equal(GROUP_TYPES.garage.invert, true);
});

test('assertGroupDevice throws for a device missing the group type\'s capability', () => {
  const group = { type: 'contact' };
  assert.throws(() => assertGroupDevice(group, { capabilities: ['onoff'] }), /isn't compatible/);
  assert.doesNotThrow(() => assertGroupDevice(group, { capabilities: ['alarm_contact'] }));
});

test('checkGroup reports zero mismatches when every device matches the expected state', () => {
  const group = {
    type: 'contact', expectedState: false, conjunction: 'and',
    messageTemplateZero: 'All closed', messageTemplateOne: '%items% open', messageTemplateMany: '%count% open: %items%',
    devices: [{ id: 'd1', name: 'Front door' }, { id: 'd2', name: 'Back door' }]
  };
  const gateway = fakeGateway({
    d1: { name: 'Front door', capabilitiesObj: { alarm_contact: { value: false } } },
    d2: { name: 'Back door', capabilitiesObj: { alarm_contact: { value: false } } }
  });
  return checkGroup(group, gateway).then((result) => {
    assert.equal(result.mismatchCount, 0);
    assert.equal(result.matchCount, 2);
    assert.equal(result.message, 'All closed');
  });
});

test('checkGroup lists mismatching devices by name and renders the "one" vs "many" template', async () => {
  const group = {
    type: 'contact', expectedState: false, conjunction: 'and',
    messageTemplateZero: 'All closed', messageTemplateOne: '%items% is open', messageTemplateMany: '%count% open: %items%',
    devices: [{ id: 'd1', name: 'Front door' }, { id: 'd2', name: 'Back door' }]
  };
  const gateway = fakeGateway({
    d1: { name: 'Front door', capabilitiesObj: { alarm_contact: { value: true } } },
    d2: { name: 'Back door', capabilitiesObj: { alarm_contact: { value: false } } }
  });
  const result = await checkGroup(group, gateway);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.mismatchList, 'Front door');
  assert.match(result.message, /Front door is open/);
});

test('checkGroup applies the garage type\'s inverted polarity correctly', async () => {
  const group = {
    type: 'garage', expectedState: true /* "Open" */, conjunction: 'and',
    messageTemplateZero: 'All open', messageTemplateOne: '%items% closed', messageTemplateMany: '%items%',
    devices: [{ id: 'd1', name: 'Main garage' }, { id: 'd2', name: 'Side garage' }]
  };
  // garagedoor_closed === true means CLOSED — expecting "Open" (target=false after invert)
  // means a device reporting closed:true is a mismatch.
  const gateway = fakeGateway({
    d1: { name: 'Main garage', capabilitiesObj: { garagedoor_closed: { value: true } } },
    d2: { name: 'Side garage', capabilitiesObj: { garagedoor_closed: { value: false } } }
  });
  const result = await checkGroup(group, gateway);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.mismatchList, 'Main garage');
});

test('checkGroup honors an explicit expectedOverride instead of the group\'s own default', async () => {
  const group = {
    type: 'contact', expectedState: false, conjunction: 'and',
    messageTemplateZero: 'zero', messageTemplateOne: 'one', messageTemplateMany: 'many',
    devices: [{ id: 'd1', name: 'A' }, { id: 'd2', name: 'B' }]
  };
  const gateway = fakeGateway({
    d1: { name: 'A', capabilitiesObj: { alarm_contact: { value: true } } },
    d2: { name: 'B', capabilitiesObj: { alarm_contact: { value: true } } }
  });
  // Default expects false (closed) — both are open, so overriding the expectation to true
  // (open) should flip it back to zero mismatches.
  const result = await checkGroup(group, gateway, true);
  assert.equal(result.mismatchCount, 0);
});

test('checkGroup throws for a group with fewer than two devices', async () => {
  const group = { type: 'contact', expectedState: false, devices: [{ id: 'd1', name: 'A' }] };
  await assert.rejects(() => checkGroup(group, fakeGateway({})), /at least two devices/);
});

test('checkGroup treats an unreachable device (gateway returns null) as a mismatch', async () => {
  const group = {
    type: 'contact', expectedState: false, conjunction: 'and',
    messageTemplateZero: 'zero', messageTemplateOne: '%items%', messageTemplateMany: '%items%',
    devices: [{ id: 'd1', name: 'Ghost door' }, { id: 'd2', name: 'Real door' }]
  };
  const gateway = fakeGateway({ d2: { name: 'Real door', capabilitiesObj: { alarm_contact: { value: false } } } });
  const result = await checkGroup(group, gateway);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.mismatchList, 'Ghost door');
});

test('groupStatistics sums mismatchSeconds/checkCount across dailySummaries within the period', () => {
  const group = {
    dailySummaries: [
      { date: '2025-12-01', mismatchSeconds: 9999, checkCount: 999 }, // well outside any window below
      { date: '2026-01-14', mismatchSeconds: 600, checkCount: 10 },
      { date: '2026-01-15', mismatchSeconds: 0, checkCount: 8 }
    ]
  };
  const now = Date.parse('2026-01-15T12:00:00Z');
  const dayStats = groupStatistics(group, 'day', 'UTC', now);
  assert.equal(dayStats.mismatch_seconds, 0);
  assert.equal(dayStats.check_count, 8);

  const weekStats = groupStatistics(group, 'week', 'UTC', now);
  assert.equal(weekStats.mismatch_seconds, 600); // 12-01 falls outside the last 7 days, the other two don't
  assert.equal(weekStats.check_count, 18);
});
