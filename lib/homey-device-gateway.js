'use strict';

const { HomeyAPI } = require('homey-api');

// The Web API is read-only in this app. No PUT/POST request is ever made to a device.
// Uses the homey-api package (HomeyAPI.createAppAPI), the officially documented client
// for apps holding the homey:manager:api permission. Each subscription is a targeted
// Device#makeCapabilityInstance() — it opens a per-device realtime channel scoped to
// one capability, rather than one global device.update listener filtered client-side.
class HomeyDeviceGateway {
  constructor(homey) { this.homey = homey; this.instances = new Map(); this.deviceRefs = new Map(); this.api = null; this._zoneNames = new Map(); this._zonesLoadedAt = 0; }

  async _getApi() {
    if (!this.api) this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    return this.api;
  }

  // What Homey's own supervisor sees for this app ({ cpu, mem }) — the number its "Memory Warning
  // Limit" (reported ~150 MB, kill after ~50 s above it) is judged on. process.memoryUsage() can't
  // read RSS inside the app sandbox, so this is the only way to see it from in here.
  async getOwnUsage() {
    const api = await this._getApi();
    return api.apps.getAppUsage({ id: this.homey.manifest.id });
  }

  // Whole-Homey memory (total, free, swap and every app's share) — needs the homey.system.readonly
  // scope; callers treat a rejection as "not permitted" and carry on.
  async getSystemMemory() {
    const api = await this._getApi();
    return api.system.getMemoryInfo();
  }

  _normalize(device, zones = {}) {
    return {
      id: device.id,
      name: device.name,
      capabilities: device.capabilities || [],
      capabilitiesObj: device.capabilitiesObj || {},
      zoneName: zones[device.zone]?.name || null,
      // Generic to every device regardless of protocol (Zigbee/Z-Wave/Wi-Fi/cloud) — Homey's
      // own driver layer maintains these, no separate per-protocol polling needed here.
      available: device.available !== false,
      lastSeenAt: device.lastSeenAt || null,
      unavailableMessage: device.unavailableMessage || null
    };
  }

  // What the pickers, the Availability tab and the Flow autocompletes use of a device, and no more:
  // identity, zone, availability, the capability ids, and per capability only its type and title
  // (plus the current value where a value is what the picker shows: booleans, enums, strings and the
  // power/energy/current/voltage readings). The raw device from homey-api carries icons, options,
  // per-language strings and driver internals that nothing here reads.
  _slim(device, zones = {}) {
    const capabilitiesObj = {};
    for (const id of device.capabilities || []) {
      const capability = device.capabilitiesObj?.[id];
      if (!capability) continue;
      const wantsValue = ['boolean', 'enum', 'string'].includes(capability.type) || /^(measure_(power|voltage|current|battery)|meter_power)(\.|$)/.test(id);
      capabilitiesObj[id] = { type: capability.type, title: capability.title };
      if (wantsValue) capabilitiesObj[id].value = capability.value;
    }
    return {
      id: device.id,
      name: device.name,
      capabilities: [...(device.capabilities || [])],
      capabilitiesObj,
      zoneName: zones[device.zone]?.name || null,
      // The app that owns the device ("homey:app:com.x"): lets the availability scan skip whole apps whose
      // devices are virtual and so never report (a Linked Switches virtual switch, say).
      ownerUri: device.ownerUri || null,
      available: device.available !== false,
      lastSeenAt: device.lastSeenAt || null,
      unavailableMessage: device.unavailableMessage || null
    };
  }

  // The slim list of EVERY device. Expensive (see lib/device-directory.js): the whole response is
  // parsed at once, which grows the process for good — call it rarely and never from an API route.
  async listDevices() {
    const api = await this._getApi();
    const [devices, zones] = await Promise.all([api.devices.getDevices(), api.zones.getZones()]);
    this._rememberZones(zones);
    return Object.values(devices).map((device) => this._slim(device, zones));
  }

  _rememberZones(zones) {
    this._zoneNames = new Map(Object.values(zones || {}).map((zone) => [zone.id, zone.name]));
    this._zonesLoadedAt = Date.now();
  }
  async _zoneName(zoneId) {
    if (!zoneId) return null;
    if (!this._zoneNames.has(zoneId) && Date.now() - this._zonesLoadedAt > 10 * 60 * 1000) {
      const api = await this._getApi();
      this._rememberZones(await api.zones.getZones());
    }
    return this._zoneNames.get(zoneId) || null;
  }

  // homey.clock.getTimezone() can misreport (confirmed returning "UTC" while Homey's own
  // System Information screen shows the real configured zone). system.getInfo().timezone,
  // read through this same already-authorized HomeyAPI client, matches what that screen
  // shows — cached in settings for the same reason the device cache is: a settings route
  // can't call the live API directly.
  async refreshSystemTimezone() {
    const api = await this._getApi();
    const info = await api.system.getInfo();
    if (info?.timezone) await this.homey.settings.set('systemTimezone', info.timezone);
    return info?.timezone || null;
  }
  getCachedSystemTimezone() { return this.homey.settings.get('systemTimezone') || null; }

