'use strict';

const { DEFAULT_ACTIVITY_THRESHOLD, OLD_DEFAULT_ACTIVITY_FINISHED, DEFAULT_ACTIVITY_MESSAGES } = require('./common');

// Each function below backfills whatever a monitor/group/counter saved by an older build of
// the app might be missing, so a fresh field added later never crashes on data saved before it
// existed. Split one per entity type (rather than one long loop body) so each can be read and
// tested — see test/store.test.js's "load() migrations" block — without having to load the
// whole store.
function migrateActivityMonitor(monitor) {
  if (monitor.messageTemplateFinished === OLD_DEFAULT_ACTIVITY_FINISHED) monitor.messageTemplateFinished = DEFAULT_ACTIVITY_MESSAGES.finished;
  monitor.capability ||= 'measure_power';
  monitor.auxiliaryCapabilities ||= [];
  monitor.cycles ||= [];
  monitor.periods ||= [];
  monitor.totals ||= { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 };
  monitor.continuityMinutes ??= 0;
  monitor.pendingStandbySince ??= null;
  monitor.minConfirmationSeconds ??= 0;
  monitor.pendingActiveSince ??= null;
  monitor.dailySummaries ||= [];
  monitor.messageTemplateStarted ||= '';
  monitor.messageTemplateFinished ||= '';
  // Migrates monitors saved by an earlier build of auto-calibration, where an omitted
  // threshold meant `null` (permanently inert until calibrated) instead of falling back to
  // DEFAULT_ACTIVITY_THRESHOLD right away.
  if (monitor.threshold == null) { monitor.threshold = DEFAULT_ACTIVITY_THRESHOLD; monitor.calibrating = true; }
  else monitor.calibrating ??= false;
}
function migrateStateMonitor(monitor) {
  monitor.mode = 'state';
  delete monitor.activeValue; // superseded by trueLabel/falseLabel — raw true is always ACTIVE now
  monitor.trueLabel ||= 'True';
  monitor.falseLabel ||= 'False';
  monitor.cycles ||= [];
  monitor.periods ||= [];
  monitor.totals ||= { cycleCount: 0, activeSeconds: 0, standbySeconds: 0 };
  monitor.totals.activeEnergy ??= 0;
  monitor.totals.standbyEnergy ??= 0;
  // Both opt-in, absent for every state monitor predating this — an enum capability's active
  // value(s) (e.g. "Running") and an auto-detected power capability to track real energy from,
  // alongside the reliable state signal instead of a threshold guess.
  monitor.auxiliaryCapabilities ||= [];
  monitor.activeValues ??= null;
  monitor.continuityMinutes ??= 0;
  monitor.pendingStandbySince ??= null;
  monitor.minConfirmationSeconds ??= 0;
  monitor.pendingActiveSince ??= null;
  monitor.dailySummaries ||= [];
  monitor.messageTemplateStarted ||= '';
  monitor.messageTemplateFinished ||= '';
}
// Options that shape every rendered message (see lib/message-template.js).
const { isSupported: isSupportedLanguage } = require('../wording');
function normalizeMessageSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    // '' means "follow the language Homey is set to"; anything else must be a language the wording files cover.
    messageLanguage: isSupportedLanguage(source.messageLanguage) ? source.messageLanguage : '',
    decimalComma: source.decimalComma === true || source.decimalComma === 'true'
  };
}
function migrateGroup(group) {
  group.conjunction ||= 'and';
  group.messageTemplateZero ||= '';
  group.messageTemplateOne ||= '';
  group.messageTemplateMany ||= '';
  group.dailySummaries ||= [];
  // Tracks whether the group was already mismatched as of the last poll, so
  // _pollGroups can fire group_mismatch_detected/group_matched_again on the
  // transition only, not on every single poll tick while it stays mismatched.
  group.mismatchSince ??= null;
}
function migrateVoltageMonitor(monitor) {
  monitor.capability ||= 'measure_voltage';
  monitor.events ||= [];
  monitor.periods ||= [];
  monitor.dailySummaries ||= [];
  monitor.auxiliaryCapabilities ||= [];
  monitor.messageTemplateUndervoltage ||= '';
  monitor.messageTemplateOvervoltage ||= '';
  monitor.messageTemplateNormalized ||= '';
  // Loaded from before the ongoing return-to-normal grace window existed — default to the same
  // 5 minutes a freshly created monitor gets, rather than 0 (instant close, the old
  // flapping-prone behavior).
  monitor.stabilizationMinutes ??= 5;
  monitor.pendingNormalSince ??= null;
}
function migrateAvailabilityWatchdog(watchdog) {
  watchdog.thresholdHours ??= 12;
  watchdog.wentUnavailableAt ??= null;
  watchdog.reason ??= null;
  watchdog.ignoreUnavailable ??= false;
  watchdog.unavailableSince ??= null;
  watchdog.zoneName ??= null;
  watchdog.battery ??= null;
  watchdog.lowBattery ??= false;
  watchdog.lowBatterySince ??= null;
  watchdog.missingCount ??= 0;
  watchdog.missing ??= false;
}

module.exports = { migrateActivityMonitor, migrateStateMonitor, migrateGroup, migrateVoltageMonitor, migrateAvailabilityWatchdog, normalizeMessageSettings };
