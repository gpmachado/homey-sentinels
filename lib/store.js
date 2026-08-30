'use strict';

const { STANDBY, ACTIVE } = require('./activity-engine');
const { NORMAL } = require('./voltage-engine');
const { startOfLocalDay, localDateKey } = require('./time');

// The local-midnight boundary a period is folded on is only ever a few hours after its own
// start (activity-engine discards any gap over 4h instead of recording a period for it), so
// a period spans at most one midnight — but crediting it whole to its start day would still
// misattribute a real chunk of an overnight standby/active period. Splits it at each local
// midnight it crosses and prorates seconds/energy by the time-fraction in each day.
function splitPeriodByLocalDay(period, timeZone) {
  const { startedAt, endedAt, seconds, energy } = period;
  const totalSeconds = seconds || Math.max(0, (endedAt - startedAt) / 1000);
  if (!(totalSeconds > 0)) return [{ date: localDateKey(new Date(startedAt), timeZone), seconds: 0, energy: 0 }];
  const segments = [];
  let cursor = startedAt;
  while (cursor < endedAt) {
    const nextMidnight = startOfLocalDay(new Date(cursor + 24 * 60 * 60 * 1000), timeZone).getTime();
    const segmentEnd = Math.min(endedAt, nextMidnight);
    const segmentSeconds = (segmentEnd - cursor) / 1000;
    segments.push({ date: localDateKey(new Date(cursor), timeZone), seconds: segmentSeconds, energy: (energy || 0) * (segmentSeconds / totalSeconds) });
    cursor = segmentEnd;
  }
  return segments;
}

// Time-Machine-style retention, not Home-Assistant-style indefinite raw history: full
// per-sample detail for the last week (never needed further back — "week" statistics are
// always a 7-day rolling window), condensed into one daily summary per calendar day beyond
// that, dropped entirely past 90 days. cycles[] (one entry per activity session, already
// compact) is never pruned — it's what keeps cycle_count and power/current stats exact for
// "month"/"all" queries regardless of how much period detail behind them has been condensed.
const GRANULAR_RETENTION_DAYS = 7;
const TOTAL_RETENTION_DAYS = 90;

