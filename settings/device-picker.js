/* global byName */

// The Capability -> Zone -> Device -> phase pickers of the monitor forms, filled from the loaded device list.
function setupDevicePicker(page) {
  // Shared by the three "Add monitor" forms below, backed by the already-cached `allDevices` list instead of a
  // live query. With a couple of hundred devices a long list to scroll is the hard part, so the picker narrows
  // from the most selective choice: the capability first (a monitor kind only ever uses one kind of capability:
  // power for Activity, voltage for Voltage, on/off or multi-state for State), then the zone among the zones that
  // have a device with it, then the device.
  function findDevice(id) { return page.allDevices.filter(function (d) { return d.id === id; })[0]; }
  // A State monitor tracks something that holds for a while (open/closed, on/off, a washer running). A device also has
  // dozens of capabilities that never are one: buttons, media controls, maintenance actions, settings, firmware, free
  // text. By default only the ones that read as a state are offered, and "Show every capability" lists the rest.
  // On/off-type: alarms, switches, lock, door and cover state, connection, playing. Multi-state: the id ends in
  // operation, state or status (machine_state, WM-operation, DEVICE-state, status_string).
  var STATE_LIKE_BOOLEAN = /^(alarm_|onoff|garagedoor_closed|locked|windowcoverings_closed|connected|speaker_playing)/;
  var STATE_LIKE_MULTI = /(operation|state|status)(_string)?$/i;
  function isStateLike(capabilityId, type) {
    return type === 'boolean' ? STATE_LIKE_BOOLEAN.test(capabilityId) : STATE_LIKE_MULTI.test(capabilityId);
  }
  function eligibleCapabilities(device, kind, showAll) {
    if (!device) return [];
    var caps = device.capabilities || [];
    if (kind === 'activity') return caps.filter(function (c) { return c.indexOf('measure_power') === 0; });
    if (kind === 'voltage') return caps.filter(function (c) { return c.indexOf('measure_voltage') === 0; });
    if (kind === 'state') return caps.filter(function (c) {
      var type = device.capabilitiesObj && device.capabilitiesObj[c] && device.capabilitiesObj[c].type;
      if (type !== 'boolean' && type !== 'enum' && type !== 'string') return false;
      return showAll || isStateLike(c, type);
    });
    return caps;
  }
  // A flat, alphabetical device list gets unwieldy fast on a real setup (50+ devices) —
  // same problem gpm.linked.switches' own device picker solved with a zone filter above
  // the device list itself. `getDevices()` only gives us each device's resolved zoneName
  // (no zoneId), so filtering matches on that string directly — fine, since it's what's
  // actually shown to the user anyway.
  // "measure_voltage.a", ".b", ".pv1" and plain "measure_voltage" are one thing to a person (a voltage), so the first
  // choice is the family (the id before the first dot) and the phase or channel is only asked at the end, for a device
  // that has more than one in that family.
  function capabilityFamily(id) { return String(id).split('.')[0]; }
  function familyCapabilities(device, kind, family, showAll) {
    return eligibleCapabilities(device, kind, showAll).filter(function (cap) { return capabilityFamily(cap) === family; });
  }
  function devicesInFamily(kind, family, showAll) {
    return page.allDevices.filter(function (device) { return familyCapabilities(device, kind, family, showAll).length > 0; });
  }
  function emptyOption(selectEl, text) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = text;
    selectEl.appendChild(opt);
  }
  function capabilityTitle(device, cap) {
    var title = device.capabilitiesObj && device.capabilitiesObj[cap] && device.capabilitiesObj[cap].title;
    return title || cap;
  }
  function humanizeId(id) {
    var text = String(id).replace(/^measure_/, '').replace(/[_-]+/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  // Every family a monitor of this kind can use, among all devices, with how many devices have something in it. Named
  // after the family's own capability when some device has it ("Voltage" for measure_voltage), else from the id.
  function populateFamilySelect(selectEl, kind, preselect, showAll) {
    selectEl.innerHTML = '';
    var found = {};
    page.allDevices.forEach(function (device) {
      var seen = {};
      eligibleCapabilities(device, kind, showAll).forEach(function (cap) {
        var family = capabilityFamily(cap);
        found[family] = found[family] || { id: family, title: null, count: 0 };
        if (cap === family) found[family].title = capabilityTitle(device, cap);
        if (!seen[family]) { seen[family] = true; found[family].count += 1; }
      });
    });
    var list = Object.keys(found).map(function (family) {
      found[family].title = found[family].title || humanizeId(family);
      return found[family];
    }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    if (!list.length) { emptyOption(selectEl, 'No device has a capability this monitor can use'); return; }
    list.forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.title + ' (' + item.id + ') — ' + item.count + ' device' + (item.count === 1 ? '' : 's');
      selectEl.appendChild(opt);
    });
    selectEl.value = found[preselect] ? preselect : list[0].id;
  }
  // Only the zones that have a device in the chosen family; the zone already picked stays if it still fits.
  function populateZoneSelect(selectEl, kind, family, showAll) {
    var current = selectEl.value;
    selectEl.innerHTML = '';
    emptyOption(selectEl, 'All zones');
    var counts = {};
    devicesInFamily(kind, family, showAll).forEach(function (d) { if (d.zoneName) counts[d.zoneName] = (counts[d.zoneName] || 0) + 1; });
    Object.keys(counts).sort().forEach(function (zone) {
      var opt = document.createElement('option');
      opt.value = zone;
      opt.textContent = zone + ' (' + counts[zone] + ')';
      selectEl.appendChild(opt);
    });
    selectEl.value = counts[current] ? current : '';
  }
  function populateDeviceSelect(selectEl, zoneName, kind, family, showAll, search) {
    selectEl.innerHTML = '';
    var wanted = (search || '').trim().toLowerCase();
    devicesInFamily(kind, family, showAll)
      .filter(function (device) { return !zoneName || device.zoneName === zoneName; })
      .filter(function (device) { return !wanted || device.name.toLowerCase().indexOf(wanted) !== -1; })
      .sort(byName)
      .forEach(function (device) {
        var opt = document.createElement('option');
        opt.value = device.id;
        opt.textContent = device.name + (device.zoneName ? ' (' + device.zoneName + ')' : '');
        selectEl.appendChild(opt);
      });
  }
  // The chosen device's own capabilities in the family (its phases or channels), the family's own id first when it has it.
  function populateCapabilitySelect(selectEl, device, kind, family, showAll) {
    selectEl.innerHTML = '';
    var caps = device ? familyCapabilities(device, kind, family, showAll) : [];
    caps.sort(function (a, b) { return (a === family ? -1 : b === family ? 1 : a.localeCompare(b)); });
    caps.forEach(function (cap) {
      var opt = document.createElement('option');
      opt.value = cap;
      opt.textContent = capabilityTitle(device, cap) + ' (' + cap + ')';
      selectEl.appendChild(opt);
    });
    return caps.length;
  }
  function populateCompatibleDeviceSelect(selectEl, capability, currentId, currentName) {
    selectEl.innerHTML = '';
    page.allDevices.filter(function (device) { return (device.capabilities || []).indexOf(capability) !== -1; })
      .sort(byName).forEach(function (device) {
        var opt = document.createElement('option');
        opt.value = device.id;
        opt.textContent = device.name + (device.zoneName ? ' (' + device.zoneName + ')' : '');
        selectEl.appendChild(opt);
      });
    if (currentId && Array.prototype.some.call(selectEl.options, function (option) { return option.value === currentId; })) selectEl.value = currentId;
    else if (currentId) {
      var missing = document.createElement('option');
      missing.value = currentId;
      missing.textContent = (currentName || 'Current device') + ' (not available)';
      selectEl.appendChild(missing);
      selectEl.value = currentId;
    }
  }
  // Wires Capability (family) -> Zone -> Device -> phase/channel for all three "Add monitor" forms (one place instead of
  // a hand-wired copy per form). The last step only shows when the chosen device has more than one in the family.
  // `refresh()` fills everything from the loaded device list; `options.preselectCapability` is the family to start on
  // (Activity: measure_power); `options.onChange` is how State shows its active-values field for a multi-state
  // capability, and runs whenever the family, the device or the capability changes; `options.showAll()` says whether to
  // list every capability instead of only the ones that fit the kind best (State).
  function setupDeviceCapabilityPicker(prefix, kind, options) {
    options = options || {};
    var familyEl = document.getElementById(prefix + '-family');
    var zoneEl = document.getElementById(prefix + '-zone');
    var deviceEl = document.getElementById(prefix + '-device');
    var capabilityEl = document.getElementById(prefix + '-capability');
    var capabilityWrap = document.getElementById(prefix + '-capability-wrap');
    var searchEl = document.getElementById(prefix + '-search'); // the Add forms have a name search, the edit forms do not
    function showAll() { return options.showAll ? options.showAll() : false; }
    function changed() { if (options.onChange) options.onChange(); }
    function refreshCapabilities() {
      var count = populateCapabilitySelect(capabilityEl, findDevice(deviceEl.value), kind, familyEl.value, showAll());
      capabilityWrap.classList.toggle('hidden', count < 2);
      changed();
    }
    function refreshDevices() { populateDeviceSelect(deviceEl, zoneEl.value, kind, familyEl.value, showAll(), searchEl ? searchEl.value : ''); refreshCapabilities(); }
    function refreshZones() { populateZoneSelect(zoneEl, kind, familyEl.value, showAll()); refreshDevices(); }
    function refresh() { populateFamilySelect(familyEl, kind, options.preselectCapability, showAll()); refreshZones(); }
    familyEl.addEventListener('change', refreshZones);
    zoneEl.addEventListener('change', refreshDevices);
    if (searchEl) searchEl.addEventListener('input', refreshDevices);
    deviceEl.addEventListener('change', refreshCapabilities);
    capabilityEl.addEventListener('change', changed);
    return { refresh: refresh };
  }

  page.findDevice = findDevice;
  page.populateCompatibleDeviceSelect = populateCompatibleDeviceSelect;
  page.setupDeviceCapabilityPicker = setupDeviceCapabilityPicker;
}
