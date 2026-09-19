'use strict';

const Homey = require('homey');
const SentinelStore = require('./lib/store');
const HomeyDeviceGateway = require('./lib/homey-device-gateway');
const { ActivityEngine } = require('./lib/activity-engine');
const { VoltageEngine } = require('./lib/voltage-engine');
const { isValidTimeZone } = require('./lib/time');
const { punctuationToAscii } = require('./lib/text');
const { startMemoryGuard } = require('./lib/memory-guard');
const { DeviceDirectory } = require('./lib/device-directory');
const { resumeWithRetry } = require('./lib/resume');
const { openHistoryDb } = require('./lib/history-db');
const { DEVICE_CACHE_REFRESH_MS, HISTORY_CONSOLIDATION_MS, EVENT_LOG_MAX, GROUP_POLL_INTERVAL_MS, AVAILABILITY_POLL_INTERVAL_MS, SAVE_DEBOUNCE_MS } = require('./lib/app/constants');

// Regenerated on every commit (see scripts/write-build-info.js, .git/hooks/post-commit) — the
// app's own version stays 1.0.0 across every dev iteration, so without this a pasted log has no
// way to tell which commit actually produced it (confirmed live: a full day of crash logs
// turned out to be from a build several commits stale, because `homey app run -r` was never
// restarted after the fix landed). Missing entirely on a machine that never ran the stamp
// script — falls back to null fields, logged as "unknown" rather than throwing.
let buildInfo = null;
try { buildInfo = require('./build-info.json'); } catch (error) { /* not stamped yet */ }

