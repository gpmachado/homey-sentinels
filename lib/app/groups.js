'use strict';

// State groups: the periodic mismatch poll, live checks and the Flow autocompletes for groups.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { GROUP_TYPES, assertGroupDevice, checkGroup, evaluateGroup, readGroupDevices, readGroupMembers } = require('../groups');
const { isNotFoundError } = require('../availability');
const { resumeWithRetry } = require('../resume');
const { GROUP_POLL_INTERVAL_MS, GROUP_MISSING_POLLS } = require('./constants');

module.exports = {
  _groupResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.groups).filter((g) => g.name.toLowerCase().includes(normalized)).map((g) => ({ name: g.name, description: g.type, data: { id: g.id } })); },

  _groupActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query)); },

  _groupConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query)); },

  _group(arg) { const item = this.store.data.groups[arg?.id || arg?.data?.id]; if (!item) throw new Error('Group not found.'); return item; },

  _assertGroupDevice(group, device) { return assertGroupDevice(group, device); },

  _checkGroup(group, expectedOverride) { return checkGroup(group, this.gateway, expectedOverride); },

  // Unsticks a mismatch the poll already thinks it reported, so the next poll can fire
  // group_mismatch_detected again. See lib/store.js#clearGroupMismatch for when this is needed.
  async clearGroupMismatchFlag(group) {
    this.store.clearGroupMismatch(group);
    await this.store.save();
    return group;
  },

  // The group is judged live, from its members' capability events (see _watchGroup), so a mismatch fires
  // group_mismatch_detected the moment it happens. This poll stays as the safety net: it re-reads every
  // member (covering a device that turned unavailable, which sends no capability event, and any event
  // that was missed), refreshes the live values, and keeps the daily "time mismatched" estimate.
  // A group with fewer than 2 devices shouldn't exist (creation already requires it) but skip
  // defensively rather than let one bad group's error stop every other group's poll this tick.
  async _pollGroups() {
    const timeZone = this._getTimezone();
    for (const group of Object.values(this.store.data.groups)) {
      if (group.devices.length < 2) continue;
      try {
        const devices = await readGroupDevices(group, this.gateway);
        const gone = this._trackMissingMembers(group, devices);
        this._refreshGroupLive(group, devices);
        // A member Homey no longer has is left out of the judgement (it would otherwise be a permanent
        // "mismatch") and is removed from the group once it has been missing for a few polls in a row.
        const result = evaluateGroup(group, devices, undefined, { ignoreMissing: true });
        this.store.recordGroupPoll(group, result.mismatchCount, GROUP_POLL_INTERVAL_MS / 1000, timeZone);
        await this._applyGroupResult(group, result);
        if (gone.length) await this._pruneGroupMembers(group, gone);
      } catch (error) {
        this.error('Failed to poll group', group.name, error);
      }
    }
    this._scheduleSave();
  },

  // Fires only on the transition into/out of a mismatch, not while it stays that way — mismatchSince is
  // the group's own memory of "was this already reported". Used by both the live path and the poll; the
  // state is changed before the trigger is awaited, so two events in a row can't both fire it.
  async _applyGroupResult(group, result) {
    if (result.mismatchCount > 0 && !group.mismatchSince) {
      group.mismatchSince = Date.now();
      this.log(`[${group.name}] group mismatch detected (${result.mismatchList.split('\n').join(', ')}) - firing group_mismatch_detected`);
      this._logEvent(result.message || `${group.name} has a mismatch`);
      this._scheduleSave();
      await this.groupCards.mismatchDetected.trigger(
        { mismatch_count: result.mismatchCount, match_count: result.matchCount, mismatch_list: result.mismatchList, message: result.message },
        { groupId: group.id }
      );
    } else if (result.mismatchCount === 0 && group.mismatchSince) {
      group.mismatchSince = null;
      this.log(`[${group.name}] group back to normal - firing group_matched_again`);
      this._logEvent(`${group.name} is back to normal`);
      this._scheduleSave();
      await this.groupCards.matchedAgain.trigger({ message: result.message }, { groupId: group.id });
    }
  },

  // ---- Live watching -------------------------------------------------------------------------------
  // One capability subscription per member device (shared with any monitor on the same device, see the
  // gateway), owned by `group:<id>`. Each event updates that member's value in memory and re-judges the
  // group from those values: no Homey API call per event.

  // Starts watching (with retries: right after a reboot the devices may not be up yet). Safe to call again
  // after the group's devices or type changed; it starts over.
  _startGroupWatch(group) {
    this._unwatchGroup(group.id);
    if (!GROUP_TYPES[group.type] || group.devices.length < 2) return;
    resumeWithRetry({
      label: `[${group.name}] group`,
      start: () => this._watchGroup(this.store.data.groups[group.id] || group),
      isStillWanted: () => Boolean(this.store.data.groups[group.id]),
      schedule: (fn, ms) => this.homey.setTimeout(fn, ms),
      log: (message) => this.log(message),
      error: (message) => this.error(message)
    });
  },

  async _watchGroup(group) {
    this._unwatchGroup(group.id);
    const live = { capability: GROUP_TYPES[group.type].capability, subscribed: [], values: new Map(), missing: new Set(), ready: false };
    this._groupLive.set(group.id, live);
    for (const { id } of group.devices) {
      try {
        await this.gateway.subscribeCapabilities(`group:${group.id}`, id, live.capability, [], (value) => this._onGroupMemberValue(group.id, id, value));
        live.subscribed.push(id);
      } catch (error) {
        // A deleted device must not stop the others from being watched; the poll cleans it up. Any other
        // failure (Homey not ready yet) still fails the start, which is retried.
        if (!isNotFoundError(error)) throw error;
        live.missing.add(id);
      }
    }
    live.ready = true;
    await this._evaluateGroupLive(group);
  },

  _unwatchGroup(groupId) {
    const live = this._groupLive.get(groupId);
    if (!live) return;
    this._groupLive.delete(groupId);
    live.ready = false;
    for (const id of live.subscribed) {
      try { this.gateway.unsubscribeCapabilities(`group:${groupId}`, id, live.capability, []); } catch (error) { /* already gone */ }
    }
  },

  async _onGroupMemberValue(groupId, deviceId, value) {
    const live = this._groupLive.get(groupId);
    const group = this.store.data.groups[groupId];
    if (!live || !group || !group.devices.some((device) => device.id === deviceId)) return;
    live.values.set(deviceId, value);
    if (live.ready) await this._evaluateGroupLive(group);
  },

  async _evaluateGroupLive(group) {
    const live = this._groupLive.get(group.id);
    if (!live || !live.ready) return;
    const devices = group.devices.map(({ id, name }) => {
      if (live.missing.has(id)) return null;
      return live.values.has(id) ? { name, capabilitiesObj: { [live.capability]: { value: live.values.get(id) } } } : undefined;
    });
    // A member that has not reported a value yet leaves the judgement to the poll, which reads it live.
    if (devices.some((device) => device === undefined)) return;
    await this._applyGroupResult(group, evaluateGroup(group, devices, undefined, { ignoreMissing: true }));
  },

  // The poll's live reads also correct the values held for the event path.
  _refreshGroupLive(group, devices) {
    const live = this._groupLive.get(group.id);
    if (!live) return;
    live.missing = new Set();
    devices.forEach((device, index) => {
      const id = group.devices[index].id;
      if (!device) { live.missing.add(id); return; }
      const value = device.capabilitiesObj?.[live.capability]?.value;
      if (typeof value === 'boolean') live.values.set(id, value);
    });
  },

  // ---- Members that no longer exist ----------------------------------------------------------------
  // Counts, per group, how many polls in a row each member has been missing from Homey; returns the ids
  // that have reached GROUP_MISSING_POLLS. A short gap (Homey still starting up) never gets a device removed.
  _trackMissingMembers(group, devices) {
    const counts = this._groupMissing.get(group.id) || new Map();
    const gone = [];
    devices.forEach((device, index) => {
      const id = group.devices[index].id;
      if (device) { counts.delete(id); return; }
      const count = (counts.get(id) || 0) + 1;
      counts.set(id, count);
      if (count >= GROUP_MISSING_POLLS) gone.push(id);
    });
    this._groupMissing.set(group.id, counts);
    return gone;
  },

  // Takes devices that are gone out of the group, tells the user, and starts watching the rest.
  async _pruneGroupMembers(group, ids) {
    const removed = group.devices.filter((device) => ids.includes(device.id));
    if (!removed.length) return [];
    this.store.setGroupDevices(group, group.devices.filter((device) => !ids.includes(device.id)));
    this._groupMissing.delete(group.id);
    const names = removed.map((device) => device.name);
    this.log(`[${group.name}] removed from the group, no longer in Homey: ${names.join(', ')}`);
    this._logEvent(`${names.join(', ')} is no longer in Homey and was removed from the group ${group.name}`);
    if (group.devices.length < 2) this.log(`[${group.name}] the group now has fewer than two devices and is not checked any more; add a device or delete the group`);
    await this.store.save();
    this._startGroupWatch(group);
    return names;
  },

  // "Clean up" in Settings: reads every member now and removes the ones Homey does not have, without waiting
  // for the automatic cleanup. Must run in app context (it calls the Homey API).
  async cleanupGroupMissing(group) {
    const devices = await readGroupMembers(group, this.gateway);
    const gone = group.devices.filter((device, index) => !devices[index]).map((device) => device.id);
    const names = await this._pruneGroupMembers(group, gone);
    return { removed: names, remaining: group.devices.length };
  }
};
