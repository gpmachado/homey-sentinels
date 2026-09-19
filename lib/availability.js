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

module.exports = { watchdogVerdict };
