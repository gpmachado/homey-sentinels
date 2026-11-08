'use strict';

// Availability watchdogs, the all-devices scan and their settings in the store. Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { normalizeAvailabilitySettings } = require('../availability');
const { migrateAvailabilityWatchdog } = require('./migrations');

module.exports = {
  // One watchdog per device — keyed by deviceId itself (not a synthetic id) since there's
  // nothing to disambiguate: a device either has a watchdog configured on it or it doesn't.
  // Polled, not subscribed (see app.js#_pollAvailabilityWatchdogs), same as groups — checking
  // available/lastSeenAt every few minutes is precise enough for an hours-scale threshold.
  // ignoreUnavailable: for a device that goes "unavailable" on purpose (an appliance switched off, a
  // cloud app that marks it offline) — only "hasn't reported for thresholdHours" counts, not the flag.
  upsertAvailabilityWatchdog({ deviceId, name, thresholdHours, ignoreUnavailable }) {
    if (!deviceId) throw new Error('Pick a device to watch.');
    const existing = this.data.availabilityWatchdogs[deviceId];
    if (existing) {
      if (Number.isFinite(thresholdHours)) existing.thresholdHours = thresholdHours;
      if (ignoreUnavailable !== undefined) existing.ignoreUnavailable = ignoreUnavailable === true || ignoreUnavailable === 'true';
      return existing;
    }
    const watchdog = {
      deviceId, name: name || deviceId,
      thresholdHours: Number.isFinite(thresholdHours) ? thresholdHours : this.data.availabilitySettings.defaultThresholdHours,
      ignoreUnavailable: ignoreUnavailable === true || ignoreUnavailable === 'true',
      wentUnavailableAt: null, reason: null
    };
    migrateAvailabilityWatchdog(watchdog);
    this.data.availabilityWatchdogs[deviceId] = watchdog;
    return watchdog;
  },
  updateAvailabilityWatchdog(watchdog, { thresholdHours } = {}) {
    if (Number.isFinite(thresholdHours)) watchdog.thresholdHours = thresholdHours;
    return watchdog;
  },
  deleteAvailabilityWatchdog(deviceId) { delete this.data.availabilityWatchdogs[deviceId]; },
  getAvailabilitySettings() { return this.data.availabilitySettings; },
  updateAvailabilitySettings(patch) {
    this.data.availabilitySettings = normalizeAvailabilitySettings({ ...this.data.availabilitySettings, ...(patch || {}) });
    return this.data.availabilitySettings;
  },
  // What the last all-devices scan left behind (see lib/availability-scan.js) and the devices/zones
  // the user asked it to skip. `at` is when the scan ran; `baselined` says a scan has run before, so the
  // very first one records what is already wrong instead of announcing all of it.
  setAvailabilityScan(state, at) { this.data.availabilityScan = { state, baselined: true, at }; },
  setAvailabilityExclusion({ deviceId, zone, app, name, excluded }) {
    const exclusions = this.data.availabilityExclusions;
    if (deviceId) { if (excluded) exclusions.devices[deviceId] = String(name || deviceId); else delete exclusions.devices[deviceId]; }
    if (zone) { if (excluded) exclusions.zones[zone] = true; else delete exclusions.zones[zone]; }
    if (app) { if (excluded) exclusions.apps[app] = true; else delete exclusions.apps[app]; }
    return exclusions;
  },
  // A silence limit of its own for one app's devices (solar panels are quiet all night, so 12 h is too short
  // for them); no value or 0 goes back to the default.
  setAppHours(app, hours) {
    const number = Math.round(Number(hours));
    if (!app) return this.data.availabilityExclusions;
    if (Number.isFinite(number) && number > 0) this.data.availabilityExclusions.appHours[app] = Math.min(number, 24 * 90);
    else delete this.data.availabilityExclusions.appHours[app];
    return this.data.availabilityExclusions;
  },
  // Watchdogs whose device Homey no longer knows (set by the poll after repeated "not found").
  removeMissingWatchdogs() {
    const ids = Object.values(this.data.availabilityWatchdogs).filter((watchdog) => watchdog.missing).map((watchdog) => watchdog.deviceId);
    ids.forEach((id) => delete this.data.availabilityWatchdogs[id]);
    return ids.length;
  },
};