class StatisticTrackerApp extends Homey.App {
  async onInit() {
    // The bulky series live in a SQLite file under /userdata, not in settings (see lib/history-db.js).
    // /userdata is served over plain HTTP on the LAN without authentication, so the file gets a random
    // name that is generated once and remembered; if the database can't be opened the store falls back
    // to keeping the series in settings.
    this._history = openHistoryDb(`/userdata/${this._historyFileName()}`, { log: (message) => this.log(message) });
    this.store = new SentinelStore(this.homey.settings, { history: this._history });
    await this.store.load();
    if (this.store.migratedFrom) this.log(`Storage migrated from ${this.store.migratedFrom}.`);
    this.store.warnings.forEach((warning) => this.log(`Storage warning: ${warning}`));
    this.log(`History storage: ${this._history ? `SQLite (${Math.round(this._history.sizeBytes() / 1024)} KB)` : 'settings key (SQLite unavailable)'}`);
    // The device list used to be persisted here; it now lives in memory only (see the gateway), and
    // the old copy would keep inflating every settings write.
    try { this.homey.settings.unset('deviceCache'); } catch (error) { /* nothing to remove */ }
    this._stopMemoryGuard = startMemoryGuard(this.homey, { log: (m) => this.log(m), error: (m, e) => this.error(m, e) });
    // In-memory only, deliberately not persisted — a per-monitor cooldown so a burst of rapid
    // samples (a device cycling its heating element on/off) can't re-run _suggestedThreshold's
    // sort over the whole periods[] array on every single one of them while still calibrating.
    this._lastCalibrationAttempt = new Map();
    this._calibrationAttempts = new Map();
    this._summaryCache = new Map();
    this._saveTimer = null;
    this.engine = new ActivityEngine();
    this.voltageEngine = new VoltageEngine();
    this.gateway = new HomeyDeviceGateway(this.homey);
    // The full device list is read on demand only (Settings pickers, the Availability tab, Flow
    // autocompletes) — never at startup or on a timer: reading all devices grows the process by ~13 MB
    // for good on a Homey with 300 devices. After each read the freed pages are handed back.
    this.directory = new DeviceDirectory({
      gateway: this.gateway,
      defer: (fn) => this.homey.setTimeout(fn, 0),
      log: (message) => this.log(message),
      error: (message, error) => this.error(message, error),
      onRefreshed: () => { if (this._stopMemoryGuard && this._stopMemoryGuard.reclaim) this._stopMemoryGuard.reclaim('device list'); }
    });
    this.cards = {
      started: this.homey.flow.getTriggerCard('activity_started'),
      finished: this.homey.flow.getTriggerCard('activity_finished'),
      calibrated: this.homey.flow.getTriggerCard('threshold_calibrated'),
      cyclesReached: this.homey.flow.getTriggerCard('activity_cycles_reached'),
      unusuallyLong: this.homey.flow.getTriggerCard('activity_cycle_unusually_long')
    };
    this.stateCards = {
      started: this.homey.flow.getTriggerCard('state_started'),
      finished: this.homey.flow.getTriggerCard('state_finished')
    };
    this.voltageCards = {
      undervoltage: this.homey.flow.getTriggerCard('voltage_undervoltage_detected'),
      overvoltage: this.homey.flow.getTriggerCard('voltage_overvoltage_detected'),
      normalized: this.homey.flow.getTriggerCard('voltage_returned_to_normal')
    };
    this.binaryCards = {
      logged: this.homey.flow.getTriggerCard('binary_event_logged')
    };
    this.groupCards = {
      mismatchDetected: this.homey.flow.getTriggerCard('group_mismatch_detected'),
      matchedAgain: this.homey.flow.getTriggerCard('group_matched_again')
    };
    this.availabilityCards = {
      unavailable: this.homey.flow.getTriggerCard('device_became_unavailable'),
      available: this.homey.flow.getTriggerCard('device_became_available'),
      batteryLow: this.homey.flow.getTriggerCard('device_battery_low')
    };
    this._registerFlowCards();
    this._registerWidgets();
    const buildTag = buildInfo ? `${buildInfo.commit}${buildInfo.dirty ? '+dirty' : ''} (${buildInfo.subject || 'no subject'}, ${buildInfo.commitDate || 'unknown date'})` : 'unstamped — run `npm run stamp`';
    this.log(`Sentinels started — observation only, no device control. [build ${buildTag}] [node ${process.version}, sqlite ${process.versions.sqlite || 'n/a'}]`);

    // Device/network work happens in the background, on purpose: onInit must resolve and
    // the Flow cards above must be registered even if HomeyAPI is slow or unreachable —
    // otherwise the app never reports ready and no card shows up in the Flow editor at all.
    this.gateway.refreshSystemTimezone().catch((error) => this.error('Failed to detect system timezone', error));
    this._scheduleWithBackoff('System timezone refresh', () => this.gateway.refreshSystemTimezone(), DEVICE_CACHE_REFRESH_MS);
    this._consolidateHistory();
    this.homey.setInterval(() => this._consolidateHistory(), HISTORY_CONSOLIDATION_MS);
    // A crash inside a few minutes leaves nothing between startup and the abort — a memory trail
    // makes it possible to tell steady growth from a single large allocation. Dense for the first
    // three minutes (that's when the startup/migration work happens), then every five.
    let memoryTick = 0;
    this.homey.setInterval(() => {
      memoryTick += 1;
      if (memoryTick <= 12 || memoryTick % 20 === 0) this._logMemory().catch(() => {});
    }, 15 * 1000);
    // The Homey as a whole is often short on memory (a Homey Pro 2023 sat at 86% used with 14% free);
    // this shows who holds it. Once shortly after start (with the raw response, to confirm its
    // shape), then hourly. A rejected call (scope not granted) is reported once and not retried.
    this.homey.setTimeout(() => this._logSystemMemory(true), 45 * 1000);
    this.homey.setInterval(() => this._logSystemMemory(false), 60 * 60 * 1000);
    this._pollGroups().catch((error) => this.error('Failed to poll groups', error));
    this._scheduleWithBackoff('Group mismatch polling', () => this._pollGroups(), GROUP_POLL_INTERVAL_MS);
    // Right after the app starts some drivers haven't loaded their devices yet, so the first look at the
    // watchdogs waits (Settings -> Availability -> defaults) instead of raising alarms that clear themselves.
    const graceMs = this.store.getAvailabilitySettings().startupGraceMinutes * 60 * 1000;
    this.homey.setTimeout(() => {
      this._pollAvailabilityWatchdogs().catch((error) => this.error('Failed to poll availability watchdogs', error));
      this._scheduleWithBackoff('Availability watchdog polling', () => this._pollAvailabilityWatchdogs(), AVAILABILITY_POLL_INTERVAL_MS);
    }, graceMs);
    // Resuming a monitor needs its device: right after a Homey reboot the apps start before the
    // devices are ready, so a failed attempt is retried with growing waits instead of leaving the
    // monitor silent until the next restart.
    const resume = (kind, collection, start) => Object.values(this.store.data[collection]).forEach((monitor) => resumeWithRetry({
      label: `[${monitor.name}] ${kind}`,
      start: () => start(monitor),
      isStillWanted: () => Boolean(this.store.data[collection][monitor.id]),
      schedule: (fn, ms) => this.homey.setTimeout(fn, ms),
      log: (message) => this.log(message),
      error: (message) => this.error(message)
    }));
    resume('monitor', 'monitors', (monitor) => this._watch(monitor));
    resume('voltage monitor', 'voltageMonitors', (monitor) => this._watchVoltage(monitor));
    resume('state monitor', 'stateMonitors', (monitor) => this._watchState(monitor));
  }

