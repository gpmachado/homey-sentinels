'use strict';

// Voltage monitors at runtime: subscribing, sampling and reacting to under/overvoltage.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { humanDuration } = require('../activity-engine');
const { UNDERVOLTAGE, OVERVOLTAGE, stabilizationGraceSeconds } = require('../voltage-engine');
const { renderMessage } = require('../message-template');
const { num } = require('./constants');

const { localTimeText } = require('../time');

module.exports = {
  async _watchVoltage(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, monitor.auxiliaryCapabilities || [], async (voltage, timestamp, device) => this._voltageSample(monitor, voltage, timestamp, device));
  },

  async _voltageSample(monitor, voltage, timestamp, device) {
    const events = this.voltageEngine.processSample(monitor, { voltage, timestamp });
    // Only present when this monitor's device also exposes a power/energy capability (see
    // AUXILIARY_CAPABILITY_CANDIDATES) — a combined energy meter's voltage monitor can then use
    // %power%/%energy% in its own messages, same idea as Activity's %power%/%energy%.
    const power = device?.capabilitiesObj?.measure_power?.value;
    const energy = device?.capabilitiesObj?.meter_power?.value;
    await this._handleVoltageEvents(monitor, events, { power, energy });
  },

  // A return-to-normal grace window (see voltage-engine.js's 'continuity_pending') needs a
  // real timer: if the voltage genuinely settles and simply stays there, no further capability
  // update will ever arrive to let processSample notice the window expired on its own — same
  // rationale as _resolveContinuity for activity monitors.
  async _resolveVoltageContinuity(monitor) {
    const events = this.voltageEngine.finalizePendingNormal(monitor, Date.now());
    await this._handleVoltageEvents(monitor, events);
  },

  async _handleVoltageEvents(monitor, events, sample = {}) {
    this._scheduleSave();
    // Left undefined (not defaulted to 0 like num() would) when the device has no power/energy
    // capability, so %power%/%energy% render as an empty string instead of a misleading "0".
    const power = Number.isFinite(sample.power) ? sample.power : undefined;
    const energy = Number.isFinite(sample.energy) ? sample.energy : undefined;
    for (const event of events) {
      if (event.type === 'continuity_pending') {
        this.homey.setTimeout(() => this._resolveVoltageContinuity(monitor).catch((error) => this.error('Failed to resolve voltage continuity window', monitor.name, error)), stabilizationGraceSeconds(monitor) * 1000);
        continue;
      }
      const base = { device: monitor.deviceName, monitor: monitor.name, voltage: event.voltage, power, energy, timestamp: new Date(event.timestamp).toISOString(), time: localTimeText(event.timestamp, this._getTimezone()) };
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
};
