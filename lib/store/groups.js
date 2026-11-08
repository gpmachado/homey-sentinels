'use strict';

// State groups in the store. Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { localDateKey } = require('../time');
const { GROUP_TYPES } = require('../groups');
const { newId } = require('./common');
const { TOTAL_RETENTION_DAYS } = require('./retention');

module.exports = {
  createGroup({ name, type, expectedState, devices = [], conjunction = 'and', messageTemplateZero = '', messageTemplateOne = '', messageTemplateMany = '' }) {
    if (!name?.trim()) throw new Error('Enter a name for the group.');
    const id = newId('group');
    this.data.groups[id] = {
      id, name: name.trim(), type, expectedState: expectedState === true || expectedState === 'true',
      devices: devices.map(({ id: deviceId, name: deviceName }) => ({ id: deviceId, name: deviceName })),
      conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany, dailySummaries: [], mismatchSince: null
    };
    return this.data.groups[id];
  },
  updateGroup(group, { name, type, expectedState, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany } = {}) {
    // Validate before assigning anything so a bad name/type can't leave the group half-edited.
    if (name !== undefined && !name.trim()) throw new Error('Enter a name for the group.');
    if (type !== undefined && !GROUP_TYPES[type]) throw new Error('Unknown group type.');
    if (name !== undefined) group.name = name.trim();
    // api.js#updateGroup validates the group's devices against the new type before calling this.
    // mismatchSince and dailySummaries are per-type (capability + polarity), so a type change
    // starts them fresh instead of mixing the old type's history into the new one.
    if (type !== undefined && type !== group.type) { group.type = type; group.mismatchSince = null; group.dailySummaries = []; }
    if (expectedState !== undefined) group.expectedState = expectedState === true || expectedState === 'true';
    if (conjunction !== undefined) group.conjunction = conjunction;
    if (messageTemplateZero !== undefined) group.messageTemplateZero = messageTemplateZero;
    if (messageTemplateOne !== undefined) group.messageTemplateOne = messageTemplateOne;
    if (messageTemplateMany !== undefined) group.messageTemplateMany = messageTemplateMany;
    return group;
  },
  setGroupDevices(group, devices) { group.devices = devices.map(({ id, name }) => ({ id, name })); return group; },
  deleteGroup(id) { delete this.data.groups[id]; },
  // Clears the poll's "already reported" memory without touching the group itself. Needed when it gets
  // stuck: the poll only clears mismatchSince by observing a live recovery (mismatchCount back to 0), so a
  // mismatch that resolved between two polls, or an app restart mid-mismatch, can leave it set forever —
  // group_mismatch_detected then never fires again even though the group keeps reporting real mismatches
  // (on-demand checks are unaffected; they never read or write mismatchSince).
  clearGroupMismatch(group) { group.mismatchSince = null; return group; },
  // A group has no per-device subscription (see the class-level "no continuous history" note
  // in app.js) — this is fed by a periodic poll instead (app.js's _pollGroups), so
  // mismatchSeconds is an estimate (intervalSeconds credited whenever a poll finds a
  // mismatch), not an exact event-driven duration. Good enough for "how much of today did
  // this group spend out of the expected state," not precise enough for per-incident timing.
  recordGroupPoll(group, mismatchCount, intervalSeconds, timeZone) {
    const key = localDateKey(new Date(), timeZone);
    group.dailySummaries ||= [];
    let day = group.dailySummaries.find((d) => d.date === key);
    if (!day) { day = { date: key, mismatchSeconds: 0, checkCount: 0 }; group.dailySummaries.push(day); }
    day.checkCount += 1;
    if (mismatchCount > 0) day.mismatchSeconds += intervalSeconds;
    const cutoffKey = localDateKey(new Date(Date.now() - TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000), timeZone);
    group.dailySummaries = group.dailySummaries.filter((d) => d.date >= cutoffKey);
  },
};
