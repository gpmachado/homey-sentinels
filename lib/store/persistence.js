'use strict';

// Loading and saving: Homey settings for the small part, the history database for the series.
// Methods are mixed into SentinelStore's prototype (see lib/store.js), so `this` is the store.
const { encodeRows, decodeRows } = require('../storage-format');
const { punctuationToAscii } = require('../text');
const { normalizeAvailabilitySettings } = require('../availability');
const { migrateActivityMonitor, migrateStateMonitor, migrateGroup, migrateVoltageMonitor, migrateAvailabilityWatchdog, normalizeMessageSettings } = require('./migrations');

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

module.exports = {
  async load() {
    const storedV3 = this.settings.get(META_KEY_V3);
    const storedV2 = this.settings.get(STATE_KEY);
    let stored = null; // a v2 payload: { meta, series }
    let legacyKeys = null;
    if (storedV3) {
      this.data = storedV3.meta;
      // The database did not open this time (a lock, a permission, a firmware without node:sqlite). Its rows are still
      // on disk, so nothing is migrated or dropped: the meta keeps being saved under the v3 key, the history of this
      // run stays in memory, and the next start with a working database finds everything it had.
      if (!this.history) {
        this.historyUnavailable = true;
        this.warnings.push('history database unavailable: history is kept in memory until the app restarts with a working database; the stored history is untouched');
      }
    } else if (storedV2) {
      stored = storedV2;
      this.data = storedV2.meta;
      if (this.history) { this.migratedFrom = 'the settings key to the history database'; legacyKeys = 'v2'; }
    }
    this.data ||= { monitors: {}, groups: {}, voltageMonitors: {} };
    this.data.voltageMonitors ||= {};
    // Binary counters were removed; whatever an older version saved is dropped here and disappears at the next save.
    delete this.data.binaryCounters;
    this.data.stateMonitors ||= {};
    this.data.eventLog = (this.data.eventLog || []).map((entry) => ({ ...entry, message: punctuationToAscii(entry.message) }));
    this.data.availabilityWatchdogs ||= {};
    // Ids come from URLs and Flow arguments: without a prototype, "__proto__" is an ordinary missing key
    // instead of Object.prototype (which an update route would then have changed for every object).
    for (const key of ['monitors', 'stateMonitors', 'voltageMonitors', 'groups', 'availabilityWatchdogs']) this.data[key] = Object.assign(Object.create(null), this.data[key]);
    this.data.availabilitySettings = normalizeAvailabilitySettings(this.data.availabilitySettings);
    this.data.messageSettings = normalizeMessageSettings(this.data.messageSettings);
    this.data.logSettings = { verbose: this.data.logSettings?.verbose === true };
    this.data.availabilityScan ||= { state: {}, baselined: false, at: null };
    this.data.availabilityExclusions ||= { devices: {}, zones: {}, apps: {}, appHours: {} };
    this.data.availabilityExclusions.devices ||= {};
    this.data.availabilityExclusions.zones ||= {};
    this.data.availabilityExclusions.apps ||= {};
    this.data.availabilityExclusions.appHours ||= {};
    if (storedV3 && this.history) this._attachSeriesFromDb();
    else if (stored) this._attachSeries((id) => stored.series?.[id]);
    Object.values(this.data.monitors).forEach(migrateActivityMonitor);
    Object.values(this.data.stateMonitors).forEach(migrateStateMonitor);
    Object.values(this.data.groups).forEach(migrateGroup);
    Object.values(this.data.voltageMonitors).forEach(migrateVoltageMonitor);
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
    } else if (this.historyUnavailable) {
      this._lastSaved = JSON.stringify(this._buildMeta());
    } else {
      this._lastSaved = this._fingerprint(this._buildPayload().metaJson);
    }
    return this.data;
  },
  _unset(key) { if (typeof this.settings.unset === 'function') this.settings.unset(key); },
  // Only ever v2 -> database: a v3 store is never moved back to the settings key (see load()).
  _removeOldLayouts() { this._unset(STATE_KEY); },
  _forEachMonitor(callback) {
    for (const [collection, [kind, hasCycles]] of Object.entries(SERIES_COLLECTIONS)) {
      for (const [id, monitor] of Object.entries(this.data[collection] || {})) callback(monitor.id || id, monitor, kind, hasCycles);
    }
  },
  _attachSeries(seriesFor) {
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      const stored = seriesFor(id);
      monitor.periods = decodeRows(kind, stored?.periods);
      if (hasCycles) monitor.cycles = decodeRows('cycle', stored?.cycles);
    });
  },
  _attachSeriesFromDb() {
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      monitor.periods = decodeRows(kind, this.history.load(id, 'p'));
      if (hasCycles) monitor.cycles = decodeRows('cycle', this.history.load(id, 'c'));
    });
  },
  // What the database holds for each series right after a load, so the first save writes nothing.
  _primeSeriesState() {
    // A series that had unreadable rows is left unknown, so the next save rewrites it whole without them.
    const usable = (id, tag) => !this.history.isDamaged?.(id, tag);
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      this._dbMonitors.add(id);
      if (usable(id, 'p')) this._seriesState.set(`${id}:p`, this._stateOf(monitor.periods, kind));
      if (hasCycles && usable(id, 'c')) this._seriesState.set(`${id}:c`, this._stateOf(monitor.cycles, 'cycle'));
    });
  },
  _stateOf(rows, kind) {
    const list = rows || [];
    return { count: list.length, first: list.length ? list[0].startedAt : null, lastJson: list.length ? JSON.stringify(encodeRows(kind, [list[list.length - 1]])[0]) : null };
  },
  // Rows whose monitor no longer exists (deleted while the app was down, or an interrupted save).
  _removeOrphanSeriesRows() {
    const known = new Set();
    this._forEachMonitor((id) => known.add(id));
    const orphans = this.history.monitors().filter((id) => !known.has(id));
    if (orphans.length) this.history.transaction((db) => orphans.forEach((id) => db.dropMonitor(id)));
  },
  // Forces the series of these monitors (all of them without `ids`) to be rewritten on the next save. Called
  // after consolidation and an Insights rebuild, which change rows in places the cheap change detection does not look at.
  invalidateSeries(ids) {
    if (!ids) { this._seriesState.clear(); return; }
    for (const id of ids) { this._seriesState.delete(`${id}:p`); this._seriesState.delete(`${id}:c`); }
  },
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
    // An empty series is cleared once (it may hold rows the load could not read) and then left alone: clearing it on
    // every save was a write each time for every monitor without cycles.
    if (list.length === 0) {
      if (!known || known.count > 0) db.clear(monitorId, tag);
      pending.set(key, { count: 0, first: null, lastJson: null });
      return;
    }
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
  },
  _buildMeta() {
    const withoutSeries = (collection) => Object.fromEntries(Object.entries(collection || {}).map(([id, monitor]) => {
      const { periods, cycles, ...rest } = monitor;
      return [id, rest];
    }));
    return { ...this.data, monitors: withoutSeries(this.data.monitors), stateMonitors: withoutSeries(this.data.stateMonitors), voltageMonitors: withoutSeries(this.data.voltageMonitors) };
  },
  _buildPayload() {
    const meta = this._buildMeta();
    const series = {};
    this._forEachMonitor((id, monitor, kind, hasCycles) => {
      series[id] = { periods: encodeRows(kind, monitor.periods) };
      if (hasCycles) series[id].cycles = encodeRows('cycle', monitor.cycles);
    });
    return { payload: { schemaVersion: SCHEMA_VERSION, meta, series }, metaJson: JSON.stringify(meta) };
  },
  // What identifies "nothing changed since the last write": the meta text plus each series' signature.
  _fingerprint(metaJson) {
    const parts = [metaJson];
    this._forEachMonitor((id, monitor) => parts.push(`${id}=${seriesSignature(monitor)}`));
    return parts.join('|');
  },
  // Saves run one at a time: two overlapping ones (the debounced sample save and an explicit
  // `await store.save()`) would otherwise interleave.
  save() {
    this.revision += 1; // lets callers drop anything they cached from the data as it was
    const run = this._saving.then(() => this._persist());
    this._saving = run.catch(() => {});
    return run;
  },
  async _persist() {
    if (this.history) return this._persistToDatabase();
    if (this.historyUnavailable) return this._persistMeta();
    const { payload, metaJson } = this._buildPayload();
    const fingerprint = this._fingerprint(metaJson);
    if (fingerprint === this._lastSaved) return;
    await this.settings.set(STATE_KEY, payload);
    this._lastSaved = fingerprint;
  },
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
    await this._persistMeta();
  },
  async _persistMeta() {
    const meta = this._buildMeta();
    const metaJson = JSON.stringify(meta);
    if (metaJson === this._lastSaved) return;
    await this.settings.set(META_KEY_V3, { schemaVersion: SCHEMA_VERSION_V3, meta });
    this._lastSaved = metaJson;
  },
};
