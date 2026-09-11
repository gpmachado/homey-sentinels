'use strict';

// Group-checking logic, extracted out of app.js. checkGroup needs a live device read (the
// gateway), so unlike lib/statistics.js this isn't 100% side-effect-free — but it still takes
// everything it needs as explicit parameters (group, gateway, timeZone) rather than assuming
// `this` is the whole app, matching lib/homey-device-gateway.js's own "take homey/gateway
// explicitly" convention for anything that must reach a live Homey manager. app.js keeps thin
// same-named delegating methods (_checkGroup, _assertGroupDevice, _groupStatistics) so every
// existing call site — including api.js's direct calls to `homey.app._checkGroup`/
// `homey.app._assertGroupDevice` — is unaffected by this move.
const { humanDuration } = require('./activity-engine');
const { startOfLocalDay, localDateKey } = require('./time');
const { renderMessage, formatList } = require('./message-template');

// Single source of truth for group type → capability + polarity. `invert: true` means the
// capability's raw true/false is the OPPOSITE of what "On / Open" / "Off / Closed" means to the
// user — garagedoor_closed reports true when the door is CLOSED, so without inverting, picking
// "Open" as the expected state would silently check for closed (the exact polarity footgun
// already fixed once for State Monitor's old active_value picker).
const GROUP_TYPES = {
  contact: { capability: 'alarm_contact', invert: false },
  light: { capability: 'onoff', invert: false },
  switch: { capability: 'onoff', invert: false },
  valve: { capability: 'onoff', invert: false },
  garage: { capability: 'garagedoor_closed', invert: true }
};

function assertGroupDevice(group, device) {
  if (!device || !device.capabilities.includes(GROUP_TYPES[group.type]?.capability)) throw new Error(`This device isn't compatible with the ${group.type} group.`);
}

async function checkGroup(group, gateway, expectedOverride) {
  if (group.devices.length < 2) throw new Error('A group needs at least two devices.');
  const expected = expectedOverride === undefined || expectedOverride === '' ? group.expectedState : (expectedOverride === true || expectedOverride === 'true');
  const devices = await Promise.all(group.devices.map(({ id }) => gateway.getDevice(id)));
  const { capability, invert } = GROUP_TYPES[group.type];
  const target = invert ? !expected : expected;
  const mismatches = devices.filter((device) => !device || Boolean(device.capabilitiesObj?.[capability]?.value) !== target).map((device, index) => device?.name || group.devices[index].name);
  const items = formatList(mismatches, group.conjunction || 'and');
  const template = mismatches.length === 0 ? group.messageTemplateZero : mismatches.length === 1 ? group.messageTemplateOne : group.messageTemplateMany;
  const message = renderMessage(template, { group: group.name, count: mismatches.length, items });
  return { groupName: group.name, checkedCount: group.devices.length, matchCount: group.devices.length - mismatches.length, mismatchCount: mismatches.length, mismatchList: mismatches.join('\n'), message };
}

// Feeds get_group_statistics — the closest a group gets to real history without a full
// live-subscription rewrite (see app.js's GROUP_POLL_INTERVAL_MS/_pollGroups).
function groupStatistics(group, period = 'day', timeZone, now = Date.now()) {
  const rollingWindowDays = { week: 7, month: 30 };
  const startKey = period === 'day'
    ? localDateKey(new Date(now), timeZone)
    : localDateKey(new Date(now - (rollingWindowDays[period] || 0) * 24 * 60 * 60 * 1000), timeZone);
  const days = (group.dailySummaries || []).filter((day) => day.date >= startKey);
  const mismatchSeconds = days.reduce((sum, day) => sum + day.mismatchSeconds, 0);
  const checkCount = days.reduce((sum, day) => sum + day.checkCount, 0);
  return { mismatch_seconds: mismatchSeconds, mismatch_duration_human: humanDuration(mismatchSeconds), check_count: checkCount };
}

// Same idea as lib/statistics.js's binaryDailyBreakdown — reads straight off dailySummaries
// (already one bucket per calendar day, see SentinelStore#recordGroupPoll) instead of
// recomputing anything, padding in a zero for any day with no poll data yet. Feeds the
// widgets' group sparkline.
function groupDailyBreakdown(group, days, timeZone, now = Date.now()) {
  const todayStart = startOfLocalDay(new Date(now), timeZone).getTime();
  const result = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dateKey = localDateKey(new Date(todayStart - i * 24 * 60 * 60 * 1000), timeZone);
    const day = (group.dailySummaries || []).find((d) => d.date === dateKey);
    result.push({ date: dateKey, mismatchSeconds: day ? day.mismatchSeconds : 0 });
  }
  return result;
}

module.exports = { GROUP_TYPES, assertGroupDevice, checkGroup, groupStatistics, groupDailyBreakdown };