  async getDevice(id) {
    const api = await this._getApi();
    const device = await api.devices.getDevice({ id });
    if (!device) return null;
    const normalized = this._normalize(device);
    normalized.zoneName = await this._zoneName(device.zone);
    return normalized;
  }

  // One retained `device` object per DEVICE (not per capability), shared by every capability
  // subscription on it. This matters beyond avoiding redundant getDevice() calls: an auxiliary
  // capability's only job is to keep device.capabilitiesObj[auxId] mutated in place so a
  // primary-capability handler can read a fresh sibling value off the SAME object — if each
  // capability instead got its own separately-fetched device object (a real regression this
  // file had), the auxiliary's updates would land on an object nothing ever reads from, and
  // _sample()'s current/energy reads would stay frozen at whatever they were when the primary
  // subscription was first created. Confirmed live: a 42-minute pump cycle reported a constant,
  // wrong average current the entire time because of exactly this.
  async _getDeviceRef(deviceId) {
    let ref = this.deviceRefs.get(deviceId);
    if (!ref) {
      const api = await this._getApi();
      const device = await api.devices.getDevice({ id: deviceId });
      if (!device) throw new Error('Device not found.');
      ref = { device, refCount: 0 };
      this.deviceRefs.set(deviceId, ref);
    }
    return ref;
  }

  // One makeCapabilityInstance() per device+capability, shared by every monitor that watches
  // it — e.g. an activity monitor's auto-detected auxiliary capability (measure_voltage) and a
  // dedicated voltage monitor can legitimately both target the very same capability id on the
  // same device. `ownerId` (the monitor's own id) scopes each monitor's own handler in a fan-out
  // map, so a second monitor subscribing to an already-claimed capability gets its own live
  // updates too, instead of silently receiving nothing forever behind the first subscriber
  // (confirmed via a monitor whose stats stayed frozen on stale data while Homey's own Insights
  // for that same capability kept updating normally).
  async _subscribeOne(ownerId, deviceId, capabilityId, handler) {
    const key = `${deviceId}:${capabilityId}`;
    let entry = this.instances.get(key);
    if (!entry) {
      const ref = await this._getDeviceRef(deviceId);
      entry = { device: ref.device, handlers: new Map() };
      // makeCapabilityInstance mutates device.capabilitiesObj[capabilityId] in place on every
      // update, so re-reading it from this one retained `device` reference stays live for
      // every owner sharing it — no re-fetch needed per event.
      entry.instance = ref.device.makeCapabilityInstance(capabilityId, (value) => {
        // Written back when every monitor was numeric (power/voltage) — rejects a null/
        // undefined/garbage reading from ever reaching a threshold comparison. A state
        // monitor's boolean capability (alarm_contact, onoff) needs to pass through the same
        // guard too, or every door-open/close event gets silently dropped right here.
        if (!Number.isFinite(value) && typeof value !== 'boolean') return;
        for (const ownerHandler of entry.handlers.values()) {
          if (!ownerHandler) continue; // passive/auxiliary owner — just keeps capabilitiesObj live
          Promise.resolve(ownerHandler(value, Date.now(), this._normalize(entry.device))).catch((error) => this.homey.error(error));
        }
      });
      this.instances.set(key, entry);
      ref.refCount += 1;
    }
    entry.handlers.set(ownerId, handler || null);
    if (handler) {
      const initialValue = entry.device.capabilitiesObj?.[capabilityId]?.value;
      if (Number.isFinite(initialValue) || typeof initialValue === 'boolean') await handler(initialValue, Date.now(), this._normalize(entry.device));
    }
  }

  async subscribeCapabilities(ownerId, deviceId, primaryCapabilityId, auxiliaryCapabilityIds, handler) {
    await this._subscribeOne(ownerId, deviceId, primaryCapabilityId, handler);
    const primaryEntry = this.instances.get(`${deviceId}:${primaryCapabilityId}`);
    for (const auxId of auxiliaryCapabilityIds || []) {
      if (auxId === primaryCapabilityId || !primaryEntry.device.capabilities.includes(auxId)) continue;
      await this._subscribeOne(ownerId, deviceId, auxId, null);
    }
  }

  // Only removes this owner's handler — the underlying instance is destroyed only once no
  // monitor references that device+capability anymore, so removing one monitor never cuts off
  // another monitor still sharing the same capability. The shared device ref is dropped once
  // nothing on that device is subscribed to anything anymore.
  unsubscribeCapabilities(ownerId, deviceId, primaryCapabilityId, auxiliaryCapabilityIds) {
    for (const capabilityId of [primaryCapabilityId, ...(auxiliaryCapabilityIds || [])]) {
      const key = `${deviceId}:${capabilityId}`;
      const entry = this.instances.get(key);
      if (!entry) continue;
      entry.handlers.delete(ownerId);
      if (entry.handlers.size === 0) {
        entry.instance.destroy();
        this.instances.delete(key);
        const ref = this.deviceRefs.get(deviceId);
        if (ref) {
          ref.refCount -= 1;
          if (ref.refCount <= 0) this.deviceRefs.delete(deviceId);
        }
      }
    }
  }
}

module.exports = HomeyDeviceGateway;
