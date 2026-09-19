'use strict';

const { STANDBY, ACTIVE } = require('./activity-engine');
const { NORMAL, VOLTAGE_BUCKET_MS } = require('./voltage-engine');
const { startOfLocalDay, localDateKey } = require('./time');
const { GROUP_TYPES } = require('./groups');
const { encodeRows, decodeRows } = require('./storage-format');
const { punctuationToAscii } = require('./text');

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
// Cycles feed the power/median/cycle-count stats for month and "all" (see statistics.js), so they
// outlive the 90-day period summaries — but not forever: each one is ~150 bytes in the one blob
// rewritten on every save, and a busy monitor adds dozens per day. totals.cycleCount stays
// lifetime, so the "all" cycle count doesn't regress when old cycles are dropped.
const CYCLE_RETENTION_DAYS = 365;
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
  monitor.messageTemplateUndervoltage ||= '';
  monitor.messageTemplateOvervoltage ||= '';
  monitor.messageTemplateNormalized ||= '';
  // Loaded from before the ongoing return-to-normal grace window existed — default to the same
  // 5 minutes a freshly created monitor gets, rather than 0 (instant close, the old
  // flapping-prone behavior).
  monitor.stabilizationMinutes ??= 5;
  monitor.pendingNormalSince ??= null;
}
function migrateBinaryCounter(counter) {
  counter.totalCount ||= 0;
  counter.dailyCounts ||= [];
  counter.lastEventAt ??= null;
  counter.messageTemplate ||= '';
}
function migrateAvailabilityWatchdog(watchdog) {
  watchdog.thresholdHours ??= 12;
  watchdog.wentUnavailableAt ??= null;
  watchdog.reason ??= null;
  watchdog.ignoreUnavailable ??= false;
}

// Merges adjacent same-state voltage periods that start within VOLTAGE_BUCKET_MS of the bucket's
// first period — the same rule VoltageEngine#processSample applies to new samples, applied to
// periods already stored under the older, finer bucket size so they shrink right away instead
// of only as they age out of the granular window. Periods in the legacy single-`voltage` shape
// (pre-bucketing) are left alone.
function compactVoltagePeriods(periods) {
  const merged = [];
  let current = null;
  for (const period of periods) {
    const bucketed = Number.isFinite(period.minVoltage) && Number.isFinite(period.maxVoltage) && Number.isFinite(period.voltageSum) && Number.isFinite(period.sampleCount);
    if (current && bucketed && current.bucketed && current.state === period.state && (period.startedAt - current.startedAt) < VOLTAGE_BUCKET_MS) {
      current.endedAt = Math.max(current.endedAt, period.endedAt);
      current.seconds += period.seconds;
      current.minVoltage = Math.min(current.minVoltage, period.minVoltage);
      current.maxVoltage = Math.max(current.maxVoltage, period.maxVoltage);
      current.voltageSum += period.voltageSum;
      current.sampleCount += period.sampleCount;
    } else {
      current = { ...period, bucketed };
      merged.push(current);
    }
  }
  return merged.map(({ bucketed, ...period }) => period);
}

// Persistence layout. ManagerSettings.set() re-serialises the ENTIRE settings object on every
// write of ANY key (measured on a Homey Pro 2023: a 1-byte write costs ~0 ms with no big key
// present, ~600 ms and +13 MB of heap churn with one 3.6 MB key present, ~1.5 s and +24 MB with
// two) — so splitting the store over several keys does not make a write cheaper, it only makes
// a save issue several of them. Everything therefore goes into ONE key per save, with the bulky
// series tuple-encoded (see storage-format.js), and nothing else large may live in settings.
// Older layouts are still read once and migrated (see load()).
const STATE_KEY = 'sentinels:v2'; // meta + series in one settings key (used when there is no history database)
const META_KEY_V3 = 'sentinels:v3'; // meta only; the series live in the history database
const SCHEMA_VERSION = 2;
const SCHEMA_VERSION_V3 = 3;
const V1_META_KEY = 'sentinels:meta'; // one meta key + one `sentinels:periods:<id>` key per monitor
const V1_PERIODS_KEY_PREFIX = 'sentinels:periods:';
const LEGACY_KEY = 'sentinels'; // the original single blob, full objects
// collection name -> [kind of period row, whether the monitors also keep cycles]
const SERIES_COLLECTIONS = {
  monitors: ['activityPeriod', true],
  stateMonitors: ['activityPeriod', true],
  voltageMonitors: ['voltagePeriod', false]
};

