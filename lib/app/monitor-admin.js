'use strict';

// Creating, updating, resetting and removing monitors and counters (Settings and Flow share these).
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { resumeWithRetry } = require('../resume');
const { isNotFoundError } = require('../availability');
const { AUXILIARY_CAPABILITY_CANDIDATES, MONITOR_MISSING_ATTEMPTS } = require('./constants');

module.exports = {
  // Starts watching a saved monitor's device, with retries (right after a Homey reboot the apps start before the
  // devices are ready). A device Homey keeps answering "Not Found" for is gone: the monitor is flagged
  // (deviceMissing, shown in Settings) and the retries stop, instead of logging the same error every few
  // minutes for ever. The monitor and its history are kept; deleting it is the user's call.
  _resumeMonitor(kind, collection, monitor) {
    const watch = { monitors: (item) => this._watch(item), voltageMonitors: (item) => this._watchVoltage(item), stateMonitors: (item) => this._watchState(item) }[collection];
    resumeWithRetry({
      label: `[${monitor.name}] ${kind}`,
      start: () => watch(monitor),
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
    const kinds = [['monitor', 'monitors'], ['voltage monitor', 'voltageMonitors'], ['state monitor', 'stateMonitors']];
    for (const [kind, collection] of kinds) {
      for (const monitor of Object.values(this.store.data[collection])) {
        if (!monitor.deviceId) continue;
        if (!present.has(monitor.deviceId)) this._flagMonitorDeviceMissing(monitor, true);
        else if (monitor.deviceMissing) { this._flagMonitorDeviceMissing(monitor, false); this._resumeMonitor(kind, collection, monitor); }
      }
    }
  },

  // Shared by the remove_activity_monitor Flow action and the Settings page's delete button —
  // both need the exact same unsubscribe-then-forget sequence, not just a store update.
  async removeMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, item.auxiliaryCapabilities);
    this._lastCalibrationAttempt.delete(item.id);
    this._calibrationAttempts.delete(item.id);
    delete this.store.data.monitors[item.id];
    await this.store.save();
  },

  async removeVoltageMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, item.auxiliaryCapabilities || []);
    this.store.deleteVoltageMonitor(item.id);
    await this.store.save();
  },

  async removeStateMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, item.auxiliaryCapabilities || []);
    delete this.store.data.stateMonitors[item.id];
    await this.store.save();
  },

  // Shared by the reset Flow actions and the Settings page's "Reset stats" button — wipes
  // accumulated data while leaving the monitor's own configuration and live subscription
  // untouched (unlike remove*, nothing needs to unsubscribe/resubscribe here).
  async resetMonitorStats(item) {
    this.store.resetMonitor(item);
    await this.store.save();
  },

  async resetVoltageMonitorStats(item) {
    this.store.resetVoltageMonitor(item);
    await this.store.save();
  },

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

  async updateVoltageMonitorIdentity(item, { name, deviceId } = {}) {
    let selected;
    let auxiliaryCapabilities;
    if (deviceId && deviceId !== item.deviceId) {
      selected = await this.gateway.getDevice(deviceId);
      if (!selected?.capabilities.includes(item.capability) || !item.capability.startsWith('measure_voltage')) throw new Error('The selected device must have this voltage capability.');
      if (Object.values(this.store.data.voltageMonitors).some((other) => other.id !== item.id && other.deviceId === selected.id && other.capability === item.capability)) throw new Error('A voltage monitor already uses this device and capability.');
      auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== item.capability && selected.capabilities.includes(cap));
    }
    const oldDeviceId = item.deviceId;
    const oldAuxiliaryCapabilities = item.auxiliaryCapabilities || [];
    this.store.updateVoltageMonitorIdentity(item, { name, device: selected, auxiliaryCapabilities });
    if (selected) {
      this.gateway.unsubscribeCapabilities(item.id, oldDeviceId, item.capability, oldAuxiliaryCapabilities);
      this._resumeMonitor('voltage monitor', 'voltageMonitors', item);
    }
    await this.store.save();
    return item;
  },

  async resetStateMonitorStats(item) {
    this.store.resetStateMonitor(item);
    await this.store.save();
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
    const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && selected.capabilities.includes(cap));
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

  async updateActivityMonitorIdentity(item, { name, deviceId } = {}) {
    let selected;
    if (deviceId && deviceId !== item.deviceId) {
      selected = await this.gateway.getDevice(deviceId);
      if (!selected?.capabilities.includes(item.capability)) throw new Error(`The selected device doesn't have the ${item.capability} capability.`);
      if (Object.values(this.store.data.monitors).some((other) => other.id !== item.id && other.deviceId === selected.id && other.capability === item.capability)) throw new Error('An activity monitor already uses this device and capability.');
    }
    const old = { deviceId: item.deviceId, capability: item.capability, auxiliaryCapabilities: item.auxiliaryCapabilities };
    this.store.updateMonitorIdentity(item, { name, device: selected, auxiliaryCapabilities: selected ? AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== item.capability && selected.capabilities.includes(cap)) : undefined });
    if (selected) {
      this.gateway.unsubscribeCapabilities(item.id, old.deviceId, old.capability, old.auxiliaryCapabilities);
      this._resumeMonitor('activity monitor', 'monitors', item);
      this._lastCalibrationAttempt.delete(item.id);
      this._calibrationAttempts.delete(item.id);
    }
    await this.store.save();
    return item;
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
    const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && selected.capabilities.includes(cap));
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
    const auxiliaryCapabilities = AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== capabilityId && selected.capabilities.includes(cap));
    const { monitor, created } = this.store.upsertStateMonitor({ device: selected, capability: capabilityId, trueLabel, falseLabel, name, activeValues, auxiliaryCapabilities });
    await this.store.save();
    // See _createActivityMonitor's comment — same Settings-form silent-creation gap, same fix.
    this.log(created
      ? `[${monitor.name}] state monitor created (device: ${selected.name}, capability: ${capabilityId})`
      : `[${monitor.name}] state monitor already existed for this device+capability — labels/settings updated`);
    if (created) await this._watchState(monitor);
    return monitor;
  },

  async updateStateMonitorIdentity(item, { name, deviceId } = {}) {
    let selected;
    if (deviceId && deviceId !== item.deviceId) {
      selected = await this.gateway.getDevice(deviceId);
      const type = selected?.capabilitiesObj?.[item.capability]?.type;
      if (!selected?.capabilities.includes(item.capability) || !['boolean', 'enum', 'string'].includes(type)) throw new Error(`The selected device must have a supported ${item.capability} capability.`);
      if (Object.values(this.store.data.stateMonitors).some((other) => other.id !== item.id && other.deviceId === selected.id && other.capability === item.capability)) throw new Error('A state monitor already uses this device and capability.');
      if (type !== 'boolean' && !item.activeValues?.length) throw new Error('This capability has multiple states — specify active values before changing device.');
    }
    const old = { deviceId: item.deviceId, capability: item.capability, auxiliaryCapabilities: item.auxiliaryCapabilities || [] };
    this.store.updateStateMonitorIdentity(item, { name, device: selected, auxiliaryCapabilities: selected ? AUXILIARY_CAPABILITY_CANDIDATES.filter((cap) => cap !== item.capability && selected.capabilities.includes(cap)) : undefined });
    if (selected) {
      this.gateway.unsubscribeCapabilities(item.id, old.deviceId, old.capability, old.auxiliaryCapabilities);
      this._resumeMonitor('state monitor', 'stateMonitors', item);
    }
    await this.store.save();
    return item;
  }
};
