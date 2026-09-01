'use strict';

const Homey = require('homey');
const SentinelStore = require('./lib/store');
const HomeyDeviceGateway = require('./lib/homey-device-gateway');
const { ACTIVE, ActivityEngine, average, maximum, median, humanDuration, standbyGraceSeconds } = require('./lib/activity-engine');
const { NORMAL, UNDERVOLTAGE, OVERVOLTAGE, VoltageEngine } = require('./lib/voltage-engine');
const { renderMessage, formatList } = require('./lib/message-template');
const { startOfLocalDay, localDateKey, isValidTimeZone } = require('./lib/time');

const DEVICE_CACHE_REFRESH_MS = 5 * 60 * 1000;
const HISTORY_CONSOLIDATION_MS = 6 * 60 * 60 * 1000;
// Auxiliary capabilities are detected automatically from whatever the device exposes —
// the user only picks the device (and, if needed, overrides the primary capability).
const AUXILIARY_CAPABILITY_CANDIDATES = ['measure_current', 'meter_power', 'measure_voltage'];
// Below this many cycles, a median duration/energy is technically defined but not
// meaningful yet as "typical" — same floor the reference app used for its health
// calculation. Below it, median_duration/median_energy come back null ("still learning")
// instead of a number that looks more authoritative than a sample of 1-2 cycles deserves.
const MEDIAN_MIN_CYCLES = 5;
// Below this many raw power samples, a "gap" in the distribution is as likely to be sampling
// noise as a real standby/active split — too little history to suggest a threshold from yet.
const THRESHOLD_SUGGESTION_MIN_SAMPLES = 30;
// Single source of truth for State Group's type→capability mapping — was previously duplicated
// (and already drifting: _checkGroup only special-cased 'contact', everything else fell through
// to 'onoff', silently wrong for any new type added there without updating both places).
// `invert: true` means the capability's raw true/false is the OPPOSITE of what "On / Open" /
// "Off / Closed" means to the user — garagedoor_closed reports true when the door is CLOSED,
// so without inverting, picking "Open" as the expected state would silently check for closed
// (the exact polarity footgun already fixed once for State Monitor's old active_value picker).
const GROUP_TYPES = {
  contact: { capability: 'alarm_contact', invert: false },
  light: { capability: 'onoff', invert: false },
  switch: { capability: 'onoff', invert: false },
  valve: { capability: 'onoff', invert: false },
  garage: { capability: 'garagedoor_closed', invert: true }
};
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
    this.engine = new ActivityEngine();
    this.voltageEngine = new VoltageEngine();
    this.gateway = new HomeyDeviceGateway(this.homey);
    this.cards = {
      started: this.homey.flow.getTriggerCard('activity_started'),
      finished: this.homey.flow.getTriggerCard('activity_finished')
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
    this._registerFlowCards();
    this._registerWidgets();
    this.log('Sentinels started — observation only, no device control.');

    // Device/network work happens in the background, on purpose: onInit must resolve and
    // the Flow cards above must be registered even if HomeyAPI is slow or unreachable —
    // otherwise the app never reports ready and no card shows up in the Flow editor at all.
    this.gateway.refreshDeviceCache().catch((error) => this.error('Failed to load device cache', error));
    this.homey.setInterval(() => this.gateway.refreshDeviceCache().catch((error) => this.error('Failed to refresh device cache', error)), DEVICE_CACHE_REFRESH_MS);
    this.gateway.refreshSystemTimezone().catch((error) => this.error('Failed to detect system timezone', error));
    this.homey.setInterval(() => this.gateway.refreshSystemTimezone().catch((error) => this.error('Failed to refresh system timezone', error)), DEVICE_CACHE_REFRESH_MS);
    this._consolidateHistory();
    this.homey.setInterval(() => this._consolidateHistory(), HISTORY_CONSOLIDATION_MS);
    Object.values(this.store.data.monitors).forEach((monitor) => this._watch(monitor).catch((error) => this.error('Failed to resume monitor', monitor.name, error)));
    Object.values(this.store.data.voltageMonitors).forEach((monitor) => this._watchVoltage(monitor).catch((error) => this.error('Failed to resume voltage monitor', monitor.name, error)));
    Object.values(this.store.data.stateMonitors).forEach((monitor) => this._watchState(monitor).catch((error) => this.error('Failed to resume state monitor', monitor.name, error)));
  }

  _consolidateHistory() {
    try {
      this.store.consolidateHistory(this._getTimezone());
      this.store.save().catch((error) => this.error('Failed to save after consolidating history', error));
    } catch (error) {
      this.error('Failed to consolidate history', error);
    }
  }
  _registerWidgets() {
    const widget = this.homey.dashboards.getWidget('sentinel');
    widget.registerSettingAutocompleteListener('monitorId', async (query) => {
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
      return [...activity, ...voltage, ...state, ...groups];
    });
  }

  // Homey sometimes stores the widget setting's full autocomplete result ({name, data:{id}}),
  // not just the id string it appears to be from the picker — unwrap defensively either way.
  async getWidgetSummary(rawId, rawPeriod) {
    const id = rawId && typeof rawId === 'object' ? (rawId.data?.id || rawId.id) : rawId;
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    const activityMonitor = this.store.data.monitors[id];
    if (activityMonitor) {
      const stats = this._statistics(activityMonitor, period);
      return {
        kind: 'activity', name: activityMonitor.name, deviceName: activityMonitor.deviceName, state: activityMonitor.state,
        activeSince: activityMonitor.state === ACTIVE ? activityMonitor.activeSince : null,
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
    return null;
  }
  // Shared by the remove_activity_monitor Flow action and the Settings page's delete button —
  // both need the exact same unsubscribe-then-forget sequence, not just a store update.
  async removeMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, item.auxiliaryCapabilities);
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
    registerTriggerFilter(this.voltageCards.undervoltage, (q) => this._voltageMonitorResults(q));
    registerTriggerFilter(this.voltageCards.overvoltage, (q) => this._voltageMonitorResults(q));
    registerTriggerFilter(this.voltageCards.normalized, (q) => this._voltageMonitorResults(q));
    registerTriggerFilter(this.stateCards.started, (q) => this._stateMonitorResults(q));
    registerTriggerFilter(this.stateCards.finished, (q) => this._stateMonitorResults(q));
    const deviceAutocomplete = (cardId) => this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('device', async (query) => {
      const normalized = (query || '').toLowerCase();
      return (await this.gateway.listDevices()).filter((device) =>
        device.name.toLowerCase().includes(normalized)
      ).map((device) => ({ name: device.name, description: device.zoneName || undefined, data: { id: device.id, name: device.name } }));
    });
    ['add_activity_monitor', 'add_voltage_monitor', 'add_state_monitor', 'add_device_to_state_group', 'remove_device_from_state_group', 'start_monitoring_device'].forEach((id) => deviceAutocomplete(id));
    // "Stop monitoring device" has to find an *already-started* manual monitor — searching raw
    // device names alone hides it the moment "Start monitoring device" was given a custom name
    // (confirmed live: created as device "Poço Energy Meter" with custom name "Bomba
    // Hidraulica", searching "Bomba" in Stop's picker found nothing). Matches against the
    // monitor's own name as well as its underlying device name, but still resolves to the
    // device id/name shape the action handler expects.
    this.homey.flow.getActionCard('stop_monitoring_device').registerArgumentAutocompleteListener('device', async (query) => {
      const normalized = (query || '').toLowerCase();
      return Object.values(this.store.data.monitors)
        .filter((m) => m.mode === 'manual' && (m.name.toLowerCase().includes(normalized) || m.deviceName.toLowerCase().includes(normalized)))
        .map((m) => ({ name: m.name, description: m.name !== m.deviceName ? m.deviceName : undefined, data: { id: m.deviceId, name: m.deviceName } }));
    });
    ['add_activity_monitor', 'add_voltage_monitor', 'add_state_monitor'].forEach((id) => this._registerCapabilityAutocomplete(id));
    ['remove_activity_monitor', 'reset_activity_monitor', 'update_activity_monitor', 'get_activity_statistics'].forEach((id) => this._monitorActionAutocomplete(id));
    this._monitorConditionAutocomplete('is_active');
    ['remove_state_monitor', 'reset_state_monitor', 'get_state_statistics'].forEach((id) => this._stateMonitorActionAutocomplete(id));
    this._stateMonitorConditionAutocomplete('is_state_active');
    ['add_device_to_state_group', 'remove_device_from_state_group', 'check_state_group'].forEach((id) => this._groupActionAutocomplete(id));
    this._groupConditionAutocomplete('state_group_has_mismatch');
    ['remove_voltage_monitor', 'reset_voltage_monitor', 'update_voltage_monitor', 'get_voltage_statistics'].forEach((id) => this._voltageMonitorActionAutocomplete(id));
    this.homey.flow.getConditionCard('is_voltage_normal').registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query));
    ['log_binary_event', 'remove_binary_counter', 'reset_binary_counter', 'get_binary_event_statistics'].forEach((id) => this._binaryCounterActionAutocomplete(id));
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
      const selected = await this.gateway.getDevice(this._deviceId(device));
      const capabilityId = capability?.id || capability?.data?.id || 'measure_power';
      if (!selected?.capabilities.includes(capabilityId)) throw new Error(`The device doesn't have the ${capabilityId} capability.`);
      const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && selected.capabilities.includes(cap));
      const { monitor, created } = this.store.upsertMonitor({ device: selected, threshold, name, capability: capabilityId, auxiliaryCapabilities });
      await this.store.save();
      if (created) await this._watch(monitor);
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
      if (continuity_minutes !== undefined && continuity_minutes !== '') {
        if (!Number.isFinite(Number(continuity_minutes)) || Number(continuity_minutes) < 0) throw new Error('The continuity window must be greater than or equal to zero.');
        item.continuityMinutes = Number(continuity_minutes);
      }
      if (min_confirmation_seconds !== undefined && min_confirmation_seconds !== '') {
        if (!Number.isFinite(Number(min_confirmation_seconds)) || Number(min_confirmation_seconds) < 0) throw new Error('The minimum confirmation must be greater than or equal to zero.');
        item.minConfirmationSeconds = Number(min_confirmation_seconds);
      }
      await this.store.save(); return true;
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
    action('create_state_group', async ({ name, type, expected_state }) => { this.store.createGroup({ name, type, expectedState: expected_state }); await this.store.save(); return true; });
    action('add_device_to_state_group', async ({ group, device }) => { const item = this._group(group); const selected = await this.gateway.getDevice(this._deviceId(device)); this._assertGroupDevice(item, selected); if (!item.devices.some((d) => d.id === selected.id)) item.devices.push({ id: selected.id, name: selected.name }); await this.store.save(); return true; });
    action('remove_device_from_state_group', async ({ group, device }) => { const item = this._group(group); const id = this._deviceId(device); item.devices = item.devices.filter((d) => d.id !== id); await this.store.save(); return true; });
    action('check_state_group', async ({ group, expected_state }) => {
      const result = await this._checkGroup(this._group(group), expected_state);
      return { group_name: result.groupName, checked_count: result.checkedCount, match_count: result.matchCount, mismatch_count: result.mismatchCount, mismatch_list: result.mismatchList, message: result.message };
    });
    condition('is_active', async ({ monitor }) => this._monitor(monitor).state === ACTIVE);
    condition('state_group_has_mismatch', async ({ group }) => (await this._checkGroup(this._group(group))).mismatchCount > 0);

    action('add_voltage_monitor', async ({ device, capability, min_voltage, max_voltage, name, stabilization_minutes }) => {
      const selected = await this.gateway.getDevice(this._deviceId(device));
      const capabilityId = capability?.id || capability?.data?.id || 'measure_voltage';
      if (!selected?.capabilities.includes(capabilityId)) throw new Error(`The device doesn't have the ${capabilityId} capability.`);
      // A device with a multi-phase meter often lists "Power Phase A" right next to "Voltage
      // Phase A" in the capability picker — easy to misclick, and nothing else here would ever
      // catch it: the min/max range is just numbers to the engine either way, so a Watts
      // reading compared against a Volts threshold silently produces false alarms instead of
      // an error. Confirmed live: a real device configured this way threw a false "overvoltage"
      // whenever the appliance's wattage exceeded the voltage threshold.
      if (!capabilityId.startsWith('measure_voltage')) {
        const title = selected.capabilitiesObj?.[capabilityId]?.title || capabilityId;
        throw new Error(`"${title}" isn't a voltage capability. Pick one whose id starts with measure_voltage (e.g. "Voltage Phase A").`);
      }
      const { monitor, created } = this.store.upsertVoltageMonitor({ device: selected, capability: capabilityId, minVoltage: min_voltage, maxVoltage: max_voltage, name, stabilizationMinutes: stabilization_minutes });
      await this.store.save();
      if (created) await this._watchVoltage(monitor);
      return true;
    });
    action('remove_voltage_monitor', async ({ monitor }) => { await this.removeVoltageMonitor(this._voltageMonitor(monitor)); return true; });
    action('reset_voltage_monitor', async ({ monitor }) => { await this.resetVoltageMonitorStats(this._voltageMonitor(monitor)); return true; });
    action('update_voltage_monitor', async ({ monitor, min_voltage, max_voltage }) => {
      this.store.updateVoltageMonitor(this._voltageMonitor(monitor), { minVoltage: min_voltage, maxVoltage: max_voltage });
      await this.store.save();
      return true;
    });
    action('get_voltage_statistics', async ({ monitor, period }) => this._voltageStatistics(this._voltageMonitor(monitor), period));
    condition('is_voltage_normal', async ({ monitor }) => this._voltageMonitor(monitor).state === NORMAL);

    // No continuity/confirmation window here (and no "Update state monitor" card exists to
    // tune it later, unlike Activity Monitor) — every real use case so far is a plain
    // door/motion/on-off sensor with no flakiness to debounce. Add one if that ever changes.
    action('add_state_monitor', async ({ device, capability, true_label, false_label, name }) => {
      const selected = await this.gateway.getDevice(this._deviceId(device));
      if (!selected) throw new Error('Device not found.');
      const capabilityId = capability?.id || capability?.data?.id || capability;
      if (!capabilityId) throw new Error('Select a capability.');
      // Mirrors the add_voltage_monitor guard: a numeric capability has no true/false state to
      // watch for, and the picker above already filters to boolean ones — this just catches
      // whatever slips through if it somehow doesn't.
      if (selected.capabilitiesObj?.[capabilityId]?.type !== 'boolean') {
        const title = selected.capabilitiesObj?.[capabilityId]?.title || capabilityId;
        throw new Error(`"${title}" isn't a boolean capability. Pick one like a contact, motion, or on/off sensor.`);
      }
      const { monitor, created } = this.store.upsertStateMonitor({ device: selected, capability: capabilityId, trueLabel: true_label, falseLabel: false_label, name });
      await this.store.save();
      if (created) await this._watchState(monitor);
      return true;
    });
    action('remove_state_monitor', async ({ monitor }) => { await this.removeStateMonitor(this._stateMonitor(monitor)); return true; });
    action('reset_state_monitor', async ({ monitor }) => { await this.resetStateMonitorStats(this._stateMonitor(monitor)); return true; });
    action('get_state_statistics', async ({ monitor, period }) => {
      const stats = this._stateStatistics(this._stateMonitor(monitor), period);
      return { ...stats, median_duration: num(stats.median_duration), median_duration_human: stats.median_duration_human || '' };
    });
    condition('is_state_active', async ({ monitor }) => this._stateMonitor(monitor).state === ACTIVE);

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
      await this.store.save();
      const data = { counter: item.name, count: todayCount, total: item.totalCount };
      return {
        event_count_today: todayCount, total_count: item.totalCount, last_event_at: new Date(timestamp).toISOString(),
        message: renderMessage(item.messageTemplate, data)
      };
    });
    action('remove_binary_counter', async ({ counter }) => { await this.removeBinaryCounter(this._binaryCounter(counter)); return true; });
    action('reset_binary_counter', async ({ counter }) => { await this.resetBinaryCounterStats(this._binaryCounter(counter)); return true; });
    action('get_binary_event_statistics', async ({ counter, period }) => {
      const stats = this._binaryEventStatistics(this._binaryCounter(counter), period);
      return { ...stats, last_event_at: stats.last_event_at || '' };
    });
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
      // (alarm_contact, alarm_motion, onoff) — a numeric one has no "active value" to mirror.
      const eligible = cardId === 'add_voltage_monitor'
        ? device.capabilities.filter((cap) => cap.startsWith('measure_voltage'))
        : cardId === 'add_state_monitor'
        ? device.capabilities.filter((cap) => device.capabilitiesObj?.[cap]?.type === 'boolean')
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
    await this.store.save();
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
        result = startedData;
      }
      if (event.type === 'finished') {
        this.log(`[${monitor.name}] finished (duration=${event.duration_human}, energy=${formatEnergy(num(event.energy))}, avg power=${num(event.average_power).toFixed(0)} W)`);
        // Today's cycle count already includes this cycle — _finalizeStandby pushed it to
        // cycles[] before this event was raised, so "%count%" reads naturally as "this is the
        // Nth time today" in a message like "pump turned off %count% %count:time|times% today".
        const finishedData = {
          ...base, duration: event.duration, duration_human: event.duration_human, energy: num(event.energy),
          average_power: num(event.average_power), max_power: num(event.max_power), average_current: num(event.average_current), max_current: num(event.max_current),
          count: this._statistics(monitor, 'day').cycle_count
        };
        finishedData.message = renderMessage(monitor.messageTemplateFinished, finishedData);
        await this.cards.finished.trigger(finishedData, { monitorId: monitor.id });
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
    const data = {
      ...base, duration: 0, duration_human: humanDuration(0), energy: 0, average_power: 0, max_power: 0, average_current: 0, max_current: 0,
      count: this._statistics(monitor, 'day').cycle_count
    };
    return { ...data, message: renderMessage(monitor.messageTemplateFinished, data) };
  }
  // Same engine, same cycle/duration/grace-window machinery as _watch/_sample above — a state
  // monitor just feeds the raw boolean straight in instead of comparing a numeric power sample
  // against a threshold (see activity-engine.js's stateFor()). No auxiliary capabilities: current
  // and energy don't mean anything for a door or a presence sensor.
  async _watchState(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, [], async (value, timestamp) => this._sampleState(monitor, value, timestamp));
  }
  async _sampleState(monitor, value, timestamp) {
    // Raw true is always ACTIVE — no more "which value means active" choice to get backwards.
    // trueLabel/falseLabel are purely cosmetic, only used when rendering the log/tokens below.
    const events = this.engine.processSample(monitor, { power: Boolean(value), timestamp });
    await this._handleStateEvents(monitor, events);
  }
  async _resolveStateContinuity(monitor) {
    const events = this.engine.finalizePendingStandby(monitor, Date.now());
    await this._handleStateEvents(monitor, events);
  }
  async _handleStateEvents(monitor, events) {
    await this.store.save();
    for (const event of events) {
      if (event.type === 'continuity_pending') {
        this.homey.setTimeout(() => this._resolveStateContinuity(monitor).catch((error) => this.error('Failed to resolve continuity window', monitor.name, error)), standbyGraceSeconds(monitor) * 1000);
        continue;
      }
      const base = { device: monitor.deviceName, monitor: monitor.name, timestamp: new Date(event.timestamp).toISOString() };
      if (event.type === 'started') {
        this.log(`[${monitor.name}] started (${monitor.trueLabel})`);
        const startedData = { ...base, label: monitor.trueLabel };
        await this.stateCards.started.trigger({ ...startedData, message: renderMessage(monitor.messageTemplateStarted, startedData) }, { monitorId: monitor.id });
      }
      if (event.type === 'finished') {
        this.log(`[${monitor.name}] finished (duration=${event.duration_human}, now ${monitor.falseLabel})`);
        const finishedData = { ...base, duration: event.duration, duration_human: event.duration_human, label: monitor.falseLabel, count: this._stateStatistics(monitor, 'day').cycle_count };
        await this.stateCards.finished.trigger({ ...finishedData, message: renderMessage(monitor.messageTemplateFinished, finishedData) }, { monitorId: monitor.id });
      }
    }
  }
  async _watchVoltage(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, [], async (voltage, timestamp) => this._voltageSample(monitor, voltage, timestamp));
  }
  async _voltageSample(monitor, voltage, timestamp) {
    const events = this.voltageEngine.processSample(monitor, { voltage, timestamp }); await this.store.save();
    for (const event of events) {
      const base = { device: monitor.deviceName, monitor: monitor.name, voltage, timestamp: new Date(timestamp).toISOString() };
      if (event.type === 'started' && event.eventType === UNDERVOLTAGE) {
        this.log(`[${monitor.name}] undervoltage (${voltage} V)`);
        await this.voltageCards.undervoltage.trigger({ ...base, message: renderMessage(monitor.messageTemplateUndervoltage, base) }, { monitorId: monitor.id });
      }
      if (event.type === 'started' && event.eventType === OVERVOLTAGE) {
        this.log(`[${monitor.name}] overvoltage (${voltage} V)`);
        await this.voltageCards.overvoltage.trigger({ ...base, message: renderMessage(monitor.messageTemplateOvervoltage, base) }, { monitorId: monitor.id });
      }
      if (event.type === 'normalized') {
        this.log(`[${monitor.name}] normalized (duration=${humanDuration(event.duration)}, min=${num(event.min_voltage).toFixed(1)} V, max=${num(event.max_voltage).toFixed(1)} V)`);
        const normalizedData = {
          ...base, event_type: event.previousEventType, duration: num(event.duration), duration_human: humanDuration(event.duration),
          min_voltage: num(event.min_voltage), max_voltage: num(event.max_voltage), average_voltage: num(event.average_voltage)
        };
        await this.voltageCards.normalized.trigger({ ...normalizedData, message: renderMessage(monitor.messageTemplateNormalized, normalizedData) }, { monitorId: monitor.id });
      }
    }
  }
  // 'all' reads counter.totalCount directly (never pruned) rather than summing dailyCounts,
  // which only keeps the same 90-day window every other monitor type retains.
  _binaryEventStatistics(counter, period = 'all') {
    const lastEventAt = counter.lastEventAt ? new Date(counter.lastEventAt).toISOString() : null;
    if (period === 'all') return { event_count: counter.totalCount, last_event_at: lastEventAt };
    const now = Date.now();
    const timeZone = this._getTimezone();
    const rollingWindowDays = { week: 7, month: 30 };
    const start = period === 'day'
      ? startOfLocalDay(new Date(now), timeZone).getTime()
      : rollingWindowDays[period] ? now - rollingWindowDays[period] * 24 * 60 * 60 * 1000 : 0;
    const startKey = localDateKey(new Date(start), timeZone);
    const eventCount = (counter.dailyCounts || []).filter((day) => day.date >= startKey).reduce((total, day) => total + day.count, 0);
    return { event_count: eventCount, last_event_at: lastEventAt };
  }
  _voltageStatistics(monitor, period = 'all') {
    const now = Date.now();
    const rollingWindowDays = { week: 7, month: 30 };
    const start = period === 'day'
      ? startOfLocalDay(new Date(now), this._getTimezone()).getTime()
      : rollingWindowDays[period] ? now - rollingWindowDays[period] * 24 * 60 * 60 * 1000 : 0;
    const periods = (monitor.periods || []).filter((item) => item.endedAt > start && item.startedAt < now);
    const voltages = periods.map((item) => item.voltage).filter(Number.isFinite);
    // Daily summaries (see SentinelStore#consolidateHistory) fill in min/max for anything
    // older than the granular period retention window. They don't track an average (only
    // min/max are kept once consolidated, to avoid carrying a running sum+count forever), so
    // average_voltage naturally only reflects the still-granular window.
    const daily = (monitor.dailySummaries || []).filter((day) => {
      const dayStart = new Date(`${day.date}T00:00:00Z`).getTime();
      return dayStart >= start && dayStart < now;
    });
    const mins = voltages.concat(daily.map((day) => day.minVoltage)).filter(Number.isFinite);
    const maxes = voltages.concat(daily.map((day) => day.maxVoltage)).filter(Number.isFinite);
    const events = (monitor.events || []).filter((event) => event.startedAt >= start && event.startedAt < now);
    const undervoltageEvents = events.filter((event) => event.type === UNDERVOLTAGE);
    const overvoltageEvents = events.filter((event) => event.type === OVERVOLTAGE);
    const sumDuration = (items) => items.reduce((total, item) => total + item.duration, 0);
    return {
      average_voltage: average(voltages), min_voltage: mins.length ? Math.min(...mins) : null, max_voltage: maxes.length ? Math.max(...maxes) : null,
      undervoltage_count: undervoltageEvents.length, undervoltage_duration: sumDuration(undervoltageEvents),
      overvoltage_count: overvoltageEvents.length, overvoltage_duration: sumDuration(overvoltageEvents)
    };
  }
  _statistics(monitor, period = 'all') {
    const now = Date.now();
    // "day" means since local midnight (matching how Home Assistant's Energy dashboard and
    // utility_meter roll over) — a rolling 24h window would answer a different question.
    const rollingWindowDays = { week: 7, month: 30 };
    const start = period === 'day'
      ? startOfLocalDay(new Date(now), this._getTimezone()).getTime()
      : rollingWindowDays[period] ? now - rollingWindowDays[period] * 24 * 60 * 60 * 1000 : 0;
    const current = this._periodStatistics(monitor, start, now);
    const trend = this._weeklyTrend(monitor, now);
    return { ...current, trend_active_duration_percent: trend.activeDuration.percent, trend_cycle_count_percent: trend.cycleCount.percent, trend_energy_percent: trend.energy.percent, trend_summary: trend.summary };
  }
  // Same underlying period/cycle math as _statistics — a state monitor is just an activity
  // monitor with no power/energy signal — but only the fields that mean something for a
  // boolean capability are surfaced, so a door's stats card doesn't show "Peak power: 0 W".
  _stateStatistics(monitor, period = 'all') {
    const stats = this._statistics(monitor, period);
    return {
      cycle_count: stats.cycle_count, true_duration: stats.active_duration, false_duration: stats.standby_duration,
      true_label: monitor.trueLabel, false_label: monitor.falseLabel,
      median_duration: stats.median_duration, median_duration_human: stats.median_duration_human,
      trend_active_duration_percent: stats.trend_active_duration_percent, trend_cycle_count_percent: stats.trend_cycle_count_percent,
      trend_summary: stats.trend_summary
    };
  }
  _periodStatistics(monitor, start, end) {
    const periods = (monitor.periods || []).filter((item) => item.endedAt > start && item.startedAt < end);
    const active = periods.filter((item) => item.state === ACTIVE);
    const standby = periods.filter((item) => item.state !== ACTIVE);
    const overlapSeconds = (item) => Math.max(0, Math.min(item.endedAt, end) - Math.max(item.startedAt, start)) / 1000;
    const sum = (items, field) => items.reduce((total, item) => total + (field === 'seconds' ? overlapSeconds(item) : (item[field] || 0)), 0);
    // Filtered by when the cycle ENDED, not started — a session that started before local
    // midnight and finished today (an AC left running overnight) must count as today's cycle.
    // Filtering by startedAt instead silently dropped it from every period's cycle_count/
    // average_power/max_power forever (it never started "today", so "today" always excluded
    // it, and by the time "yesterday" is queried the window has already moved on) — confirmed
    // live: a unit active since before midnight showed 0 cycles / no average power for the
    // entire day even after it turned off. periods[] doesn't have this problem since it's
    // filtered by overlap and prorated across the midnight split (see splitPeriodByLocalDay).
    const cycles = (monitor.cycles || []).filter((cycle) => cycle.endedAt > start && cycle.endedAt <= end);
    // Sourced from cycles (never pruned/condensed), not periods (condensed after ~7 days) —
    // keeps power/current stats accurate for "month"/"all" queries regardless of how much of
    // the raw period detail behind them has already been folded into daily summaries.
    const numeric = (items, field) => items.map((item) => item[field]).filter(Number.isFinite);
    const powers = numeric(cycles, 'averagePower');
    const currents = numeric(cycles, 'averageCurrent');
    const peakPowers = numeric(cycles, 'maxPower');
    const peakCurrents = numeric(cycles, 'maxCurrent');
    const hasEnoughCycles = cycles.length >= MEDIAN_MIN_CYCLES;
    const medianDuration = hasEnoughCycles ? median(numeric(cycles, 'duration')) : null;
    const medianEnergy = hasEnoughCycles ? median(numeric(cycles, 'energy')) : null;
    // Daily summaries (see SentinelStore#consolidateHistory) fill in duration/energy for
    // anything older than the granular period retention window.
    const daily = (monitor.dailySummaries || []).reduce((acc, day) => {
      const dayStart = new Date(`${day.date}T00:00:00Z`).getTime();
      if (dayStart >= start && dayStart < end) {
        acc.activeSeconds += day.activeSeconds; acc.standbySeconds += day.standbySeconds;
        acc.activeEnergy += day.activeEnergy; acc.standbyEnergy += day.standbyEnergy;
        acc.meterResetCount += day.meterResetCount || 0;
      }
      return acc;
    }, { activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0, meterResetCount: 0 });
    // A negative energy delta (meter replaced/reset) is already clamped to 0 above like
    // before — this only tells the difference between "genuinely measured zero" and "a
    // reset happened here," instead of the two silently looking identical. Sparse field:
    // absent when nothing was detected in the requested period, same convention as
    // getWidgetSummary's null-for-no-data fields.
    const hadMeterReset = periods.some((item) => item.meterReset) || daily.meterResetCount > 0;
    return {
      cycle_count: cycles.length, active_duration: sum(active, 'seconds') + daily.activeSeconds, standby_duration: sum(standby, 'seconds') + daily.standbySeconds,
      total_energy: sum(periods, 'energy') + daily.activeEnergy + daily.standbyEnergy, active_energy: sum(active, 'energy') + daily.activeEnergy, standby_energy: sum(standby, 'energy') + daily.standbyEnergy,
      average_power: average(powers), max_power: maximum(peakPowers), average_current: average(currents), max_current: maximum(peakCurrents),
      median_duration: medianDuration, median_duration_human: medianDuration !== null ? humanDuration(medianDuration) : null, median_energy: medianEnergy,
      energy_quality: hadMeterReset ? 'meter_reset' : null
    };
  }
  // Finds a threshold by locating the widest gap in the monitor's raw power sample history —
  // works well for appliances with a clearly separated standby draw (clock/display
  // electronics, a few watts) and active draw (heating element/motor, much higher), which is
  // the common shape a device like this actually has. `minClusterSize` samples are required
  // on both sides of the split so a single outlier reading can't be mistaken for "the gap".
  // Reports the observed low/high bounds alongside the suggestion so the user can judge how
  // convincing the gap really is, instead of trusting a bare number.
  _suggestedThreshold(monitor) {
    const values = (monitor.periods || []).map((period) => period.power).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length < THRESHOLD_SUGGESTION_MIN_SAMPLES) return null;
    const minClusterSize = Math.max(3, Math.floor(values.length * 0.1));
    let bestGap = -1;
    let bestIndex = -1;
    for (let i = minClusterSize; i < values.length - minClusterSize; i += 1) {
      const gap = values[i] - values[i - 1];
      if (gap > bestGap) { bestGap = gap; bestIndex = i; }
    }
    if (bestIndex === -1 || bestGap <= 0) return null;
    const low = values[bestIndex - 1];
    const high = values[bestIndex];
    // Geometric mean lands the suggestion proportionally inside the gap rather than at its
    // arithmetic midpoint — standby and active are often an order of magnitude apart (5 W vs
    // 1000 W), where a straight average (502 W) would sit absurdly close to full load instead
    // of comfortably above standby noise.
    const threshold = Math.sqrt(Math.max(low, 0.1) * high);
    return { threshold: Math.round(threshold * 10) / 10, low, high, sampleCount: values.length };
  }
  // Backs the Settings page's Monitors tab — the same period/energy/daily-breakdown detail
  // the widget shows, but for every activity monitor at once in one table (no need to set up
  // a widget per device just to see this).
  getMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.monitors).map((monitor) => {
      const stats = this._statistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, state: monitor.state,
        period, cycleCount: stats.cycle_count, energy: stats.total_energy, averagePower: stats.average_power, energyQuality: stats.energy_quality,
        dailyBreakdown: period === 'day' ? null : this._dailyBreakdown(monitor, period === 'week' ? 7 : 30),
        messageTemplateStarted: monitor.messageTemplateStarted, messageTemplateFinished: monitor.messageTemplateFinished,
        suggestedThreshold: this._suggestedThreshold(monitor)
      };
    });
  }
  // Same idea as getMonitorsSummary, for the state monitors table — trimmed to duration/count
  // fields, same as _stateStatistics, since energy/power don't mean anything here.
  getStateMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.stateMonitors).map((monitor) => {
      const stats = this._stateStatistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, capability: monitor.capability, state: monitor.state,
        trueLabel: monitor.trueLabel, falseLabel: monitor.falseLabel,
        period, cycleCount: stats.cycle_count, trueDuration: stats.true_duration, falseDuration: stats.false_duration,
        dailyBreakdown: period === 'day' ? null : this._stateDailyBreakdown(monitor, period === 'week' ? 7 : 30),
        messageTemplateStarted: monitor.messageTemplateStarted, messageTemplateFinished: monitor.messageTemplateFinished
      };
    });
  }
  // Same idea as _dailyBreakdown, for state monitors — active seconds per day instead of energy.
  _stateDailyBreakdown(monitor, days) {
    const timeZone = this._getTimezone();
    const now = Date.now();
    const todayStart = startOfLocalDay(new Date(now), timeZone).getTime();
    const result = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const dayStart = todayStart - i * 24 * 60 * 60 * 1000;
      const dayEnd = startOfLocalDay(new Date(dayStart + 25 * 60 * 60 * 1000), timeZone).getTime();
      const stats = this._periodStatistics(monitor, dayStart, Math.min(dayEnd, now));
      result.push({ date: localDateKey(new Date(dayStart), timeZone), trueDuration: stats.active_duration });
    }
    return result;
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
  // One energy total per calendar day for the last `days` days (oldest first), for the
  // widget's sparkline. Reuses _periodStatistics per day rather than a separate aggregation
  // path, so it stays consistent with whatever the stat cards show for the same range.
  _dailyBreakdown(monitor, days) {
    const timeZone = this._getTimezone();
    const now = Date.now();
    const todayStart = startOfLocalDay(new Date(now), timeZone).getTime();
    const result = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const dayStart = todayStart - i * 24 * 60 * 60 * 1000;
      const dayEnd = startOfLocalDay(new Date(dayStart + 25 * 60 * 60 * 1000), timeZone).getTime();
      const stats = this._periodStatistics(monitor, dayStart, Math.min(dayEnd, now));
      result.push({ date: localDateKey(new Date(dayStart), timeZone), energy: stats.total_energy });
    }
    return result;
  }
  _weeklyTrend(monitor, now) {
    const week = 7 * 24 * 60 * 60 * 1000;
    const current = this._periodStatistics(monitor, now - week, now);
    const previous = this._periodStatistics(monitor, now - 2 * week, now - week);
    const compare = (key) => {
      const value = current[key]; const baseline = previous[key];
      const hasBaseline = baseline !== 0;
      const percent = hasBaseline ? ((value - baseline) / baseline) * 100 : 0;
      return { current: value, previous: baseline, percent, hasBaseline };
    };
    const activeDuration = compare('active_duration'); const cycleCount = compare('cycle_count'); const energy = compare('total_energy');
    const label = (item) => !item.hasBaseline ? 'no prior baseline' : `${item.percent >= 0 ? '+' : ''}${item.percent.toFixed(1)}%`;
    return { activeDuration, cycleCount, energy, summary: `This week vs. previous: activity ${label(activeDuration)}, cycles ${label(cycleCount)}, energy ${label(energy)}.` };
  }
  _assertGroupDevice(group, device) {
    if (!device || !device.capabilities.includes(GROUP_TYPES[group.type]?.capability)) throw new Error(`This device isn't compatible with the ${group.type} group.`);
  }
  async _checkGroup(group, expectedOverride) {
    if (group.devices.length < 2) throw new Error('A group needs at least two devices.');
    const expected = expectedOverride === undefined || expectedOverride === '' ? group.expectedState : (expectedOverride === true || expectedOverride === 'true');
    const devices = await Promise.all(group.devices.map(({ id }) => this.gateway.getDevice(id)));
    const { capability, invert } = GROUP_TYPES[group.type];
    const target = invert ? !expected : expected;
    const mismatches = devices.filter((device) => !device || Boolean(device.capabilitiesObj?.[capability]?.value) !== target).map((device, index) => device?.name || group.devices[index].name);
    const items = formatList(mismatches, group.conjunction || 'and');
    const template = mismatches.length === 0 ? group.messageTemplateZero : mismatches.length === 1 ? group.messageTemplateOne : group.messageTemplateMany;
    const message = renderMessage(template, { group: group.name, count: mismatches.length, items });
    return { groupName: group.name, checkedCount: group.devices.length, matchCount: group.devices.length - mismatches.length, mismatchCount: mismatches.length, mismatchList: mismatches.join('\n'), message };
  }
}

module.exports = StatisticTrackerApp;
