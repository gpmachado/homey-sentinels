'use strict';

// Answers Homey's own memory warnings. Homey's supervisor counts the app's whole resident memory
// against a per-app ceiling and, when it is exceeded, emits `memwarn` ({ count, limit }) about every
// ten seconds before killing the app on the `limit`-th one ("Memory Warning Limit Reached").
// What eats the margin is often not live data: V8 frees the garbage of every large serialisation
// but keeps the emptied pages committed until its memory reducer runs, and the reducer waits for a
// quiet moment. A `last-resort` collection uncommits them at once (~10 ms on a 40 MB heap) — the
// same lever the PELS app uses (see its lib/diagnostics/heapReclaim.ts).
//
// The collector is not exposed on Homey, so it is obtained the documented-by-practice way: set the
// flag after startup and read the builtin out of a fresh vm context. Everything here is best
// effort and must never throw into the caller: it runs on the warning path.
const v8 = require('v8');
const vm = require('vm');

const LAST_RESORT = { type: 'major', execution: 'sync', flavor: 'last-resort' };
const MIN_RECLAIM_INTERVAL_MS = 30 * 1000; // warnings arrive every ~10 s; a collection just run has nothing more to give
const BACKSTOP_INTERVAL_MS = 10 * 60 * 1000;
// Startup does the heaviest work of the app's life (loading and migrating the store, the first device
// refresh, calibration passes) and leaves emptied pages committed; reclaim once after it settles
// instead of waiting for the first backstop tick or a warning.
const STARTUP_RECLAIM_MS = 90 * 1000;

let exposedGc; // undefined = not resolved yet, null = not available on this runtime
function resolveGc() {
  if (exposedGc !== undefined) return exposedGc;
  try {
    if (typeof globalThis.gc === 'function') {
      exposedGc = globalThis.gc;
    } else {
      v8.setFlagsFromString('--expose-gc');
      const fromContext = vm.runInNewContext('gc');
      exposedGc = typeof fromContext === 'function' ? fromContext : null;
    }
  } catch (error) {
    exposedGc = null;
  }
  return exposedGc;
}

const heapTotalMb = () => Math.round(v8.getHeapStatistics().total_heap_size / 1048576 * 10) / 10;

// Returns a function that reclaims at most once per MIN_RECLAIM_INTERVAL_MS and reports what it did.
function createReclaimer({ log = () => {}, now = Date.now, gc = resolveGc } = {}) {
  let last = null;
  let unavailableLogged = false;
  return function reclaim(trigger) {
    const at = now();
    if (last !== null && at - last < MIN_RECLAIM_INTERVAL_MS) return false;
    last = at;
    const collect = gc();
    if (!collect) {
      if (!unavailableLogged) { unavailableLogged = true; log('heap reclaim unavailable: gc could not be exposed on this runtime'); }
      return false;
    }
    const before = heapTotalMb();
    const started = now();
    try {
      collect(LAST_RESORT);
    } catch (error) {
      try { collect(); } catch (again) { return false; }
    }
    log(`heap reclaimed (${trigger}): total ${before} -> ${heapTotalMb()} MB in ${now() - started} ms`);
    return true;
  };
}

// Wires the listeners onto a Homey-like emitter. Returns a function that removes them.
function startMemoryGuard(homey, { log = () => {}, error = () => {} } = {}) {
  const reclaim = createReclaimer({ log });
  const onMemwarn = (payload) => {
    try {
      const count = payload && Number.isFinite(payload.count) ? payload.count : '?';
      const limit = payload && Number.isFinite(payload.limit) ? payload.limit : '?';
      log(`Homey memory warning ${count}/${limit}`);
    } finally {
      try { reclaim('memwarn'); } catch (e) { error('memory reclaim failed', e); }
    }
  };
  const onCpuwarn = (payload) => {
    const count = payload && Number.isFinite(payload.count) ? payload.count : '?';
    const limit = payload && Number.isFinite(payload.limit) ? payload.limit : '?';
    log(`Homey CPU warning ${count}/${limit}`);
  };
  homey.on('memwarn', onMemwarn);
  homey.on('cpuwarn', onCpuwarn);
  const startup = typeof homey.setTimeout === 'function' ? homey.setTimeout(() => { try { reclaim('startup'); } catch (e) { error('memory reclaim failed', e); } }, STARTUP_RECLAIM_MS) : null;
  const backstop = homey.setInterval(() => { try { reclaim('interval'); } catch (e) { error('memory reclaim failed', e); } }, BACKSTOP_INTERVAL_MS);
  return () => {
    if (typeof homey.clearInterval === 'function') homey.clearInterval(backstop);
    if (startup !== null && typeof homey.clearTimeout === 'function') homey.clearTimeout(startup);
    const off = homey.off || homey.removeListener;
    if (typeof off === 'function') { off.call(homey, 'memwarn', onMemwarn); off.call(homey, 'cpuwarn', onCpuwarn); }
  };
}

module.exports = { startMemoryGuard, createReclaimer, MIN_RECLAIM_INTERVAL_MS, BACKSTOP_INTERVAL_MS, STARTUP_RECLAIM_MS };
