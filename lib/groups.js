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
const { recentLocalDayStarts, localDateKey } = require('./time');
const { renderMessage, formatList } = require('./message-template');
const { isNotFoundError } = require('./availability');

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

// Reads every member of the group live, without requiring the group to be checkable. A member Homey no
// longer has (removed, or re-paired under another id) comes back as null instead of failing the whole read:
// one deleted door sensor used to make every poll and check of its group fail with "Not Found". Any other
// failure (Homey busy, API not ready) still throws, so a hiccup is never mistaken for a deleted device.
async function readGroupMembers(group, gateway) {
  return Promise.all(group.devices.map(({ id }) => gateway.getDevice(id).catch((error) => {
    if (isNotFoundError(error)) return null;
    throw error;
  })));
}

async function readGroupDevices(group, gateway) {
  if (group.devices.length < 2) throw new Error('A group needs at least two devices.');
  return readGroupMembers(group, gateway);
}

// Judges the group from its members' current values. Pure: `devices` lines up with group.devices, each
// entry a device-like object ({ name, capabilitiesObj }) or null for one that is gone. By default a gone
// member counts as a mismatch (the on-demand check should point at it); with `ignoreMissing` it is left out
// of the judgement, which is what the background paths use so a deleted sensor does not raise alarms while it
// waits to be cleaned up. Shared by the on-demand check, the 5-minute poll and the live (event-driven) path.
function evaluateGroup(group, devices, expectedOverride, { ignoreMissing = false } = {}) {
  const expected = expectedOverride === undefined || expectedOverride === '' ? group.expectedState : (expectedOverride === true || expectedOverride === 'true');
  const { capability, invert } = GROUP_TYPES[group.type];
  const target = invert ? !expected : expected;
  const entries = devices.map((device, index) => ({ device, name: device?.name || group.devices[index].name }));
  const considered = ignoreMissing ? entries.filter(({ device }) => device) : entries;
  const mismatches = considered
    .filter(({ device }) => !device || Boolean(device.capabilitiesObj?.[capability]?.value) !== target)
    .map(({ name }) => name);
  const items = formatList(mismatches, group.conjunction || 'and');
  const template = mismatches.length === 0 ? group.messageTemplateZero : mismatches.length === 1 ? group.messageTemplateOne : group.messageTemplateMany;
  const message = renderMessage(template, { group: group.name, count: mismatches.length, items });
  return { groupName: group.name, checkedCount: considered.length, matchCount: considered.length - mismatches.length, mismatchCount: mismatches.length, mismatchList: mismatches.join('\n'), message };
}

async function checkGroup(group, gateway, expectedOverride) {
  return evaluateGroup(group, await readGroupDevices(group, gateway), expectedOverride);
}

// Feeds get_group_statistics — the closest a group gets to real history without a full
// live-subscription rewrite (see app.js's GROUP_POLL_INTERVAL_MS/_pollGroups).
function groupStatistics(group, period = 'day', timeZone, now = Date.now()) {
  const rollingWindowDays = { week: 7, month: 30 };
  const startKey = localDateKey(new Date(rollingWindowDays[period] ? recentLocalDayStarts(new Date(now), rollingWindowDays[period] + 1, timeZone)[0] : now), timeZone);
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
  const result = [];
  for (const dayStart of recentLocalDayStarts(new Date(now), days, timeZone)) {
    const dateKey = localDateKey(new Date(dayStart), timeZone);
    const day = (group.dailySummaries || []).find((d) => d.date === dateKey);
    result.push({ date: dateKey, mismatchSeconds: day ? day.mismatchSeconds : 0 });
  }
  return result;
}

module.exports = { GROUP_TYPES, assertGroupDevice, checkGroup, evaluateGroup, readGroupDevices, readGroupMembers, groupStatistics, groupDailyBreakdown };
