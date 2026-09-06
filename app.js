'use strict';

const Homey = require('homey');
const SentinelStore = require('./lib/store');
const HomeyDeviceGateway = require('./lib/homey-device-gateway');
const { ACTIVE, ActivityEngine, humanDuration, standbyGraceSeconds } = require('./lib/activity-engine');
const { NORMAL, UNDERVOLTAGE, OVERVOLTAGE, VoltageEngine, stabilizationGraceSeconds } = require('./lib/voltage-engine');
const { renderMessage } = require('./lib/message-template');
const { startOfLocalDay, localDateKey, isValidTimeZone } = require('./lib/time');
const {
  statistics: computeStatistics, stateStatistics: computeStateStatistics, voltageStatistics: computeVoltageStatistics,
  binaryEventStatistics: computeBinaryEventStatistics, dailyBreakdown: computeDailyBreakdown, stateDailyBreakdown: computeStateDailyBreakdown,
  binaryDailyBreakdown: computeBinaryDailyBreakdown, suggestedThreshold: computeSuggestedThreshold, generateTextReport: computeTextReport
} = require('./lib/statistics');
const { assertGroupDevice, checkGroup, groupStatistics: computeGroupStatistics } = require('./lib/groups');

// Regenerated on every commit (see scripts/write-build-info.js, .git/hooks/post-commit) — the
// app's own version stays 1.0.0 across every dev iteration, so without this a pasted log has no
// way to tell which commit actually produced it (confirmed live: a full day of crash logs
// turned out to be from a build several commits stale, because `homey app run -r` was never
// restarted after the fix landed). Missing entirely on a machine that never ran the stamp
// script — falls back to null fields, logged as "unknown" rather than throwing.
let buildInfo = null;
try { buildInfo = require('./build-info.json'); } catch (error) { /* not stamped yet */ }

const DEVICE_CACHE_REFRESH_MS = 5 * 60 * 1000;
const HISTORY_CONSOLIDATION_MS = 6 * 60 * 60 * 1000;
// Auxiliary capabilities are detected automatically from whatever the device exposes —
// the user only picks the device (and, if needed, overrides the primary capability).
// measure_power is here for state monitors' benefit (see add_state_monitor) — it's normally
// an activity monitor's own primary capability, so this only ever fires as "auxiliary" when
// the primary capability is something else (an activity monitor on measure_current, or any
// state monitor at all, whose primary is never a power reading).
const AUXILIARY_CAPABILITY_CANDIDATES = ['measure_power', 'measure_current', 'meter_power', 'measure_voltage'];
// Feeds the Timeline widget — a rolling feed of the most recent rendered event messages across
// every monitor, capped rather than time-retained since its only purpose is "what just
// happened", not historical analysis (that's what each monitor's own statistics are for).
const EVENT_LOG_MAX = 50;
// Groups have no per-device subscription (see _checkGroup) — a light periodic poll instead of
// a full live-subscription rewrite gets 80% of the value (a daily "how much of today was this
// group mismatched" stat) for a fraction of the complexity. 5 minutes matches
// DEVICE_CACHE_REFRESH_MS's own cadence — frequent enough to be useful, infrequent enough that
// even several groups' worth of getDevice() calls per tick stays negligible.
const GROUP_POLL_INTERVAL_MS = 5 * 60 * 1000;
// Every raw capability sample across every monitor used to call store.save() synchronously —
// each one serializing and writing the ENTIRE settings blob (all monitors' periods/cycles
// combined, now 30k+ entries). Confirmed live: as that data volume grew, a burst of
// near-simultaneous samples (several monitors reporting close together) pushed cumulative save
// cost past Homey's CPU watchdog and crashed the app. Coalescing rapid saves into one write
// every this long fixes the scaling problem — store.save() always persists the current
// `this.data` wholesale, so any number of mutations before the timer fires are captured by
// that one eventual write regardless.
const SAVE_DEBOUNCE_MS = 3000;
// A calibrating monitor re-attempts _suggestedThreshold on every sample — cheap for a device
// that reports every few minutes, but a device cycling rapidly (a heating element's thermostat
// clicking on/off) can push many samples per second, each re-sorting the whole periods[]
// array. Confirmed live: this hit Homey's own CPU limit and crashed the app. A per-monitor
// cooldown bounds the sort to at most once per this interval, regardless of sample rate.
const CALIBRATION_RETRY_MS = 60 * 1000;
// MEDIAN_MIN_CYCLES, THRESHOLD_SUGGESTION_MIN_SAMPLES/MIN_GAP_RATIO, and GROUP_TYPES now live in
// lib/statistics.js and lib/groups.js respectively, alongside the functions that use them.
// Homey rejects a "number" Flow token whose value is null/undefined ("Invalid Token") —
// average()/maximum() legitimately return null for "no data yet". Only coerce at this
// Flow-token boundary; getWidgetSummary keeps reading the raw null to render "—" instead of "0".
const num = (value) => (Number.isFinite(value) ? value : 0);
// Energy is always stored/tokenized in kWh (matching Homey's meter_power capability), but a
// small appliance's single cycle is often a fraction of a kWh — "0.070 kWh" in a log line
// reads worse than "70 Wh". Human-readable log lines switch units dynamically; Flow tokens
// stay in kWh regardless, for predictable math across Flows.
const formatEnergy = (kwh) => (kwh < 1 ? `${Math.round(kwh * 1000)} Wh` : `${kwh.toFixed(2)} kWh`);

