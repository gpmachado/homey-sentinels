'use strict';

// The list of the Homey's devices that the Settings pickers, the Availability tab and the Flow
// autocompletes need, kept SLIM (see HomeyDeviceGateway#_slim) and read only when something asks.
//
// Why not read it at startup and every few minutes: on a Homey with 305 devices the first
// api.devices.getDevices() cost ~13 MB of PSS that never came back, and every later read another
// 2-6 MB (measured with a probe app on the device). Monitors need only their own devices' live
// values, which come from per-device subscriptions, so the full list is needed rarely.
//
// Routes of the app's Web API must not call the Homey API themselves (a getDevices() from inside a
// route never resolves), so request() only schedules the read on a timer and returns at once; the
// page polls until the list has loaded. Callers that already run in app context (a Flow
// autocomplete) use ensure(), which waits for the read.
class DeviceDirectory {
  constructor({ gateway, defer = (fn) => setTimeout(fn, 0), now = Date.now, log = () => {}, error = () => {}, onRefreshed = null, ttlMs = 10 * 60 * 1000 } = {}) {
    this._gateway = gateway;
    this._defer = defer;
    this._now = now;
    this._log = log;
    this._error = error;
    this._onRefreshed = onRefreshed;
    this._ttlMs = ttlMs;
    this._list = [];
    this._at = null;
    this._loading = null;
  }

  list() { return this._list; }
  isLoading() { return this._loading !== null; }
  hasLoaded() { return this._at !== null; }
  ageMs() { return this._at === null ? null : this._now() - this._at; }
  isFresh(maxAgeMs = this._ttlMs) { const age = this.ageMs(); return age !== null && age <= maxAgeMs; }
  status() { return { loading: this.isLoading(), loaded: this.hasLoaded(), ageMs: this.ageMs(), count: this._list.length }; }

  // Starts a read in the background unless the list is fresh enough or one is already running.
  // Never throws and never touches the Homey API on the caller's stack. Returns whether a read is
  // now in flight.
  request(maxAgeMs = this._ttlMs) {
    if (this._loading) return true;
    if (this.isFresh(maxAgeMs)) return false;
    this._loading = new Promise((resolve) => {
      this._defer(async () => {
        try {
          const started = this._now();
          this._list = await this._gateway.listDevices();
          this._at = this._now();
          this._log(`device list read: ${this._list.length} devices in ${this._at - started} ms`);
          if (this._onRefreshed) { try { this._onRefreshed(); } catch (e) { /* housekeeping only */ } }
        } catch (error) {
          this._error('Failed to read the device list', error);
        } finally {
          this._loading = null;
          resolve();
        }
      });
    });
    return true;
  }

  // For callers already running in app context: waits for a fresh-enough list.
  async ensure(maxAgeMs = this._ttlMs) {
    this.request(maxAgeMs);
    if (this._loading) await this._loading;
    return this._list;
  }
}

module.exports = { DeviceDirectory };
