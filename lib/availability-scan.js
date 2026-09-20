'use strict';

// Judges every device of the Homey against the watchdog defaults, the way the Device Watchdog app does,
// for the devices that have no watchdog of their own. Pure: the device list, the settings and what the
// previous scan knew come in, the verdicts and the new state go out.
//
// The state kept between scans is only what a later scan needs and can't work out itself: for the
// devices that are a problem (or waiting out a delay) since when, and the reason, so a problem is
// announced once and not at every scan, and a restart does not announce them all again.
const { evaluateWatchdog } = require('./availability');

function scanDevices(devices, { settings, exclusions = {}, watchedIds = new Set(), previous = {}, now = Date.now() }) {
  const excludedDevices = exclusions.devices || {};
  const excludedZones = exclusions.zones || {};
  const excludedApps = exclusions.apps || {};
  const problems = [];
  const state = {};
  let monitored = 0;
  for (const device of devices || []) {
    if (watchedIds.has(device.id) || excludedDevices[device.id] || (device.zoneName && excludedZones[device.zoneName]) || (device.ownerUri && excludedApps[device.ownerUri])) continue;
    monitored += 1;
    const before = previous[device.id] || {};
    const result = evaluateWatchdog(
      { thresholdHours: settings.defaultThresholdHours, ignoreUnavailable: false, unavailableSince: before.u ?? null, lowBatterySince: before.b ?? null },
      device, settings, now
    );
    const reason = result.isDown ? result.reason : null;
    if (!reason && !result.lowBattery && result.unavailableSince === null && result.lowBatterySince === null) continue;
    const since = reason ? (before.r === reason && before.s ? before.s : now) : null;
    state[device.id] = { r: reason, s: since, u: result.unavailableSince, b: result.lowBatterySince, lb: result.lowBattery ? 1 : 0 };
    if (reason || result.lowBattery) {
      problems.push({
        id: device.id, name: device.name, zoneName: device.zoneName || null, ownerUri: device.ownerUri || null, reason, lowBattery: result.lowBattery,
        battery: result.battery, lastSeenAt: device.lastSeenAt || null, since,
        isNew: (reason && before.r !== reason) || (result.lowBattery && !before.lb) ? true : false
      });
    }
  }
  const counts = {
    stale: problems.filter((p) => p.reason === 'stale').length,
    unavailable: problems.filter((p) => p.reason === 'unavailable').length,
    lowBattery: problems.filter((p) => p.lowBattery).length
  };
  return { monitored, problems, state, counts };
}

module.exports = { scanDevices };
