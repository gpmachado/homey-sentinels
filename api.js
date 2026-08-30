'use strict';

module.exports = {
  async getDevices({ homey }) {
    return homey.app.gateway.getCachedDevices();
  },
  async getGroups({ homey }) {
    return Object.values(homey.app.store.data.groups);
  },
  async getMonitorsSummary({ homey, query }) {
    return homey.app.getMonitorsSummary(query.period);
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
    const devices = homey.app.gateway.getCachedDevices();
    const selected = deviceIds.map((id) => devices.find((device) => device.id === id)).filter(Boolean);
    selected.forEach((device) => homey.app._assertGroupDevice({ type }, device));
    const group = homey.app.store.createGroup({ name, type, expectedState, devices: selected, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany });
    await homey.app.store.save();
    return group;
  },
  async updateGroup({ homey, params, body }) {
    const group = homey.app.store.data.groups[params.id];
    if (!group) throw new Error('Group not found.');
    const { name, expectedState, deviceIds, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany } = body;
    homey.app.store.updateGroup(group, { name, expectedState, conjunction, messageTemplateZero, messageTemplateOne, messageTemplateMany });
    if (Array.isArray(deviceIds)) {
      if (deviceIds.length < 2) throw new Error('Select at least two devices.');
      const devices = homey.app.gateway.getCachedDevices();
      const selected = deviceIds.map((id) => devices.find((device) => device.id === id)).filter(Boolean);
      selected.forEach((device) => homey.app._assertGroupDevice(group, device));
      homey.app.store.setGroupDevices(group, selected);
    }
    await homey.app.store.save();
    return group;
  },
  // On-demand only (not fetched automatically when the Groups tab loads) — a check reads
  // every device in the group live, and doing that for every group on every page load would
  // be slow and pointless if the user just wants to see the config, not the current status.
  async checkGroupStatus({ homey, params }) {
    const group = homey.app.store.data.groups[params.id];
    if (!group) throw new Error('Group not found.');
    return homey.app._checkGroup(group);
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