// Cheap change detector for a monitor's series, so an unchanged store isn't written at all. The
// engines extend the last period in place (endedAt/seconds/sampleCount) or append a new one, and
// consolidation shrinks the array from the front — every one of those shows up in this string.
function seriesSignature(monitor) {
  const periods = monitor.periods || [];
  const cycles = monitor.cycles || [];
  const first = periods[0];
  const last = periods[periods.length - 1];
  const lastCycle = cycles[cycles.length - 1];
  return [periods.length, first?.startedAt, last?.endedAt, last?.seconds, last?.sampleCount, cycles.length, lastCycle?.endedAt].join(':');
}

class SentinelStore {
  // `history` is an opened history database (lib/history-db.js) or null; without one the series are
  // kept in the settings key, exactly as before.
  constructor(settings, { history = null } = {}) {
    this.settings = settings; this.history = history; this.data = null; this._lastSaved = null; this._saving = Promise.resolve();
    this.migratedFrom = null; this.revision = 0; this._seriesState = new Map(); this._dbMonitors = new Set(); this.warnings = [];
  }
  async load() {
    const storedV3 = this.settings.get(META_KEY_V3);
    const storedV2 = this.settings.get(STATE_KEY);
    let stored = null; // a v2 payload: { meta, series }
    let legacyKeys = null;
    if (storedV3) {
      this.data = storedV3.meta;
      if (!this.history) {
        this.warnings.push('history database unavailable: the stored history could not be read and starts empty');
        this.migratedFrom = 'the history database (unavailable) to the settings key'; legacyKeys = 'v3';
      }
    } else if (storedV2) {
      stored = storedV2;
      this.data = storedV2.meta;
      if (this.history) { this.migratedFrom = 'the settings key to the history database'; legacyKeys = 'v2'; }
    } else {
      const v1Meta = this.settings.get(V1_META_KEY);
      if (v1Meta) { this.data = v1Meta; this.migratedFrom = 'per-monitor keys'; legacyKeys = 'v1'; }
      else {
        const legacy = this.settings.get(LEGACY_KEY);
        if (legacy) { this.data = legacy; this.migratedFrom = 'single blob'; legacyKeys = 'legacy'; }
      }
    }
    this.data ||= { monitors: {}, groups: {}, voltageMonitors: {} };
    this.data.voltageMonitors ||= {};
    this.data.binaryCounters ||= {};
    this.data.stateMonitors ||= {};
    this.data.eventLog = (this.data.eventLog || []).map((entry) => ({ ...entry, message: punctuationToAscii(entry.message) }));
    this.data.availabilityWatchdogs ||= {};
    if (storedV3 && this.history) this._attachSeriesFromDb();
    else if (stored) this._attachSeries((id) => stored.series?.[id]);
    else if (legacyKeys === 'v1') this._attachSeries((id) => this.settings.get(`${V1_PERIODS_KEY_PREFIX}${id}`));
    Object.values(this.data.monitors).forEach(migrateActivityMonitor);
    Object.values(this.data.stateMonitors).forEach(migrateStateMonitor);
    Object.values(this.data.groups).forEach(migrateGroup);
    Object.values(this.data.voltageMonitors).forEach(migrateVoltageMonitor);
    Object.values(this.data.binaryCounters).forEach(migrateBinaryCounter);
    Object.values(this.data.availabilityWatchdogs).forEach(migrateAvailabilityWatchdog);
    this._lastSaved = null;
    if (storedV3 && this.history) this._primeSeriesState();
    if (legacyKeys) {
      // Write the new layout first, drop the old keys only after that succeeded — a crash in
      // between just repeats the migration on the next start, never loses data.
      await this.save();
      this._removeOldLayouts();
    } else if (this.history) {
      this._removeOrphanSeriesRows();
      this._lastSaved = JSON.stringify(this._buildMeta());
    } else {
      this._lastSaved = this._fingerprint(this._buildPayload().metaJson);
    }
    return this.data;
  }
  _unset(key) { if (typeof this.settings.unset === 'function') this.settings.unset(key); }
  _removeOldLayouts() {
    this._unset(LEGACY_KEY);
    this._unset(V1_META_KEY);
    if (this.history) this._unset(STATE_KEY);
    else this._unset(META_KEY_V3);
    if (typeof this.settings.getKeys === 'function') {
      for (const key of this.settings.getKeys()) if (key.startsWith(V1_PERIODS_KEY_PREFIX)) this._unset(key);
    }
  }
  _forEachMonitor(callback) {
    for (const [collection, [kind, hasCycles]] of Object.entries(SERIES_COLLECTIONS)) {
      for (const [id, monitor] of Object.entries(this.data[collection] || {})) callback(monitor.id || id, monitor, kind, hasCycles);
    }
  }
  _attachSeries(seriesFor) {
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      const stored = seriesFor(id);
      monitor.periods = decodeRows(kind, stored?.periods);
      if (hasCycles) monitor.cycles = decodeRows('cycle', stored?.cycles);
    });
  }
  _attachSeriesFromDb() {
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      monitor.periods = decodeRows(kind, this.history.load(id, 'p'));
      if (hasCycles) monitor.cycles = decodeRows('cycle', this.history.load(id, 'c'));
    });
  }
  // What the database holds for each series right after a load, so the first save writes nothing.
  _primeSeriesState() {
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      this._dbMonitors.add(id);
      this._seriesState.set(`${id}:p`, this._stateOf(monitor.periods, kind));
      if (hasCycles) this._seriesState.set(`${id}:c`, this._stateOf(monitor.cycles, 'cycle'));
    });
  }
  _stateOf(rows, kind) {
    const list = rows || [];
    return { count: list.length, first: list.length ? list[0].startedAt : null, lastJson: list.length ? JSON.stringify(encodeRows(kind, [list[list.length - 1]])[0]) : null };
  }
  // Rows whose monitor no longer exists (deleted while the app was down, or an interrupted save).
  _removeOrphanSeriesRows() {
    const known = new Set();
    this._forEachMonitor((id) => known.add(id));
    const orphans = this.history.monitors().filter((id) => !known.has(id));
    if (orphans.length) this.history.transaction((db) => orphans.forEach((id) => db.dropMonitor(id)));
  }
  // Forces every series to be rewritten on the next save. Called after consolidation, which rewrites
  // rows in places the cheap change detection does not look at.
  invalidateSeries() { this._seriesState.clear(); }
  // Writes one series. The engines only extend the LAST row in place or append, so while the first
  // row is unchanged and the count did not shrink, rows before the last persisted one are untouched
  // and only from there on is written. Otherwise (first save, folding, compaction, reset) the series
  // is rewritten whole.
  _syncSeries(db, monitorId, tag, kind, rows, pending) {
    const list = rows || [];
    const key = `${monitorId}:${tag}`;
    const known = this._seriesState.get(key);
    const first = list.length ? list[0].startedAt : null;
    const incremental = known && known.count > 0 && list.length >= known.count && first === known.first;
    if (!known && list.length === 0) { pending.set(key, { count: 0, first: null, lastJson: null }); return; }
    let from = 0;
    if (incremental) {
      from = known.count - 1;
      const lastJson = JSON.stringify(encodeRows(kind, [list[from]])[0]);
      if (list.length === known.count && lastJson === known.lastJson) return; // nothing changed
    } else {
      db.clear(monitorId, tag);
    }
    const encoded = encodeRows(kind, from === 0 ? list : list.slice(from));
    encoded.forEach((row, i) => db.upsert(monitorId, tag, from + i, row));
    pending.set(key, { count: list.length, first, lastJson: list.length ? JSON.stringify(encoded[encoded.length - 1]) : null });
  }
  _buildMeta() {
    const withoutSeries = (collection) => Object.fromEntries(Object.entries(collection || {}).map(([id, monitor]) => {
      const { periods, cycles, ...rest } = monitor;
      return [id, rest];
    }));
    return { ...this.data, monitors: withoutSeries(this.data.monitors), stateMonitors: withoutSeries(this.data.stateMonitors), voltageMonitors: withoutSeries(this.data.voltageMonitors) };
  }
  // Size of the non-series part of the store, for diagnostics, and whether it holds any character
  // above U+00FF: one such character turns the WHOLE serialized settings string into two bytes per
  // character, doubling every write's memory (an em dash in a default message did exactly that).
  metaStats() {
    const json = JSON.stringify(this._buildMeta());
    return { kb: Math.round(json.length / 1024), twoByte: /[^\u0000-\u00ff]/.test(json) };
  }
  metaSizeKb() { return this.metaStats().kb; }
  _buildPayload() {
    const meta = this._buildMeta();
    const series = {};
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      series[id] = { periods: encodeRows(kind, monitor.periods) };
      if (hasCycles) series[id].cycles = encodeRows('cycle', monitor.cycles);
    });
    return { payload: { schemaVersion: SCHEMA_VERSION, meta, series }, metaJson: JSON.stringify(meta) };
  }
  // What identifies "nothing changed since the last write": the meta text plus each series' signature.
  _fingerprint(metaJson) {
    const parts = [metaJson];
    this._forEachMonitor((id, monitor) => parts.push(`${id}=${seriesSignature(monitor)}`));
    return parts.join('|');
  }
  // Saves run one at a time: two overlapping ones (the debounced sample save and an explicit
  // `await store.save()`) would otherwise interleave.
  save() {
    this.revision += 1; // lets callers drop anything they cached from the data as it was
    const run = this._saving.then(() => this._persist());
    this._saving = run.catch(() => {});
    return run;
  }
  async _persist() {
    if (this.history) return this._persistToDatabase();
    const { payload, metaJson } = this._buildPayload();
    const fingerprint = this._fingerprint(metaJson);
    if (fingerprint === this._lastSaved) return;
    await this.settings.set(STATE_KEY, payload);
    this._lastSaved = fingerprint;
  }
  // Series go to the database first (one transaction), then the small meta to settings, so meta never
  // points at series that were not written. The settings write is skipped when meta is unchanged.
  async _persistToDatabase() {
    const live = new Set();
    this._forEachMonitor((id) => live.add(id));
    const gone = [...this._dbMonitors].filter((id) => !live.has(id));
    // The remembered state of a series is only updated once the transaction has committed: after a
    // rollback the database still holds the old rows, and remembering the new ones would skip them.
    const pending = new Map();
    this.history.transaction((db) => {
      this._forEachMonitor((id, monitor, kind, hasCycles) => {
        this._syncSeries(db, id, 'p', kind, monitor.periods, pending);
        if (hasCycles) this._syncSeries(db, id, 'c', 'cycle', monitor.cycles, pending);
      });
      gone.forEach((id) => db.dropMonitor(id));
    });
    pending.forEach((state, key) => this._seriesState.set(key, state));
    gone.forEach((id) => { this._seriesState.delete(`${id}:p`); this._seriesState.delete(`${id}:c`); });
    this._dbMonitors = live;
    const meta = this._buildMeta();
    const metaJson = JSON.stringify(meta);
    if (metaJson === this._lastSaved) return;
    await this.settings.set(META_KEY_V3, { schemaVersion: SCHEMA_VERSION_V3, meta });
    this._lastSaved = metaJson;
  }
  // null means "no explicit value given" — createMonitor falls back to
  // DEFAULT_ACTIVITY_THRESHOLD and flags the monitor as still `calibrating` rather than
  // leaving it inert.
  static _parseThreshold(threshold) {
    if (threshold === undefined || threshold === null || threshold === '') return null;
    const value = Number(threshold);
    if (!Number.isFinite(value) || value < 0) throw new Error('The threshold must be a number greater than or equal to zero.');
    return value;
  }
  createMonitor({ device, threshold, name, capability = 'measure_power', auxiliaryCapabilities = [], continuityMinutes = 0, minConfirmationSeconds = 0 }) {
    if (!device?.id) throw new Error('Select a valid device.');
    const explicitThreshold = SentinelStore._parseThreshold(threshold);
    if (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0) throw new Error('The continuity window must be a number greater than or equal to zero.');
    if (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0) throw new Error('The minimum confirmation must be a number greater than or equal to zero.');
    if (Object.values(this.data.monitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a monitor for this capability.');
    const id = `monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, auxiliaryCapabilities,
      threshold: explicitThreshold ?? DEFAULT_ACTIVITY_THRESHOLD, calibrating: explicitThreshold === null,
      continuityMinutes: Number(continuityMinutes), minConfirmationSeconds: Number(minConfirmationSeconds),
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: DEFAULT_ACTIVITY_MESSAGES.started, messageTemplateFinished: DEFAULT_ACTIVITY_MESSAGES.finished
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
      // Omitting the threshold on an idempotent re-run must not blow away one the monitor
      // already learned (auto-calibration) or the user set by hand — only overwrite when a
      // value is actually given.
      if (threshold !== undefined && threshold !== null && threshold !== '') {
        existing.threshold = SentinelStore._parseThreshold(threshold);
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
    return { monitor: this.createMonitor({ device, threshold, name, capability, auxiliaryCapabilities, continuityMinutes, minConfirmationSeconds }), created: true };
  }
  // A "manual" monitor never decides ACTIVE/STANDBY on its own — see activity-engine.js's
  // stateFor(), which returns the monitor's current state unchanged for mode 'manual' instead
  // of comparing power against a threshold. Only startNow/stopNow (driven by the caller's own
  // Flow logic, e.g. a native "Power becomes greater than X" trigger) ever change its state.
  // It still tracks power/current/energy continuously via periods, same as a threshold
  // monitor — there's just no threshold to configure, since nothing here ever crosses one.
  // One card handles both "create if needed" and "start now" — for wiring a brand new
  // on/off-only device in a single native-trigger Flow, no separate creation step first.
  upsertManualMonitor({ device, capability = 'measure_power', auxiliaryCapabilities = [], name }) {
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
    const id = `monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const monitor = {
      // No continuity/confirmation window: those only matter when the engine itself decides a
      // transition from a threshold crossing (stateFor's default mode) — a 'manual' monitor
      // never does that (see stateFor()), and startNow/stopNow bypass grace windows anyway.
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, auxiliaryCapabilities, mode: 'manual',
      threshold: null, continuityMinutes: 0, minConfirmationSeconds: 0,
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: DEFAULT_ACTIVITY_MESSAGES.started, messageTemplateFinished: DEFAULT_ACTIVITY_MESSAGES.finished
    };
    this.data.monitors[id] = monitor;
    return { monitor, created: true };
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
  }
  updateMonitorMessages(monitor, { messageTemplateStarted, messageTemplateFinished } = {}) {
    if (messageTemplateStarted !== undefined) monitor.messageTemplateStarted = messageTemplateStarted;
    if (messageTemplateFinished !== undefined) monitor.messageTemplateFinished = messageTemplateFinished;
    return monitor;
  }
  // A state monitor is the same cycle/duration engine as an activity monitor, just driven by
  // a boolean or enum capability (a door, a presence sensor, an appliance's own state) instead
  // of a numeric threshold — see activity-engine.js's stateFor(). No 'threshold': ACTIVE/
  // STANDBY never comes from a number here. `activeValues` (null for a plain boolean
  // capability) lists which raw values of an enum capability count as active — e.g. an
  // appliance's own state exposing "Power Off"/"Running" instead of true/false.
  // `auxiliaryCapabilities` (auto-detected, like an activity monitor's) is optional real
  // power/energy/current tracking layered on top of that reliable state signal.
  createStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes = 0, minConfirmationSeconds = 0, activeValues = null, auxiliaryCapabilities = [] }) {
    if (!device?.id) throw new Error('Select a valid device.');
    if (!capability) throw new Error('Select a capability.');
    if (!Number.isFinite(Number(continuityMinutes)) || Number(continuityMinutes) < 0) throw new Error('The continuity window must be a number greater than or equal to zero.');
    if (!Number.isFinite(Number(minConfirmationSeconds)) || Number(minConfirmationSeconds) < 0) throw new Error('The minimum confirmation must be a number greater than or equal to zero.');
    if (Object.values(this.data.stateMonitors).some((item) => item.deviceId === device.id && item.capability === capability)) throw new Error('This device already has a state monitor for this capability.');
    const id = `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const monitor = {
      id, name: name?.trim() || device.name, deviceId: device.id, deviceName: device.name, capability, mode: 'state',
      trueLabel: trueLabel?.trim() || 'True', falseLabel: falseLabel?.trim() || 'False',
      activeValues: activeValues?.length ? activeValues : null, auxiliaryCapabilities,
      continuityMinutes: Number(continuityMinutes), minConfirmationSeconds: Number(minConfirmationSeconds),
      state: STANDBY, activeSince: null, pendingStandbySince: null, pendingActiveSince: null, lastSample: null,
      cycles: [], periods: [], totals: { cycleCount: 0, activeSeconds: 0, standbySeconds: 0, activeEnergy: 0, standbyEnergy: 0 },
      messageTemplateStarted: DEFAULT_STATE_MESSAGES.started, messageTemplateFinished: DEFAULT_STATE_MESSAGES.finished
    };
    this.data.stateMonitors[id] = monitor;
    return monitor;
  }
  // auxiliaryCapabilities is deliberately not revised here on a re-run — same as
  // upsertMonitor's activity-monitor equivalent, changing what a live monitor subscribes to
  // would need active re-subscription, not just a data update.
  upsertStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes, minConfirmationSeconds, activeValues, auxiliaryCapabilities }) {
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
    return { monitor: this.createStateMonitor({ device, capability, trueLabel, falseLabel, name, continuityMinutes, minConfirmationSeconds, activeValues, auxiliaryCapabilities }), created: true };
  }
  resetStateMonitor(monitor) {
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
      conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany, dailySummaries: [], mismatchSince: null
    };
    return this.data.groups[id];
  }
  updateGroup(group, { name, type, expectedState, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany } = {}) {
    // Validate before assigning anything so a bad name/type can't leave the group half-edited.
    if (name !== undefined && !name.trim()) throw new Error('Enter a name for the group.');
    if (type !== undefined && !GROUP_TYPES[type]) throw new Error('Unknown group type.');
    if (name !== undefined) group.name = name.trim();
    // api.js#updateGroup validates the group's devices against the new type before calling this.
    // mismatchSince and dailySummaries are per-type (capability + polarity), so a type change
    // starts them fresh instead of mixing the old type's history into the new one.
    if (type !== undefined && type !== group.type) { group.type = type; group.mismatchSince = null; group.dailySummaries = []; }
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
      // Reused on an ongoing basis, not just once at creation — see voltage-engine.js's
      // return-to-NORMAL grace window (stabilizedAt above only covers the very first reading).
      stabilizationMinutes: Number(stabilizationMinutes), pendingNormalSince: null,
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
    monitor.pendingNormalSince = null;
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
  // One watchdog per device — keyed by deviceId itself (not a synthetic id) since there's
  // nothing to disambiguate: a device either has a watchdog configured on it or it doesn't.
  // Polled, not subscribed (see app.js#_pollAvailabilityWatchdogs), same as groups — checking
  // available/lastSeenAt every few minutes is precise enough for an hours-scale threshold.
  // ignoreUnavailable: for a device that goes "unavailable" on purpose (an appliance switched off, a
  // cloud app that marks it offline) — only "hasn't reported for thresholdHours" counts, not the flag.
  upsertAvailabilityWatchdog({ deviceId, name, thresholdHours, ignoreUnavailable }) {
    if (!deviceId) throw new Error('Pick a device to watch.');
    const existing = this.data.availabilityWatchdogs[deviceId];
    if (existing) {
      if (Number.isFinite(thresholdHours)) existing.thresholdHours = thresholdHours;
      if (ignoreUnavailable !== undefined) existing.ignoreUnavailable = ignoreUnavailable === true || ignoreUnavailable === 'true';
      return existing;
    }
    const watchdog = {
      deviceId, name: name || deviceId,
      thresholdHours: Number.isFinite(thresholdHours) ? thresholdHours : 12,
      ignoreUnavailable: ignoreUnavailable === true || ignoreUnavailable === 'true',
      wentUnavailableAt: null, reason: null
    };
    this.data.availabilityWatchdogs[deviceId] = watchdog;
    return watchdog;
  }
  updateAvailabilityWatchdog(watchdog, { thresholdHours } = {}) {
    if (Number.isFinite(thresholdHours)) watchdog.thresholdHours = thresholdHours;
    return watchdog;
  }
  deleteAvailabilityWatchdog(deviceId) { delete this.data.availabilityWatchdogs[deviceId]; }
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
  // A group has no per-device subscription (see the class-level "no continuous history" note
  // in app.js) — this is fed by a periodic poll instead (app.js's _pollGroups), so
  // mismatchSeconds is an estimate (intervalSeconds credited whenever a poll finds a
  // mismatch), not an exact event-driven duration. Good enough for "how much of today did
  // this group spend out of the expected state," not precise enough for per-incident timing.
  recordGroupPoll(group, mismatchCount, intervalSeconds, timeZone) {
    const key = localDateKey(new Date(), timeZone);
    group.dailySummaries ||= [];
    let day = group.dailySummaries.find((d) => d.date === key);
    if (!day) { day = { date: key, mismatchSeconds: 0, checkCount: 0 }; group.dailySummaries.push(day); }
    day.checkCount += 1;
    if (mismatchCount > 0) day.mismatchSeconds += intervalSeconds;
    const cutoffKey = localDateKey(new Date(Date.now() - TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000), timeZone);
    group.dailySummaries = group.dailySummaries.filter((d) => d.date >= cutoffKey);
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
    this.invalidateSeries();
    const granularCutoff = now - GRANULAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const totalCutoffKey = localDateKey(new Date(now - TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000), timeZone);
    this._foldActivityLikeMonitors(this.data.monitors, granularCutoff, totalCutoffKey, timeZone);
    this._foldActivityLikeMonitors(this.data.stateMonitors, granularCutoff, totalCutoffKey, timeZone);
    const cycleCutoff = now - CYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const monitor of [...Object.values(this.data.monitors), ...Object.values(this.data.stateMonitors)]) {
      if (monitor.cycles?.length && monitor.cycles[0].endedAt < cycleCutoff) monitor.cycles = monitor.cycles.filter((cycle) => cycle.endedAt >= cycleCutoff);
    }
    // Same retention shape as activity monitors, but simpler: a voltage sample is a single
    // point-in-time reading (no duration/energy to prorate across a midnight it might span),
    // so folding it just needs the min/max observed per calendar day — no per-sample average
    // tracking, which would otherwise mean carrying a sum+count pair for the life of the app.
    for (const monitor of Object.values(this.data.voltageMonitors)) {
      monitor.dailySummaries ||= [];
      if (monitor.periods?.length) monitor.periods = compactVoltagePeriods(monitor.periods);
      // minVoltage/maxVoltage per period (see VoltageEngine#processSample's bucketing) — falls
      // back to the older single-`voltage`-per-period shape for anything still stored that way.
      const toFold = (monitor.periods || []).filter((period) => period.endedAt < granularCutoff && (Number.isFinite(period.minVoltage) || Number.isFinite(period.voltage)));
      if (toFold.length) {
        const byDay = {};
        for (const period of toFold) {
          const key = localDateKey(new Date(period.startedAt), timeZone);
          const periodMin = period.minVoltage ?? period.voltage;
          const periodMax = period.maxVoltage ?? period.voltage;
          byDay[key] ||= { date: key, minVoltage: periodMin, maxVoltage: periodMax };
          byDay[key].minVoltage = Math.min(byDay[key].minVoltage, periodMin);
          byDay[key].maxVoltage = Math.max(byDay[key].maxVoltage, periodMax);
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
module.exports.CYCLE_RETENTION_DAYS = CYCLE_RETENTION_DAYS;
module.exports.compactVoltagePeriods = compactVoltagePeriods;
module.exports.migrateActivityMonitor = migrateActivityMonitor;
module.exports.migrateStateMonitor = migrateStateMonitor;
module.exports.migrateGroup = migrateGroup;
module.exports.migrateVoltageMonitor = migrateVoltageMonitor;
module.exports.migrateBinaryCounter = migrateBinaryCounter;
module.exports.migrateAvailabilityWatchdog = migrateAvailabilityWatchdog;