class StatisticTrackerApp extends Homey.App {
  async onInit() {
    this.store = new SentinelStore(this.homey.settings);
    await this.store.load();
    // In-memory only, deliberately not persisted — a per-monitor cooldown so a burst of rapid
    // samples (a device cycling its heating element on/off) can't re-run _suggestedThreshold's
    // sort over the whole periods[] array on every single one of them while still calibrating.
    this._lastCalibrationAttempt = new Map();
    this._saveTimer = null;
    this.engine = new ActivityEngine();
    this.voltageEngine = new VoltageEngine();
    this.gateway = new HomeyDeviceGateway(this.homey);
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
    this._registerFlowCards();
    this._registerWidgets();
    const buildTag = buildInfo ? `${buildInfo.commit}${buildInfo.dirty ? '+dirty' : ''} (${buildInfo.subject || 'no subject'}, ${buildInfo.commitDate || 'unknown date'})` : 'unstamped — run `npm run stamp`';
    this.log(`Sentinels started — observation only, no device control. [build ${buildTag}]`);

    // Device/network work happens in the background, on purpose: onInit must resolve and
    // the Flow cards above must be registered even if HomeyAPI is slow or unreachable —
    // otherwise the app never reports ready and no card shows up in the Flow editor at all.
    this.gateway.refreshDeviceCache().catch((error) => this.error('Failed to load device cache', error));
    this._scheduleWithBackoff('Device cache refresh', () => this.gateway.refreshDeviceCache(), DEVICE_CACHE_REFRESH_MS);
    this.gateway.refreshSystemTimezone().catch((error) => this.error('Failed to detect system timezone', error));
    this._scheduleWithBackoff('System timezone refresh', () => this.gateway.refreshSystemTimezone(), DEVICE_CACHE_REFRESH_MS);
    this._consolidateHistory();
    this.homey.setInterval(() => this._consolidateHistory(), HISTORY_CONSOLIDATION_MS);
    this._pollGroups().catch((error) => this.error('Failed to poll groups', error));
    this._scheduleWithBackoff('Group mismatch polling', () => this._pollGroups(), GROUP_POLL_INTERVAL_MS);
    Object.values(this.store.data.monitors).forEach((monitor) => this._watch(monitor).catch((error) => this.error('Failed to resume monitor', monitor.name, error)));
    Object.values(this.store.data.voltageMonitors).forEach((monitor) => this._watchVoltage(monitor).catch((error) => this.error('Failed to resume voltage monitor', monitor.name, error)));
    Object.values(this.store.data.stateMonitors).forEach((monitor) => this._watchState(monitor).catch((error) => this.error('Failed to resume state monitor', monitor.name, error)));
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
  async onUninit() {
    if (this._saveTimer) {
      this.homey.clearTimeout(this._saveTimer);
      this._saveTimer = null;
      await this.store.save().catch((error) => this.error('Failed to save on shutdown', error));
    }
  }
  _consolidateHistory() {
    try {
      // Runs at startup and every 6h — logging its cost is the only way to tell whether a
      // synchronous pass over a monitor's raw periods (7 days of them, uncapped in count — a
      // device sampling every few seconds can mean tens of thousands) is itself long enough to
      // trip Homey's CPU watchdog, versus some other cause entirely.
      const periodCountBefore = this._totalPeriodCount();
      // Above this, name the worst offenders directly — cheaper than waiting for another
      // crash-and-report round trip to find out which monitor is actually the problem.
      if (periodCountBefore > 20000) this._logLargestPeriodCounts();
      const startedAt = Date.now();
      this.store.consolidateHistory(this._getTimezone());
      const durationMs = Date.now() - startedAt;
      const periodCountAfter = this._totalPeriodCount();
      this.log(`Consolidated history in ${durationMs}ms (periods ${periodCountBefore} -> ${periodCountAfter})`);
      this.store.save().catch((error) => this.error('Failed to save after consolidating history', error));
    } catch (error) {
      this.error('Failed to consolidate history', error);
    }
  }
  _totalPeriodCount() {
    const collections = [this.store.data.monitors, this.store.data.stateMonitors, this.store.data.voltageMonitors];
    return collections.reduce((total, collection) => total + Object.values(collection).reduce((sum, monitor) => sum + (monitor.periods?.length || 0), 0), 0);
  }
  _logLargestPeriodCounts() {
    const collections = { activity: this.store.data.monitors, state: this.store.data.stateMonitors, voltage: this.store.data.voltageMonitors };
    const all = Object.entries(collections).flatMap(([kind, collection]) =>
      Object.values(collection).map((monitor) => ({ kind, name: monitor.name, count: monitor.periods?.length || 0 })));
    const top = all.sort((a, b) => b.count - a.count).slice(0, 5);
    this.log('Largest raw period counts:', top.map((m) => `${m.name} (${m.kind}): ${m.count}`).join(', '));
  }
  // Shared by every widget setting that needs to pick "any monitor or group" — sentinel's own
  // `monitorId`, and overview's five `monitorN` slots below.
  async _monitorOrGroupAutocomplete(query) {
    const normalized = (query || '').toLowerCase();
    const activity = Object.values(this.store.data.monitors)
      .filter((m) => m.name.toLowerCase().includes(normalized))
      .map((m) => ({ name: m.name, description: `Activity · ${m.deviceName}`, data: { id: m.id } }));
    const voltage = Object.values(this.store.data.voltageMonitors)
      .filter((m) => m.name.toLowerCase().includes(normalized))
      .map((m) => ({ name: m.name, description: `Voltage · ${m.deviceName}`, data: { id: m.id } }));
    const state = Object.values(this.store.data.stateMonitors)
      .filter((m) => m.name.toLowerCase().includes(normalized))
      .map((m) => ({ name: m.name, description: `State · ${m.deviceName}`, data: { id: m.id } }));
    const groups = Object.values(this.store.data.groups)
      .filter((g) => g.name.toLowerCase().includes(normalized))
      .map((g) => ({ name: g.name, description: `Group · ${g.devices.length} device(s)`, data: { id: g.id } }));
    const binary = Object.values(this.store.data.binaryCounters)
      .filter((c) => c.name.toLowerCase().includes(normalized))
      .map((c) => ({ name: c.name, description: 'Binary counter', data: { id: c.id } }));
    return [...activity, ...voltage, ...state, ...groups, ...binary];
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
    this.store.data.eventLog.push({ timestamp: Date.now(), message });
    if (this.store.data.eventLog.length > EVENT_LOG_MAX) this.store.data.eventLog.shift();
  }
  getRecentEvents(limit = 10) {
    return (this.store.data.eventLog || []).slice(-limit).reverse();
  }
  async getWidgetSummary(rawId, rawPeriod) {
    const id = rawId && typeof rawId === 'object' ? (rawId.data?.id || rawId.id) : rawId;
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    const activityMonitor = this.store.data.monitors[id];
    if (activityMonitor) {
      const stats = this._statistics(activityMonitor, period);
      return {
        kind: 'activity', name: activityMonitor.name, deviceName: activityMonitor.deviceName, state: activityMonitor.state,
        activeSince: activityMonitor.state === ACTIVE ? activityMonitor.activeSince : null,
        calibrating: !!activityMonitor.calibrating,
        period, cycleCount: stats.cycle_count, energy: stats.total_energy, averagePower: stats.average_power, averageCurrent: stats.average_current,
        dailyBreakdown: period === 'day' ? null : this._dailyBreakdown(activityMonitor, period === 'week' ? 7 : 30)
      };
    }
    const voltageMonitor = this.store.data.voltageMonitors[id];
    if (voltageMonitor) {
      const stats = this._voltageStatistics(voltageMonitor, period);
      return {
        kind: 'voltage', name: voltageMonitor.name, deviceName: voltageMonitor.deviceName, state: voltageMonitor.state,
        eventSince: voltageMonitor.state !== NORMAL ? voltageMonitor.eventSince : null,
        period, currentVoltage: voltageMonitor.lastSample?.voltage ?? null, minVoltage: stats.min_voltage, maxVoltage: stats.max_voltage,
        undervoltageCount: stats.undervoltage_count, overvoltageCount: stats.overvoltage_count
      };
    }
    const stateMonitor = this.store.data.stateMonitors[id];
    if (stateMonitor) {
      const stats = this._stateStatistics(stateMonitor, period);
      return {
        kind: 'state', name: stateMonitor.name, deviceName: stateMonitor.deviceName, state: stateMonitor.state,
        trueLabel: stateMonitor.trueLabel, falseLabel: stateMonitor.falseLabel,
        activeSince: stateMonitor.state === ACTIVE ? stateMonitor.activeSince : null,
        period, cycleCount: stats.cycle_count, trueDuration: stats.true_duration, falseDuration: stats.false_duration,
        dailyBreakdown: period === 'day' ? null : this._stateDailyBreakdown(stateMonitor, period === 'week' ? 7 : 30)
      };
    }
    const group = this.store.data.groups[id];
    if (group) {
      // A group has no continuous history to poll from storage — it's checked live, the
      // same way the Check state group Flow action does, just triggered by the widget's own
      // refresh timer instead of a Flow.
      const result = await this._checkGroup(group);
      return {
        kind: 'group', name: group.name, deviceName: `${group.devices.length} device(s)`,
        checkedCount: result.checkedCount, matchCount: result.matchCount, mismatchCount: result.mismatchCount,
        mismatchList: result.mismatchList, message: result.message
      };
    }
    const binaryCounter = this.store.data.binaryCounters[id];
    if (binaryCounter) {
      const stats = this._binaryEventStatistics(binaryCounter, period);
      return {
        kind: 'binary', name: binaryCounter.name, deviceName: 'Binary counter',
        period, eventCount: stats.event_count, totalCount: binaryCounter.totalCount, lastEventAt: stats.last_event_at,
        dailyBreakdown: period === 'day' ? null : this._binaryDailyBreakdown(binaryCounter, period === 'week' ? 7 : 30)
      };
    }
    return null;
  }
  // Shared by the remove_activity_monitor Flow action and the Settings page's delete button —
  // both need the exact same unsubscribe-then-forget sequence, not just a store update.
  async removeMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, item.auxiliaryCapabilities);
    this._lastCalibrationAttempt.delete(item.id);
    delete this.store.data.monitors[item.id];
    await this.store.save();
  }
  async removeVoltageMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, []);
    this.store.deleteVoltageMonitor(item.id);
    await this.store.save();
  }
  async removeStateMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, []);
    delete this.store.data.stateMonitors[item.id];
    await this.store.save();
  }
  // Shared by the reset Flow actions and the Settings page's "Reset stats" button — wipes
  // accumulated data while leaving the monitor's own configuration and live subscription
  // untouched (unlike remove*, nothing needs to unsubscribe/resubscribe here).
  async resetMonitorStats(item) {
    this.store.resetMonitor(item);
    await this.store.save();
  }
  async resetVoltageMonitorStats(item) {
    this.store.resetVoltageMonitor(item);
    await this.store.save();
  }
  async resetStateMonitorStats(item) {
    this.store.resetStateMonitor(item);
    await this.store.save();
  }
  // No gateway subscription to tear down — binary counters aren't watching any device
  // capability, so removing/resetting one is just a store update.
  async removeBinaryCounter(item) {
    this.store.deleteBinaryCounter(item.id);
    await this.store.save();
  }
  async resetBinaryCounterStats(item) {
    this.store.resetBinaryCounter(item);
    await this.store.save();
  }

  _registerFlowCards() {
    // Wrapping every card here (instead of editing each handler) logs entry/result/error for
    // free on every action and condition, present and future — the terminal from `homey app
    // run` otherwise shows nothing when a card runs or fails; only the card's own red error
    // bubble in the Flow editor did, which isn't visible from a running CLI session.
    const withLogging = (kind, id, listener) => async (args, state) => {
      this.log(`[${kind}] ${id}`, this._summarizeArgs(args));
      try {
        const result = await listener(args, state);
        this.log(`[${kind}] ${id} ok`, result === true ? undefined : result);
        return result;
      } catch (error) {
        this.error(`[${kind}] ${id} failed:`, error.message);
        throw error;
      }
    };
    const action = (id, listener) => this.homey.flow.getActionCard(id).registerRunListener(withLogging('action', id, listener));
    const condition = (id, listener) => this.homey.flow.getConditionCard(id).registerRunListener(withLogging('condition', id, listener));
    // Every trigger card fires globally for any monitor of that type (there's no other way
    // to scope a subscription-driven event to "just this one"), so without this each of the 5
    // trigger cards showed as a bare, undifferentiated title in the Flow editor with no way to
    // tell which monitor a given Flow was even reacting to. The optional `monitor` autocomplete
    // arg filters the SAME trigger to one specific monitor when set; left blank, it still fires
    // for all of them, matching the old app's identical pattern for its own trigger cards.
    const registerTriggerFilter = (card, resultsFn) => {
      card.registerRunListener(async (args, state) => {
        const filterId = args.monitor?.id || args.monitor?.data?.id;
        return filterId === state.monitorId;
      });
      card.registerArgumentAutocompleteListener('monitor', async (query) => resultsFn(query));
    };
    registerTriggerFilter(this.cards.started, (q) => this._monitorResults(q));
    registerTriggerFilter(this.cards.finished, (q) => this._monitorResults(q));
    registerTriggerFilter(this.cards.calibrated, (q) => this._monitorResults(q));
    registerTriggerFilter(this.voltageCards.undervoltage, (q) => this._voltageMonitorResults(q));
    registerTriggerFilter(this.voltageCards.overvoltage, (q) => this._voltageMonitorResults(q));
    registerTriggerFilter(this.voltageCards.normalized, (q) => this._voltageMonitorResults(q));
    registerTriggerFilter(this.stateCards.started, (q) => this._stateMonitorResults(q));
    registerTriggerFilter(this.stateCards.finished, (q) => this._stateMonitorResults(q));
    // Cycle count reached also needs the exact-cycles match, not just "which monitor" —
    // registerTriggerFilter's helper only covers the latter, so this stays hand-written.
    this.cards.cyclesReached.registerRunListener(async (args, state) => {
      const filterId = args.monitor?.id || args.monitor?.data?.id;
      return filterId === state.monitorId && Number(args.cycles) === state.cycleCount;
    });
    this.cards.cyclesReached.registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query));
    this.cards.unusuallyLong.registerRunListener(async (args, state) => {
      const filterId = args.monitor?.id || args.monitor?.data?.id;
      return filterId === state.monitorId && state.ratio >= Number(args.multiplier);
    });
    this.cards.unusuallyLong.registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query));
    this.binaryCards.logged.registerRunListener(async (args, state) => (args.counter?.id || args.counter?.data?.id) === state.counterId);
    this.binaryCards.logged.registerArgumentAutocompleteListener('counter', async (query) => this._binaryCounterResults(query));
    const deviceAutocomplete = (card) => card.registerArgumentAutocompleteListener('device', async (query) => {
      const normalized = (query || '').toLowerCase();
      return (await this.gateway.listDevices()).filter((device) =>
        device.name.toLowerCase().includes(normalized)
      ).map((device) => ({ name: device.name, description: device.zoneName || undefined, data: { id: device.id, name: device.name } }));
    });
    ['add_activity_monitor', 'add_voltage_monitor', 'add_state_monitor', 'add_device_to_state_group', 'remove_device_from_state_group', 'start_monitoring_device'].forEach((id) => deviceAutocomplete(this.homey.flow.getActionCard(id)));
    deviceAutocomplete(this.homey.flow.getConditionCard('is_device_monitored'));
    // Lists every Homey device (like Start's own picker), not just ones with an
    // already-started manual monitor — restricting to existing monitors forced building the
    // Stop half of a Flow to wait until Start had actually run once in production, just to
    // "generate" the monitor first. A device that was already started shows under its custom
    // monitor name (and still matches on that name, not just the device's own — confirmed
    // live: created as device "Poço Energy Meter" with custom name "Bomba Hidraulica",
    // searching "Bomba" found nothing when this only searched existing monitors' names). One
    // never started shows under its plain device name; the action handler itself is still the
    // one place that enforces "must be started first", with a clear error either way.
    this.homey.flow.getActionCard('stop_monitoring_device').registerArgumentAutocompleteListener('device', async (query) => {
      const normalized = (query || '').toLowerCase();
      const monitorByDeviceId = new Map(
        Object.values(this.store.data.monitors).filter((m) => m.mode === 'manual').map((m) => [m.deviceId, m])
      );
      return (await this.gateway.listDevices())
        .map((device) => ({ device, monitor: monitorByDeviceId.get(device.id) }))
        .filter(({ device, monitor }) => (monitor ? monitor.name : device.name).toLowerCase().includes(normalized) || device.name.toLowerCase().includes(normalized))
        .map(({ device, monitor }) => ({
          name: monitor ? monitor.name : device.name,
          description: monitor ? (monitor.name !== monitor.deviceName ? monitor.deviceName : undefined) : device.zoneName || undefined,
          data: { id: device.id, name: device.name }
        }));
    });
    ['add_activity_monitor', 'add_voltage_monitor', 'add_state_monitor'].forEach((id) => this._registerCapabilityAutocomplete(id));
    ['remove_activity_monitor', 'reset_activity_monitor', 'update_activity_monitor', 'get_activity_statistics', 'calibrate_threshold'].forEach((id) => this._monitorActionAutocomplete(id));
    this._monitorConditionAutocomplete('is_active');
    this._monitorConditionAutocomplete('activity_running_longer_than');
    ['remove_state_monitor', 'reset_state_monitor', 'get_state_statistics'].forEach((id) => this._stateMonitorActionAutocomplete(id));
    this._stateMonitorConditionAutocomplete('is_state_active');
    ['add_device_to_state_group', 'remove_device_from_state_group', 'check_state_group', 'get_group_statistics'].forEach((id) => this._groupActionAutocomplete(id));
    this._groupConditionAutocomplete('state_group_has_mismatch');
    ['remove_voltage_monitor', 'reset_voltage_monitor', 'update_voltage_monitor', 'get_voltage_statistics'].forEach((id) => this._voltageMonitorActionAutocomplete(id));
    this.homey.flow.getConditionCard('is_voltage_normal').registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query));
    this.homey.flow.getConditionCard('voltage_is_state').registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query));
    ['log_binary_event', 'remove_binary_counter', 'reset_binary_counter', 'get_binary_event_statistics'].forEach((id) => this._binaryCounterActionAutocomplete(id));
    this.homey.flow.getConditionCard('binary_count_greater_than').registerArgumentAutocompleteListener('counter', async (query) => this._binaryCounterResults(query));
    this.homey.flow.getActionCard('generate_text_report').registerArgumentAutocompleteListener('item', async (query) => [
      ...this._monitorResults(query), ...this._voltageMonitorResults(query), ...this._stateMonitorResults(query), ...this._binaryCounterResults(query)
    ]);
    // Unlike the other binary-counter cards (which only ever pick an existing one), this one
    // also has to let the user type a brand new name — so the exact-match case gets offered
    // as "create new" instead of forcing a pick from existing counters alone.
    this.homey.flow.getActionCard('add_binary_counter').registerArgumentAutocompleteListener('name', async (query) => {
      const results = this._binaryCounterResults(query);
      const hasExactMatch = results.some((r) => r.name.toLowerCase() === (query || '').toLowerCase());
      if (query && !hasExactMatch) results.unshift({ name: query, description: 'Create new counter', data: { id: null } });
      return results;
    });

    // No continuity/confirmation window here — those start at 0 for a freshly created monitor
    // and are only worth tuning after noticing an actual problem (fragmented or noisy cycles),
    // at which point "Update activity monitor" already covers it. Keeping them off "Add" keeps
    // the common case (most devices never need either) simple.
    action('add_activity_monitor', async ({ device, capability, threshold, name }) => {
      await this._createActivityMonitor({ deviceId: this._deviceId(device), capability: capability?.id || capability?.data?.id, threshold, name });
      return true;
    });
    action('remove_activity_monitor', async ({ monitor }) => { await this.removeMonitor(this._monitor(monitor)); return true; });
    action('reset_activity_monitor', async ({ monitor }) => { await this.resetMonitorStats(this._monitor(monitor)); return true; });
    // One card handles both "create the monitor if it doesn't exist yet" and "start it" — for
    // wiring a brand new on/off-only device (a pump, a device with no reliable standby signal)
    // in a single Flow off a native "Power becomes greater than X" trigger, instead of needing
    // "Add activity monitor" run separately first. The resulting monitor is mode 'manual' — it
    // never decides ACTIVE/STANDBY on its own, only this card and its Stop counterpart do.
    action('start_monitoring_device', async ({ device, name }) => {
      const selected = await this.gateway.getDevice(this._deviceId(device));
      if (!selected) throw new Error('Device not found.');
      if (!selected.capabilities.includes('measure_power')) throw new Error(`"${selected.name}" doesn't have a measure_power capability.`);
      const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => selected.capabilities.includes(cap));
      const { monitor, created } = this.store.upsertManualMonitor({ device: selected, auxiliaryCapabilities, name });
      await this.store.save();
      if (created) await this._watch(monitor);
      return (await this._handleActivityEvents(monitor, this.engine.startNow(monitor))) || this._startedSnapshot(monitor);
    });
    action('stop_monitoring_device', async ({ device }) => {
      const selected = await this.gateway.getDevice(this._deviceId(device));
      if (!selected) throw new Error('Device not found.');
      const monitor = Object.values(this.store.data.monitors).find((item) => item.deviceId === selected.id && item.capability === 'measure_power');
      if (!monitor) throw new Error(`No monitor found for "${selected.name}". Use "Start monitoring device" first.`);
      return (await this._handleActivityEvents(monitor, this.engine.stopNow(monitor))) || this._finishedSnapshot(monitor);
    });
    action('update_activity_monitor', async ({ monitor, threshold, continuity_minutes, min_confirmation_seconds }) => {
      const item = this._monitor(monitor);
      if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0) throw new Error('The threshold must be greater than or equal to zero.');
      item.threshold = Number(threshold);
      item.calibrating = false;
      if (continuity_minutes !== undefined && continuity_minutes !== '') {
        if (!Number.isFinite(Number(continuity_minutes)) || Number(continuity_minutes) < 0) throw new Error('The continuity window must be greater than or equal to zero.');
        item.continuityMinutes = Number(continuity_minutes);
      }
      if (min_confirmation_seconds !== undefined && min_confirmation_seconds !== '') {
        if (!Number.isFinite(Number(min_confirmation_seconds)) || Number(min_confirmation_seconds) < 0) throw new Error('The minimum confirmation must be greater than or equal to zero.');
        item.minConfirmationSeconds = Number(min_confirmation_seconds);
      }
      await this.store.save();
      if (item.lastSample) await this._sample(item, item.lastSample.power, Date.now());
      return true;
    });
    // Homey rejects a "number" token with a null/undefined value ("Invalid Token"), which
    // average()/maximum() return for a period with zero cycles (e.g. "Today" before the
    // device has run yet) — coerce only at this Flow-token boundary; getWidgetSummary keeps
    // reading the raw null from _statistics/_voltageStatistics to render "—" instead of "0".
    action('get_activity_statistics', async ({ monitor, period }) => {
      const stats = this._statistics(this._monitor(monitor), period);
      return {
        ...stats, average_power: num(stats.average_power), max_power: num(stats.max_power), average_current: num(stats.average_current), max_current: num(stats.max_current),
        median_duration: num(stats.median_duration), median_duration_human: stats.median_duration_human || '', median_energy: num(stats.median_energy),
        energy_quality: stats.energy_quality || ''
      };
    });
    // Re-enables auto-calibration without deleting/recreating the monitor — reuses
    // _maybeAutoCalibrate's existing pipeline entirely (app.js's onSample path already checks
    // `monitor.calibrating` before re-suggesting a threshold), same as a freshly created
    // monitor with no explicit threshold.
    action('calibrate_threshold', async ({ monitor }) => {
      const item = this._monitor(monitor);
      item.calibrating = true;
      await this.store.save();
      return true;
    });
    action('generate_text_report', async ({ item, period }) => ({ report: this._generateTextReport(item, period) }));
    action('create_state_group', async ({ name, type, expected_state }) => { this.store.createGroup({ name, type, expectedState: expected_state }); await this.store.save(); return true; });
    action('add_device_to_state_group', async ({ group, device }) => { const item = this._group(group); const selected = await this.gateway.getDevice(this._deviceId(device)); this._assertGroupDevice(item, selected); if (!item.devices.some((d) => d.id === selected.id)) item.devices.push({ id: selected.id, name: selected.name }); await this.store.save(); return true; });
    action('remove_device_from_state_group', async ({ group, device }) => { const item = this._group(group); const id = this._deviceId(device); item.devices = item.devices.filter((d) => d.id !== id); await this.store.save(); return true; });
    action('check_state_group', async ({ group, expected_state }) => {
      const result = await this._checkGroup(this._group(group), expected_state);
      return { group_name: result.groupName, checked_count: result.checkedCount, match_count: result.matchCount, mismatch_count: result.mismatchCount, mismatch_list: result.mismatchList, message: result.message };
    });
    action('get_group_statistics', async ({ group, period }) => this._groupStatistics(this._group(group), period));
    action('export_data', async () => {
      const json = JSON.stringify(this.store.data);
      return { json, size_bytes: Buffer.byteLength(json, 'utf8') };
    });
    condition('is_active', async ({ monitor }) => this._monitor(monitor).state === ACTIVE);
    // Lets an energy-saving Flow act only once a device has been running a while (e.g. "turn
    // off the AC when the tariff spikes, but only if it's been on for 2+ hours") instead of
    // reacting to any activity at all. False for a monitor currently STANDBY — there's no
    // "since" to measure.
    condition('activity_running_longer_than', async ({ monitor, minutes }) => {
      const item = this._monitor(monitor);
      if (item.state !== ACTIVE || !item.activeSince) return false;
      return (Date.now() - item.activeSince) / 60000 >= Number(minutes);
    });
    condition('state_group_has_mismatch', async ({ group }) => (await this._checkGroup(this._group(group))).mismatchCount > 0);
    condition('is_device_monitored', async ({ device }) => {
      const id = this._deviceId(device);
      return [this.store.data.monitors, this.store.data.voltageMonitors, this.store.data.stateMonitors]
        .some((collection) => Object.values(collection).some((m) => m.deviceId === id));
    });

    action('add_voltage_monitor', async ({ device, capability, min_voltage, max_voltage, name, stabilization_minutes }) => {
      await this._createVoltageMonitor({ deviceId: this._deviceId(device), capability: capability?.id || capability?.data?.id, minVoltage: min_voltage, maxVoltage: max_voltage, name, stabilizationMinutes: stabilization_minutes });
      return true;
    });
    action('remove_voltage_monitor', async ({ monitor }) => { await this.removeVoltageMonitor(this._voltageMonitor(monitor)); return true; });
    action('reset_voltage_monitor', async ({ monitor }) => { await this.resetVoltageMonitorStats(this._voltageMonitor(monitor)); return true; });
    action('update_voltage_monitor', async ({ monitor, min_voltage, max_voltage }) => {
      const item = this._voltageMonitor(monitor);
      this.store.updateVoltageMonitor(item, { minVoltage: min_voltage, maxVoltage: max_voltage });
      await this.store.save();
      if (item.lastSample) await this._voltageSample(item, item.lastSample.voltage, Date.now());
      return true;
    });
    action('get_voltage_statistics', async ({ monitor, period }) => this._voltageStatistics(this._voltageMonitor(monitor), period));
    condition('is_voltage_normal', async ({ monitor }) => this._voltageMonitor(monitor).state === NORMAL);
    // is_voltage_normal alone can't distinguish under- from over-voltage on the "not normal"
    // side — useful for a safety Flow that should react differently to each (e.g. only skip
    // running a motor on overvoltage, not undervoltage).
    condition('voltage_is_state', async ({ monitor, state }) => this._voltageMonitor(monitor).state === state);

    // No continuity/confirmation window here (and no "Update state monitor" card exists to
    // tune it later, unlike Activity Monitor) — every real use case so far is a plain
    // door/motion/on-off sensor with no flakiness to debounce. Add one if that ever changes.
    action('add_state_monitor', async ({ device, capability, true_label, false_label, name, active_values }) => {
      await this._createStateMonitor({ deviceId: this._deviceId(device), capability: capability?.id || capability?.data?.id || capability, trueLabel: true_label, falseLabel: false_label, name, activeValues: active_values });
      return true;
    });
    action('remove_state_monitor', async ({ monitor }) => { await this.removeStateMonitor(this._stateMonitor(monitor)); return true; });
    action('reset_state_monitor', async ({ monitor }) => { await this.resetStateMonitorStats(this._stateMonitor(monitor)); return true; });
    action('get_state_statistics', async ({ monitor, period }) => {
      const stats = this._stateStatistics(this._stateMonitor(monitor), period);
      return {
        ...stats, median_duration: num(stats.median_duration), median_duration_human: stats.median_duration_human || '',
        energy: num(stats.energy), average_power: num(stats.average_power), max_power: num(stats.max_power),
        average_current: num(stats.average_current), max_current: num(stats.max_current)
      };
    });
    condition('is_state_active', async ({ monitor }) => this._stateMonitor(monitor).state === ACTIVE);

    condition('binary_count_greater_than', async ({ counter, count }) => this._binaryEventStatistics(this._binaryCounter(counter), 'day').event_count > Number(count));
    action('add_binary_counter', async ({ name: rawName }) => {
      const name = (typeof rawName === 'object' ? rawName?.name : rawName || '').trim();
      if (!name) throw new Error('Counter name is required.');
      this.store.upsertBinaryCounter({ name });
      await this.store.save();
      return true;
    });
    // The one card in this family with tokens — message is rendered here from the counter's
    // own template (configured in Settings, not as a card argument) so a plain notification
    // Flow never needs a separate text-building card.
    action('log_binary_event', async ({ counter }) => {
      const item = this._binaryCounter(counter);
      const timestamp = Date.now();
      const todayCount = this.store.recordBinaryEvent(item, timestamp, this._getTimezone());
      const data = { counter: item.name, count: todayCount, total: item.totalCount };
      const message = renderMessage(item.messageTemplate, data);
      this._logEvent(message);
      await this.store.save();
      await this.binaryCards.logged.trigger({ counter: item.name, event_count_today: todayCount, total_count: item.totalCount, message }, { counterId: item.id });
      return {
        event_count_today: todayCount, total_count: item.totalCount, last_event_at: new Date(timestamp).toISOString(),
        message
      };
    });
    action('remove_binary_counter', async ({ counter }) => { await this.removeBinaryCounter(this._binaryCounter(counter)); return true; });
    action('reset_binary_counter', async ({ counter }) => { await this.resetBinaryCounterStats(this._binaryCounter(counter)); return true; });
    action('get_binary_event_statistics', async ({ counter, period }) => {
      const stats = this._binaryEventStatistics(this._binaryCounter(counter), period);
      return { ...stats, last_event_at: stats.last_event_at || '' };
    });
  }

  // Shared by the "Add activity monitor" Flow card and the Settings "Add monitor" form — same
  // validation and creation path either way, so the two can never silently drift apart.
  async _createActivityMonitor({ deviceId, capability, threshold, name }) {
    const selected = await this.gateway.getDevice(deviceId);
    const capabilityId = capability || 'measure_power';
    if (!selected?.capabilities.includes(capabilityId)) throw new Error(`The device doesn't have the ${capabilityId} capability.`);
    const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && selected.capabilities.includes(cap));
    const { monitor, created } = this.store.upsertMonitor({ device: selected, threshold, name, capability: capabilityId, auxiliaryCapabilities });
    await this.store.save();
    if (created) await this._watch(monitor);
    // An existing monitor's threshold just changed (or was re-run idempotently) — re-check it
    // against the last known reading right away instead of waiting for the device's next real
    // push.
    else if (monitor.lastSample) await this._sample(monitor, monitor.lastSample.power, Date.now());
    return monitor;
  }
  async _createVoltageMonitor({ deviceId, capability, minVoltage, maxVoltage, name, stabilizationMinutes }) {
    const selected = await this.gateway.getDevice(deviceId);
    const capabilityId = capability || 'measure_voltage';
    if (!selected?.capabilities.includes(capabilityId)) throw new Error(`The device doesn't have the ${capabilityId} capability.`);
    // A device with a multi-phase meter often lists "Power Phase A" right next to "Voltage
    // Phase A" — nothing else here would catch a mixup, since the min/max range is just numbers
    // to the engine either way. Confirmed live: a real device configured this way threw a false
    // "overvoltage" whenever the appliance's wattage exceeded the voltage threshold.
    if (!capabilityId.startsWith('measure_voltage')) {
      const title = selected.capabilitiesObj?.[capabilityId]?.title || capabilityId;
      throw new Error(`"${title}" isn't a voltage capability. Pick one whose id starts with measure_voltage (e.g. "Voltage Phase A").`);
    }
    const { monitor, created } = this.store.upsertVoltageMonitor({ device: selected, capability: capabilityId, minVoltage, maxVoltage, name, stabilizationMinutes });
    await this.store.save();
    if (created) await this._watchVoltage(monitor);
    else if (monitor.lastSample) await this._voltageSample(monitor, monitor.lastSample.voltage, Date.now());
    return monitor;
  }
  async _createStateMonitor({ deviceId, capability, trueLabel, falseLabel, name, activeValues: rawActiveValues }) {
    const selected = await this.gateway.getDevice(deviceId);
    if (!selected) throw new Error('Device not found.');
    const capabilityId = capability;
    if (!capabilityId) throw new Error('Select a capability.');
    const capabilityType = selected.capabilitiesObj?.[capabilityId]?.type;
    if (capabilityType !== 'boolean' && capabilityType !== 'enum' && capabilityType !== 'string') {
      const title = selected.capabilitiesObj?.[capabilityId]?.title || capabilityId;
      throw new Error(`"${title}" isn't a boolean or multi-state capability. Pick one like a contact, motion, on/off sensor, or an appliance's own state.`);
    }
    const activeValues = Array.isArray(rawActiveValues)
      ? rawActiveValues.map((v) => String(v).trim()).filter(Boolean)
      : (rawActiveValues ? String(rawActiveValues).split(',').map((v) => v.trim()).filter(Boolean) : null);
    // An enum/string has more than two states — plain true/false has no meaning for it, so this
    // has to be told explicitly which value(s) count as active instead of guessing.
    if (capabilityType !== 'boolean' && !activeValues?.length) {
      throw new Error('This capability has multiple states — specify which value(s) count as active (e.g. "Running, Rinse").');
    }
    const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && selected.capabilities.includes(cap));
    const { monitor, created } = this.store.upsertStateMonitor({ device: selected, capability: capabilityId, trueLabel, falseLabel, name, activeValues, auxiliaryCapabilities });
    await this.store.save();
    if (created) await this._watchState(monitor);
    return monitor;
  }
  _monitorResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.monitors).filter((m) => m.name.toLowerCase().includes(normalized)).map((m) => ({ name: m.name, description: m.deviceName, data: { id: m.id } })); }
  _groupResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.groups).filter((g) => g.name.toLowerCase().includes(normalized)).map((g) => ({ name: g.name, description: g.type, data: { id: g.id } })); }
  _voltageMonitorResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.voltageMonitors).filter((m) => m.name.toLowerCase().includes(normalized)).map((m) => ({ name: m.name, description: m.deviceName, data: { id: m.id } })); }
  _stateMonitorResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.stateMonitors).filter((m) => m.name.toLowerCase().includes(normalized)).map((m) => ({ name: m.name, description: m.deviceName, data: { id: m.id } })); }
  _binaryCounterResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.binaryCounters).filter((c) => c.name.toLowerCase().includes(normalized)).map((c) => ({ name: c.name, description: `${c.totalCount} total`, data: { id: c.id } })); }
  _monitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query)); }
  _monitorConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query)); }
  _groupActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query)); }
  _groupConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query)); }
  _voltageMonitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query)); }
  _stateMonitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._stateMonitorResults(query)); }
  _stateMonitorConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._stateMonitorResults(query)); }
  _binaryCounterActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('counter', async (query) => this._binaryCounterResults(query)); }
  _registerCapabilityAutocomplete(cardId) {
    this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('capability', async (query, args) => {
      const deviceId = args.device?.id || args.device?.data?.id;
      if (!deviceId) return [];
      const device = await this.gateway.getDevice(deviceId);
      if (!device) return [];
      const normalized = (query || '').toLowerCase();
      // add_voltage_monitor only makes sense against a voltage capability — filtering the
      // picker itself keeps a "Power Phase A" vs "Voltage Phase A" mixup (confirmed live: it
      // silently compares Watts against a Volts threshold, producing false overvoltage alarms)
      // from ever being selectable in the first place, instead of only catching it after the
      // fact in the action handler.
      // Same idea for add_state_monitor: it only makes sense against a boolean capability
      // (alarm_contact, alarm_motion, onoff) or a multi-value one (an appliance's own state) —
      // a plain number has no "active value" to mirror. A multi-value capability isn't always
      // typed 'enum' in practice — confirmed live: a community ThinQ app exposes its washer's
      // state as a plain 'string' capability ("Power Off"/"Running"/...), not a declared enum —
      // so both types are accepted here.
      const eligible = cardId === 'add_voltage_monitor'
        ? device.capabilities.filter((cap) => cap.startsWith('measure_voltage'))
        : cardId === 'add_state_monitor'
        ? device.capabilities.filter((cap) => ['boolean', 'enum', 'string'].includes(device.capabilitiesObj?.[cap]?.type))
        : device.capabilities;
      // Search and display by the capability's friendly title (e.g. "Voltage Phase A") as well
      // as its raw id (e.g. measure_voltage.phase_a) — a user typing "phase A" only matches the
      // title, which Homey's own native tag picker shows instead of the id.
      return eligible
        .map((cap) => ({ id: cap, title: device.capabilitiesObj?.[cap]?.title || cap, value: device.capabilitiesObj?.[cap]?.value }))
        .filter((cap) => cap.id.toLowerCase().includes(normalized) || String(cap.title).toLowerCase().includes(normalized))
        .map((cap) => ({
          name: cap.title,
          description: cap.value !== undefined ? `${cap.id} — ${cap.value}` : cap.id,
          data: { id: cap.id }
        }));
    });
  }
  _monitor(arg) { const item = this.store.data.monitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('Monitor not found.'); return item; }
  _group(arg) { const item = this.store.data.groups[arg?.id || arg?.data?.id]; if (!item) throw new Error('Group not found.'); return item; }
  _voltageMonitor(arg) { const item = this.store.data.voltageMonitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('Voltage monitor not found.'); return item; }
  _stateMonitor(arg) { const item = this.store.data.stateMonitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('State monitor not found.'); return item; }
  _binaryCounter(arg) { const item = this.store.data.binaryCounters[arg?.id || arg?.data?.id]; if (!item) throw new Error('Binary counter not found.'); return item; }
  // Homey keeps an autocomplete selection nested as {name, data:{id}} — it does not flatten
  // data onto the top level, confirmed against a real "Missing Parameter: id" runtime error.
  _deviceId(arg) { const id = arg?.id || arg?.data?.id; if (!id) throw new Error('Select a valid device.'); return id; }
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
  async _watch(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, monitor.auxiliaryCapabilities, async (power, timestamp, device) => this._sample(monitor, power, timestamp, device));
  }
  async _sample(monitor, power, timestamp, device) {
    const energy = device?.capabilitiesObj?.meter_power?.value;
    const current = device?.capabilitiesObj?.measure_current?.value;
    const events = this.engine.processSample(monitor, { power, timestamp, energy, current });
    await this._handleActivityEvents(monitor, events);
    // Only a plain threshold monitor (no mode) still refining its DEFAULT_ACTIVITY_THRESHOLD
    // fallback auto-calibrates — 'state' mirrors a boolean and 'manual' never looks at a
    // threshold at all, see stateFor() in activity-engine.js.
    if (monitor.calibrating && !monitor.mode) await this._maybeAutoCalibrate(monitor);
  }
  // Lets "Add activity monitor" work from just a device — no Watts guess needed. A monitor
  // created without a threshold starts immediately usable at DEFAULT_ACTIVITY_THRESHOLD
  // (SentinelStore) instead of sitting inert, flagged `calibrating` while it collects raw power
  // samples until there's enough history for _suggestedThreshold to find a confident
  // standby/active gap — then replaces the fallback and fires "Threshold calibrated" once so
  // the user knows what value was picked, reusing the exact same gap-detection already backing
  // the Settings page's passive suggestion.
  async _maybeAutoCalibrate(monitor) {
    const now = Date.now();
    const lastAttempt = this._lastCalibrationAttempt.get(monitor.id);
    if (lastAttempt && now - lastAttempt < CALIBRATION_RETRY_MS) return;
    this._lastCalibrationAttempt.set(monitor.id, now);
    const periodCount = (monitor.periods || []).length;
    this.log(`[${monitor.name}] checking for a calibration threshold (${periodCount} power samples so far)`);
    const suggestion = this._suggestedThreshold(monitor);
    if (!suggestion) return;
    monitor.threshold = suggestion.threshold;
    monitor.calibrating = false;
    await this.store.save();
    this.log(`[${monitor.name}] calibrated: threshold ${suggestion.threshold} W (standby ~${suggestion.low} W, active ~${suggestion.high} W, ${suggestion.sampleCount} samples)`);
    const base = {
      device: monitor.deviceName, monitor: monitor.name, threshold: suggestion.threshold,
      standby_power: suggestion.low, active_power: suggestion.high
    };
    const data = { ...base, message: `${monitor.name} calibrated: threshold set to ~${Math.round(suggestion.threshold)} W (standby ~${Math.round(suggestion.low)} W, active ~${Math.round(suggestion.high)} W).` };
    await this.cards.calibrated.trigger(data, { monitorId: monitor.id });
  }
  // A continuity grace window (see activity-engine.js's 'continuity_pending') needs a real timer:
  // if power drops and simply stays there, no further capability update will ever arrive to let
  // processSample notice the window expired on its own.
  async _resolveContinuity(monitor) {
    const events = this.engine.finalizePendingStandby(monitor, Date.now());
    await this._handleActivityEvents(monitor, events);
  }
  // Returns the data for whichever 'started'/'finished' event actually fired (or null for a
  // pure 'continuity_pending' tick) — callers driving a manual start/stop (start_monitoring_device
  // / stop_monitoring_device) reuse this as their own action-card tokens, so the same power/
  // energy/current/message data is available in the same Flow without a second Flow listening
  // on "Activity started"/"Activity finished".
  async _handleActivityEvents(monitor, events) {
    this._scheduleSave();
    let result = null;
    for (const event of events) {
      if (event.type === 'continuity_pending') {
        this.homey.setTimeout(() => this._resolveContinuity(monitor).catch((error) => this.error('Failed to resolve continuity window', monitor.name, error)), standbyGraceSeconds(monitor) * 1000);
        continue;
      }
      // event.power is null for a manually-triggered start/stop (startNow/stopNow) on a
      // device with no numeric sample yet — coerce so the "power" number token never hits
      // the same "Invalid Token" null issue fixed elsewhere for the other stat tokens.
      const base = { device: monitor.deviceName, monitor: monitor.name, power: num(event.power), timestamp: new Date(event.timestamp).toISOString() };
      if (event.type === 'started') {
        this.log(`[${monitor.name}] started (${num(event.power)} W)`);
        const startedData = { ...base, message: renderMessage(monitor.messageTemplateStarted, base) };
        await this.cards.started.trigger(startedData, { monitorId: monitor.id });
        this._logEvent(startedData.message);
        result = startedData;
      }
      if (event.type === 'finished') {
        this.log(`[${monitor.name}] finished (duration=${event.duration_human}, energy=${formatEnergy(num(event.energy))}, avg power=${num(event.average_power).toFixed(0)} W)`);
        // Today's cycle count already includes this cycle — _finalizeStandby pushed it to
        // cycles[] before this event was raised, so "%count%" reads naturally as "this is the
        // Nth time today" in a message like "pump turned off %count% %count:time|times% today".
        const dayStats = this._statistics(monitor, 'day');
        const finishedData = {
          ...base, duration: event.duration, duration_human: event.duration_human, energy: num(event.energy),
          average_power: num(event.average_power), max_power: num(event.max_power), average_current: num(event.average_current), max_current: num(event.max_current),
          count: dayStats.cycle_count, energy_today: num(dayStats.total_energy)
        };
        finishedData.message = renderMessage(monitor.messageTemplateFinished, finishedData);
        await this.cards.finished.trigger(finishedData, { monitorId: monitor.id });
        this._logEvent(finishedData.message);
        // dayStats.cycle_count strictly increases by exactly one per finished cycle, so an
        // exact-equality state match (see registerRunListener above) fires this precisely once
        // per Flow's configured count, not on every finish after crossing it.
        await this.cards.cyclesReached.trigger(
          { device: monitor.deviceName, monitor: monitor.name, count: dayStats.cycle_count, message: finishedData.message },
          { monitorId: monitor.id, cycleCount: dayStats.cycle_count }
        );
        // 'all' rather than 'day' for the baseline — cycles[] is never pruned, so this stays a
        // stable, meaningful median regardless of how long the monitor's been running; a small
        // cycle count (checked via median_duration being non-null, same MEDIAN_MIN_CYCLES guard
        // every other median-consuming stat already uses) simply doesn't fire yet.
        const allTimeStats = this._statistics(monitor, 'all');
        if (Number.isFinite(allTimeStats.median_duration) && allTimeStats.median_duration > 0) {
          const ratio = event.duration / allTimeStats.median_duration;
          await this.cards.unusuallyLong.trigger(
            { device: monitor.deviceName, monitor: monitor.name, duration: event.duration, duration_human: event.duration_human, median_duration: allTimeStats.median_duration, message: finishedData.message },
            { monitorId: monitor.id, ratio }
          );
        }
        result = finishedData;
      }
    }
    return result;
  }
  // Fallback tokens for start_monitoring_device/stop_monitoring_device when startNow/stopNow
  // was a no-op (monitor already in that state) — _handleActivityEvents returns null then,
  // but the action card still declares tokens and must always return a value for them.
  _startedSnapshot(monitor) {
    const base = { device: monitor.deviceName, monitor: monitor.name, power: num(monitor.lastSample?.power ?? null), timestamp: new Date().toISOString() };
    return { ...base, message: renderMessage(monitor.messageTemplateStarted, base) };
  }
  _finishedSnapshot(monitor) {
    const base = { device: monitor.deviceName, monitor: monitor.name, power: num(monitor.lastSample?.power ?? null), timestamp: new Date().toISOString() };
    const dayStats = this._statistics(monitor, 'day');
    const data = {
      ...base, duration: 0, duration_human: humanDuration(0), energy: 0, average_power: 0, max_power: 0, average_current: 0, max_current: 0,
      count: dayStats.cycle_count, energy_today: num(dayStats.total_energy)
    };
    return { ...data, message: renderMessage(monitor.messageTemplateFinished, data) };
  }
  // Same engine, same cycle/duration/grace-window machinery as _watch/_sample above — a state
  // monitor decides ACTIVE/STANDBY from its own reliable signal (a boolean, or specific
  // activeValues on an enum) instead of comparing a numeric power sample against a threshold
  // (see activity-engine.js's stateFor()). auxiliaryCapabilities (empty for a plain door/motion
  // sensor) optionally layers real power/energy/current tracking on top of that signal.
  async _watchState(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, monitor.auxiliaryCapabilities || [], async (value, timestamp, device) => this._sampleState(monitor, value, timestamp, device));
  }
  async _sampleState(monitor, value, timestamp, device) {
    // activeValues unset (every plain boolean monitor) — raw true is always ACTIVE, same as
    // before. Set — an enum capability like an appliance's own state ("Power Off"/"Running"),
    // matched case/whitespace-insensitively so a slightly different casing typed at setup time
    // doesn't silently never match. trueLabel/falseLabel stay purely cosmetic either way.
    const isActive = monitor.activeValues?.length
      ? monitor.activeValues.some((v) => v.trim().toLowerCase() === String(value).trim().toLowerCase())
      : Boolean(value);
    const wattage = device?.capabilitiesObj?.measure_power?.value;
    const energy = device?.capabilitiesObj?.meter_power?.value;
    const current = device?.capabilitiesObj?.measure_current?.value;
    const events = this.engine.processSample(monitor, { power: isActive, wattage, energy, current, timestamp });
    await this._handleStateEvents(monitor, events);
  }
  async _resolveStateContinuity(monitor) {
    const events = this.engine.finalizePendingStandby(monitor, Date.now());
    await this._handleStateEvents(monitor, events);
  }
  async _handleStateEvents(monitor, events) {
    this._scheduleSave();
    for (const event of events) {
      if (event.type === 'continuity_pending') {
        this.homey.setTimeout(() => this._resolveStateContinuity(monitor).catch((error) => this.error('Failed to resolve continuity window', monitor.name, error)), standbyGraceSeconds(monitor) * 1000);
        continue;
      }
      const base = { device: monitor.deviceName, monitor: monitor.name, timestamp: new Date(event.timestamp).toISOString() };
      // Every declared Flow token must always get a value — Homey rejects the trigger
      // otherwise ("Invalid value for token X. Expected number but got undefined"), confirmed
      // live for every plain door/motion monitor the moment these tokens were added, since
      // they have no auxiliary power capability at all and event.power/energy are undefined.
      // num() already defaults a non-finite value to 0, same convention used everywhere else
      // these numbers reach a Flow token.
      if (event.type === 'started') {
        this.log(`[${monitor.name}] started (${monitor.trueLabel})`);
        const startedData = { ...base, label: monitor.trueLabel, power: num(event.power) };
        const startedMessage = renderMessage(monitor.messageTemplateStarted, startedData);
        await this.stateCards.started.trigger({ ...startedData, message: startedMessage }, { monitorId: monitor.id });
        this._logEvent(startedMessage);
      }
      if (event.type === 'finished') {
        this.log(`[${monitor.name}] finished (duration=${event.duration_human}, now ${monitor.falseLabel})`);
        const dayStats = this._stateStatistics(monitor, 'day');
        const finishedData = {
          ...base, duration: event.duration, duration_human: event.duration_human, label: monitor.falseLabel, count: dayStats.cycle_count,
          energy: num(event.energy), average_power: num(event.average_power), max_power: num(event.max_power),
          average_current: num(event.average_current), max_current: num(event.max_current), energy_today: num(dayStats.energy)
        };
        const finishedMessage = renderMessage(monitor.messageTemplateFinished, finishedData);
        await this.stateCards.finished.trigger({ ...finishedData, message: finishedMessage }, { monitorId: monitor.id });
        this._logEvent(finishedMessage);
      }
    }
  }
  async _watchVoltage(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, [], async (voltage, timestamp) => this._voltageSample(monitor, voltage, timestamp));
  }
  async _voltageSample(monitor, voltage, timestamp) {
    const events = this.voltageEngine.processSample(monitor, { voltage, timestamp });
    await this._handleVoltageEvents(monitor, events);
  }
  // A return-to-normal grace window (see voltage-engine.js's 'continuity_pending') needs a
  // real timer: if the voltage genuinely settles and simply stays there, no further capability
  // update will ever arrive to let processSample notice the window expired on its own — same
  // rationale as _resolveContinuity for activity monitors.
  async _resolveVoltageContinuity(monitor) {
    const events = this.voltageEngine.finalizePendingNormal(monitor, Date.now());
    await this._handleVoltageEvents(monitor, events);
  }
  async _handleVoltageEvents(monitor, events) {
    this._scheduleSave();
    for (const event of events) {
      if (event.type === 'continuity_pending') {
        this.homey.setTimeout(() => this._resolveVoltageContinuity(monitor).catch((error) => this.error('Failed to resolve voltage continuity window', monitor.name, error)), stabilizationGraceSeconds(monitor) * 1000);
        continue;
      }
      const base = { device: monitor.deviceName, monitor: monitor.name, voltage: event.voltage, timestamp: new Date(event.timestamp).toISOString() };
      if (event.type === 'started' && event.eventType === UNDERVOLTAGE) {
        this.log(`[${monitor.name}] undervoltage (${event.voltage} V)`);
        const undervoltageMessage = renderMessage(monitor.messageTemplateUndervoltage, base);
        await this.voltageCards.undervoltage.trigger({ ...base, message: undervoltageMessage }, { monitorId: monitor.id });
        this._logEvent(undervoltageMessage);
      }
      if (event.type === 'started' && event.eventType === OVERVOLTAGE) {
        this.log(`[${monitor.name}] overvoltage (${event.voltage} V)`);
        const overvoltageMessage = renderMessage(monitor.messageTemplateOvervoltage, base);
        await this.voltageCards.overvoltage.trigger({ ...base, message: overvoltageMessage }, { monitorId: monitor.id });
        this._logEvent(overvoltageMessage);
      }
      if (event.type === 'normalized') {
        this.log(`[${monitor.name}] normalized (duration=${humanDuration(event.duration)}, min=${num(event.min_voltage).toFixed(1)} V, max=${num(event.max_voltage).toFixed(1)} V)`);
        const normalizedData = {
          ...base, event_type: event.previousEventType, duration: num(event.duration), duration_human: humanDuration(event.duration),
          min_voltage: num(event.min_voltage), max_voltage: num(event.max_voltage), average_voltage: num(event.average_voltage)
        };
        const normalizedMessage = renderMessage(monitor.messageTemplateNormalized, normalizedData);
        await this.voltageCards.normalized.trigger({ ...normalizedData, message: normalizedMessage }, { monitorId: monitor.id });
        this._logEvent(normalizedMessage);
      }
    }
  }
  // Thin delegates over lib/statistics.js (pure functions, no `this`) — kept as same-named
  // methods so every internal call site and api.js's contract with app.js (getMonitorsSummary
  // etc. call these by name) are unaffected by the move. See lib/statistics.js for the actual
  // logic and its own now-isolated tests.
  _binaryEventStatistics(counter, period) { return computeBinaryEventStatistics(counter, period, this._getTimezone()); }
  _generateTextReport(rawId, rawPeriod) { return computeTextReport(rawId, rawPeriod, this.store.data, this._getTimezone()); }
  _voltageStatistics(monitor, period) { return computeVoltageStatistics(monitor, period, this._getTimezone()); }
  _statistics(monitor, period) { return computeStatistics(monitor, period, this._getTimezone()); }
  _stateStatistics(monitor, period) { return computeStateStatistics(monitor, period, this._getTimezone()); }
  _dailyBreakdown(monitor, days) { return computeDailyBreakdown(monitor, days, this._getTimezone()); }
  _stateDailyBreakdown(monitor, days) { return computeStateDailyBreakdown(monitor, days, this._getTimezone()); }
  _binaryDailyBreakdown(counter, days) { return computeBinaryDailyBreakdown(counter, days, this._getTimezone()); }
  _suggestedThreshold(monitor) { return computeSuggestedThreshold(monitor); }
  _assertGroupDevice(group, device) { return assertGroupDevice(group, device); }
  _checkGroup(group, expectedOverride) { return checkGroup(group, this.gateway, expectedOverride); }
  _groupStatistics(group, period) { return computeGroupStatistics(group, period, this._getTimezone()); }
  // Backs the Settings page's Monitors tab — the same period/energy/daily-breakdown detail
  // the widget shows, but for every activity monitor at once in one table (no need to set up
  // a widget per device just to see this). Restored here after the lib/statistics.js
  // extraction accidentally dropped it along with the block it lived in — api.js's
  // getMonitorsSummary route calls this by name, so its disappearance broke the whole
  // Settings Monitors tab.
  getMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.monitors).map((monitor) => {
      const stats = this._statistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, state: monitor.state, threshold: monitor.threshold,
        period, cycleCount: stats.cycle_count, energy: stats.total_energy, averagePower: stats.average_power, energyQuality: stats.energy_quality,
        dailyBreakdown: period === 'day' ? null : this._dailyBreakdown(monitor, period === 'week' ? 7 : 30),
        messageTemplateStarted: monitor.messageTemplateStarted, messageTemplateFinished: monitor.messageTemplateFinished,
        calibrating: !!monitor.calibrating,
        suggestedThreshold: this._suggestedThreshold(monitor)
      };
    });
  }
  // Same idea as getMonitorsSummary, for the state monitors table — trimmed to duration/count
  // fields by default, same as _stateStatistics, since energy/power don't mean anything for a
  // plain boolean capability. Included when the monitor has an auxiliary power capability.
  getStateMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.stateMonitors).map((monitor) => {
      const stats = this._stateStatistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, capability: monitor.capability, state: monitor.state,
        trueLabel: monitor.trueLabel, falseLabel: monitor.falseLabel,
        period, cycleCount: stats.cycle_count, trueDuration: stats.true_duration, falseDuration: stats.false_duration,
        energy: stats.energy, averagePower: stats.average_power,
        dailyBreakdown: period === 'day' ? null : this._stateDailyBreakdown(monitor, period === 'week' ? 7 : 30),
        messageTemplateStarted: monitor.messageTemplateStarted, messageTemplateFinished: monitor.messageTemplateFinished
      };
    });
  }
  // Same idea as getMonitorsSummary, for the voltage monitors table.
  getVoltageMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.voltageMonitors).map((monitor) => {
      const stats = this._voltageStatistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, capability: monitor.capability, state: monitor.state,
        period, currentVoltage: monitor.lastSample?.voltage ?? null, minVoltage: stats.min_voltage, maxVoltage: stats.max_voltage,
        undervoltageCount: stats.undervoltage_count, overvoltageCount: stats.overvoltage_count,
        messageTemplateUndervoltage: monitor.messageTemplateUndervoltage, messageTemplateOvervoltage: monitor.messageTemplateOvervoltage, messageTemplateNormalized: monitor.messageTemplateNormalized
      };
    });
  }
  // Same idea again, for the Binary counters table.
  getBinaryCountersSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.binaryCounters).map((counter) => {
      const stats = this._binaryEventStatistics(counter, period);
      return { id: counter.id, name: counter.name, period, eventCount: stats.event_count, totalCount: counter.totalCount, lastEventAt: stats.last_event_at, messageTemplate: counter.messageTemplate };
    });
  }
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
      } catch (error) {
        this.error('Failed to poll group', group.name, error);
      }
    }
    this._scheduleSave();
  }
}

module.exports = StatisticTrackerApp;
