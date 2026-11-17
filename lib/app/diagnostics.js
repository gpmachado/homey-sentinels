'use strict';

// The Diagnostics tab of the Settings page: how the app itself is doing (build, storage, memory, Homey's warnings, the last
// reading of each monitor). Read-only, and built only from what is already in memory: no device read, no Insights, no
// database query beyond the file size. Methods are mixed into StatisticTrackerApp's prototype (see app.js).

const MONITOR_KINDS = [['monitors', 'activity'], ['stateMonitors', 'state'], ['voltageMonitors', 'voltage']];

// The text of one value an error log call got. Never throws: an error from homey-api can carry a circular request, and
// JSON.stringify also refuses a BigInt.
function textOf(arg) {
  if (arg instanceof Error) return arg.message;
  if (typeof arg === 'string') return arg;
  try {
    const text = JSON.stringify(arg);
    return text === undefined ? String(arg) : text;
  } catch (error) {
    return String(arg);
  }
}

// The heap in use, from V8. process.memoryUsage() is not used: it also reads the process's resident memory, which the
// Homey's app sandbox refuses (ENOENT: uv_resident_set_memory), and the error took the whole tab down. Required here
// rather than at the top, so a sandbox that refused the module too would cost this one line, not the app's start.
function heapUsedBytes() {
  try { return require('node:v8').getHeapStatistics().used_heap_size; } catch (error) { return null; }
}

module.exports = {
  // Called by app.js for every this.error(): keeps the last one for the Diagnostics tab. The text is shown on the screen
  // only: the copied report gives just its age, since any part of it can hold a monitor's or group's name
  // ('[Pump] activity monitor could not start watching').
  _rememberError(args) {
    this._lastError = { at: Date.now(), message: args.map(textOf).join(' ').slice(0, 300) };
  },

  // Called by app.js for Homey's memwarn / cpuwarn events.
  _rememberWarning(kind, payload) {
    this._homeyWarnings ||= {};
    this._homeyWarnings[kind] = { count: payload?.count ?? null, limit: payload?.limit ?? null, at: Date.now() };
  },

  getDiagnostics() {
    const data = this.store.data;
    const build = this.buildInfo || null;
    const monitors = [];
    for (const [collection, kind] of MONITOR_KINDS) {
      for (const monitor of Object.values(data[collection] || {})) {
        monitors.push({
          kind,
          name: monitor.name,
          deviceName: monitor.deviceName || '',
          deviceMissing: Boolean(monitor.deviceMissing),
          calibrating: kind === 'activity' && Boolean(monitor.calibrating),
          lastReadingAt: monitor.lastSample?.timestamp ?? null
        });
      }
    }
    return {
      now: Date.now(),
      app: {
        version: this.homey.manifest?.version || null,
        build: build ? { commit: build.commit || null, dirty: Boolean(build.dirty), subject: build.subject || null, date: build.commitDate || null } : null,
        node: process.version,
        sqlite: process.versions.sqlite || null,
        startedAt: this._startedAt || null
      },
      storage: {
        database: Boolean(this._history),
        sizeBytes: this._history ? this._history.sizeBytes() : null,
        degraded: Boolean(this.store.historyUnavailable),
        warnings: [...(this.store.warnings || [])],
        lastSave: this.store.lastSave || null,
        lastConsolidation: this._lastConsolidation || null
      },
      load: {
        heapUsedBytes: heapUsedBytes(),
        cpuWarning: this._homeyWarnings?.cpu || null,
        memoryWarning: this._homeyWarnings?.memory || null
      },
      subscriptions: this.gateway?.instances?.size ?? 0,
      detailedLog: Boolean(data.logSettings?.verbose),
      lastError: this._lastError || null,
      counts: { groups: Object.keys(data.groups || {}).length, watchdogs: Object.keys(data.availabilityWatchdogs || {}).length },
      availabilityScanAt: this._availabilityScan?.at ?? null,
      monitors
    };
  }
};
