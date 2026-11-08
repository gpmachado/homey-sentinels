'use strict';

// State monitors in the store. Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { STANDBY } = require('../activity-engine');
const { DEFAULT_STATE_MESSAGES, applyMonitorIdentity, clearActivityHistory, assertGraceWindows, newId } = require('./common');

module.exports = {
  // A state monitor is the same cycle/duration engine as an activity monitor, just driven by
  // a boolean or enum capability (a door, a presence sensor, an appliance's own state) instead
  // of a numeric threshold — see activity-engine.js's stateFor(). No 'threshold': ACTIVE/
  // STANDBY never comes from a number here. `activeValues` (null for a plain boolean
  // capability) lists which raw values of an enum capability count as active — e.g. an
  // appliance's own state exposing "Power Off"/"Running" instead of true/false.
  // `auxiliaryCapabilities` (auto-detected, like an activity monitor's) is optional real
  // power/energy/current tracking layered on top of that reliable state signal.
  createStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes = 0, minConfirmationSeconds = 0, activeValues = null, auxiliaryCapabilities = [], messageTemplateStarted, messageTemplateFinished }) {
    if (!device?.id) throw new Error('Select a valid device.');
    if (!capability) throw new Error('Select a capability.');
    assertGraceWindows(continuityMinutes, minConfirmationSeconds);
    if (Object.values(this.data.stateMonitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a state monitor for this capability.');
    const id = newId('state');
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, mode: 'state',
      trueLabel: trueLabel?.trim() || 'True', falseLabel: falseLabel?.trim() || 'False',
      activeValues: activeValues?.length ? activeValues : null, auxiliaryCapabilities,
      continuityMinutes: Number(continuityMinutes), minConfirmationSeconds: Number(minConfirmationSeconds),
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: messageTemplateStarted ?? DEFAULT_STATE_MESSAGES.started, messageTemplateFinished: messageTemplateFinished ?? DEFAULT_STATE_MESSAGES.finished
    };
    this.data.stateMonitors[id] = monitor;
    return monitor;
  },
  // auxiliaryCapabilities is deliberately not revised here on a re-run — same as
  // upsertMonitor's activity-monitor equivalent, changing what a live monitor subscribes to
  // would need active re-subscription, not just a data update.
  upsertStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes, minConfirmationSeconds, activeValues, auxiliaryCapabilities, messageTemplateStarted, messageTemplateFinished }) {
    const existing = Object.values(this.data.stateMonitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      if (trueLabel?.trim()) existing.trueLabel = trueLabel.trim();
      if (falseLabel?.trim()) existing.falseLabel = falseLabel.trim();
      if (name?.trim()) existing.name = name.trim();
      if (activeValues !== undefined) existing.activeValues = activeValues?.length ? activeValues : null;
      if (continuityMinutes !== undefined) {
        if (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0) throw new Error('The continuity window must be a number greater than or equal to zero.');
        existing.continuityMinutes = Number(continuityMinutes);
      }
      if (minConfirmationSeconds !== undefined) {
        if (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0) throw new Error('The minimum confirmation must be a number greater than or equal to zero.');
        existing.minConfirmationSeconds = Number(minConfirmationSeconds);
      }
      return { monitor: existing, created: false };
    }
    return { monitor: this.createStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes, minConfirmationSeconds, activeValues, auxiliaryCapabilities, messageTemplateStarted, messageTemplateFinished }), created: true };
  },
  resetStateMonitor(monitor) { return clearActivityHistory(monitor); },
  // Edits an existing state monitor in place — no device lookup, so it works while the device is
  // offline or removed. A cleared label falls back to the creation default; activeValues only
  // applies to a multi-state monitor (a plain boolean one has none) and can't be emptied.
  updateStateMonitor(monitor, { trueLabel, falseLabel, activeValues } = {}) {
    let nextActiveValues;
    if (activeValues !== undefined && monitor.activeValues) {
      nextActiveValues = (Array.isArray(activeValues) ? activeValues : String(activeValues || '').split(',')).map((v) => String(v).trim()).filter(Boolean);
      if (!nextActiveValues.length) throw new Error('This capability has multiple states — specify which value(s) count as active (e.g. "Running, Rinse").');
    }
    if (trueLabel !== undefined) monitor.trueLabel = trueLabel?.trim() || 'True';
    if (falseLabel !== undefined) monitor.falseLabel = falseLabel?.trim() || 'False';
    if (nextActiveValues) monitor.activeValues = nextActiveValues;
    return monitor;
  },
  updateStateMonitorIdentity(monitor, changes = {}) { return applyMonitorIdentity(monitor, changes); },
  updateStateMonitorMessages(monitor, { messageTemplateStarted, messageTemplateFinished } = {}) {
    if (messageTemplateStarted !== undefined) monitor.messageTemplateStarted = messageTemplateStarted;
    if (messageTemplateFinished !== undefined) monitor.messageTemplateFinished = messageTemplateFinished;
    return monitor;
  },
};
