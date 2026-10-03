'use strict';

// Creating, updating, resetting and removing monitors and counters (Settings and Flow share these).
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { resumeWithRetry } = require('../resume');
const { isNotFoundError } = require('../availability');
const { AUXILIARY_CAPABILITY_CANDIDATES, MONITOR_MISSING_ATTEMPTS } = require('./constants');

// The three kinds of monitor that watch a device capability, keyed by their collection in the store. What they
// share (resume, remove, reset, change device, the missing-device scan) is written once below and reads this
// table; what differs per kind is named here or passed in by that kind's own method.
const MONITOR_KINDS = {
  monitors: { label: 'activity monitor', watch: '_watch', reset: 'resetMonitor', identity: 'updateMonitorIdentity' },
  voltageMonitors: { label: 'voltage monitor', watch: '_watchVoltage', reset: 'resetVoltageMonitor', identity: 'updateVoltageMonitorIdentity' },
  stateMonitors: { label: 'state monitor', watch: '_watchState', reset: 'resetStateMonitor', identity: 'updateStateMonitorIdentity' }
};

module.exports = {
  // Capabilities that ride along with a monitor's own (power, current, energy, voltage on the same device), found
  // from the device itself rather than picked by the user. Used when a monitor is created and when it moves.
  _auxiliaryCapabilitiesFor(device, capabilityId) {
    return AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && device.capabilities.includes(cap));
  },

  // Starts watching a saved monitor's device, with retries (right after a Homey reboot the apps start before the
  // devices are ready). A device Homey keeps answering "Not Found" for is gone: the monitor is flagged
  // (deviceMissing, shown in Settings) and the retries stop, instead of logging the same error every few
  // minutes for ever. The monitor and its history are kept; deleting it is the user's call.
  _resumeMonitor(collection, monitor) {
    const { label, watch } = MONITOR_KINDS[collection];
    resumeWithRetry({
      label: `[${monitor.name}] ${label}`,
      start: () => this[watch](monitor),
      // Also stops a retry loop already in flight the moment anything else (the hourly device-list scan, which
      // can notice a deletion faster than this loop's own backoff) flags the device missing — without this a
      // loop already scheduled kept retrying and logging on its own schedule for several more minutes after
      // the scan had already said so, ignoring it.
      isStillWanted: () => Boolean(this.store.data[collection][monitor.id]) && !monitor.deviceMissing,
      schedule: (fn, ms) => this.homey.setTimeout(fn, ms),
      log: (message) => this.log(message),
      error: (message) => this.error(message),
      shouldGiveUp: (failure, attempt) => isNotFoundError(failure) && attempt >= MONITOR_MISSING_ATTEMPTS - 1,
      onGiveUp: () => this._flagMonitorDeviceMissing(monitor, true),
      onStarted: () => this._flagMonitorDeviceMissing(monitor, false),
      // An attempt that was already in flight when the monitor was deleted (or flagged missing) still
      // subscribed; without this that subscription would stay for a monitor nothing reads any more.
      onAbandoned: () => this.gateway.unsubscribeCapabilities(monitor.id, monitor.deviceId, monitor.capability, monitor.auxiliaryCapabilities || [])
    });
  },

  _flagMonitorDeviceMissing(monitor, missing) {
    if (Boolean(monitor.deviceMissing) === missing) return;
    monitor.deviceMissing = missing;
    if (missing) {
      this.log(`[${monitor.name}] its device (${monitor.deviceName}) is no longer in Homey; the monitor is kept, delete it in Settings if it is not needed`);
      this._logEvent(`${monitor.name}: the device ${monitor.deviceName} is no longer in Homey`);
    } else {
      this.log(`[${monitor.name}] its device is back in Homey`);
    }
    this._scheduleSave();
  },

  // The availability scan reads every device once per interval, which is also the moment to see which monitors
  // point at a device that no longer exists (deleted while the monitor was running, so no start ever failed), and
  // which flagged ones have their device back (then they are started again).
  _checkMonitorDevices(devices) {
    if (!devices.length) return;
    const present = new Set(devices.map((device) => device.id));
    for (const collection of Object.keys(MONITOR_KINDS)) {
      for (const monitor of Object.values(this.store.data[collection])) {
        if (!monitor.deviceId) continue;
        if (!present.has(monitor.deviceId)) this._flagMonitorDeviceMissing(monitor, true);
        else if (monitor.deviceMissing) { this._flagMonitorDeviceMissing(monitor, false); this._resumeMonitor(collection, monitor); }
      }
    }
  },

  // Shared by the remove_* Flow actions and the Settings page's delete buttons — both need the exact same
  // unsubscribe-then-forget sequence, not just a store update. The auxiliary capabilities are unsubscribed too,
  // or their subscriptions would stay behind for a monitor nothing reads any more.
  async _removeMonitorOf(collection, item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, item.auxiliaryCapabilities || []);
    delete this.store.data[collection][item.id];
    await this.store.save();
  },

  async removeMonitor(item) {
    this._lastCalibrationAttempt.delete(item.id);
    this._calibrationAttempts.delete(item.id);
    await this._removeMonitorOf('monitors', item);
  },

  async removeVoltageMonitor(item) { await this._removeMonitorOf('voltageMonitors', item); },

  async removeStateMonitor(item) { await this._removeMonitorOf('stateMonitors', item); },

  // Shared by the reset Flow actions and the Settings page's "Reset stats" button — wipes
  // accumulated data while leaving the monitor's own configuration and live subscription
  // untouched (unlike remove*, nothing needs to unsubscribe/resubscribe here).
  async _resetMonitorOf(collection, item) {
    this.store[MONITOR_KINDS[collection].reset](item);
    await this.store.save();
  },

  async resetMonitorStats(item) { await this._resetMonitorOf('monitors', item); },

  async resetVoltageMonitorStats(item) { await this._resetMonitorOf('voltageMonitors', item); },

  async resetStateMonitorStats(item) { await this._resetMonitorOf('stateMonitors', item); },

  // Shared by the "Update voltage monitor" Flow card and the Settings "Edit" form — same
  // validation (store.updateVoltageMonitor throws on an invalid range) and the same
  // immediate re-check against the last known reading, so a range edit that would already
  // flag the current voltage doesn't wait for the device's next real push to notice.
  async updateVoltageMonitorRange(item, { minVoltage, maxVoltage, stabilizationMinutes } = {}) {
    this.store.updateVoltageMonitor(item, { minVoltage, maxVoltage, stabilizationMinutes });
    await this.store.save();
    if (item.lastSample) await this._voltageSample(item, item.lastSample.voltage, Date.now());
    return item;
  },

  // Rename and/or move a monitor to another device, shared by the three kinds. `validate(selected)` is the
  // kind's own check that the new device fits (it throws); the duplicate check and the order of the steps are
  // the same for all: capture what the old device had, change the store, drop the old subscriptions, then
  // start watching the new device (with the retries every resume gets).
  async _changeMonitorIdentity(collection, item, { name, deviceId }, { validate, duplicateMessage, afterMove }) {
    let selected;
    let auxiliaryCapabilities;
    if (deviceId && deviceId !== item.deviceId) {
      selected = await this.gateway.getDevice(deviceId);
      validate(selected);
      if (Object.values(this.store.data[collection]).some((other) => other.id !== item.id && other.deviceId === selected.id && other.capability === item.capability)) throw new Error(duplicateMessage);
      auxiliaryCapabilities = this._auxiliaryCapabilitiesFor(selected, item.capability);
    }
    const old = { deviceId: item.deviceId, auxiliaryCapabilities: item.auxiliaryCapabilities || [] };
    this.store[MONITOR_KINDS[collection].identity](item, { name, device: selected, auxiliaryCapabilities });
    if (selected) {
      this.gateway.unsubscribeCapabilities(item.id, old.deviceId, item.capability, old.auxiliaryCapabilities);
      this._resumeMonitor(collection, item);
      if (afterMove) afterMove(item);
    }
    await this.store.save();
    return item;
  },

  async updateVoltageMonitorIdentity(item, change = {}) {
    return this._changeMonitorIdentity('voltageMonitors', item, change, {
      validate: (selected) => { if (!selected?.capabilities.includes(item.capability) || !item.capability.startsWith('measure_voltage')) throw new Error('The selected device must have this voltage capability.'); },
      duplicateMessage: 'A voltage monitor already uses this device and capability.'
    });
  },

  // No gateway subscription to tear down — binary counters aren't watching any device
  // capability, so removing/resetting one is just a store update.
  async removeBinaryCounter(item) {
    this.store.deleteBinaryCounter(item.id);
    await this.store.save();
  },

  async resetBinaryCounterStats(item) {
    this.store.resetBinaryCounter(item);
    await this.store.save();
  },

  // Shared by the "Add activity monitor" Flow card and the Settings "Add monitor" form — same
  // validation and creation path either way, so the two can never silently drift apart.
  async _createActivityMonitor({ deviceId, capability, threshold, name }) {
    const selected = await this.gateway.getDevice(deviceId);
    const capabilityId = capability || 'measure_power';
    if (!selected?.capabilities.includes(capabilityId)) throw new Error(`The device doesn't have the ${capabilityId} capability.`);
    const auxiliaryCapabilities = this._auxiliaryCapabilitiesFor(selected, capabilityId);
    const { monitor, created } = this.store.upsertMonitor({ device: selected, threshold, name, capability: capabilityId, auxiliaryCapabilities });
    await this.store.save();
    // Flow-card creation already logs for free via _registerFlowCards' withLogging wrapper —
    // this is the only line for the Settings-form path, which calls this directly through
    // api.js with no such wrapper. Confirmed live: a monitor created from Settings left zero
    // trace in the terminal, looking indistinguishable from a silent failure.
    this.log(created
      ? `[${monitor.name}] activity monitor created (device: ${selected.name}, capability: ${capabilityId}, threshold: ${threshold != null ? `${threshold} W` : 'auto-calibrating'})`
      : `[${monitor.name}] activity monitor already existed for this device+capability${threshold != null ? ` — threshold updated to ${threshold} W` : ''}`);
    if (created) await this._watch(monitor);
    // An existing monitor's threshold just changed (or was re-run idempotently) — re-check it
    // against the last known reading right away instead of waiting for the device's next real
    // push.
    else if (monitor.lastSample) await this._sample(monitor, monitor.lastSample.power, Date.now());
    return monitor;
  },

  // Shared by the "Update activity monitor" Flow card and the Settings "Edit" form. Unlike the
  // Flow card (whose `threshold` arg is required), threshold here is optional — Settings can
  // edit just the continuity/confirmation windows without having to re-type a value that isn't
  // changing.
  async updateActivityMonitorSettings(item, { threshold, continuityMinutes, minConfirmationSeconds } = {}) {
    this.store.updateMonitorSettings(item, { threshold, continuityMinutes, minConfirmationSeconds });
    await this.store.save();
    if (item.lastSample) await this._sample(item, item.lastSample.power, Date.now());
    return item;
  },

  async updateActivityMonitorIdentity(item, change = {}) {
    return this._changeMonitorIdentity('monitors', item, change, {
      validate: (selected) => { if (!selected?.capabilities.includes(item.capability)) throw new Error(`The selected device doesn't have the ${item.capability} capability.`); },
      duplicateMessage: 'An activity monitor already uses this device and capability.',
      // A moved monitor calibrates from the new device's own readings, not the back-off the old one had built up.
      afterMove: () => { this._lastCalibrationAttempt.delete(item.id); this._calibrationAttempts.delete(item.id); }
    });
  },

  // Reads the platform's own language for the fresh sentence a new Voltage monitor starts
  // with (see locales/<lang>.json's "voltageMessageDefaults") — falls back to store.js's
  // baked-in English constant (via the ?? in createVoltageMonitor) on any missing key,
  // missing translation, or an older Homey firmware without this.homey.__.
  _localizedVoltageMessageDefaults() {
    const keys = { undervoltage: 'voltageMessageDefaults.undervoltage', overvoltage: 'voltageMessageDefaults.overvoltage', normalized: 'voltageMessageDefaults.normalized' };
    const result = {};
    for (const [field, key] of Object.entries(keys)) {
      try {
        const value = this.homey.__(key);
        if (typeof value === 'string' && value && value !== key) result[field] = value;
      } catch (error) { /* store.js's own English default takes over */ }
    }
    return result;
  },

  async _createVoltageMonitor({ deviceId, capability, minVoltage, maxVoltage, name, stabilizationMinutes }) {
    const selected = await this.gateway.getDevice(deviceId);
    const capabilityId = capability || 'measure_voltage';
    if (!selected?.capabilities.includes(capabilityId)) throw new Error(`The device doesn't have the ${capabilityId} capability.`);
    // A device with a multi-phase meter often lists "Power Phase A" right next to "Voltage
    // Phase A" — nothing else here would catch a mixup, since the min/max range is just numbers
    // to the engine either way. Confirmed live: a real device configured this way threw a false
    // "overvoltage" whenever the appliance's wattage exceeded the voltage threshold.
    if (!capabilityId.startsWith('measure_voltage')) {
      const title = selected.capabilitiesObj?.[capabilityId]?.title || capabilityId;
      throw new Error(`"${title}" isn't a voltage capability. Pick one whose id starts with measure_voltage (e.g. "Voltage Phase A").`);
    }
    // Auto-detected, same as Activity/State — a combined energy meter (voltage + power on one
    // device) lets this monitor's own messages also use %power%/%energy%, no picker needed.
    const auxiliaryCapabilities = this._auxiliaryCapabilitiesFor(selected, capabilityId);
    const localized = this._localizedVoltageMessageDefaults();
    const { monitor, created } = this.store.upsertVoltageMonitor({
      device: selected, capability: capabilityId, minVoltage, maxVoltage, name, stabilizationMinutes, auxiliaryCapabilities,
      messageTemplateUndervoltage: localized.undervoltage, messageTemplateOvervoltage: localized.overvoltage, messageTemplateNormalized: localized.normalized
    });
    await this.store.save();
    // Flow-card creation already logs for free via _registerFlowCards' withLogging wrapper —
    // this is the only line for the Settings-form path, which calls this directly through
    // api.js with no such wrapper. Confirmed live: a monitor created from Settings left zero
    // trace in the terminal, looking indistinguishable from a silent failure.
    this.log(created
      ? `[${monitor.name}] voltage monitor created (device: ${selected.name}, capability: ${capabilityId}, range: ${minVoltage}-${maxVoltage} V)`
      : `[${monitor.name}] voltage monitor already existed for this device+capability — range updated to ${minVoltage}-${maxVoltage} V`);
    if (created) await this._watchVoltage(monitor);
    else if (monitor.lastSample) await this._voltageSample(monitor, monitor.lastSample.voltage, Date.now());
    return monitor;
  },

  async _createStateMonitor({ deviceId, capability, trueLabel, falseLabel, name, activeValues: rawActiveValues }) {
    const selected = await this.gateway.getDevice(deviceId);
    if (!selected) throw new Error('Device not found.');
    const capabilityId = capability;
    if (!capabilityId) throw new Error('Select a capability.');
    const capabilityType = selected.capabilitiesObj?.[capabilityId]?.type;
    if (capabilityType !== 'boolean' && capabilityType !== 'enum' && capabilityType !== 'string') {
      const title = selected.capabilitiesObj?.[capabilityId]?.title || capabilityId;
      throw new Error(`"${title}" isn't a boolean or multi-state capability. Pick one like a contact, motion, on/off sensor, or an appliance's own state.`);
    }
    const activeValues = Array.isArray(rawActiveValues)
      ? rawActiveValues.map((v) => String(v).trim()).filter(Boolean)
      : (rawActiveValues ? String(rawActiveValues).split(',').map((v) => v.trim()).filter(Boolean) : null);
    // An enum/string has more than two states — plain true/false has no meaning for it, so this
    // has to be told explicitly which value(s) count as active instead of guessing.
    if (capabilityType !== 'boolean' && !activeValues?.length) {
      throw new Error('This capability has multiple states — specify which value(s) count as active (e.g. "Running, Rinse").');
    }
    const auxiliaryCapabilities = this._auxiliaryCapabilitiesFor(selected, capabilityId);
    const { monitor, created } = this.store.upsertStateMonitor({ device: selected, capability: capabilityId, trueLabel, falseLabel, name, activeValues, auxiliaryCapabilities });
    await this.store.save();
    // See _createActivityMonitor's comment — same Settings-form silent-creation gap, same fix.
    this.log(created
      ? `[${monitor.name}] state monitor created (device: ${selected.name}, capability: ${capabilityId})`
      : `[${monitor.name}] state monitor already existed for this device+capability — labels/settings updated`);
    if (created) await this._watchState(monitor);
    return monitor;
  },

  async updateStateMonitorIdentity(item, change = {}) {
    return this._changeMonitorIdentity('stateMonitors', item, change, {
      validate: (selected) => {
        const type = selected?.capabilitiesObj?.[item.capability]?.type;
        if (!selected?.capabilities.includes(item.capability) || !['boolean', 'enum', 'string'].includes(type)) throw new Error(`The selected device must have a supported ${item.capability} capability.`);
        if (type !== 'boolean' && !item.activeValues?.length) throw new Error('This capability has multiple states — specify active values before changing device.');
      },
      duplicateMessage: 'A state monitor already uses this device and capability.'
    });
  }
};
