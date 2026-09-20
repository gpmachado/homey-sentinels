'use strict';

// Availability watchdogs: creation/removal, the polling loop, delays, battery and timeline notes.
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { humanDuration } = require('../activity-engine');
const { evaluateWatchdog, isNotFoundError } = require('../availability');
const { punctuationToAscii } = require('../text');
const { WATCHDOG_MISSING_POLLS, WATCHDOG_CHECK_MIN_MS } = require('./constants');

module.exports = {
  // The widget's "Check now": the regular poll, but not more often than every 15 s however hard it is tapped.
  async checkWatchdogsNow() {
    if (!this._lastWatchdogPollAt || Date.now() - this._lastWatchdogPollAt > WATCHDOG_CHECK_MIN_MS) await this._pollAvailabilityWatchdogs();
    await this.runAvailabilityScanNow(); // the all-devices scan too (rate limited on its own)
    this._summaryCache.delete('widget:watchdogs');
    return this.getWatchdogsWidgetSummary();
  },

  // Shared by the "Add availability watchdog" Flow card and Settings — same upsert-by-deviceId
  // path either way, matching _createActivityMonitor's rationale (re-running the Flow card just
  // updates the threshold instead of erroring on a duplicate).
  async _createAvailabilityWatchdog({ deviceId, thresholdHours, ignoreUnavailable }) {
    const selected = await this.gateway.getDevice(deviceId);
    if (!selected) throw new Error('Device not found.');
    const existed = !!this.store.data.availabilityWatchdogs[deviceId];
    const watchdog = this.store.upsertAvailabilityWatchdog({ deviceId, name: selected.name, thresholdHours, ignoreUnavailable });
    await this.store.save();
    // See _createActivityMonitor's comment — same Settings-form silent-creation gap, same fix.
    this.log(existed
      ? `[${watchdog.name}] availability watchdog already existed — threshold updated to ${watchdog.thresholdHours}h`
      : `[${watchdog.name}] availability watchdog created (threshold: ${watchdog.thresholdHours}h)`);
    return watchdog;
  },

  async removeAvailabilityWatchdog(deviceId) {
    this.store.deleteAvailabilityWatchdog(deviceId);
    await this.store.save();
  },

  // Keyed by deviceId (not a synthetic id, see store.js) — `data.id` here IS the device id,
  // matching what _deviceId() and the trigger filters above expect.
  _availabilityWatchdogResults(query) { const normalized = (query || '').toLowerCase(); return Object.values(this.store.data.availabilityWatchdogs).filter((w) => w.name.toLowerCase().includes(normalized)).map((w) => ({ name: w.name, description: `alert after ${w.thresholdHours}h`, data: { id: w.deviceId } })); },

  // Combines two signals per the design in analise/NOTA_DISPONIBILIDADE_FLOWS.md: the device's
  // own `available` flag (accurate whenever a driver actually manages it, fires instantly) and
  // `lastSeenAt` staleness against a per-watchdog configurable threshold (covers drivers that
  // never touch `available` at all — a single global threshold was exactly what made the
  // Device Watchdog app's own detection unreliable in practice). Each watched device is read on its own
  // at every poll — no full device list and no new subscription needed.
  async _pollAvailabilityWatchdogs() {
    this._lastWatchdogPollAt = Date.now();
    const settings = this.store.getAvailabilitySettings();
    let recheckInMs = null;
    for (const watchdog of Object.values(this.store.data.availabilityWatchdogs)) {
      try {
        // Only the watched devices are read, one by one — never the whole device list.
        let device = null;
        let lookupFailed = false;
        try {
          device = await this.gateway.getDevice(watchdog.deviceId);
        } catch (error) {
          if (!isNotFoundError(error)) lookupFailed = true; // API not ready or a timeout: says nothing about the device
        }
        if (lookupFailed) continue;
        if (!device) {
          // Paired out of Homey? Only after a few polls in a row, then it is flagged so Settings can offer
          // to clean it up. The watchdog itself is left as it was — no guessing about its state.
          watchdog.missingCount = (watchdog.missingCount || 0) + 1;
          if (watchdog.missingCount >= WATCHDOG_MISSING_POLLS && !watchdog.missing) {
            watchdog.missing = true;
            this._logEvent(`${watchdog.name} is no longer in Homey - its watchdog can be removed`);
          }
          continue;
        }
        watchdog.missingCount = 0;
        watchdog.missing = false;
        watchdog.name = device.name;
        watchdog.zoneName = device.zoneName || null;
        watchdog.available = device.available !== false;
        watchdog.lastSeenAt = device.lastSeenAt || null;
        const result = evaluateWatchdog(watchdog, device, settings);
        watchdog.unavailableSince = result.unavailableSince;
        watchdog.battery = result.battery;
        watchdog.lowBatterySince = result.lowBatterySince;
        if (result.recheckInMs !== null) recheckInMs = recheckInMs === null ? result.recheckInMs : Math.min(recheckInMs, result.recheckInMs);
        if (result.isDown && !watchdog.wentUnavailableAt) {
          watchdog.wentUnavailableAt = Date.now();
          watchdog.reason = result.reason;
          const message = watchdog.reason === 'stale'
            ? `${device.name} hasn't reported in over ${watchdog.thresholdHours}h`
            : `${device.name} became unavailable`;
          this._logEvent(message);
          this._notifyTimeline(message);
          await this.availabilityCards.unavailable.trigger(
            { device: device.name, zone: device.zoneName || '', last_seen: device.lastSeenAt || '', reason: watchdog.reason },
            { deviceId: watchdog.deviceId }
          );
        } else if (!result.isDown && watchdog.wentUnavailableAt) {
          const downtimeSeconds = Math.max(0, Math.round((Date.now() - watchdog.wentUnavailableAt) / 1000));
          this._logEvent(`${device.name} became available again`);
          await this.availabilityCards.available.trigger(
            { device: device.name, downtime: humanDuration(downtimeSeconds) },
            { deviceId: watchdog.deviceId }
          );
          watchdog.wentUnavailableAt = null;
          watchdog.reason = null;
        }
        if (result.lowBattery && !watchdog.lowBattery) {
          watchdog.lowBattery = true;
          const message = `${device.name} battery is low (${result.battery}%)`;
          this._logEvent(message);
          this._notifyTimeline(message);
          await this.availabilityCards.batteryLow.trigger(
            { device: device.name, zone: device.zoneName || '', battery: result.battery },
            { deviceId: watchdog.deviceId }
          );
        } else if (!result.lowBattery && watchdog.lowBattery) {
          watchdog.lowBattery = false;
          this._logEvent(`${device.name} battery is back to normal`);
        }
      } catch (error) {
        this.error('Failed to poll availability watchdog', watchdog.deviceId, error);
      }
    }
    this._scheduleWatchdogRecheck(recheckInMs);
    this._scheduleSave();
  },

  // A device that has to stay unavailable (or low) for N seconds is looked at again when that time is
  // up, instead of waiting for the next regular poll, which is 10 minutes away.
  _scheduleWatchdogRecheck(inMs) {
    if (this._watchdogRecheckTimer) { this.homey.clearTimeout(this._watchdogRecheckTimer); this._watchdogRecheckTimer = null; }
    if (inMs === null || inMs === undefined) return;
    this._watchdogRecheckTimer = this.homey.setTimeout(() => {
      this._watchdogRecheckTimer = null;
      this._pollAvailabilityWatchdogs().catch((error) => this.error('Failed to recheck availability watchdogs', error));
    }, Math.max(1000, inMs + 500));
  },

  // One entry in Homey's own timeline, for a problem that is new (never repeated while it lasts).
  _notifyTimeline(text) {
    if (!this.store.getAvailabilitySettings().timelineNotifications) return;
    try {
      Promise.resolve(this.homey.notifications.createNotification({ excerpt: punctuationToAscii(text) })).catch((error) => this.error('Timeline entry failed', error));
    } catch (error) {
      this.error('Timeline entry failed', error);
    }
  }
};
