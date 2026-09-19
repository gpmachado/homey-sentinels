'use strict';

// Voltage monitors at runtime: subscribing, sampling and reacting to under/overvoltage.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { humanDuration } = require('../activity-engine');
const { UNDERVOLTAGE, OVERVOLTAGE, stabilizationGraceSeconds } = require('../voltage-engine');
const { renderMessage } = require('../message-template');
const { num } = require('./constants');

module.exports = {
  async _watchVoltage(monitor) {
    await this.gateway.subscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, [], async (voltage, timestamp) => this._voltageSample(monitor, voltage, timestamp));
  },

  async _voltageSample(monitor, voltage, timestamp) {
    const events = this.voltageEngine.processSample(monitor, { voltage, timestamp });
    await this._handleVoltageEvents(monitor, events);
  },

  // A return-to-normal grace window (see voltage-engine.js's 'continuity_pending') needs a
  // real timer: if the voltage genuinely settles and simply stays there, no further capability
  // update will ever arrive to let processSample notice the window expired on its own — same
  // rationale as _resolveContinuity for activity monitors.
  async _resolveVoltageContinuity(monitor) {
    const events = this.voltageEngine.finalizePendingNormal(monitor, Date.now());
    await this._handleVoltageEvents(monitor, events);
  },

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
};
