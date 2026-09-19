'use strict';

// State monitors at runtime: subscribing, sampling and reacting to state changes.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { ACTIVE, standbyGraceSeconds } = require('../activity-engine');
const { renderMessage } = require('../message-template');
const { num } = require('./constants');

module.exports = {
  // Same engine, same cycle/duration/grace-window machinery as _watch/_sample above — a state
  // monitor decides ACTIVE/STANDBY from its own reliable signal (a boolean, or specific
  // activeValues on an enum) instead of comparing a numeric power sample against a threshold
  // (see activity-engine.js's stateFor()). auxiliaryCapabilities (empty for a plain door/motion
  // sensor) optionally layers real power/energy/current tracking on top of that signal.
  async _watchState(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, monitor.auxiliaryCapabilities || [], async (value, timestamp, device) => this._sampleState(monitor, value, timestamp, device));
  },

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
  },

  async _resolveStateContinuity(monitor) {
    const events = this.engine.finalizePendingStandby(monitor, Date.now());
    await this._handleStateEvents(monitor, events);
  },

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
};
