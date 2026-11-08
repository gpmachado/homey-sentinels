'use strict';

// Activity monitors in the store. Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { STANDBY } = require('../activity-engine');
const { DEFAULT_ACTIVITY_THRESHOLD, DEFAULT_ACTIVITY_MESSAGES, applyMonitorIdentity, clearActivityHistory, assertGraceWindows, newId } = require('./common');

// null means "no explicit value given" — createMonitor falls back to
// DEFAULT_ACTIVITY_THRESHOLD and flags the monitor as still `calibrating` rather than
// leaving it inert.
function parseThreshold(threshold) {
  if (threshold === undefined || threshold === null || threshold === '') return null;
  const value = Number(threshold);
  if (!Number.isFinite(value) || value < 0) throw new Error('The threshold must be a number greater than or equal to zero.');
  return value;
}

module.exports = {
  createMonitor({ device, threshold, name, capability = 'measure_power', auxiliaryCapabilities = [], continuityMinutes = 0, minConfirmationSeconds = 0, messageTemplateStarted, messageTemplateFinished }) {
    if (!device?.id) throw new Error('Select a valid device.');
    const explicitThreshold = parseThreshold(threshold);
    assertGraceWindows(continuityMinutes, minConfirmationSeconds);
    if (Object.values(this.data.monitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a monitor for this capability.');
    const id = newId('monitor');
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, auxiliaryCapabilities,
      threshold: explicitThreshold ?? DEFAULT_ACTIVITY_THRESHOLD, calibrating: explicitThreshold === null,
      continuityMinutes: Number(continuityMinutes), minConfirmationSeconds: Number(minConfirmationSeconds),
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: messageTemplateStarted ?? DEFAULT_ACTIVITY_MESSAGES.started, messageTemplateFinished: messageTemplateFinished ?? DEFAULT_ACTIVITY_MESSAGES.finished
    };
    this.data.monitors[id] = monitor;
    return monitor;
  },
  // Upsert instead of throwing on a duplicate device+capability: a Flow wired to a native
  // threshold trigger (e.g. "Power becomes greater than 50W") can legitimately re-run this
  // action, and a reboot/re-deploy can re-fire a "Homey started" setup Flow — neither should
  // need a guard condition in front of the action just to avoid an error.
  upsertMonitor({ device, threshold, name, capability = 'measure_power', auxiliaryCapabilities = [], continuityMinutes, minConfirmationSeconds, messageTemplateStarted, messageTemplateFinished }) {
    const existing = Object.values(this.data.monitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      // Omitting the threshold on an idempotent re-run must not blow away one the monitor
      // already learned (auto-calibration) or the user set by hand — only overwrite when a
      // value is actually given.
      if (threshold !== undefined && threshold !== null && threshold !== '') {
        existing.threshold = parseThreshold(threshold);
        existing.calibrating = false;
      }
      // Symmetric with upsertManualMonitor's adoption below — a monitor previously put into
      // 'manual' mode by "Start monitoring device" must go back to normal threshold dispatch,
      // otherwise stateFor() would keep ignoring the threshold just set above.
      delete existing.mode;
      if (name?.trim()) existing.name = name.trim();
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
    return { monitor: this.createMonitor({ device, threshold, name, capability, auxiliaryCapabilities, continuityMinutes, minConfirmationSeconds, messageTemplateStarted, messageTemplateFinished }), created: true };
  },
  // A "manual" monitor never decides ACTIVE/STANDBY on its own — see activity-engine.js's
  // stateFor(), which returns the monitor's current state unchanged for mode 'manual' instead
  // of comparing power against a threshold. Only startNow/stopNow (driven by the caller's own
  // Flow logic, e.g. a native "Power becomes greater than X" trigger) ever change its state.
  // It still tracks power/current/energy continuously via periods, same as a threshold
  // monitor — there's just no threshold to configure, since nothing here ever crosses one.
  // One card handles both "create if needed" and "start now" — for wiring a brand new
  // on/off-only device in a single native-trigger Flow, no separate creation step first.
  upsertManualMonitor({ device, capability = 'measure_power', auxiliaryCapabilities = [], name, messageTemplateStarted, messageTemplateFinished }) {
    if (!device?.id) throw new Error('Select a valid device.');
    const existing = Object.values(this.data.monitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      if (name?.trim()) existing.name = name.trim();
      // Adopting a monitor that was originally created via "Add activity monitor" (threshold
      // mode) — force it fully into 'manual' mode, otherwise it keeps its old threshold and
      // stateFor() would still try to auto-transition it from power readings, fighting with
      // this card's own startNow/stopNow calls (confirmed live: adopted monitor's mode never
      // flipped, so it was invisible to any 'manual'-only lookup, e.g. Stop's own picker).
      existing.mode = 'manual';
      existing.threshold = null;
      return { monitor: existing, created: false };
    }
    const id = newId('monitor');
    const monitor = {
      // No continuity/confirmation window: those only matter when the engine itself decides a
      // transition from a threshold crossing (stateFor's default mode) — a 'manual' monitor
      // never does that (see stateFor()), and startNow/stopNow bypass grace windows anyway.
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, auxiliaryCapabilities, mode: 'manual',
      threshold: null, continuityMinutes: 0, minConfirmationSeconds: 0,
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: messageTemplateStarted ?? DEFAULT_ACTIVITY_MESSAGES.started, messageTemplateFinished: messageTemplateFinished ?? DEFAULT_ACTIVITY_MESSAGES.finished
    };
    this.data.monitors[id] = monitor;
    return { monitor, created: true };
  },
  // Wipes accumulated data (cycles, periods, history, live state) while keeping the
  // monitor's own configuration (device, capability, threshold, continuity/confirmation,
  // name) — for when the data itself was wrong (e.g. a misconfigured capability recorded
  // garbage before being fixed) but the monitor setup, once corrected, is right. Clearing
  // lastSample also matters beyond just history: it's what processSample compares the next
  // reading against, so leaving stale data there would corrupt the very first period after
  // reset too.
  resetMonitor(monitor) { return clearActivityHistory(monitor); },
  // Validates every provided field before assigning any, so one bad value can't leave the live
  // monitor half-edited. An undefined/'' field is left unchanged (Settings can edit just the
  // continuity/confirmation windows without re-typing the threshold).
  updateMonitorSettings(monitor, { threshold, continuityMinutes, minConfirmationSeconds } = {}) {
    const provided = (value) => value !== undefined && value !== '';
    if (provided(threshold) && (!Number.isFinite(Number(threshold)) || Number(threshold) < 0)) throw new Error('The threshold must be greater than or equal to zero.');
    if (provided(continuityMinutes) && (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0)) throw new Error('The continuity window must be greater than or equal to zero.');
    if (provided(minConfirmationSeconds) && (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0)) throw new Error('The minimum confirmation must be greater than or equal to zero.');
    if (provided(threshold)) { monitor.threshold = Number(threshold); monitor.calibrating = false; }
    if (provided(continuityMinutes)) monitor.continuityMinutes = Number(continuityMinutes);
    if (provided(minConfirmationSeconds)) monitor.minConfirmationSeconds = Number(minConfirmationSeconds);
    return monitor;
  },
  updateMonitorIdentity(monitor, changes = {}) { return applyMonitorIdentity(monitor, changes); },
  updateMonitorMessages(monitor, { messageTemplateStarted, messageTemplateFinished } = {}) {
    if (messageTemplateStarted !== undefined) monitor.messageTemplateStarted = messageTemplateStarted;
    if (messageTemplateFinished !== undefined) monitor.messageTemplateFinished = messageTemplateFinished;
    return monitor;
  },
};
