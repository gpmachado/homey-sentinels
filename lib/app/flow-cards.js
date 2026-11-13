'use strict';

// Flow card registration, their autocompletes and the argument resolvers the cards share.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { ACTIVE } = require('../activity-engine');
const { voltageImbalancePercent, hoursSinceLastRun } = require('../statistics');
const { hourShare } = require('../usage-pattern');
const { FLOW_LIST_MAX_AGE_MS, AUXILIARY_CAPABILITY_CANDIDATES, num, roundTokens, formatEnergy } = require('./constants');

// The id of the "Any ..." choice of a trigger's argument. Real ids are monitor-/state-/voltage-/group-<...> or a device id.
const ANY = '*';
const LOG_TEXT_LIMIT = 500;

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
    return [...activity, ...voltage, ...state, ...groups];
  },

  _registerFlowCards() {
    // Wrapping every card here (instead of editing each handler) logs entry/result/error for
    // free on every action and condition, present and future — the terminal from `homey app
    // run` otherwise shows nothing when a card runs or fails; only the card's own red error
    // bubble in the Flow editor did, which isn't visible from a running CLI session. A failure
    // is always logged; the run and its result only with the detailed log on, since a Flow that
    // checks a condition every minute otherwise wrote two lines a minute forever.
    const withLogging = (kind, id, listener) => async (args, state) => {
      this._debug(() => [`[${kind}] ${id}`, this._summarizeArgs(args)]);
      try {
        const result = roundTokens(await listener(args, state));
        // A plain true (a condition that held, or an action with no tokens) logs as "ok" alone.
        // A long text token (export_data's JSON is megabytes) logs as its length, not its contents.
        const shown = () => (result && typeof result === 'object'
          ? Object.fromEntries(Object.entries(result).map(([key, value]) => [key, typeof value === 'string' && value.length > LOG_TEXT_LIMIT ? `<${value.length} characters>` : value]))
          : result);
        this._debug(() => (result === true ? [`[${kind}] ${id} ok`] : [`[${kind}] ${id} ok`, shown()]));
        return result;
      } catch (error) {
        this.error(`[${kind}] ${id} failed:`, error.message);
        throw error;
      }
    };
    const action = (id, listener) => this.homey.flow.getActionCard(id).registerRunListener(withLogging('action', id, listener));
    const condition = (id, listener) => this.homey.flow.getConditionCard(id).registerRunListener(withLogging('condition', id, listener));
    // A trigger's run listener decides, per Flow using the card, whether that Flow runs; the detailed log says which.
    const triggerRun = (card, decide) => card.registerRunListener(async (args, state) => {
      const runs = await decide(args, state);
      this._debug(() => [`[trigger] ${card.id} ${runs ? 'runs' : 'does not run'} a Flow set to`, this._summarizeArgs(args), 'for', state]);
      return runs;
    });
    // Every trigger card fires for every monitor (or group, or watched device) of its kind, and the card's own
    // argument narrows it to one. Its list starts with an "Any ..." choice, so one Flow can react to all of
    // them instead of one Flow per monitor; the tokens then say which one it was.
    const picked = (arg, id) => { const filterId = arg?.id || arg?.data?.id; return filterId === ANY || filterId === id; };
    const withAny = (label, results, query) => {
      const wanted = (query || '').trim().toLowerCase();
      return [...(!wanted || label.toLowerCase().includes(wanted) ? [{ name: label, description: 'Runs for every one', data: { id: ANY } }] : []), ...results];
    };
    const registerTriggerFilter = (card, resultsFn, label = 'Any activity monitor') => {
      triggerRun(card, (args, state) => picked(args.monitor, state.monitorId));
      card.registerArgumentAutocompleteListener('monitor', async (query) => withAny(label, resultsFn(query), query));
    };
    registerTriggerFilter(this.cards.started, (q) => this._monitorResults(q));
    registerTriggerFilter(this.cards.finished, (q) => this._monitorResults(q));
    registerTriggerFilter(this.cards.calibrated, (q) => this._monitorResults(q));
    registerTriggerFilter(this.voltageCards.undervoltage, (q) => this._voltageMonitorResults(q), 'Any voltage monitor');
    registerTriggerFilter(this.voltageCards.overvoltage, (q) => this._voltageMonitorResults(q), 'Any voltage monitor');
    registerTriggerFilter(this.voltageCards.normalized, (q) => this._voltageMonitorResults(q), 'Any voltage monitor');
    registerTriggerFilter(this.stateCards.started, (q) => this._stateMonitorResults(q), 'Any state monitor');
    registerTriggerFilter(this.stateCards.finished, (q) => this._stateMonitorResults(q), 'Any state monitor');
    // Cycle count reached also needs the exact-cycles match, not just "which monitor" —
    // registerTriggerFilter's helper only covers the latter, so this stays hand-written.
    triggerRun(this.cards.cyclesReached, (args, state) => {
      return picked(args.monitor, state.monitorId) && Number(args.cycles) === state.cycleCount;
    });
    this.cards.cyclesReached.registerArgumentAutocompleteListener('monitor', async (query) => withAny('Any monitor', this._cycleMonitorResults(query), query));
    triggerRun(this.cards.stillRunning, (args, state) => picked(args.monitor, state.monitorId) && Number(args.multiplier) === state.multiplier);
    this.cards.stillRunning.registerArgumentAutocompleteListener('monitor', async (query) => withAny('Any monitor', this._cycleMonitorResults(query), query));
    // A Flow added or changed while a cycle is running gets its timer now, not only from the next start.
    this.cards.stillRunning.on?.('update', () => {
      for (const monitor of [...Object.values(this.store.data.monitors), ...Object.values(this.store.data.stateMonitors)]) {
        this._scheduleOverrunChecks(monitor).catch((error) => this.error('Failed to schedule a long-running check', monitor.name, error));
      }
    });
    triggerRun(this.cards.unusuallyLong, (args, state) => {
      return picked(args.monitor, state.monitorId) && state.ratio >= Number(args.multiplier);
    });
    this.cards.unusuallyLong.registerArgumentAutocompleteListener('monitor', async (query) => withAny('Any monitor', this._cycleMonitorResults(query), query));
    // Filters to only devices that already have a watchdog configured (unlike the generic
    // deviceAutocomplete below, which lists every device — picking an unwatched one here would
    // just never fire).
    const registerAvailabilityTriggerFilter = (card) => {
      triggerRun(card, (args, state) => picked(args.device, state.deviceId));
      card.registerArgumentAutocompleteListener('device', async (query) => withAny('Any watched device', this._availabilityWatchdogResults(query), query));
    };
    registerAvailabilityTriggerFilter(this.availabilityCards.unavailable);
    registerAvailabilityTriggerFilter(this.availabilityCards.available);
    registerAvailabilityTriggerFilter(this.availabilityCards.batteryLow);
    registerAvailabilityTriggerFilter(this.availabilityCards.batteryOk);
    const registerGroupTriggerFilter = (card) => {
      triggerRun(card, (args, state) => picked(args.group, state.groupId));
      card.registerArgumentAutocompleteListener('group', async (query) => withAny('Any group', this._groupResults(query), query));
    };
    registerGroupTriggerFilter(this.groupCards.mismatchDetected);
    registerGroupTriggerFilter(this.groupCards.matchedAgain);
    const deviceAutocomplete = (card) => card.registerArgumentAutocompleteListener('device', async (query) => {
      const normalized = (query || '').toLowerCase();
      return (await this.directory.ensure(FLOW_LIST_MAX_AGE_MS)).filter((device) =>
        device.name.toLowerCase().includes(normalized)
      ).map((device) => ({ name: device.name, description: device.zoneName || undefined, data: { id: device.id, name: device.name } }));
    });
    deviceAutocomplete(this.homey.flow.getActionCard('start_monitoring_device'));
    deviceAutocomplete(this.homey.flow.getConditionCard('is_device_monitored'));
    deviceAutocomplete(this.homey.flow.getConditionCard('is_device_available'));
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
    ['update_activity_monitor', 'get_activity_statistics', 'calibrate_threshold'].forEach((id) => this._monitorActionAutocomplete(id));
    this.homey.flow.getConditionCard('is_monitor_active').registerArgumentAutocompleteListener('monitor', async (query) => this._cycleMonitorResults(query));
    this.homey.flow.getActionCard('reset_monitor').registerArgumentAutocompleteListener('monitor', async (query) => [
      ...this._monitorResults(query), ...this._stateMonitorResults(query), ...this._voltageMonitorResults(query)
    ]);
    this.homey.flow.getConditionCard('activity_running_longer_than').registerArgumentAutocompleteListener('monitor', async (query) => this._cycleMonitorResults(query));
    ['get_state_statistics'].forEach((id) => this._stateMonitorActionAutocomplete(id));
    ['check_state_group', 'get_group_statistics'].forEach((id) => this._groupActionAutocomplete(id));
    this._groupConditionAutocomplete('state_group_has_mismatch');
    ['update_voltage_monitor', 'get_voltage_statistics'].forEach((id) => this._voltageMonitorActionAutocomplete(id));
    this.homey.flow.getConditionCard('voltage_is_state').registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query));
    this.homey.flow.getConditionCard('usage_unusual_hour').registerArgumentAutocompleteListener('monitor', async (query) => this._cycleMonitorResults(query));
    this.homey.flow.getConditionCard('activity_not_run_for').registerArgumentAutocompleteListener('monitor', async (query) => this._cycleMonitorResults(query));
    this.homey.flow.getActionCard('get_usage_pattern').registerArgumentAutocompleteListener('monitor', async (query) => this._cycleMonitorResults(query));
    this.homey.flow.getConditionCard('monitor_has_recent_reading').registerArgumentAutocompleteListener('monitor', async (query) => [
      ...this._monitorResults(query), ...this._stateMonitorResults(query), ...this._voltageMonitorResults(query)
    ]);
    this.homey.flow.getActionCard('generate_text_report').registerArgumentAutocompleteListener('item', async (query) => [
      ...this._monitorResults(query), ...this._voltageMonitorResults(query), ...this._stateMonitorResults(query)
    ]);

    // One reset for the three kinds of monitor (it used to be one card per kind).
    action('reset_monitor', async ({ monitor }) => {
      const id = monitor?.id || monitor?.data?.id;
      const { monitors, stateMonitors, voltageMonitors } = this.store.data;
      if (monitors[id]) await this.resetMonitorStats(monitors[id]);
      else if (stateMonitors[id]) await this.resetStateMonitorStats(stateMonitors[id]);
      else if (voltageMonitors[id]) await this.resetVoltageMonitorStats(voltageMonitors[id]);
      else throw new Error('Monitor not found.');
      return true;
    });
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
      const wording = this._defaultWording().activityMessageDefaults;
      const { monitor, created } = this.store.upsertManualMonitor({ device: selected, auxiliaryCapabilities, name, messageTemplateStarted: wording.started, messageTemplateFinished: wording.finished });
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
        p25_duration: num(stats.p25_duration), p25_duration_human: stats.p25_duration_human || '', p75_duration: num(stats.p75_duration), p75_duration_human: stats.p75_duration_human || '',
        p25_energy: num(stats.p25_energy), p75_energy: num(stats.p75_energy),
        energy_quality: stats.energy_quality || '', trend_summary: this._trendSummaryFor(this._monitor(monitor))
      };
    });
    // Re-enables auto-calibration without deleting/recreating the monitor — reuses
    // _maybeAutoCalibrate's existing pipeline entirely (app.js's onSample path already checks
    // `monitor.calibrating` before re-suggesting a threshold), same as a freshly created
    // monitor with no explicit threshold.
    action('calibrate_threshold', async ({ monitor }) => {
      const item = this._monitor(monitor);
      if (item.mode) throw new Error('This monitor is started and stopped by Flows, it has no threshold to calibrate.');
      // A fresh start: without this the new attempt waited out the back-off of the failed ones, up to 30 minutes.
      this._calibrationAttempts.delete(item.id);
      this._lastCalibrationAttempt.delete(item.id);
      item.calibrating = true;
      await this.store.save();
      return true;
    });
    // Cycles by weekday and hour: the busiest day and hour and how much of the time on is in the day (06:00 to 22:00).
    // The weekday name and the sentence come in the Default message language; the numbers are there to build your own.
    action('get_usage_pattern', async ({ monitor, period }) => {
      const pattern = this.getUsagePattern(monitor, period);
      // A state monitor's "power" is its on/off value (1 while on), so it has no real peak power to report.
      if (this.store.data.stateMonitors[pattern.id]) Object.assign(pattern, { peakPowerHour: null, peakPowerHourLabel: '', peakPower: null });
      return {
        enough_data: pattern.enough, cycle_count: pattern.cycleCount,
        busiest_weekday: pattern.weekdayName, busiest_weekday_number: pattern.busiestWeekday === null ? 0 : pattern.busiestWeekday + 1,
        busiest_weekday_percent: num(pattern.busiestWeekdayShare), busiest_hour: pattern.busiestHour === null ? -1 : pattern.busiestHour, busiest_hour_label: pattern.hourLabel,
        day_percent: num(pattern.dayShare), night_percent: num(pattern.nightShare),
        energy_total: pattern.totalEnergy, peak_power_hour: pattern.peakPowerHour === null ? -1 : pattern.peakPowerHour, peak_power_hour_label: pattern.peakPowerHourLabel, peak_power: num(pattern.peakPower),
        message: pattern.message
      };
    });
    action('get_daily_digest', async () => {
      const digest = this.getDailyDigest();
      return {
        cycles: digest.cycles, energy: digest.energy, top_name: digest.topName, top_energy: digest.topEnergy,
        problems: digest.problems, groups_mismatch: digest.groupsMismatch, message: digest.message
      };
    });
    // Language-neutral on purpose: the ranking lines are "name: kWh", with no words to translate.
    action('get_standby_ranking', async ({ period }) => {
      const ranking = this.getStandbyRanking(period);
      const top = ranking.rows[0];
      return {
        count: ranking.rows.length, total_standby_energy: ranking.totalStandbyEnergy,
        top_name: top ? top.name : '', top_standby_energy: top ? top.standbyEnergy : 0,
        ranking: ranking.rows.slice(0, 5).map((row, i) => `${i + 1}. ${row.name}: ${formatEnergy(row.standbyEnergy)}`).join('\n')
      };
    });
    action('generate_text_report', async ({ item, period }) => ({ report: this._generateTextReport(item, period) }));
    action('check_state_group', async ({ group, expected_state }) => {
      const result = await this._checkGroup(this._group(group), expected_state);
      return { group_name: result.groupName, checked_count: result.checkedCount, match_count: result.matchCount, mismatch_count: result.mismatchCount, mismatch_list: result.mismatchList, message: result.message };
    });
    action('get_group_statistics', async ({ group, period }) => this._groupStatistics(this._group(group), period));
    action('export_data', async () => {
      const json = JSON.stringify(this.store.data);
      return { json, size_bytes: Buffer.byteLength(json, 'utf8') };
    });
    condition('is_monitor_active', async ({ monitor }) => this._cycleMonitor(monitor).state === ACTIVE);
    // Lets an energy-saving Flow act only once a device has been running a while (e.g. "turn
    // off the AC when the tariff spikes, but only if it's been on for 2+ hours") instead of
    // reacting to any activity at all. False for a monitor currently STANDBY — there's no
    // "since" to measure.
    condition('activity_running_longer_than', async ({ monitor, minutes }) => {
      const item = this._cycleMonitor(monitor);
      if (item.state !== ACTIVE || !item.activeSince) return false;
      return (Date.now() - item.activeSince) / 60000 >= Number(minutes);
    });
    condition('monitor_has_recent_reading', async ({ monitor, minutes }) => {
      const id = monitor?.id || monitor?.data?.id;
      const item = this.store.data.monitors[id] || this.store.data.stateMonitors[id] || this.store.data.voltageMonitors[id];
      if (!item) throw new Error('Monitor not found.');
      const at = item.lastSample?.timestamp;
      return Number.isFinite(at) && (Date.now() - at) / 60000 <= Number(minutes);
    });
    condition('activity_not_run_for', async ({ monitor, hours }) => {
      const since = hoursSinceLastRun(this._cycleMonitor(monitor));
      return since !== null && since >= Number(hours);
    });
    condition('usage_unusual_hour', async ({ monitor, percent }) => {
      const share = hourShare(this._cycleMonitor(monitor), { timeZone: this._getTimezone() });
      return share !== null && share < Number(percent);
    });
    condition('state_group_has_mismatch', async ({ group }) => (await this._checkGroup(this._group(group))).mismatchCount > 0);
    condition('is_device_monitored', async ({ device }) => {
      const id = this._deviceId(device);
      return [this.store.data.monitors, this.store.data.voltageMonitors, this.store.data.stateMonitors]
        .some((collection) => Object.values(collection).some((m) => m.deviceId === id));
    });

    action('update_voltage_monitor', async ({ monitor, min_voltage, max_voltage }) => {
      await this.updateVoltageMonitorRange(this._voltageMonitor(monitor), { minVoltage: min_voltage, maxVoltage: max_voltage });
      return true;
    });
    // A monitor with no reading yet has null voltages, and Homey rejects a null number token ("Invalid Token").
    action('get_voltage_statistics', async ({ monitor, period }) => {
      const stats = this._voltageStatistics(this._voltageMonitor(monitor), period);
      return { ...stats, average_voltage: num(stats.average_voltage), min_voltage: num(stats.min_voltage), max_voltage: num(stats.max_voltage) };
    });
    // is_voltage_normal alone can't distinguish under- from over-voltage on the "not normal"
    // side — useful for a safety Flow that should react differently to each (e.g. only skip
    // running a motor on overvoltage, not undervoltage).
    condition('voltage_is_state', async ({ monitor, state }) => this._voltageMonitor(monitor).state === state);
    condition('voltage_phase_imbalance', async ({ monitor_a, monitor_b, percent }) => {
      const imbalance = voltageImbalancePercent(this._voltageMonitor(monitor_a).lastSample?.voltage, this._voltageMonitor(monitor_b).lastSample?.voltage);
      // Strictly greater, as the card says ("more than N %"): with >= a 0 % limit was true for two identical readings.
      return imbalance !== null && imbalance > Number(percent);
    });
    const imbalanceCard = this.homey.flow.getConditionCard('voltage_phase_imbalance');
    imbalanceCard.registerArgumentAutocompleteListener('monitor_a', async (query) => this._voltageMonitorResults(query));
    imbalanceCard.registerArgumentAutocompleteListener('monitor_b', async (query) => this._voltageMonitorResults(query));

    action('get_state_statistics', async ({ monitor, period }) => {
      const stats = this._stateStatistics(this._stateMonitor(monitor), period);
      return {
        ...stats, median_duration: num(stats.median_duration), median_duration_human: stats.median_duration_human || '',
        p25_duration: num(stats.p25_duration), p25_duration_human: stats.p25_duration_human || '', p75_duration: num(stats.p75_duration), p75_duration_human: stats.p75_duration_human || '',
        energy: num(stats.energy), average_power: num(stats.average_power), max_power: num(stats.max_power),
        average_current: num(stats.average_current), max_current: num(stats.max_current), trend_summary: this._trendSummaryFor(this._stateMonitor(monitor))
      };
    });


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

  _monitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._monitorResults(query)); },


  _voltageMonitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._voltageMonitorResults(query)); },

  _stateMonitorActionAutocomplete(cardId) { this.homey.flow.getActionCard(cardId).registerArgumentAutocompleteListener('monitor', async (query) => this._stateMonitorResults(query)); },


  // An Activity or State monitor from a card argument or an id: the two kinds that keep cycles.
  _cycleMonitor(arg) {
    const id = typeof arg === 'string' ? arg : (arg?.id || arg?.data?.id);
    const item = this.store.data.monitors[id] || this.store.data.stateMonitors[id];
    if (!item) throw new Error('Monitor not found.');
    return item;
  },

  _cycleMonitorResults(query) { return [...this._monitorResults(query), ...this._stateMonitorResults(query)]; },

  _monitor(arg) { const item = this.store.data.monitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('Monitor not found.'); return item; },

  _voltageMonitor(arg) { const item = this.store.data.voltageMonitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('Voltage monitor not found.'); return item; },

  _stateMonitor(arg) { const item = this.store.data.stateMonitors[arg?.id || arg?.data?.id]; if (!item) throw new Error('State monitor not found.'); return item; },

  // Homey keeps an autocomplete selection nested as {name, data:{id}} — it does not flatten
  // data onto the top level, confirmed against a real "Missing Parameter: id" runtime error.
  _deviceId(arg) { const id = arg?.id || arg?.data?.id; if (!id) throw new Error('Select a valid device.'); return id; }
};
