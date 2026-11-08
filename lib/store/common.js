'use strict';

// What the kinds of monitor share: their starting values, and how one is renamed or moved.
const { STANDBY } = require('../activity-engine');

// A monitor created without an explicit threshold starts here instead of sitting fully inert
// (never ACTIVE, zero detection) until auto-calibration eventually finds a confident value —
// idle draw is under this for most higher-load appliances (an oven, freezer, pump, dishwasher:
// a few watts to a few tens of watts standby vs hundreds+ active), so it already works
// reasonably from creation. _maybeAutoCalibrate in app.js still replaces it with a real
// calibrated value once enough history confirms one; `calibrating` tracks that this is still
// just the fallback, not a value gap-detection actually confirmed.
const DEFAULT_ACTIVITY_THRESHOLD = 40;

// A monitor works out of the box, without a trip to Settings first — these are just the
// starting value of messageTemplateStarted/Finished, edited there like anything else.
// Plain ASCII on purpose (see lib/text.js): a default containing an em dash is stored in every
// monitor, and one such character doubles the memory of every settings write.
const OLD_DEFAULT_ACTIVITY_FINISHED = '%monitor% turned off \u2014 %duration_human%, %energy% kWh (%count% today)';
const DEFAULT_ACTIVITY_MESSAGES = { started: '%monitor% turned on (%power% W)', finished: '%monitor% turned off - %duration_human%, %energy% kWh (%count% today)' };
const DEFAULT_STATE_MESSAGES = { started: '%monitor% is now %label%', finished: '%monitor% is now %label% (%count% today)' };
const DEFAULT_VOLTAGE_MESSAGES = {
  undervoltage: '%monitor% is in undervoltage - %voltage% V.',
  overvoltage: '%monitor% is in overvoltage - %voltage% V.',
  normalized: '%monitor% normalized after %duration_human% (min %min_voltage% V, max %max_voltage% V).'
};

// Rename and/or move a monitor (Activity, State or Voltage) to another device. Moving drops the live
// reading (it belonged to the old device), clears a "device missing" flag, and replaces the auxiliary
// capabilities with the new device's (an empty list when it has none, never the old device's leftovers).
// History, id and settings stay, which is the point: no delete-and-recreate.
function applyMonitorIdentity(monitor, { name, device, auxiliaryCapabilities } = {}) {
  if (name !== undefined && !name.trim()) throw new Error('Enter a name for the monitor.');
  if (name !== undefined) monitor.name = name.trim();
  if (device) {
    monitor.deviceId = device.id; monitor.deviceName = device.name; monitor.lastSample = null; monitor.deviceMissing = false;
    monitor.auxiliaryCapabilities = auxiliaryCapabilities || [];
  }
  return monitor;
}

// Wipes what an Activity or State monitor has recorded and keeps its configuration (device, capability,
// threshold, continuity/confirmation, name).
function clearActivityHistory(monitor) {
  monitor.cycles = [];
  monitor.periods = [];
  monitor.dailySummaries = [];
  delete monitor.insightsBackfill;
  monitor.totals = { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 };
  monitor.state = STANDBY;
  monitor.activeSince = null;
  monitor.pendingStandbySince = null;
  monitor.pendingActiveSince = null;
  monitor.lastSample = null;
  return monitor;
}

function assertGraceWindows(continuityMinutes, minConfirmationSeconds) {
  if (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0) throw new Error('The continuity window must be a number greater than or equal to zero.');
  if (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0) throw new Error('The minimum confirmation must be a number greater than or equal to zero.');
}

// `prefix-<time>-<random>`, the id of everything except a watchdog (keyed by its device).
const newId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

module.exports = {
  DEFAULT_ACTIVITY_THRESHOLD, OLD_DEFAULT_ACTIVITY_FINISHED, DEFAULT_ACTIVITY_MESSAGES, DEFAULT_STATE_MESSAGES, DEFAULT_VOLTAGE_MESSAGES,
  applyMonitorIdentity, clearActivityHistory, assertGraceWindows, newId
};
