'use strict';

// The app's data and everything that may change it. The class holds the state; its methods live in
// lib/store/, one file per concern, and are copied onto the prototype below (the same arrangement as
// the App class and lib/app/).
const { migrateActivityMonitor, migrateStateMonitor, migrateGroup, migrateVoltageMonitor, migrateAvailabilityWatchdog, normalizeMessageSettings } = require('./store/migrations');
const { GRANULAR_RETENTION_DAYS, TOTAL_RETENTION_DAYS, CYCLE_RETENTION_DAYS, compactVoltagePeriods, retentionMethods } = require('./store/retention');

class SentinelStore {
  // `history` is an opened history database (lib/history-db.js) or null; without one the series are
  // kept in the settings key, exactly as before.
  constructor(settings, { history = null } = {}) {
    this.settings = settings; this.history = history; this.data = null; this._lastSaved = null; this._saving = Promise.resolve();
    this.migratedFrom = null; this.revision = 0; this._seriesState = new Map(); this._dbMonitors = new Set(); this.warnings = [];
    this.historyUnavailable = false; // a v3 store whose database did not open: see load()
  }
  // Without its database a reset would only clear memory and the old rows would come back at the next start (see
  // load()), so it is refused with a reason instead.
  _assertHistoryWritable() {
    if (this.historyUnavailable) throw new Error('The history database is not available right now, so history cannot be reset or rebuilt. Restart the app and try again.');
  }
  getMessageSettings() { return this.data.messageSettings; }
  // Detailed log: off by default, so the log only has events and errors.
  getLogSettings() { return this.data.logSettings; }
  updateLogSettings(patch) {
    this.data.logSettings = { verbose: (patch || {}).verbose === true || (patch || {}).verbose === 'true' };
    return this.data.logSettings;
  }
  updateMessageSettings(patch) {
    this.data.messageSettings = normalizeMessageSettings({ ...this.data.messageSettings, ...(patch || {}) });
    return this.data.messageSettings;
  }
}

Object.assign(
  SentinelStore.prototype,
  require('./store/persistence'),
  require('./store/activity-monitors'),
  require('./store/state-monitors'),
  require('./store/voltage-monitors'),
  require('./store/groups'),
  require('./store/availability'),
  retentionMethods
);

module.exports = SentinelStore;
module.exports.GRANULAR_RETENTION_DAYS = GRANULAR_RETENTION_DAYS;
module.exports.TOTAL_RETENTION_DAYS = TOTAL_RETENTION_DAYS;
module.exports.CYCLE_RETENTION_DAYS = CYCLE_RETENTION_DAYS;
module.exports.compactVoltagePeriods = compactVoltagePeriods;
module.exports.migrateActivityMonitor = migrateActivityMonitor;
module.exports.migrateStateMonitor = migrateStateMonitor;
module.exports.migrateGroup = migrateGroup;
module.exports.migrateVoltageMonitor = migrateVoltageMonitor;
module.exports.migrateAvailabilityWatchdog = migrateAvailabilityWatchdog;
