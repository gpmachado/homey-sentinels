'use strict';

// Flow card registration, their autocompletes and the argument resolvers the cards share.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { ACTIVE } = require('../activity-engine');
const { NORMAL } = require('../voltage-engine');
const { renderMessage } = require('../message-template');
const { FLOW_LIST_MAX_AGE_MS, AUXILIARY_CAPABILITY_CANDIDATES, num } = require('./constants');

module.exports = {
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
  },

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
    // Filters to only devices that already have a watchdog configured (unlike the generic
    // deviceAutocomplete below, which lists every device — picking an unwatched one here would
    // just never fire).
    const registerAvailabilityTriggerFilter = (card) => {
      card.registerRunListener(async (args, state) => (args.device?.id || args.device?.data?.id) === state.deviceId);
      card.registerArgumentAutocompleteListener('device', async (query) => this._availabilityWatchdogResults(query));
    };
    registerAvailabilityTriggerFilter(this.availabilityCards.unavailable);
    registerAvailabilityTriggerFilter(this.availabilityCards.available);
    registerAvailabilityTriggerFilter(this.availabilityCards.batteryLow);
    const registerGroupTriggerFilter = (card) => {
      card.registerRunListener(async (args, state) => (args.group?.id || args.group?.data?.id) === state.groupId);
      card.registerArgumentAutocompleteListener('group', async (query) => this._groupResults(query));
    };
    registerGroupTriggerFilter(this.groupCards.mismatchDetected);
    registerGroupTriggerFilter(this.groupCards.matchedAgain);
    const deviceAutocomplete = (card) => card.registerArgumentAutocompleteListener('device', async (query) => {
      const normalized = (query || '').toLowerCase();
      return (await this.directory.ensure(FLOW_LIST_MAX_AGE_MS)).filter((device) =>
        device.name.toLowerCase().includes(normalized)
      ).map((device) => ({ name: device.name, description: device.zoneName || undefined, data: { id: device.id, name: device.name } }));
    });
    ['add_activity_monitor', 'add_voltage_monitor', 'add_state_monitor', 'add_device_to_state_group', 'remove_device_from_state_group', 'start_monitoring_device', 'add_availability_watchdog'].forEach((id) => deviceAutocomplete(this.homey.flow.getActionCard(id)));
    deviceAutocomplete(this.homey.flow.getConditionCard('is_device_monitored'));
    deviceAutocomplete(this.homey.flow.getConditionCard('is_device_available'));
    // Unlike the trigger filters above, "remove" should list only watched devices — same
    // rationale as _availabilityWatchdogResults being used there.
    this.homey.flow.getActionCard('remove_availability_watchdog').registerArgumentAutocompleteListener('device', async (query) => this._availabilityWatchdogResults(query));
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
      return (await this.directory.ensure(FLOW_LIST_MAX_AGE_MS))
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
      await this.updateActivityMonitorSettings(this._monitor(monitor), { threshold, continuityMinutes: continuity_minutes, minConfirmationSeconds: min_confirmation_seconds });
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
      await this.updateVoltageMonitorRange(this._voltageMonitor(monitor), { minVoltage: min_voltage, maxVoltage: max_voltage });
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

    action('add_availability_watchdog', async ({ device, thresholdHours }) => {
      await this._createAvailabilityWatchdog({ deviceId: this._deviceId(device), thresholdHours: Number(thresholdHours) });
      return true;
    });
    action('remove_availability_watchdog', async ({ device }) => { await this.removeAvailabilityWatchdog(this._deviceId(device)); return true; });
    // Reads just this device (never the whole device list) — homey-api answers from what it already
    // holds for a device it has seen, so a condition that runs often inside a Flow stays cheap.
    condition('is_device_available', async ({ device }) => {
      const id = this._deviceId(device);
      const live = await this.gateway.getDevice(id).catch(() => null);
      return live ? live.available : false;
    });
  },

  _monitorResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.monitors).filter((m) => m.name.toLowerCase().includes(normalized)).map((m) => ({ name: m.name, description: m.deviceName, data: { id: m.id } })); },

  _voltageMonitorResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.voltageMonitors).filter((m) => m.name.toLowerCase().includes(normalized)).map((m) => ({ name: m.name, description: m.deviceName, data: { id: m.id } })); },

  _stateMonitorResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.stateMonitors).filter((m) => m.name.toLowerCase().includes(normalized)).map((m) => ({ name: m.name, description: m.deviceName, data: { id: m.id } })); },

  _binaryCounterResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.binaryCounters).filter((c) => c.name.toLowerCase().includes(normalized)).map((c) => ({ name: c.name, description: `${c.totalCount} total`, data: { id: c.id } })); },

  _monitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query)); },

  _monitorConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query)); },

  _voltageMonitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query)); },

  _stateMonitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._stateMonitorResults(query)); },

  _stateMonitorConditionAutocomplete(cardId) { this.homey.flow.getConditionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._stateMonitorResults(query)); },

  _binaryCounterActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('counter', async (query) => this._binaryCounterResults(query)); },

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
  },

  _monitor(arg) { const item = this.store.data.monitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('Monitor not found.'); return item; },

  _voltageMonitor(arg) { const item = this.store.data.voltageMonitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('Voltage monitor not found.'); return item; },

  _stateMonitor(arg) { const item = this.store.data.stateMonitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('State monitor not found.'); return item; },

  _binaryCounter(arg) { const item = this.store.data.binaryCounters[arg?.id || arg?.data?.id]; if (!item) throw new Error('Binary counter not found.'); return item; },

  // Homey keeps an autocomplete selection nested as {name, data:{id}} — it does not flatten
  // data onto the top level, confirmed against a real "Missing Parameter: id" runtime error.
  _deviceId(arg) { const id = arg?.id || arg?.data?.id; if (!id) throw new Error('Select a valid device.'); return id; }
};
