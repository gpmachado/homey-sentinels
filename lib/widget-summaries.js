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

// One card for the state of the house. Built from data the app already holds (the availability scan and the
// watchdogs, the activity monitors, the voltage monitors' current state, the groups' "mismatch reported" flag),
// so it costs no device read. Rows without anything configured are left out; the overall level is the worst of
// the rows that judge something (the "running now" row only informs).
const ROW_NAMES_MAX = 3;
const LEVEL_RANK = { good: 0, warn: 1, bad: 2 };
const pickNames = (names) => {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  return { names: unique.slice(0, ROW_NAMES_MAX), more: Math.max(0, unique.length - ROW_NAMES_MAX) };
};

function healthWidgetSummary({ scan = null, watchdogs = [], activityMonitors = [], voltageSummaries = [], groups = [] } = {}) {
  const rows = [];

  // Devices: a watchdog that fired, or anything the scan flagged. Unavailable is worse than merely silent.
  const scanProblems = scan ? scan.problems : [];
  const downWatchdogs = watchdogs.filter((watchdog) => watchdog.wentUnavailableAt);
  const unavailable = downWatchdogs.length + scanProblems.filter((problem) => problem.reason === 'unavailable').length;
  const silent = scanProblems.filter((problem) => problem.reason === 'stale').length;
  const lowBattery = scanProblems.filter((problem) => problem.lowBattery).length + watchdogs.filter((watchdog) => watchdog.lowBattery && !watchdog.wentUnavailableAt).length;
  const watched = watchdogs.length + (scan ? scan.monitored : 0);
  if (watched > 0) {
    const attention = pickNames([
      ...downWatchdogs.map((watchdog) => watchdog.name),
      ...scanProblems.map((problem) => problem.name),
      ...watchdogs.filter((watchdog) => watchdog.lowBattery).map((watchdog) => watchdog.name)
    ]);
    const parts = [];
    if (unavailable) parts.push(`${unavailable} unavailable`);
    if (silent) parts.push(`${silent} not reporting`);
    if (lowBattery) parts.push(`${lowBattery} low battery`);
    rows.push({
      key: 'devices', label: 'Devices', level: unavailable ? 'bad' : (silent || lowBattery ? 'warn' : 'good'),
      count: unavailable + silent + lowBattery, total: watched,
      text: parts.length ? parts.join(', ') : `All ${watched} fine`, ...attention
    });
  }

  // Running now: activity monitors that are ACTIVE at this moment (informational, never a problem).
  if (activityMonitors.length) {
    const running = activityMonitors.filter((monitor) => monitor.state === 'ACTIVE');
    rows.push({
      key: 'running', label: 'Running now', level: 'info', count: running.length, total: activityMonitors.length,
      text: running.length ? `${running.length} running` : 'Nothing running', ...pickNames(running.map((monitor) => monitor.name))
    });
  }

  // Voltage: monitors currently outside their band.
  if (voltageSummaries.length) {
    const abnormal = voltageSummaries.filter((item) => item.state && item.state !== 'NORMAL');
    rows.push({
      key: 'voltage', label: 'Voltage', level: abnormal.length ? 'bad' : 'good', count: abnormal.length, total: voltageSummaries.length,
      text: abnormal.length ? `${abnormal.length} out of range` : 'All in range', ...pickNames(abnormal.map((item) => item.name))
    });
  }

  // Groups: those Flow has been told are mismatched (kept live by the members' own events).
  const judged = groups.filter((group) => group.devices && group.devices.length >= 2);
  if (judged.length) {
    const mismatched = judged.filter((group) => group.mismatchSince);
    rows.push({
      key: 'groups', label: 'Groups', level: mismatched.length ? 'warn' : 'good', count: mismatched.length, total: judged.length,
      text: mismatched.length ? `${mismatched.length} with a mismatch` : 'All as expected', ...pickNames(mismatched.map((group) => group.name))
    });
  }

  const level = rows.reduce((worst, row) => (row.level in LEVEL_RANK && LEVEL_RANK[row.level] > LEVEL_RANK[worst] ? row.level : worst), 'good');
  const attentionCount = rows.filter((row) => row.level === 'warn' || row.level === 'bad').length;
  return { level, attentionCount, scanning: Boolean(scan), rows };
}

module.exports = { watchdogsWidgetSummary, voltageWidgetSummary, healthWidgetSummary };