  // A plain setInterval calling something network-dependent (device cache, system timezone)
  // logs the exact same failure forever, at full frequency, if Homey's own API is unreachable
  // for hours — confirmed as a real annoyance during a network blip earlier this session.
  // Doubles the wait after each consecutive failure (capped at 8x the base interval) and drops
  // back to normal the moment a call succeeds again, so a real outage doesn't spam the log
  // while a brief hiccup still recovers on the very next regular tick. Also thins out the log
  // itself during a prolonged outage — full detail for the first few failures, then only every
  // 10th attempt — rather than silencing it (still need to know it's ongoing).
  _scheduleWithBackoff(label, fn, baseIntervalMs, maxIntervalMs = baseIntervalMs * 8) {
    let currentInterval = baseIntervalMs;
    let consecutiveFailures = 0;
    const tick = async () => {
      try {
        await fn();
        if (consecutiveFailures > 0) this.log(`${label} recovered after ${consecutiveFailures} failed attempt(s)`);
        consecutiveFailures = 0;
        currentInterval = baseIntervalMs;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures <= 3 || consecutiveFailures % 10 === 0) this.error(`${label} failed (attempt ${consecutiveFailures})`, error);
        currentInterval = Math.min(currentInterval * 2, maxIntervalMs);
      }
      this.homey.setTimeout(tick, currentInterval);
    };
    this.homey.setTimeout(tick, baseIntervalMs);
  }

  // Coalesces rapid-fire saves from the sample hot path (see SAVE_DEBOUNCE_MS above) — any
  // number of calls while one is already pending just ride along on that same upcoming write,
  // since store.save() always persists the full current state regardless of what changed.
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = this.homey.setTimeout(() => {
      this._saveTimer = null;
      this.store.save().catch((error) => this.error('Failed to save (debounced)', error));
    }, SAVE_DEBOUNCE_MS);
  }

  // Flushes a still-pending debounced save immediately — without this, an app update/restart
  // landing inside the debounce window would silently drop whatever samples arrived since the
  // last write.
  // Runs `fn` from a timer instead of on the caller's stack. Routes of the app's Web API call this
  // around anything that talks to the Homey API: a call made from inside a route has been seen to
  // never resolve, and from a timer it runs in the same context as the Flow cards and onInit.
  inAppContext(fn) {
    return new Promise((resolve, reject) => {
      this.homey.setTimeout(() => { Promise.resolve().then(fn).then(resolve, reject); }, 0);
    });
  }

  _historyFileName() {
    let name = this.homey.settings.get('historyFile');
    if (!name) {
      name = `sentinels-${require('crypto').randomBytes(12).toString('hex')}.sqlite`;
      this.homey.settings.set('historyFile', name);
    }
    return name;
  }

  async onUninit() {
    if (this._saveTimer) {
      this.homey.clearTimeout(this._saveTimer);
      this._saveTimer = null;
      await this.store.save().catch((error) => this.error('Failed to save on shutdown', error));
    }
    try { this._history?.close(); } catch (error) { /* already closed */ }
  }

  _registerWidgets() {
    const widget = this.homey.dashboards.getWidget('sentinel');
    widget.registerSettingAutocompleteListener('monitorId', async (query) => this._monitorOrGroupAutocomplete(query));
    const overviewWidget = this.homey.dashboards.getWidget('overview');
    ['monitor1', 'monitor2', 'monitor3', 'monitor4', 'monitor5'].forEach((id) =>
      overviewWidget.registerSettingAutocompleteListener(id, async (query) => this._monitorOrGroupAutocomplete(query)));
  }

  // Homey sometimes stores the widget setting's full autocomplete result ({name, data:{id}}),
  // not just the id string it appears to be from the picker — unwrap defensively either way.
  // Called right alongside every real trigger (started/finished/under-/over-voltage/normalized/
  // binary event) — see the call sites in _handleActivityEvents/_handleStateEvents/
  // _handleVoltageEvents/log_binary_event — with the exact message already rendered for that
  // Flow card's own `message` token, so there's nothing new to compute here. Not called for
  // 'continuity_pending' (not a real event yet) or the "used to be" Flow cards' own token
  // fallbacks (_startedSnapshot/_finishedSnapshot are just what a card returns when nothing
  // actually changed).
  _logEvent(message) {
    if (!message) return;
    this.store.data.eventLog ||= [];
    this.store.data.eventLog.push({ timestamp: Date.now(), message: punctuationToAscii(message) });
    if (this.store.data.eventLog.length > EVENT_LOG_MAX) this.store.data.eventLog.shift();
  }

  getRecentEvents(limit = 10) {
    return (this.store.data.eventLog || []).slice(-limit).reverse();
  }

  // homey.clock.getTimezone() isn't always trustworthy — confirmed returning "UTC" on
  // hardware whose actual region is set to Brazil, while Homey's own System Information
  // screen (backed by system.getInfo().timezone, cached via gateway.refreshSystemTimezone)
  // shows the real zone. The midnight cutoff for "day" statistics depends on getting this
  // right, so prefer the detected value over the unreliable clock manager, and still let the
  // user override either one explicitly as a last resort.
  _getTimezone() { return this.homey.settings.get('timezoneOverride') || this.gateway.getCachedSystemTimezone() || this.homey.clock.getTimezone(); }

  getTimezoneSettings() {
    return {
      override: this.homey.settings.get('timezoneOverride') || '',
      detected: this.gateway.getCachedSystemTimezone() || '',
      reported: this.homey.clock.getTimezone(),
      effective: this._getTimezone()
    };
  }

  setTimezoneOverride(timeZone) {
    const value = (timeZone || '').trim();
    if (value && !isValidTimeZone(value)) throw new Error(`"${value}" is not a valid IANA timezone (e.g. America/Sao_Paulo).`);
    this.homey.settings.set('timezoneOverride', value);
    return this.getTimezoneSettings();
  }

  // Collapses an autocomplete selection ({name, data:{id}}) down to something short and
  // readable for the log line, instead of dumping the whole nested object.
  _summarizeArgs(args) {
    const summary = {};
    for (const key of Object.keys(args || {})) {
      const value = args[key];
      summary[key] = (value && typeof value === 'object') ? (value.name ?? value.data?.id ?? value.id ?? JSON.stringify(value)) : value;
    }
    return summary;
  }
}

// The app's behaviour is split by concern under lib/app/. Each module exports plain methods that are
// mixed into the prototype, so they keep using `this` (store, gateway, homey) exactly as before.
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/activity'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/availability-watchdogs'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/flow-cards'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/groups'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/memory'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/monitor-admin'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/state'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/summaries'));
Object.assign(StatisticTrackerApp.prototype, require('./lib/app/voltage'));

module.exports = StatisticTrackerApp;
