'use strict';

// Memory diagnostics and the periodic history consolidation that keeps the store small.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { summarizeSystemMemory } = require('../memory-report');

module.exports = {
  _consolidateHistory() {
    try {
      // Runs at startup and every 6h — logging its cost is the only way to tell whether a
      // synchronous pass over a monitor's raw periods (7 days of them, uncapped in count — a
      // device sampling every few seconds can mean tens of thousands) is itself long enough to
      // trip Homey's CPU watchdog, versus some other cause entirely.
      const periodCountBefore = this._totalPeriodCount();
      // Above this, name the worst offenders directly — cheaper than waiting for another
      // crash-and-report round trip to find out which monitor is actually the problem.
      if (periodCountBefore > 20000) this._logLargestPeriodCounts();
      const startedAt = Date.now();
      this.store.consolidateHistory(this._getTimezone());
      const durationMs = Date.now() - startedAt;
      const periodCountAfter = this._totalPeriodCount();
      // Meta is the part rewritten on every save; the series live in one key per monitor and are
      // sized by the period counts above. (Serializing the whole in-memory store here, as an
      // earlier version did, would recreate the very multi-MB string the split storage avoids.)
      this.log(`Consolidated history in ${durationMs}ms (periods ${periodCountBefore} -> ${periodCountAfter}, meta ~${this._metaLabel()}${this._history ? `, history db ${Math.round(this._history.sizeBytes() / 1024)} KB` : ''}, heap ${this._heapMb()} MB used/limit)`);
      this.store.save().then(() => this._history?.checkpoint()).catch((error) => this.error('Failed to save after consolidating history', error));
    } catch (error) {
      this.error('Failed to consolidate history', error);
    }
  },

  // v8.getHeapStatistics, not process.memoryUsage(): the latter reads the process RSS from /proc,
  // which doesn't exist inside Homey's app container (ENOENT uv_resident_set_memory) and made the
  // consolidation pass throw before it could save. Also exposes the real heap limit. Diagnostics
  // must never be able to break the code they're logging, hence the catch.
  // Heap from V8 plus what Homey's supervisor measures for this app. The latter is the one its
  // Memory Warning Limit applies to; if the call isn't permitted or fails, log that once and
  // carry on with the heap numbers alone.
  async _logMemory() {
    let homeyUsage = '';
    try {
      const usage = await this.gateway.getOwnUsage();
      homeyUsage = `, homey usage ${JSON.stringify(usage)}`;
    } catch (error) {
      if (!this._usageErrorLogged) { this._usageErrorLogged = true; homeyUsage = `, homey usage unavailable (${error.message})`; }
    }
    const stats = require('v8').getHeapStatistics();
    const dbSizes = this._history ? this._history.sizes() : null;
    const dbLabel = dbSizes ? `, history db ${Math.round(dbSizes.main / 1024)} KB + wal ${Math.round(dbSizes.wal / 1024)} KB` : '';
    this.log(`memory: heap ${this._heapMb()} MB used/limit, external ${Math.round(stats.external_memory / 1048576)} MB, malloced ${Math.round(stats.malloced_memory / 1048576)} MB${dbLabel}${homeyUsage}`);
  },

  async _logSystemMemory(includeRaw) {
    if (this._systemMemoryUnavailable) return;
    try {
      const info = await this.gateway.getSystemMemory();
      this.log(summarizeSystemMemory(info, this.homey.manifest.id, { includeRaw }));
    } catch (error) {
      this._systemMemoryUnavailable = true;
      this.log(`system memory unavailable (${error.message}); not retrying`);
    }
  },

  _metaLabel() {
    const { kb, twoByte } = this.store.metaStats();
    return `${kb} KB${twoByte ? ' (HAS NON-LATIN1 TEXT: writes cost double)' : ''}`;
  },

  _heapMb() {
    try {
      const { used_heap_size: used, heap_size_limit: limit } = require('v8').getHeapStatistics();
      return `${Math.round(used / 1048576)}/${Math.round(limit / 1048576)}`;
    } catch (error) {
      return '?';
    }
  },

  _totalPeriodCount() {
    const collections = [this.store.data.monitors, this.store.data.stateMonitors, this.store.data.voltageMonitors];
    return collections.reduce((total, collection) => total + Object.values(collection).reduce((sum, monitor) => sum + (monitor.periods?.length || 0), 0), 0);
  },

  _logLargestPeriodCounts() {
    const collections = { activity: this.store.data.monitors, state: this.store.data.stateMonitors, voltage: this.store.data.voltageMonitors };
    const all = Object.entries(collections).flatMap(([kind, collection]) =>
      Object.values(collection).map((monitor) => ({ kind, name: monitor.name, count: monitor.periods?.length || 0 })));
    const top = all.sort((a, b) => b.count - a.count).slice(0, 5);
    this.log('Largest raw period counts:', top.map((m) => `${m.name} (${m.kind}): ${m.count}`).join(', '));
  }
};
