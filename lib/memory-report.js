'use strict';

// Turns ManagerSystem.getMemoryInfo() ({ total, free, swap, types } — `types` keyed `homey:app:<id>`
// for every app plus `homey`, `zigbeed`, `matterd`, ...) into one log line: how much of the Homey is
// free and who holds the rest. The shape of each entry is not documented, so sizes are read
// defensively (a number, or an object with pss/rss/size/total/used/mem) and the very first report
// also carries the raw response so the real shape can be checked in the log.
const MB = 1048576;

function sizeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['pss', 'rss', 'size', 'total', 'used', 'mem', 'memory']) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key];
      if (value[key] && typeof value[key] === 'object') { const nested = sizeOf(value[key]); if (nested !== null) return nested; }
    }
    const numbers = Object.values(value).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (numbers.length) return Math.max(...numbers);
  }
  return null;
}

const toMb = (bytes) => (bytes === null ? '?' : `${Math.round(bytes / MB)}`);

function summarizeSystemMemory(info, ownAppId, { top = 5, includeRaw = false } = {}) {
  if (!info || typeof info !== 'object') return 'system memory: no data';
  const total = sizeOf(info.total);
  const free = sizeOf(info.free);
  const swap = sizeOf(info.swap);
  const entries = Object.entries(info.types || {})
    .map(([name, value]) => ({ name: name.replace(/^homey:app:/, ''), bytes: sizeOf(value) }))
    .filter((entry) => entry.bytes !== null)
    .sort((a, b) => b.bytes - a.bytes);
  const own = entries.findIndex((entry) => entry.name === ownAppId);
  const freePct = total && free !== null ? `${Math.round((free / total) * 100)}%` : '?';
  const list = entries.slice(0, top).map((entry) => `${entry.name} ${toMb(entry.bytes)}`).join(', ');
  const ownLabel = own >= 0 ? `, this app #${own + 1} of ${entries.length} at ${toMb(entries[own].bytes)} MB` : '';
  const raw = includeRaw ? ` | raw: ${JSON.stringify(info).slice(0, 1500)}` : '';
  return `system memory (MB, assuming bytes): total ${toMb(total)}, free ${toMb(free)} (${freePct}), swap ${toMb(swap)}; top: ${list || 'n/a'}${ownLabel}${raw}`;
}

module.exports = { summarizeSystemMemory, sizeOf };
