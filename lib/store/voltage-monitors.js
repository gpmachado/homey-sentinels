'use strict';

// Voltage monitors in the store. Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { NORMAL } = require('../voltage-engine');
const { DEFAULT_VOLTAGE_MESSAGES, applyMonitorIdentity, newId } = require('./common');

module.exports = {
  createVoltageMonitor({
    device, capability = 'measure_voltage', minVoltage, maxVoltage, name, stabilizationMinutes = 5, auxiliaryCapabilities = [],
    messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized
  }) {
    if (!device?.id) throw new Error('Select a valid device.');
    if (!Number.isFinite(Number(minVoltage)) || !Number.isFinite(Number(maxVoltage)) || Number(minVoltage) >= Number(maxVoltage)) throw new Error('The minimum must be less than the maximum.');
    if (Object.values(this.data.voltageMonitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a voltage monitor for this capability.');
    const id = newId('voltage');
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability,
      minVoltage: Number(minVoltage), maxVoltage: Number(maxVoltage),
      stabilizedAt: Date.now() + Number(stabilizationMinutes) * 60 * 1000,
      // Reused on an ongoing basis, not just once at creation — see voltage-engine.js's
      // return-to-NORMAL grace window (stabilizedAt above only covers the very first reading).
      stabilizationMinutes: Number(stabilizationMinutes), pendingNormalSince: null,
      // Same auxiliary-capability idea as Activity/State monitors (see AUXILIARY_CAPABILITY_CANDIDATES):
      // auto-detected from the device, not user-picked, so a voltage monitor on a combined
      // energy meter can also expose %power%/%energy% in its own messages.
      auxiliaryCapabilities,
      state: NORMAL, eventSince: null, eventType: null, lastSample: null, events: [], periods: [],
      messageTemplateUndervoltage: messageTemplateUndervoltage ?? DEFAULT_VOLTAGE_MESSAGES.undervoltage,
      messageTemplateOvervoltage: messageTemplateOvervoltage ?? DEFAULT_VOLTAGE_MESSAGES.overvoltage,
      messageTemplateNormalized: messageTemplateNormalized ?? DEFAULT_VOLTAGE_MESSAGES.normalized
    };
    this.data.voltageMonitors[id] = monitor;
    return monitor;
  },
  // Same upsert rationale as upsertMonitor above.
  upsertVoltageMonitor({
    device, capability = 'measure_voltage', minVoltage, maxVoltage, name, stabilizationMinutes, auxiliaryCapabilities,
    messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized
  }) {
    const existing = Object.values(this.data.voltageMonitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      this.updateVoltageMonitor(existing, { minVoltage, maxVoltage, stabilizationMinutes });
      if (name?.trim()) existing.name = name.trim();
      if (auxiliaryCapabilities !== undefined) existing.auxiliaryCapabilities = auxiliaryCapabilities;
      return { monitor: existing, created: false };
    }
    return {
      monitor: this.createVoltageMonitor({
        device, capability, minVoltage, maxVoltage, name, stabilizationMinutes: stabilizationMinutes ?? 5, auxiliaryCapabilities,
        messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized
      }),
      created: true
    };
  },
  updateVoltageMonitor(monitor, { minVoltage, maxVoltage, stabilizationMinutes, messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized } = {}) {
    const nextMin = minVoltage !== undefined ? Number(minVoltage) : monitor.minVoltage;
    const nextMax = maxVoltage !== undefined ? Number(maxVoltage) : monitor.maxVoltage;
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMin >= nextMax) throw new Error('The minimum must be less than the maximum.');
    if (stabilizationMinutes !== undefined && (!Number.isFinite(Number(stabilizationMinutes)) || Number(stabilizationMinutes) < 0)) throw new Error('The stabilization window must be a number greater than or equal to zero.');
    monitor.minVoltage = nextMin;
    monitor.maxVoltage = nextMax;
    // Only restart the stabilization window when its length actually changed — the Settings form
    // resends the current value on every edit, and restarting it would mute real alerts (and the
    // immediate re-check) for that long after an unrelated range tweak.
    if (stabilizationMinutes !== undefined && Number(stabilizationMinutes) !== monitor.stabilizationMinutes) {
      monitor.stabilizedAt = Date.now() + Number(stabilizationMinutes) * 60 * 1000;
      monitor.stabilizationMinutes = Number(stabilizationMinutes);
    }
    if (messageTemplateUndervoltage !== undefined) monitor.messageTemplateUndervoltage = messageTemplateUndervoltage;
    if (messageTemplateOvervoltage !== undefined) monitor.messageTemplateOvervoltage = messageTemplateOvervoltage;
    if (messageTemplateNormalized !== undefined) monitor.messageTemplateNormalized = messageTemplateNormalized;
    return monitor;
  },
  updateVoltageMonitorIdentity(monitor, changes = {}) { return applyMonitorIdentity(monitor, changes); },
  deleteVoltageMonitor(id) { delete this.data.voltageMonitors[id]; },
  // Same rationale as resetMonitor above. Clearing lastSample also re-arms the engine's
  // own "first-ever reading only establishes the reference" suppression (isFirstSample in
  // voltage-engine.js), so the first sample after a reset can't itself false-fire an alert —
  // no need to separately re-arm the stabilization window.
  resetVoltageMonitor(monitor) {
    monitor.periods = [];
    monitor.dailySummaries = [];
    monitor.events = [];
    monitor.state = NORMAL;
    monitor.eventSince = null;
    monitor.eventType = null;
    monitor.lastSample = null;
    monitor.pendingNormalSince = null;
    return monitor;
  },
};
