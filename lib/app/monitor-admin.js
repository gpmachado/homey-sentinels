'use strict';

// Creating, updating, resetting and removing monitors and counters (Settings and Flow share these).
// Methods are mixed into StatisticTrackerApp's prototype (see app.js), so `this` is the app.
const { AUXILIARY_CAPABILITY_CANDIDATES } = require('./constants');

module.exports = {
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
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, []);
    this.store.deleteVoltageMonitor(item.id);
    await this.store.save();
  },

  async removeStateMonitor(item) {
    this.gateway.unsubscribeCapabilities(item.id, item.deviceId, item.capability, []);
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
    const { monitor, created } = this.store.upsertVoltageMonitor({ device: selected, capability: capabilityId, minVoltage, maxVoltage, name, stabilizationMinutes });
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
  }
};