class SentinelStore {
  constructor(settings) { this.settings = settings; this.data = null; }
  async load() {
    this.data = this.settings.get('sentinels') || { monitors: {}, groups: {}, voltageMonitors: {} };
    this.data.voltageMonitors ||= {};
    this.data.binaryCounters ||= {};
    this.data.stateMonitors ||= {};
    for (const monitor of Object.values(this.data.monitors)) {
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
    }
    for (const monitor of Object.values(this.data.stateMonitors)) {
      monitor.mode = 'state';
      delete monitor.activeValue; // superseded by trueLabel/falseLabel — raw true is always ACTIVE now
      monitor.trueLabel ||= 'True';
      monitor.falseLabel ||= 'False';
      monitor.cycles ||= [];
      monitor.periods ||= [];
      monitor.totals ||= { cycleCount: 0, activeSeconds: 0, standbySeconds: 0 };
      monitor.continuityMinutes ??= 0;
      monitor.pendingStandbySince ??= null;
      monitor.minConfirmationSeconds ??= 0;
      monitor.pendingActiveSince ??= null;
      monitor.dailySummaries ||= [];
      monitor.messageTemplateStarted ||= '';
      monitor.messageTemplateFinished ||= '';
    }
    for (const group of Object.values(this.data.groups)) {
      group.conjunction ||= 'and';
      group.messageTemplateZero ||= '';
      group.messageTemplateOne ||= '';
      group.messageTemplateMany ||= '';
    }
    for (const monitor of Object.values(this.data.voltageMonitors)) {
      monitor.capability ||= 'measure_voltage';
      monitor.events ||= [];
      monitor.periods ||= [];
      monitor.dailySummaries ||= [];
      monitor.messageTemplateUndervoltage ||= '';
      monitor.messageTemplateOvervoltage ||= '';
      monitor.messageTemplateNormalized ||= '';
    }
    for (const counter of Object.values(this.data.binaryCounters)) {
      counter.totalCount ||= 0;
      counter.dailyCounts ||= [];
      counter.lastEventAt ??= null;
      counter.messageTemplate ||= '';
    }
    return this.data;
  }
  async save() { await this.settings.set('sentinels', this.data); }
  createMonitor({ device, threshold, name, capability = 'measure_power', auxiliaryCapabilities = [], continuityMinutes = 0, minConfirmationSeconds = 0 }) {
    if (!device?.id) throw new Error('Select a valid device.');
    if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0) throw new Error('The threshold must be a number greater than or equal to zero.');
    if (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0) throw new Error('The continuity window must be a number greater than or equal to zero.');
    if (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0) throw new Error('The minimum confirmation must be a number greater than or equal to zero.');
    if (Object.values(this.data.monitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a monitor for this capability.');
    const id = `monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, auxiliaryCapabilities,
      threshold: Number(threshold), continuityMinutes: Number(continuityMinutes), minConfirmationSeconds: Number(minConfirmationSeconds),
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: '', messageTemplateFinished: ''
    };
    this.data.monitors[id] = monitor;
    return monitor;
  }
  // Upsert instead of throwing on a duplicate device+capability: a Flow wired to a native
  // threshold trigger (e.g. "Power becomes greater than 50W") can legitimately re-run this
  // action, and a reboot/re-deploy can re-fire a "Homey started" setup Flow — neither should
  // need a guard condition in front of the action just to avoid an error.
  upsertMonitor({ device, threshold, name, capability = 'measure_power', auxiliaryCapabilities = [], continuityMinutes, minConfirmationSeconds }) {
    const existing = Object.values(this.data.monitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0) throw new Error('The threshold must be a number greater than or equal to zero.');
      existing.threshold = Number(threshold);
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
    return { monitor: this.createMonitor({ device, threshold, name, capability, auxiliaryCapabilities, continuityMinutes, minConfirmationSeconds }), created: true };
  }
  // Wipes accumulated data (cycles, periods, history, live state) while keeping the
  // monitor's own configuration (device, capability, threshold, continuity/confirmation,
  // name) — for when the data itself was wrong (e.g. a misconfigured capability recorded
  // garbage before being fixed) but the monitor setup, once corrected, is right. Clearing
  // lastSample also matters beyond just history: it's what processSample compares the next
  // reading against, so leaving stale data there would corrupt the very first period after
  // reset too.
  resetMonitor(monitor) {
    monitor.cycles = [];
    monitor.periods = [];
    monitor.dailySummaries = [];
    monitor.totals = { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 };
    monitor.state = STANDBY;
    monitor.activeSince = null;
    monitor.pendingStandbySince = null;
    monitor.pendingActiveSince = null;
    monitor.lastSample = null;
    return monitor;
  }
  updateMonitorMessages(monitor, { messageTemplateStarted, messageTemplateFinished } = {}) {
    if (messageTemplateStarted !== undefined) monitor.messageTemplateStarted = messageTemplateStarted;
    if (messageTemplateFinished !== undefined) monitor.messageTemplateFinished = messageTemplateFinished;
    return monitor;
  }
  // A state monitor is the same cycle/duration engine as an activity monitor, just driven by
  // a boolean capability (a door, a presence sensor) instead of a numeric threshold — see
  // activity-engine.js's stateFor(). No 'threshold', no auxiliary current/energy tracking:
  // those don't mean anything for "open" or "closed".
  createStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes = 0, minConfirmationSeconds = 0 }) {
    if (!device?.id) throw new Error('Select a valid device.');
    if (!capability) throw new Error('Select a capability.');
    if (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0) throw new Error('The continuity window must be a number greater than or equal to zero.');
    if (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0) throw new Error('The minimum confirmation must be a number greater than or equal to zero.');
    if (Object.values(this.data.stateMonitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a state monitor for this capability.');
    const id = `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, mode: 'state',
      trueLabel: trueLabel?.trim() || 'True', falseLabel: falseLabel?.trim() || 'False',
      continuityMinutes: Number(continuityMinutes), minConfirmationSeconds: Number(minConfirmationSeconds),
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0 },
      messageTemplateStarted: '', messageTemplateFinished: ''
    };
    this.data.stateMonitors[id] = monitor;
    return monitor;
  }
  upsertStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes, minConfirmationSeconds }) {
    const existing = Object.values(this.data.stateMonitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      if (trueLabel?.trim()) existing.trueLabel = trueLabel.trim();
      if (falseLabel?.trim()) existing.falseLabel = falseLabel.trim();
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
    return { monitor: this.createStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes, minConfirmationSeconds }), created: true };
  }
  resetStateMonitor(monitor) {
    monitor.cycles = [];
    monitor.periods = [];
    monitor.dailySummaries = [];
    monitor.totals = { cycleCount: 0, activeSeconds: 0, standbySeconds: 0 };
    monitor.state = STANDBY;
    monitor.activeSince = null;
    monitor.pendingStandbySince = null;
    monitor.pendingActiveSince = null;
    monitor.lastSample = null;
    return monitor;
  }
  updateStateMonitorMessages(monitor, { messageTemplateStarted, messageTemplateFinished } = {}) {
    if (messageTemplateStarted !== undefined) monitor.messageTemplateStarted = messageTemplateStarted;
    if (messageTemplateFinished !== undefined) monitor.messageTemplateFinished = messageTemplateFinished;
    return monitor;
  }
  createGroup({ name, type, expectedState, devices = [], conjunction = 'and', messageTemplateZero = '', messageTemplateOne = '', messageTemplateMany = '' }) {
    if (!name?.trim()) throw new Error('Enter a name for the group.');
    const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.data.groups[id] = {
      id, name: name.trim(), type, expectedState: expectedState === true || expectedState === 'true',
      devices: devices.map(({ id: deviceId, name: deviceName }) => ({ id: deviceId, name: deviceName })),
      conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany
    };
    return this.data.groups[id];
  }
  updateGroup(group, { name, expectedState, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany } = {}) {
    if (name !== undefined) { if (!name.trim()) throw new Error('Enter a name for the group.'); group.name = name.trim(); }
    if (expectedState !== undefined) group.expectedState = expectedState === true || expectedState === 'true';
    if (conjunction !== undefined) group.conjunction = conjunction;
    if (messageTemplateZero !== undefined) group.messageTemplateZero = messageTemplateZero;
    if (messageTemplateOne !== undefined) group.messageTemplateOne = messageTemplateOne;
    if (messageTemplateMany !== undefined) group.messageTemplateMany = messageTemplateMany;
    return group;
  }
  setGroupDevices(group, devices) { group.devices = devices.map(({ id, name }) => ({ id, name })); return group; }
  deleteGroup(id) { delete this.data.groups[id]; }
  createVoltageMonitor({ device, capability = 'measure_voltage', minVoltage, maxVoltage, name, stabilizationMinutes = 5 }) {
    if (!device?.id) throw new Error('Select a valid device.');
    if (!Number.isFinite(Number(minVoltage)) || !Number.isFinite(Number(maxVoltage)) || Number(minVoltage) >= Number(maxVoltage)) throw new Error('The minimum must be less than the maximum.');
    if (Object.values(this.data.voltageMonitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a voltage monitor for this capability.');
    const id = `voltage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability,
      minVoltage: Number(minVoltage), maxVoltage: Number(maxVoltage),
      stabilizedAt: Date.now() + Number(stabilizationMinutes) * 60 * 1000,
      state: NORMAL, eventSince: null, eventType: null, lastSample: null, events: [], periods: [],
      messageTemplateUndervoltage: '', messageTemplateOvervoltage: '', messageTemplateNormalized: ''
    };
    this.data.voltageMonitors[id] = monitor;
    return monitor;
  }
  // Same upsert rationale as upsertMonitor above.
  upsertVoltageMonitor({ device, capability = 'measure_voltage', minVoltage, maxVoltage, name, stabilizationMinutes }) {
    const existing = Object.values(this.data.voltageMonitors).find((item) => item.deviceId === device.id && item.capability === capability);
    if (existing) {
      this.updateVoltageMonitor(existing, { minVoltage, maxVoltage, stabilizationMinutes });
      if (name?.trim()) existing.name = name.trim();
      return { monitor: existing, created: false };
    }
    return { monitor: this.createVoltageMonitor({ device, capability, minVoltage, maxVoltage, name, stabilizationMinutes: stabilizationMinutes ?? 5 }), created: true };
  }
  updateVoltageMonitor(monitor, { minVoltage, maxVoltage, stabilizationMinutes, messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized } = {}) {
    const nextMin = minVoltage !== undefined ? Number(minVoltage) : monitor.minVoltage;
    const nextMax = maxVoltage !== undefined ? Number(maxVoltage) : monitor.maxVoltage;
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMin >= nextMax) throw new Error('The minimum must be less than the maximum.');
    monitor.minVoltage = nextMin;
    monitor.maxVoltage = nextMax;
    if (stabilizationMinutes !== undefined) {
      if (!Number.isFinite(Number(stabilizationMinutes)) || Number(stabilizationMinutes) < 0) throw new Error('The stabilization window must be a number greater than or equal to zero.');
      monitor.stabilizedAt = Date.now() + Number(stabilizationMinutes) * 60 * 1000;
    }
    if (messageTemplateUndervoltage !== undefined) monitor.messageTemplateUndervoltage = messageTemplateUndervoltage;
    if (messageTemplateOvervoltage !== undefined) monitor.messageTemplateOvervoltage = messageTemplateOvervoltage;
    if (messageTemplateNormalized !== undefined) monitor.messageTemplateNormalized = messageTemplateNormalized;
    return monitor;
  }
  deleteVoltageMonitor(id) { delete this.data.voltageMonitors[id]; }
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
    return monitor;
  }
  // Binary counters are deliberately lighter than activity/voltage monitors: a fire-and-
  // forget occurrence (doorbell press, single motion pulse) has no device/capability
  // subscription of its own — the user's own Flow (already triggered by whatever sensor
  // event) calls "Log binary event" to tally it. No engine/state machine needed, just a
  // running total plus one count per calendar day.
  createBinaryCounter({ name }) {
    if (!name?.trim()) throw new Error('Enter a name for the counter.');
    const id = `binary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const counter = { id, name: name.trim(), totalCount: 0, dailyCounts: [], lastEventAt: null, messageTemplate: '' };
    this.data.binaryCounters[id] = counter;
    return counter;
  }
  // Matched by name (there's no device+capability to dedupe on) — same upsert rationale as
  // the other monitor types: re-running "Add binary counter" for a name that already exists
  // (e.g. a setup Flow re-firing after a restart) returns the existing counter instead of
  // erroring or creating a duplicate.
  upsertBinaryCounter({ name }) {
    const trimmed = name?.trim();
    const existing = trimmed && Object.values(this.data.binaryCounters).find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return { counter: existing, created: false };
    return { counter: this.createBinaryCounter({ name }), created: true };
  }
  updateBinaryCounter(counter, { messageTemplate } = {}) {
    if (messageTemplate !== undefined) counter.messageTemplate = messageTemplate;
    return counter;
  }
  deleteBinaryCounter(id) { delete this.data.binaryCounters[id]; }
  resetBinaryCounter(counter) {
    counter.totalCount = 0;
    counter.dailyCounts = [];
    counter.lastEventAt = null;
    return counter;
  }
  // The only "engine" logic this family needs: bump today's bucket (creating it if this is
  // the first event today) and the all-time total. dailyCounts stays at most
  // TOTAL_RETENTION_DAYS entries — one per calendar day, never one per event — so unlike
  // activity/voltage periods there's no separate granular-vs-folded consolidation pass to run.
  recordBinaryEvent(counter, timestamp, timeZone) {
    const key = localDateKey(new Date(timestamp), timeZone);
    let day = counter.dailyCounts.find((d) => d.date === key);
    if (!day) { day = { date: key, count: 0 }; counter.dailyCounts.push(day); }
    day.count += 1;
    counter.totalCount += 1;
    counter.lastEventAt = timestamp;
    const cutoffKey = localDateKey(new Date(timestamp - TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000), timeZone);
    counter.dailyCounts = counter.dailyCounts.filter((d) => d.date >= cutoffKey);
    return day.count;
  }
  // Folds periods older than GRANULAR_RETENTION_DAYS into one dailySummaries[] entry per
  // calendar day (in `timeZone`), then drops the now-redundant raw periods and anything in
  // dailySummaries past TOTAL_RETENTION_DAYS. Meant to run occasionally (once at startup, then
  // every few hours) — not on every sample, since it's a bulk pass over the whole array.
  // Shared by activity monitors and state monitors — both fold periods the same way (they're
  // the same engine, see activity-engine.js's stateFor()). A state monitor's periods just
  // never carry a meaningful energy value, so activeEnergy/standbyEnergy end up 0 for it,
  // same as if energy had genuinely been zero the whole time — harmless, and simpler than
  // maintaining a second fold shape for one missing field.
  _foldActivityLikeMonitors(monitors, granularCutoff, totalCutoffKey, timeZone) {
    for (const monitor of Object.values(monitors)) {
      monitor.dailySummaries ||= [];
      const toFold = (monitor.periods || []).filter((period) => period.endedAt < granularCutoff);
      if (toFold.length) {
        const byDay = {};
        for (const period of toFold) {
          for (const segment of splitPeriodByLocalDay(period, timeZone)) {
            byDay[segment.date] ||= { date: segment.date, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0, meterResetCount: 0 };
            const bucket = byDay[segment.date];
            if (period.state === ACTIVE) { bucket.activeSeconds += segment.seconds; bucket.activeEnergy += segment.energy; }
            else { bucket.standbySeconds += segment.seconds; bucket.standbyEnergy += segment.energy; }
            // A reset is a property of the whole period, not something to prorate across a
            // midnight split — tag every day the period touches, same as the old app's
            // "credit the whole gap/reset to each day it spans" approach.
            if (period.meterReset) bucket.meterResetCount += 1;
          }
        }
        for (const key of Object.keys(byDay)) {
          const existing = monitor.dailySummaries.find((day) => day.date === key);
          if (existing) {
            existing.activeSeconds += byDay[key].activeSeconds; existing.standbySeconds += byDay[key].standbySeconds;
            existing.activeEnergy += byDay[key].activeEnergy; existing.standbyEnergy += byDay[key].standbyEnergy;
            existing.meterResetCount = (existing.meterResetCount || 0) + byDay[key].meterResetCount;
          } else {
            monitor.dailySummaries.push(byDay[key]);
          }
        }
        monitor.periods = (monitor.periods || []).filter((period) => period.endedAt >= granularCutoff);
      }
      monitor.dailySummaries = monitor.dailySummaries.filter((day) => day.date >= totalCutoffKey);
    }
  }
  consolidateHistory(timeZone, now = Date.now()) {
    const granularCutoff = now - GRANULAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const totalCutoffKey = localDateKey(new Date(now - TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000), timeZone);
    this._foldActivityLikeMonitors(this.data.monitors, granularCutoff, totalCutoffKey, timeZone);
    this._foldActivityLikeMonitors(this.data.stateMonitors, granularCutoff, totalCutoffKey, timeZone);
    // Same retention shape as activity monitors, but simpler: a voltage sample is a single
    // point-in-time reading (no duration/energy to prorate across a midnight it might span),
    // so folding it just needs the min/max observed per calendar day — no per-sample average
    // tracking, which would otherwise mean carrying a sum+count pair for the life of the app.
    for (const monitor of Object.values(this.data.voltageMonitors)) {
      monitor.dailySummaries ||= [];
      const toFold = (monitor.periods || []).filter((period) => period.endedAt < granularCutoff && Number.isFinite(period.voltage));
      if (toFold.length) {
        const byDay = {};
        for (const period of toFold) {
          const key = localDateKey(new Date(period.startedAt), timeZone);
          byDay[key] ||= { date: key, minVoltage: period.voltage, maxVoltage: period.voltage };
          byDay[key].minVoltage = Math.min(byDay[key].minVoltage, period.voltage);
          byDay[key].maxVoltage = Math.max(byDay[key].maxVoltage, period.voltage);
        }
        for (const key of Object.keys(byDay)) {
          const existing = monitor.dailySummaries.find((day) => day.date === key);
          if (existing) {
            existing.minVoltage = Math.min(existing.minVoltage, byDay[key].minVoltage);
            existing.maxVoltage = Math.max(existing.maxVoltage, byDay[key].maxVoltage);
          } else {
            monitor.dailySummaries.push(byDay[key]);
          }
        }
        monitor.periods = (monitor.periods || []).filter((period) => period.endedAt >= granularCutoff);
      }
      monitor.dailySummaries = monitor.dailySummaries.filter((day) => day.date >= totalCutoffKey);
    }
  }
}

module.exports = SentinelStore;
module.exports.GRANULAR_RETENTION_DAYS = GRANULAR_RETENTION_DAYS;
module.exports.TOTAL_RETENTION_DAYS = TOTAL_RETENTION_DAYS;
