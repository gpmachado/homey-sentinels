'use strict';

// The startup summary line and the periodic history consolidation that keeps the store small.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.

module.exports = {
  // One line at startup saying what this app is running, so a pasted log shows it at once.
  _startupSummary() {
    const data = this.store.data;
    const count = (collection) => Object.keys(data[collection] || {}).length;
    const members = Object.values(data.groups || {}).reduce((total, group) => total + group.devices.length, 0);
    const missing = ['monitors', 'stateMonitors', 'voltageMonitors'].reduce((total, collection) => total + Object.values(data[collection] || {}).filter((monitor) => monitor.deviceMissing).length, 0);
    const availability = this.store.getAvailabilitySettings();
    return `Watching: ${count('monitors')} activity, ${count('stateMonitors')} state and ${count('voltageMonitors')} voltage monitors`
      + `${missing ? ` (${missing} with a missing device)` : ''}, ${count('groups')} groups (${members} devices), `
      + `${count('availabilityWatchdogs')} watchdogs; availability scan ${availability.scanAll ? `every ${availability.scanIntervalMinutes} min` : 'off'}`;
  },

  // Runs at startup and every 6 h: folds old periods into daily summaries, then saves. Logs its cost, the only way to tell whether a
  // synchronous pass over a monitor's raw periods (7 days of them) is long enough to trip Homey's CPU watchdog.
  _consolidateHistory() {
    try {
      const periodCount = () => [this.store.data.monitors, this.store.data.stateMonitors, this.store.data.voltageMonitors]
        .reduce((total, collection) => total + Object.values(collection).reduce((sum, monitor) => sum + (monitor.periods?.length || 0), 0), 0);
      const before = periodCount();
      const startedAt = Date.now();
      this.store.consolidateHistory(this._getTimezone());
      this.log(`Consolidated history in ${Date.now() - startedAt}ms (periods ${before} -> ${periodCount()}${this._history ? `, history db ${Math.round(this._history.sizeBytes() / 1024)} KB` : ''})`);
      this.store.save().then(() => this._history?.checkpoint()).catch((error) => this.error('Failed to save after consolidating history', error));
    } catch (error) {
      this.error('Failed to consolidate history', error);
    }
  }
};
