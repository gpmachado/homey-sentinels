'use strict';

// State groups: the periodic mismatch poll, live checks and the Flow autocompletes for groups.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { assertGroupDevice, checkGroup } = require('../groups');
const { GROUP_POLL_INTERVAL_MS } = require('./constants');

module.exports = {
  _groupResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.groups).filter((g) => g.name.toLowerCase().includes(normalized)).map((g) => ({ name: g.name, description: g.type, data: { id: g.id } })); },

  _groupActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query)); },

  _groupConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query)); },

  _group(arg) { const item = this.store.data.groups[arg?.id || arg?.data?.id]; if (!item) throw new Error('Group not found.'); return item; },

  _assertGroupDevice(group, device) { return assertGroupDevice(group, device); },

  _checkGroup(group, expectedOverride) { return checkGroup(group, this.gateway, expectedOverride); },

  // Feeds get_group_statistics — the closest a group gets to real history without a full
  // live-subscription rewrite (see GROUP_POLL_INTERVAL_MS). A group with fewer than 2 devices
  // shouldn't exist (creation already requires it) but skip defensively rather than let one bad
  // group's error stop every other group's poll this tick.
  async _pollGroups() {
    const timeZone = this._getTimezone();
    for (const group of Object.values(this.store.data.groups)) {
      if (group.devices.length < 2) continue;
      try {
        const result = await this._checkGroup(group);
        this.store.recordGroupPoll(group, result.mismatchCount, GROUP_POLL_INTERVAL_MS / 1000, timeZone);
        // Fires only on the transition into/out of a mismatch, not on every poll tick while it
        // stays that way — mismatchSince is the group's own memory of "was this already
        // reported" across polls. Still bounded by the poll cadence (up to
        // GROUP_POLL_INTERVAL_MS late), not a real capability subscription — "Check state
        // group" remains the only instant, on-demand path.
        if (result.mismatchCount > 0 && !group.mismatchSince) {
          group.mismatchSince = Date.now();
          this._logEvent(result.message || `${group.name} has a mismatch`);
          await this.groupCards.mismatchDetected.trigger(
            { mismatch_count: result.mismatchCount, match_count: result.matchCount, mismatch_list: result.mismatchList, message: result.message },
            { groupId: group.id }
          );
        } else if (result.mismatchCount === 0 && group.mismatchSince) {
          group.mismatchSince = null;
          this._logEvent(`${group.name} is back to normal`);
          await this.groupCards.matchedAgain.trigger({ message: result.message }, { groupId: group.id });
        }
      } catch (error) {
        this.error('Failed to poll group', group.name, error);
      }
    }
    this._scheduleSave();
  }
};
