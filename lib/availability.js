'use strict';

// Whether a watched device counts as "down" right now, and why. Pure so it can be tested (the
// polling loop in app.js needs a Homey). Two signals: the device's own `available` flag, and how long
// it has been silent (lastSeenAt older than the watchdog's threshold). A watchdog with
// `ignoreUnavailable` counts only the silence — for a device that goes "unavailable" on purpose, like
// an appliance switched off, which a cloud app then marks offline.
function watchdogVerdict(watchdog, device, now = Date.now()) {
  const lastSeenMs = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
  const isStale = Number.isFinite(lastSeenMs) && (now - lastSeenMs) > watchdog.thresholdHours * 60 * 60 * 1000;
  const flagDown = !device.available && !watchdog.ignoreUnavailable;
  const isDown = flagDown || isStale;
  return { isDown, isStale, reason: isDown ? (flagDown ? 'unavailable' : 'stale') : null };
}

// Defaults every watchdog falls back on. Kept in the store (a few numbers) and editable in Settings.
const DEFAULT_AVAILABILITY_SETTINGS = {
  defaultThresholdHours: 12,     // hours without an update before a watchdog calls the device silent
  startupGraceMinutes: 2,        // after the app starts, wait this long before the first check (drivers may still be loading)
  unavailableDelaySeconds: 0,    // a device must stay unavailable this long before it counts as down
  batteryWarnPercent: 30,        // 0 turns the low battery check off
  batteryDelaySeconds: 0,        // a battery must stay low this long before it counts
  timelineNotifications: true    // write a Homey timeline entry when a watched device newly goes down or its battery gets low
};

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

// Fills the gaps and clamps what is there, so a stored or submitted object can never hold a value the
// polling code can't use.
function normalizeAvailabilitySettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_AVAILABILITY_SETTINGS;
  return {
    defaultThresholdHours: clampNumber(source.defaultThresholdHours, 1, 24 * 90, defaults.defaultThresholdHours),
    startupGraceMinutes: clampNumber(source.startupGraceMinutes, 0, 60, defaults.startupGraceMinutes),
    unavailableDelaySeconds: clampNumber(source.unavailableDelaySeconds, 0, 24 * 3600, defaults.unavailableDelaySeconds),
    batteryWarnPercent: clampNumber(source.batteryWarnPercent, 0, 100, defaults.batteryWarnPercent),
    batteryDelaySeconds: clampNumber(source.batteryDelaySeconds, 0, 24 * 3600, defaults.batteryDelaySeconds),
    timelineNotifications: source.timelineNotifications === undefined ? defaults.timelineNotifications : source.timelineNotifications === true || source.timelineNotifications === 'true'
  };
}

// The battery percentage of a device, or null when it has none.
function batteryLevel(device) {
  const value = device && device.capabilitiesObj && device.capabilitiesObj.measure_battery && device.capabilitiesObj.measure_battery.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// homey-api answers "no such device" with a 404 / "not found" error; anything else (timeout, API not
// ready) says nothing about whether the device still exists.
function isNotFoundError(error) {
  if (!error) return false;
  if (error.statusCode === 404 || error.status === 404) return true;
  return /not found|no such device/i.test(String(error.message || ''));
}

// Everything one poll needs to decide about a watched device: the verdict (with the "must stay
// unavailable for N seconds" delay applied), the battery state, and how long until a pending delay
// resolves so the caller can look again then instead of waiting for the next regular poll.
// `watchdog` carries the running state (unavailableSince, lowBatterySince); the caller stores what
// this returns.
function evaluateWatchdog(watchdog, device, settings, now = Date.now()) {
  const stale = watchdogVerdict(watchdog, device, now).isStale;
  const unavailableDelayMs = settings.unavailableDelaySeconds * 1000;
  const unavailableNow = !device.available && !watchdog.ignoreUnavailable;
  const unavailableSince = unavailableNow ? (watchdog.unavailableSince ?? now) : null;
  const unavailableFor = unavailableNow ? now - unavailableSince : 0;
  const flagDown = unavailableNow && unavailableFor >= unavailableDelayMs;
  const isDown = flagDown || stale;

  const level = batteryLevel(device);
  const batteryDelayMs = settings.batteryDelaySeconds * 1000;
  const belowWarn = settings.batteryWarnPercent > 0 && level !== null && level <= settings.batteryWarnPercent;
  const lowBatterySince = belowWarn ? (watchdog.lowBatterySince ?? now) : null;
  const lowFor = belowWarn ? now - lowBatterySince : 0;
  const isLow = belowWarn && lowFor >= batteryDelayMs;

  const pending = [];
  if (unavailableNow && !flagDown) pending.push(unavailableDelayMs - unavailableFor);
  if (belowWarn && !isLow) pending.push(batteryDelayMs - lowFor);
  return {
    isDown, reason: isDown ? (flagDown ? 'unavailable' : 'stale') : null, unavailableSince,
    battery: level, lowBattery: isLow, lowBatterySince,
    recheckInMs: pending.length ? Math.min(...pending) : null
  };
}

module.exports = { watchdogVerdict, evaluateWatchdog, normalizeAvailabilitySettings, batteryLevel, isNotFoundError, DEFAULT_AVAILABILITY_SETTINGS };
