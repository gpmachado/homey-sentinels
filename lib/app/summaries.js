'use strict';

// Read-side summaries for Settings, widgets and Flow tokens: cached, built from the store only.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { ACTIVE } = require('../activity-engine');
const { NORMAL } = require('../voltage-engine');
const { statistics: computeStatistics, stateStatistics: computeStateStatistics, voltageStatistics: computeVoltageStatistics, dailyBreakdown: computeDailyBreakdown, standbyRanking: computeStandbyRanking, stateDailyBreakdown: computeStateDailyBreakdown, analyzeThreshold: computeAnalyzeThreshold, calibrationProgress: computeCalibrationProgress, generateTextReport: computeTextReport } = require('../statistics');
const { costOf, costText } = require('../cost');
const { usagePattern, describeUsagePattern } = require('../usage-pattern');
const { wordingFor } = require('../wording');
const { renderMessage } = require('../message-template');
const { watchdogsWidgetSummary, voltageWidgetSummary, healthWidgetSummary } = require('../widget-summaries');
const { groupStatistics: computeGroupStatistics, groupDailyBreakdown: computeGroupDailyBreakdown } = require('../groups');
const { SUMMARY_CACHE_MS, WIDGET_LIST_MAX, formatEnergy } = require('./constants');

module.exports = {
  // Cost of an amount of energy at the configured price (Settings -> Monitors -> Energy cost), as the four Flow
  // tokens the finished-cycle triggers carry. All zero / empty while no price is set, never undefined.
  _costTokens(energy, energyToday) {
    const { pricePerKwh, currency } = this.store.getMessageSettings();
    const cost = costOf(energy, pricePerKwh);
    const today = costOf(energyToday, pricePerKwh);
    return { cost, cost_today: today, cost_text: costText(cost, pricePerKwh, currency), cost_today_text: costText(today, pricePerKwh, currency) };
  },

  // What today's cost was right before a cycle finished. Priced from the energy itself and rounded once:
  // subtracting the two already-rounded costs (cost_today - cost) can land a cent off the real previous
  // total, which makes a threshold equal to that exact total look already crossed (or never crossed).
  _costBeforeCycle(energy, energyToday) {
    const { pricePerKwh } = this.store.getMessageSettings();
    return costOf(Math.max(0, energyToday - energy), pricePerKwh);
  },

  // Settings pages and widgets re-request the same summaries (every dashboard tile, every tab
  // switch), and each one re-filters every period of every monitor — garbage that lands on top of
  // the heap and the process footprint. A few seconds of reuse is invisible to the user; any save
  // (a config edit, or the debounced sample save) bumps store.revision and drops the entry, so an
  // edit is never shown stale.
  _cached(key, ttlMs, compute) {
    const now = Date.now();
    const hit = this._summaryCache.get(key);
    if (hit && hit.revision === this.store.revision && now - hit.at < ttlMs) return hit.value;
    const value = compute();
    this._summaryCache.set(key, { at: now, revision: this.store.revision, value });
    if (value && typeof value.catch === 'function') value.catch(() => this._summaryCache.delete(key));
    if (this._summaryCache.size > 64) this._summaryCache.delete(this._summaryCache.keys().next().value);
    return value;
  },

  // Dashboard widgets. Both are built from the store alone — no device list, no live device reads.
  getWatchdogsWidgetSummary() {
    return this._cached('widget:watchdogs', SUMMARY_CACHE_MS, () => {
      const found = this._availabilityScan;
      const scan = found ? { monitored: found.monitored, problems: found.problems, thresholdHours: this.store.getAvailabilitySettings().defaultThresholdHours } : null;
      return watchdogsWidgetSummary(Object.values(this.store.data.availabilityWatchdogs), Date.now(), scan);
    });
  },

  // The "Sentinels Health" widget: the state of the house in one card, from data already in memory.
  getHealthWidgetSummary() {
    return this._cached('widget:health', SUMMARY_CACHE_MS, () => healthWidgetSummary({
      scan: this._availabilityScan || null,
      watchdogs: Object.values(this.store.data.availabilityWatchdogs),
      activityMonitors: Object.values(this.store.data.monitors),
      voltageSummaries: this._computeVoltageMonitorsSummary('day'),
      groups: Object.values(this.store.data.groups)
    }));
  },

  getVoltageWidgetSummary() {
    return this._cached('widget:voltage', SUMMARY_CACHE_MS, () => voltageWidgetSummary(this._computeVoltageMonitorsSummary('day')));
  },

  // When an Activity or State monitor is used (by weekday and hour, worked out from its cycles), with the names and
  // the sentence in the Default message language. Backs the Get usage pattern card and the Pattern view in Settings.
  getUsagePattern(id, rawPeriod) {
    const monitor = this.store.data.monitors[id] || this.store.data.stateMonitors[id];
    if (!monitor) throw new Error('Monitor not found.');
    const period = ['week', 'month', 'all'].includes(rawPeriod) ? rawPeriod : 'month';
    const language = this._messageLanguage();
    const pattern = usagePattern(monitor, { timeZone: this._getTimezone(), period });
    return { id: monitor.id, name: monitor.name, ...describeUsagePattern(pattern, { name: monitor.name, language, wording: wordingFor(language).usagePatternMessages }) };
  },

  // Today in one go, for a morning notification: cycles and energy of the Activity monitors, the biggest user, the devices the
  // last availability scan flagged and the state groups with a mismatch now, with a sentence in the Default message language.
  getDailyDigest() {
    const monitors = Object.values(this.store.data.monitors).map((monitor) => ({ name: monitor.name, stats: this._statistics(monitor, 'day') }));
    const cycles = monitors.reduce((total, item) => total + item.stats.cycle_count, 0);
    const energy = monitors.reduce((total, item) => total + (item.stats.total_energy || 0), 0);
    const top = monitors.filter((item) => item.stats.total_energy > 0).sort((a, b) => b.stats.total_energy - a.stats.total_energy)[0];
    const { pricePerKwh, currency } = this.store.getMessageSettings();
    const priced = (kwh) => { const cost = costOf(kwh, pricePerKwh); return { cost, costText: costText(cost, pricePerKwh, currency) }; };
    const withCost = (kwh) => `${formatEnergy(kwh)}${priced(kwh).costText ? ` (${priced(kwh).costText})` : ''}`;
    const problems = this._availabilityScan ? this._availabilityScan.problems.length : 0;
    const groups = Object.values(this.store.data.groups).filter((group) => group.mismatchSince).length;
    const message = renderMessage(wordingFor(this._messageLanguage()).dailyDigestMessages.summary, {
      cycles, energy: withCost(energy), top: top ? `${top.name} (${withCost(top.stats.total_energy)})` : '-', problems, groups
    });
    return { cycles, energy, ...priced(energy), topName: top ? top.name : '', topEnergy: top ? top.stats.total_energy : 0, problems, groupsMismatch: groups, message };
  },

  // Standby energy by monitor (Activity and State), with what it costs at the price set in Settings.
  getStandbyRanking(rawPeriod) {
    const period = ['day', 'week', 'month', 'all'].includes(rawPeriod) ? rawPeriod : 'month';
    const items = [
      ...Object.values(this.store.data.monitors).map((monitor) => ({ id: monitor.id, name: monitor.name, kind: 'activity', monitor })),
      ...Object.values(this.store.data.stateMonitors).map((monitor) => ({ id: monitor.id, name: monitor.name, kind: 'state', monitor }))
    ];
    const ranking = computeStandbyRanking(items, period, this._getTimezone());
    const { pricePerKwh, currency } = this.store.getMessageSettings();
    const priced = (kwh) => ({ cost: costOf(kwh, pricePerKwh), costText: costText(costOf(kwh, pricePerKwh), pricePerKwh, currency) });
    return { period, totalStandbyEnergy: ranking.totalStandbyEnergy, ...priced(ranking.totalStandbyEnergy), rows: ranking.rows.map((row) => ({ ...row, ...priced(row.standbyEnergy) })) };
  },

  getMonitorsSummary(rawPeriod) { return this._cached(`monitors:${rawPeriod}`, SUMMARY_CACHE_MS, () => this._computeMonitorsSummary(rawPeriod)); },

  getStateMonitorsSummary(rawPeriod) { return this._cached(`state:${rawPeriod}`, SUMMARY_CACHE_MS, () => this._computeStateMonitorsSummary(rawPeriod)); },

  getVoltageMonitorsSummary(rawPeriod) { return this._cached(`voltage:${rawPeriod}`, SUMMARY_CACHE_MS, () => this._computeVoltageMonitorsSummary(rawPeriod)); },

  // Every monitor of one kind (or all kinds), as the same per-monitor summaries the single widgets use.
  // Capped so a dashboard widget can never fan out into hundreds of group checks.
  async getWidgetList(rawKind) {
    const collections = { activity: 'monitors', state: 'stateMonitors', voltage: 'voltageMonitors', group: 'groups' };
    const kinds = collections[rawKind] ? [rawKind] : Object.keys(collections);
    const ids = kinds.flatMap((kind) => Object.keys(this.store.data[collections[kind]] || {})).slice(0, WIDGET_LIST_MAX);
    return Promise.all(ids.map((id) => this.getWidgetSummary(id, 'day').catch(() => null)));
  },

  getWidgetSummary(rawId, rawPeriod) { return this._cached(`widget:${JSON.stringify(rawId)}:${rawPeriod}`, SUMMARY_CACHE_MS, () => this._computeWidgetSummary(rawId, rawPeriod)); },

  async _computeWidgetSummary(rawId, rawPeriod) {
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
      // Live status still comes from checking the devices right now, the same way the Check
      // state group Flow action does — but the period selector isn't wasted like before: the
      // accumulated mismatch-time estimate (from the same 5-min poll that now also drives the
      // live group triggers) fills in "how much of today/this week/this month was this group
      // mismatched", exactly like the other kinds' period stats.
      const result = await this._checkGroup(group);
      const stats = this._groupStatistics(group, period);
      return {
        kind: 'group', name: group.name, deviceName: `${group.devices.length} device(s)`,
        checkedCount: result.checkedCount, matchCount: result.matchCount, mismatchCount: result.mismatchCount,
        mismatchList: result.mismatchList, message: result.message,
        period, mismatchSeconds: stats.mismatch_seconds, mismatchDurationHuman: stats.mismatch_duration_human,
        dailyBreakdown: period === 'day' ? null : this._groupDailyBreakdown(group, period === 'week' ? 7 : 30)
      };
    }
    return null;
  },

  // Thin delegates over lib/statistics.js (pure functions, no `this`) — kept as same-named
  // methods so every internal call site and api.js's contract with app.js (getMonitorsSummary
  // etc. call these by name) are unaffected by the move. See lib/statistics.js for the actual
  // logic and its own now-isolated tests.
  _generateTextReport(rawId, rawPeriod) { return computeTextReport(rawId, rawPeriod, this.store.data, this._getTimezone()); },

  _voltageStatistics(monitor, period) { return computeVoltageStatistics(monitor, period, this._getTimezone()); },

  _statistics(monitor, period) { return computeStatistics(monitor, period, this._getTimezone()); },

  _stateStatistics(monitor, period) { return computeStateStatistics(monitor, period, this._getTimezone()); },

  _dailyBreakdown(monitor, days) { return computeDailyBreakdown(monitor, days, this._getTimezone()); },

  _stateDailyBreakdown(monitor, days) { return computeStateDailyBreakdown(monitor, days, this._getTimezone()); },


  _groupStatistics(group, period) { return computeGroupStatistics(group, period, this._getTimezone()); },

  _groupDailyBreakdown(group, days) { return computeGroupDailyBreakdown(group, days, this._getTimezone()); },

  // Backs the Settings page's Monitors tab — the same period/energy/daily-breakdown detail
  // the widget shows, but for every activity monitor at once in one table (no need to set up
  // a widget per device just to see this). Restored here after the lib/statistics.js
  // extraction accidentally dropped it along with the block it lived in — api.js's
  // getMonitorsSummary route calls this by name, so its disappearance broke the whole
  // Settings Monitors tab.
  _computeMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.monitors).map((monitor) => {
      const stats = this._statistics(monitor, period);
      // Sorts every raw power value of the monitor, so it runs once here and feeds both fields below.
      const analysis = computeAnalyzeThreshold(monitor);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, deviceMissing: Boolean(monitor.deviceMissing), state: monitor.state, threshold: monitor.threshold,
        continuityMinutes: monitor.continuityMinutes, minConfirmationSeconds: monitor.minConfirmationSeconds, mode: monitor.mode || null,
        rebuiltFromInsights: monitor.insightsBackfill ? { from: monitor.insightsBackfill.from, to: monitor.insightsBackfill.to, cycles: monitor.insightsBackfill.cycles } : null,
        period, cycleCount: stats.cycle_count, energy: stats.total_energy, averagePower: stats.average_power, energyQuality: stats.energy_quality,
        dailyBreakdown: period === 'day' ? null : this._dailyBreakdown(monitor, period === 'week' ? 7 : 30),
        messageTemplateStarted: monitor.messageTemplateStarted, messageTemplateFinished: monitor.messageTemplateFinished,
        calibrating: !!monitor.calibrating,
        suggestedThreshold: analysis.suggestion || null,
        calibrationProgress: monitor.calibrating ? computeCalibrationProgress(monitor, analysis) : null,
        hasCompletedCycles: (monitor.totals?.cycleCount || 0) > 0
      };
    });
  },

  // Same idea as getMonitorsSummary, for the state monitors table — trimmed to duration/count
  // fields by default, same as _stateStatistics, since energy/power don't mean anything for a
  // plain boolean capability. Included when the monitor has an auxiliary power capability.
  _computeStateMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.stateMonitors).map((monitor) => {
      const stats = this._stateStatistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, deviceMissing: Boolean(monitor.deviceMissing), deviceId: monitor.deviceId, capability: monitor.capability, state: monitor.state,
        trueLabel: monitor.trueLabel, falseLabel: monitor.falseLabel, activeValues: monitor.activeValues,
        period, cycleCount: stats.cycle_count, trueDuration: stats.true_duration, falseDuration: stats.false_duration,
        energy: stats.energy, averagePower: stats.average_power,
        dailyBreakdown: period === 'day' ? null : this._stateDailyBreakdown(monitor, period === 'week' ? 7 : 30),
        messageTemplateStarted: monitor.messageTemplateStarted, messageTemplateFinished: monitor.messageTemplateFinished
      };
    });
  },

  // Same idea as getMonitorsSummary, for the voltage monitors table.
  _computeVoltageMonitorsSummary(rawPeriod) {
    const period = ['day', 'week', 'month'].includes(rawPeriod) ? rawPeriod : 'day';
    return Object.values(this.store.data.voltageMonitors).map((monitor) => {
      const stats = this._voltageStatistics(monitor, period);
      return {
        id: monitor.id, name: monitor.name, deviceName: monitor.deviceName, deviceMissing: Boolean(monitor.deviceMissing), capability: monitor.capability, state: monitor.state,
        period, currentVoltage: monitor.lastSample?.voltage ?? null, minVoltage: stats.min_voltage, maxVoltage: stats.max_voltage,
        undervoltageCount: stats.undervoltage_count, overvoltageCount: stats.overvoltage_count,
        // minVoltage/maxVoltage above are the OBSERVED range for the period (from stats) — the
        // "range 218.5-221.3 V" the Settings row already shows. These two are the CONFIGURED
        // alert thresholds instead, needed by the Settings "Edit" form; same name collision
        // risk noted here so a future change doesn't reuse minVoltage/maxVoltage for this by
        // mistake.
        configuredMinVoltage: monitor.minVoltage, configuredMaxVoltage: monitor.maxVoltage, stabilizationMinutes: monitor.stabilizationMinutes,
        messageTemplateUndervoltage: monitor.messageTemplateUndervoltage, messageTemplateOvervoltage: monitor.messageTemplateOvervoltage, messageTemplateNormalized: monitor.messageTemplateNormalized
      };
    });
  }
};
