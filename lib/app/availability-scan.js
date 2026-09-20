'use strict';

// The all-devices availability scan (the Device Watchdog way): every device that has no watchdog of its
// own is judged with the watchdog defaults, so a dead sensor shows up without anyone adding a watchdog.
// It reads the whole device list once per interval — the one place besides Settings that does — and the
// list is released for garbage collection right after (see DeviceDirectory's onRefreshed).
const { scanDevices } = require('../availability-scan');
const { punctuationToAscii } = require('../text');

const SCAN_MIN_INTERVAL_MS = 60 * 1000; // "Scan now" never reads the list more often than this
const SCAN_TRIGGER_MAX = 10;            // one scan announces at most this many new problems as Flow triggers

module.exports = {
  // Runs one scan and stores the outcome. Never throws.
  async _runAvailabilityScan() {
    const settings = this.store.getAvailabilitySettings();
    if (!settings.scanAll) { this._availabilityScan = null; return null; }
    try {
      const devices = await this.directory.ensure(SCAN_MIN_INTERVAL_MS);
      if (!devices.length) return this._availabilityScan || null; // the list could not be read; keep what was known
      const previous = this.store.data.availabilityScan;
      const now = Date.now();
      const result = scanDevices(devices, {
        settings, exclusions: this.store.data.availabilityExclusions,
        watchedIds: new Set(Object.keys(this.store.data.availabilityWatchdogs)),
        previous: previous.state, now
      });
      // The first scan only records what is already wrong; announcing it would be a flood.
      const announce = previous.baselined ? result.problems.filter((problem) => problem.isNew) : [];
      this.store.setAvailabilityScan(result.state, now);
      this._availabilityScan = { at: now, monitored: result.monitored, counts: result.counts, problems: result.problems };
      this._summaryCache.delete('widget:watchdogs');
      this._scheduleSave();
      await this._announceScanProblems(announce);
      this.log(`availability scan: ${result.monitored} devices, ${result.counts.stale} not reporting, ${result.counts.unavailable} unavailable, ${result.counts.lowBattery} low battery`);
      return this._availabilityScan;
    } catch (error) {
      this.error('Availability scan failed', error);
      return this._availabilityScan || null;
    }
  },

  async _announceScanProblems(problems) {
    if (!problems.length) return;
    for (const problem of problems) {
      const what = problem.reason === 'stale' ? 'has stopped reporting' : problem.reason === 'unavailable' ? 'is unavailable' : `has a low battery (${Math.round(problem.battery)}%)`;
      this._logEvent(`${problem.name} ${what}`);
    }
    if (this.store.getAvailabilitySettings().timelineNotifications) {
      const names = problems.slice(0, 3).map((problem) => problem.name).join(', ');
      this._notifyTimeline(problems.length === 1
        ? `${problems[0].name} ${problems[0].reason === 'stale' ? 'has stopped reporting' : problems[0].reason === 'unavailable' ? 'is unavailable' : 'has a low battery'}`
        : `${problems.length} devices need attention: ${names}${problems.length > 3 ? ` and ${problems.length - 3} more` : ''}`);
    }
    for (const problem of problems.slice(0, SCAN_TRIGGER_MAX)) {
      try {
        await this.availabilityCards.problem.trigger({
          device: problem.name, zone: problem.zoneName || '', last_seen: problem.lastSeenAt || '',
          reason: problem.reason || 'low_battery', battery: Number.isFinite(problem.battery) ? problem.battery : 0
        });
      } catch (error) {
        this.error('Trigger for a scanned device failed', error);
      }
    }
  },

  // Runs a scan now and again after each interval (read fresh from the settings every time, so a changed
  // interval applies without a restart).
  _scheduleAvailabilityScan(delayMs) {
    if (this._scanTimer) { this.homey.clearTimeout(this._scanTimer); this._scanTimer = null; }
    this._scanTimer = this.homey.setTimeout(async () => {
      this._scanTimer = null;
      await this._runAvailabilityScan();
      this._scheduleAvailabilityScan(this.store.getAvailabilitySettings().scanIntervalMinutes * 60 * 1000);
    }, Math.max(1000, delayMs));
  },

  // What Settings and the widget show. `null` while no scan has finished yet (or the scan is off).
  getAvailabilityScanSummary() {
    const settings = this.store.getAvailabilitySettings();
    const exclusions = this.store.data.availabilityExclusions;
    return {
      enabled: settings.scanAll,
      scan: this._availabilityScan || null,
      excludedDevices: Object.entries(exclusions.devices).map(([id, name]) => ({ id, name })),
      excludedZones: Object.keys(exclusions.zones),
      excludedApps: Object.keys(exclusions.apps)
    };
  },

  // "Scan now" from Settings or the widget; a scan that just ran is answered from memory.
  async runAvailabilityScanNow() {
    if (!this._availabilityScan || Date.now() - this._availabilityScan.at > SCAN_MIN_INTERVAL_MS) await this._runAvailabilityScan();
    return this.getAvailabilityScanSummary();
  },

  async setAvailabilityExclusion(body) {
    this.store.setAvailabilityExclusion({ deviceId: body.deviceId, zone: body.zone, app: body.app, name: body.name, excluded: body.excluded === true || body.excluded === 'true' });
    await this.store.save();
    // Drop it from the shown results at once; the next scan rebuilds them.
    if (this._availabilityScan) {
      const exclusions = this.store.data.availabilityExclusions;
      this._availabilityScan.problems = this._availabilityScan.problems.filter((problem) => !exclusions.devices[problem.id] && !(problem.zoneName && exclusions.zones[problem.zoneName]) && !(problem.ownerUri && exclusions.apps[problem.ownerUri]));
      this._availabilityScan.counts = {
        stale: this._availabilityScan.problems.filter((p) => p.reason === 'stale').length,
        unavailable: this._availabilityScan.problems.filter((p) => p.reason === 'unavailable').length,
        lowBattery: this._availabilityScan.problems.filter((p) => p.lowBattery).length
      };
    }
    this._summaryCache.delete('widget:watchdogs');
    return this.getAvailabilityScanSummary();
  }
};
