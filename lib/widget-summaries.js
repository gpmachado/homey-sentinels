'use strict';

// Shapes the data the dashboard widgets show. Pure (no Homey), so it is tested directly; app.js only
// feeds it the store's own data — the widgets never read the Homey's device list.

const SCAN_ITEMS_MAX = 100; // a scan over hundreds of devices must not make the widget payload grow with the house

// Watchdogs first the ones that are down, then by name. `now` is injected for the tests. `scan` is what
// the all-devices scan found ({ monitored, thresholdHours, problems }): its problem devices are listed
// next to the watchdogs, and the devices it found healthy count as OK.
function watchdogsWidgetSummary(watchdogs, now = Date.now(), scan = null) {
  const scanned = scan ? scan.problems.slice(0, SCAN_ITEMS_MAX).map((problem) => ({
    deviceId: problem.id,
    name: problem.name,
    zoneName: problem.zoneName || null,
    battery: Number.isFinite(problem.battery) ? problem.battery : null,
    lowBattery: Boolean(problem.lowBattery),
    missing: false,
    down: Boolean(problem.reason),
    reason: problem.reason || null,
    downSeconds: problem.reason && problem.since ? Math.max(0, Math.round((now - problem.since) / 1000)) : null,
    thresholdHours: problem.thresholdHours || scan.thresholdHours,
    silenceOnly: false,
    available: problem.reason !== 'unavailable',
    lastSeenAt: problem.lastSeenAt || null,
    scanned: true
  })) : [];
  const items = (watchdogs || []).map((watchdog) => {
    const down = Boolean(watchdog.wentUnavailableAt);
    return {
      deviceId: watchdog.deviceId,
      name: watchdog.name,
      zoneName: watchdog.zoneName || null,
      battery: Number.isFinite(watchdog.battery) ? watchdog.battery : null,
      lowBattery: Boolean(watchdog.lowBattery),
      missing: Boolean(watchdog.missing),
      down,
      reason: down ? watchdog.reason : null,
      downSeconds: down ? Math.max(0, Math.round((now - watchdog.wentUnavailableAt) / 1000)) : null,
      thresholdHours: watchdog.thresholdHours,
      silenceOnly: Boolean(watchdog.ignoreUnavailable),
      available: watchdog.available !== false,
      lastSeenAt: watchdog.lastSeenAt || null
    };
  }).concat(scanned).sort((a, b) => (a.down === b.down ? String(a.name).localeCompare(String(b.name)) : (a.down ? -1 : 1)));
  const downCount = items.filter((item) => item.down).length;
  const staleCount = items.filter((item) => item.down && item.reason === 'stale').length;
  const total = (watchdogs || []).length + (scan ? scan.monitored : 0);
  return { total, downCount, staleCount, unavailableCount: downCount - staleCount, okCount: total - downCount, lowBatteryCount: items.filter((item) => item.lowBattery).length, scanning: Boolean(scan), items };
}

// From the Settings voltage summary for "today": what is measured now, what it did today, and the
// configured band, per monitor. Numbers that don't exist yet stay null, never 0 (a widget showing
// "0 V" for a monitor with no reading yet would look like a blackout).
function voltageWidgetSummary(summaries) {
  const finite = (value) => (Number.isFinite(value) ? value : null);
  const items = (summaries || []).map((summary) => ({
    id: summary.id,
    name: summary.name,
    state: summary.state,
    currentVoltage: finite(summary.currentVoltage),
    todayMin: finite(summary.minVoltage),
    todayMax: finite(summary.maxVoltage),
    undervoltageCount: summary.undervoltageCount || 0,
    overvoltageCount: summary.overvoltageCount || 0,
    bandMin: finite(summary.configuredMinVoltage),
    bandMax: finite(summary.configuredMaxVoltage)
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { total: items.length, abnormalCount: items.filter((item) => item.state && item.state !== 'NORMAL').length, items };
}

module.exports = { watchdogsWidgetSummary, voltageWidgetSummary };
