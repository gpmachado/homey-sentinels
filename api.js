'use strict';

const { GROUP_TYPES } = require('./lib/groups');

// How old the device list may be before opening the page triggers a new read of it.
const DEVICE_LIST_MAX_AGE_MS = 5 * 60 * 1000;

// Group create/update validate members against the loaded device list. On a cold start the list
// isn't there yet: ask for it and say so instead of reporting a misleading "select two devices".
function loadedDevices(homey) {
  const directory = homey.app.directory;
  if (!directory.hasLoaded()) {
    directory.request(DEVICE_LIST_MAX_AGE_MS);
    throw new Error('The device list is still loading. Try again in a few seconds.');
  }
  return directory.list();
}

module.exports = {
  // The full device list is read on demand: this only asks the app to (re)load it in the background
  // and answers with what is loaded now (empty on the very first call); the page polls
  // getDevicesStatus and asks again once it reports the list loaded.
  async getDevices({ homey }) {
    homey.app.directory.request(DEVICE_LIST_MAX_AGE_MS);
    return homey.app.directory.list();
  },
  async getDevicesStatus({ homey }) {
    return homey.app.directory.status();
  },
  async getAvailabilityWatchdogs({ homey }) {
    return Object.values(homey.app.store.data.availabilityWatchdogs);
  },
  async createAvailabilityWatchdog({ homey, body }) {
    return homey.app.inAppContext(() => homey.app._createAvailabilityWatchdog({ deviceId: body.deviceId, thresholdHours: Number(body.thresholdHours), ignoreUnavailable: body.ignoreUnavailable === true || body.ignoreUnavailable === 'true' }));
  },
  async deleteAvailabilityWatchdog({ homey, params }) {
    const item = homey.app.store.data.availabilityWatchdogs[params.deviceId];
    if (!item) throw new Error('Watchdog not found.');
    await homey.app.removeAvailabilityWatchdog(params.deviceId);
    return { ok: true };
  },
  async getGroups({ homey }) {
    return Object.values(homey.app.store.data.groups);
  },
  async getMonitorsSummary({ homey, query }) {
    return homey.app.getMonitorsSummary(query.period);
  },
  async createActivityMonitor({ homey, body }) {
    return homey.app.inAppContext(() => homey.app._createActivityMonitor({ deviceId: body.deviceId, capability: body.capability, threshold: body.threshold, name: body.name }));
  },
  async deleteMonitor({ homey, params }) {
    const item = homey.app.store.data.monitors[params.id];
    if (!item) throw new Error('Monitor not found.');
    await homey.app.removeMonitor(item);
    return { ok: true };
  },
  async resetMonitor({ homey, params }) {
    const item = homey.app.store.data.monitors[params.id];
    if (!item) throw new Error('Monitor not found.');
    await homey.app.resetMonitorStats(item);
    return { ok: true };
  },
  async updateMonitor({ homey, params, body }) {
    const item = homey.app.store.data.monitors[params.id];
    if (!item) throw new Error('Monitor not found.');
    await homey.app.updateActivityMonitorSettings(item, { threshold: body.threshold, continuityMinutes: body.continuityMinutes, minConfirmationSeconds: body.minConfirmationSeconds });
    return item;
  },
  async updateMonitorMessages({ homey, params, body }) {
    const item = homey.app.store.data.monitors[params.id];
    if (!item) throw new Error('Monitor not found.');
    const { messageTemplateStarted, messageTemplateFinished } = body;
    homey.app.store.updateMonitorMessages(item, { messageTemplateStarted, messageTemplateFinished });
    await homey.app.store.save();
    return item;
  },
  async getVoltageMonitorsSummary({ homey, query }) {
    return homey.app.getVoltageMonitorsSummary(query.period);
  },
  async createVoltageMonitor({ homey, body }) {
    return homey.app.inAppContext(() => homey.app._createVoltageMonitor({ deviceId: body.deviceId, capability: body.capability, minVoltage: body.minVoltage, maxVoltage: body.maxVoltage, name: body.name, stabilizationMinutes: body.stabilizationMinutes }));
  },
  async deleteVoltageMonitor({ homey, params }) {
    const item = homey.app.store.data.voltageMonitors[params.id];
    if (!item) throw new Error('Voltage monitor not found.');
    await homey.app.removeVoltageMonitor(item);
    return { ok: true };
  },
  async resetVoltageMonitor({ homey, params }) {
    const item = homey.app.store.data.voltageMonitors[params.id];
    if (!item) throw new Error('Voltage monitor not found.');
    await homey.app.resetVoltageMonitorStats(item);
    return { ok: true };
  },
  async updateVoltageMonitor({ homey, params, body }) {
    const item = homey.app.store.data.voltageMonitors[params.id];
    if (!item) throw new Error('Voltage monitor not found.');
    await homey.app.updateVoltageMonitorRange(item, { minVoltage: body.minVoltage, maxVoltage: body.maxVoltage, stabilizationMinutes: body.stabilizationMinutes });
    return item;
  },
  async updateVoltageMonitorMessages({ homey, params, body }) {
    const item = homey.app.store.data.voltageMonitors[params.id];
    if (!item) throw new Error('Voltage monitor not found.');
    const { messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized } = body;
    homey.app.store.updateVoltageMonitor(item, { messageTemplateUndervoltage, messageTemplateOvervoltage, messageTemplateNormalized });
    await homey.app.store.save();
    return item;
  },
  async getStateMonitorsSummary({ homey, query }) {
    return homey.app.getStateMonitorsSummary(query.period);
  },
  async createStateMonitor({ homey, body }) {
    return homey.app.inAppContext(() => homey.app._createStateMonitor({ deviceId: body.deviceId, capability: body.capability, trueLabel: body.trueLabel, falseLabel: body.falseLabel, name: body.name, activeValues: body.activeValues }));
  },
  async deleteStateMonitor({ homey, params }) {
    const item = homey.app.store.data.stateMonitors[params.id];
    if (!item) throw new Error('State monitor not found.');
    await homey.app.removeStateMonitor(item);
    return { ok: true };
  },
  async resetStateMonitor({ homey, params }) {
    const item = homey.app.store.data.stateMonitors[params.id];
    if (!item) throw new Error('State monitor not found.');
    await homey.app.resetStateMonitorStats(item);
    return { ok: true };
  },
  async updateStateMonitor({ homey, params, body }) {
    const item = homey.app.store.data.stateMonitors[params.id];
    if (!item) throw new Error('State monitor not found.');
    homey.app.store.updateStateMonitor(item, { trueLabel: body.trueLabel, falseLabel: body.falseLabel, activeValues: body.activeValues });
    await homey.app.store.save();
    homey.app.log(`[${item.name}] state monitor settings updated`);
    return item;
  },
  async updateStateMonitorMessages({ homey, params, body }) {
    const item = homey.app.store.data.stateMonitors[params.id];
    if (!item) throw new Error('State monitor not found.');
    const { messageTemplateStarted, messageTemplateFinished } = body;
    homey.app.store.updateStateMonitorMessages(item, { messageTemplateStarted, messageTemplateFinished });
    await homey.app.store.save();
    return item;
  },
  async getBinaryCountersSummary({ homey, query }) {
    return homey.app.getBinaryCountersSummary(query.period);
  },
  async createBinaryCounter({ homey, body }) {
    const counter = homey.app.store.upsertBinaryCounter({ name: body.name });
    await homey.app.store.save();
    return counter;
  },
  async deleteBinaryCounter({ homey, params }) {
    const item = homey.app.store.data.binaryCounters[params.id];
    if (!item) throw new Error('Binary counter not found.');
    await homey.app.removeBinaryCounter(item);
    return { ok: true };
  },
  async resetBinaryCounter({ homey, params }) {
    const item = homey.app.store.data.binaryCounters[params.id];
    if (!item) throw new Error('Binary counter not found.');
    await homey.app.resetBinaryCounterStats(item);
    return { ok: true };
  },
  async updateBinaryCounterMessage({ homey, params, body }) {
    const item = homey.app.store.data.binaryCounters[params.id];
    if (!item) throw new Error('Binary counter not found.');
    homey.app.store.updateBinaryCounter(item, { messageTemplate: body.messageTemplate });
    await homey.app.store.save();
    return item;
  },
  async createGroup({ homey, body }) {
    const { name, type, expectedState, deviceIds = [], conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany } = body;
    if (deviceIds.length < 2) throw new Error('Select at least two devices.');
    const devices = loadedDevices(homey);
    const selected = deviceIds.map((id) => devices.find((device) => device.id === id)).filter(Boolean);
    selected.forEach((device) => homey.app._assertGroupDevice({ type }, device));
    const group = homey.app.store.createGroup({ name, type, expectedState, devices: selected, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany });
    await homey.app.store.save();
    return group;
  },
  async updateGroup({ homey, params, body }) {
    const group = homey.app.store.data.groups[params.id];
    if (!group) throw new Error('Group not found.');
    const { name, type, expectedState, deviceIds, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany } = body;
    // Validate devices against the (possibly new) type before touching the group, so a failure
    // leaves it unchanged. A type change re-checks the existing devices too when none were resent.
    if (type !== undefined && !GROUP_TYPES[type]) throw new Error('Unknown group type.');
    const candidate = { ...group, type: type !== undefined ? type : group.type };
    const devices = loadedDevices(homey);
    let selected = null;
    if (Array.isArray(deviceIds)) {
      if (deviceIds.length < 2) throw new Error('Select at least two devices.');
      selected = deviceIds.map((id) => devices.find((device) => device.id === id)).filter(Boolean);
    } else if (candidate.type !== group.type) {
      selected = group.devices.map(({ id }) => devices.find((device) => device.id === id)).filter(Boolean);
    }
    if (selected) selected.forEach((device) => homey.app._assertGroupDevice(candidate, device));
    homey.app.store.updateGroup(group, { name, type, expectedState, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany });
    if (Array.isArray(deviceIds)) homey.app.store.setGroupDevices(group, selected);
    await homey.app.store.save();
    return group;
  },
  // On-demand only (not fetched automatically when the Groups tab loads) — a check reads
  // every device in the group live, and doing that for every group on every page load would
  // be slow and pointless if the user just wants to see the config, not the current status.
  async checkGroupStatus({ homey, params }) {
    const group = homey.app.store.data.groups[params.id];
    if (!group) throw new Error('Group not found.');
    return homey.app.inAppContext(() => homey.app._checkGroup(group));
  },
  async deleteGroup({ homey, params }) {
    homey.app.store.deleteGroup(params.id);
    await homey.app.store.save();
    return { ok: true };
  },
  async getTimezone({ homey }) {
    return homey.app.getTimezoneSettings();
  },
  async setTimezone({ homey, body }) {
    return homey.app.setTimezoneOverride(body.timeZone);
  }
};
