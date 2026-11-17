/* global t, openModal, closeModal, escapeHtml, entityRow, actionLink, trackSwitch, entityActions, renderEmptyList, formatLastSeen, silenceLabel */

// The Availability tab: the scan and its tiles, apps to skip, watchdog defaults and the device list.
function setupAvailability(page) {
  var api = page.api, showError = page.showError, confirmAction = page.confirmAction;

  var availabilityWatchdogFormWrapper = document.getElementById('availability-watchdog-form-wrapper');
  var availabilityWatchdogForm = document.getElementById('availability-watchdog-form');
  var availabilityWatchdogThresholdInput = document.getElementById('availability-watchdog-thresholdHours');
  var editingWatchdogDeviceId = null;
  var availabilityDefaults = { defaultThresholdHours: 12 };
  // What the all-devices scan found (see the Availability tab): null until Settings has asked, then the
  // API's summary. `scanFilter` is the tile the user tapped to narrow the list.
  var lastScan = null;
  var scanFilter = null;
  var scanProblemById = {};
  var excludedIds = {};
  var excludedAppIds = {};
  function shortApp(uri) { return String(uri || '').replace(/^homey:app:/, ''); }
  function isScanIgnored(device) { return !!(excludedIds[device.id] || (device.ownerUri && excludedAppIds[device.ownerUri])); }
  function renderScanTiles() {
    var wrapper = document.getElementById('availability-scan');
    var scanButton = document.getElementById('availability-scan-btn');
    var enabled = lastScan && lastScan.enabled;
    document.getElementById('availability-scan-switch').checked = Boolean(enabled);
    scanButton.classList.toggle('hidden', !enabled);
    scanProblemById = {};
    excludedIds = {};
    excludedAppIds = {};
    if (lastScan) {
      lastScan.excludedDevices.forEach(function (d) { excludedIds[d.id] = true; });
      lastScan.excludedApps.forEach(function (uri) { excludedAppIds[uri] = true; });
    }
    if (!enabled || !lastScan.scan) {
      wrapper.classList.toggle('hidden', !enabled);
      document.getElementById('availability-scan-tiles').innerHTML = '';
      document.getElementById('availability-scan-stamp').textContent = enabled ? t('The first scan runs a couple of minutes after the app starts. Press Scan now to run it.') : '';
      return;
    }
    var scan = lastScan.scan;
    scan.problems.forEach(function (p) { scanProblemById[p.id] = p; });
    var tiles = [
      ['stale', scan.counts.stale, t('Not reporting'), 'is-bad'],
      ['unavailable', scan.counts.unavailable, t('Unavailable'), 'is-bad'],
      ['battery', scan.counts.lowBattery, t('Low battery'), 'is-warn'],
      ['ok', Math.max(0, scan.monitored - scan.problems.length), t('OK'), '']
    ];
    var box = document.getElementById('availability-scan-tiles');
    box.innerHTML = '';
    tiles.forEach(function (tile) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'tile' + (tile[1] && tile[3] ? ' ' + tile[3] : '') + (scanFilter === tile[0] ? ' active' : '');
      el.innerHTML = '<span class="tile-count"></span><span class="tile-label"></span>';
      el.querySelector('.tile-count').textContent = tile[1];
      el.querySelector('.tile-label').textContent = tile[2];
      el.addEventListener('click', function () { scanFilter = scanFilter === tile[0] ? null : tile[0]; renderScanTiles(); renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs); });
      box.appendChild(el);
    });
    var ignoredApps = lastScan.excludedApps.map(shortApp);
    // Many silent devices from one app usually means virtual or event-only devices: point at Ignore app.
    var silentByApp = {};
    scan.problems.forEach(function (p) { if (p.reason === 'stale' && p.ownerUri) silentByApp[p.ownerUri] = (silentByApp[p.ownerUri] || 0) + 1; });
    var topApp = Object.keys(silentByApp).sort(function (a, b) { return silentByApp[b] - silentByApp[a]; })[0];
    var appHint = topApp && silentByApp[topApp] >= 5 ? t('{n} of the silent devices belong to {app}; if they only report when used, press Ignore app on one of them.', { n: silentByApp[topApp], app: shortApp(topApp) }) + ' ' : '';
    var checked = t(scan.problems.length ? '{n} devices without a watchdog checked, last scan {at}.' : '{n} devices without a watchdog checked, last scan {at}, no problems found.', { n: scan.monitored, at: new Date(scan.at).toLocaleString() });
    document.getElementById('availability-scan-stamp').textContent = appHint + (ignoredApps.length ? t('Ignoring every device of: {apps}.', { apps: ignoredApps.join(', ') }) + ' ' : '') + checked + ' '
      + t('Silent for more than {hours} h counts as not reporting.', { hours: availabilityDefaults.defaultThresholdHours });
    wrapper.classList.remove('hidden');
  }
  document.getElementById('availability-scan-btn').addEventListener('click', function () {
    var button = document.getElementById('availability-scan-btn');
    button.disabled = true;
    api('POST', '/availability-scan').then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(showError).then(function () { button.disabled = false; });
  });
  // One row per app that owns devices, with how many devices it has, how many the scan flags, and a switch to
  // skip the whole app. Built from the device list already on the page, so it costs nothing extra.
  function renderAppList(devices, watchdogs) {
    var details = document.getElementById('availability-apps');
    var body = document.getElementById('availability-apps-body');
    var scanOn = lastScan && lastScan.enabled;
    var watchedIds = {};
    (watchdogs || []).forEach(function (w) { watchedIds[w.deviceId] = true; });
    var apps = {};
    (devices || []).forEach(function (d) {
      if (!d.ownerUri || watchedIds[d.id]) return;
      var app = apps[d.ownerUri] || (apps[d.ownerUri] = { uri: d.ownerUri, devices: 0, flagged: 0 });
      app.devices += 1;
      if (scanProblemById[d.id]) app.flagged += 1;
    });
    lastScan && lastScan.excludedApps.forEach(function (uri) { if (!apps[uri]) apps[uri] = { uri: uri, devices: 0, flagged: 0 }; });
    // By name only, so ticking an app doesn't make it jump to another place in the list.
    var list = Object.keys(apps).map(function (uri) { return apps[uri]; }).sort(function (a, b) { return shortApp(a.uri).localeCompare(shortApp(b.uri)); });
    details.classList.toggle('hidden', !scanOn || !list.length);
    body.innerHTML = '';
    var appHours = (lastScan && lastScan.appHours) || {};
    list.forEach(function (app) {
      var row = document.createElement('div');
      row.className = 'app-row';
      var label = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!excludedAppIds[app.uri];
      box.addEventListener('change', function () { setAppExclusion(app.uri, box.checked); });
      var text = document.createElement('span');
      text.textContent = shortApp(app.uri) + ' - ' + t(app.devices === 1 ? '{n} device' : '{n} devices', { n: app.devices }) + (app.flagged ? ', ' + t('{n} flagged', { n: app.flagged }) : '');
      label.appendChild(box);
      label.appendChild(text);
      // Its own silence limit, for an app whose devices are quiet for long stretches (solar panels at night).
      var hours = document.createElement('input');
      hours.type = 'number';
      hours.min = '1';
      hours.className = 'app-hours';
      hours.title = t('Hours of silence before this app\'s devices count as not reporting (empty = the default)');
      hours.placeholder = String(availabilityDefaults.defaultThresholdHours);
      hours.value = appHours[app.uri] || '';
      hours.disabled = box.checked;
      hours.addEventListener('change', function () { setAppHours(app.uri, hours.value); });
      var unit = document.createElement('span');
      unit.className = 'hint';
      unit.textContent = 'h';
      row.appendChild(label);
      row.appendChild(hours);
      row.appendChild(unit);
      body.appendChild(row);
    });
  }
  function setAppHours(uri, value) {
    var hours = Math.round(Number(value));
    api('POST', '/availability-exclusions', { app: uri, hours: Number.isFinite(hours) && hours > 0 ? hours : 0 }).then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
      // The scan runs again a moment after the change; fetch its result then.
      setTimeout(function () {
        api('GET', '/availability-scan').then(function (fresh) { lastScan = fresh; renderScanTiles(); renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs); }).catch(function () {});
      }, 4000);
    }).catch(showError);
  }
  function setAppExclusion(uri, excluded) {
    api('POST', '/availability-exclusions', { app: uri, excluded: excluded }).then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(showError);
  }
  function setExclusion(device, excluded) {
    api('POST', '/availability-exclusions', { deviceId: device.id, name: device.name, excluded: excluded }).then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(function (error) {
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs); // puts the switch back where it really is
      showError(error);
    });
  }
  // The master switch: scan every device without a watchdog, or only watch the ones that have one. Turning it on
  // runs a scan at once so the tiles are not empty until the next interval.
  var scanSwitch = document.getElementById('availability-scan-switch');
  scanSwitch.addEventListener('change', function () {
    var on = scanSwitch.checked;
    scanSwitch.disabled = true;
    api('POST', '/availability-settings', { scanAll: on })
      .then(function (saved) {
        availabilityDefaults = saved;
        return on ? api('POST', '/availability-scan').catch(function () { return null; }) : null;
      })
      .then(function () { scanSwitch.disabled = false; return page.loadAll(); })
      .catch(function (error) { scanSwitch.disabled = false; scanSwitch.checked = !on; showError(error); });
  });
  var DEFAULT_FIELDS = ['defaultThresholdHours', 'startupGraceMinutes', 'unavailableDelaySeconds', 'batteryWarnPercent', 'batteryDelaySeconds', 'scanIntervalMinutes'];
  var defaultsFormWrapper = document.getElementById('availability-defaults-form-wrapper');
  function defaultsField(name) { return document.getElementById('availability-defaults-' + name); }
  function fillDefaultsForm(settings) {
    DEFAULT_FIELDS.forEach(function (name) { defaultsField(name).value = settings[name]; });
    defaultsField('timelineNotifications').checked = settings.timelineNotifications !== false;
    defaultsField('scanAnnounceSilent').checked = settings.scanAnnounceSilent === true;
  }
  document.getElementById('availability-defaults-btn').addEventListener('click', function () {
    api('GET', '/availability-settings').then(function (settings) {
      availabilityDefaults = settings;
      fillDefaultsForm(settings);
      openModal(defaultsFormWrapper);
    }).catch(showError);
  });
  document.getElementById('availability-defaults-cancel-btn').addEventListener('click', function () { closeModal(defaultsFormWrapper); });
  document.getElementById('availability-defaults-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var body = { timelineNotifications: defaultsField('timelineNotifications').checked, scanAnnounceSilent: defaultsField('scanAnnounceSilent').checked };
    DEFAULT_FIELDS.forEach(function (name) { body[name] = Number(defaultsField(name).value); });
    api('POST', '/availability-settings', body).then(function (saved) {
      availabilityDefaults = saved;
      closeModal(defaultsFormWrapper);
      page.loadAll();
    }).catch(showError);
  });
  document.getElementById('availability-cleanup-btn').addEventListener('click', function () {
    confirmAction(t('Remove every watchdog whose device is no longer in Homey?'), function () {
      api('POST', '/availability-watchdogs-cleanup').then(page.loadAll).catch(showError);
    });
  });
  function openAvailabilityWatchdogForm(device, watchdog) {
    editingWatchdogDeviceId = device.id;
    document.getElementById('availability-watchdog-form-name').textContent = device.name;
    availabilityWatchdogThresholdInput.value = watchdog ? watchdog.thresholdHours : availabilityDefaults.defaultThresholdHours;
    document.getElementById('availability-watchdog-ignoreUnavailable').checked = !!(watchdog && watchdog.ignoreUnavailable);
    openModal(availabilityWatchdogFormWrapper);
  }
  document.getElementById('availability-watchdog-cancel-btn').addEventListener('click', function () {
    editingWatchdogDeviceId = null;
    closeModal(availabilityWatchdogFormWrapper);
  });
  availabilityWatchdogForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingWatchdogDeviceId) return;
    api('POST', '/availability-watchdogs', { deviceId: editingWatchdogDeviceId, thresholdHours: Number(availabilityWatchdogThresholdInput.value), ignoreUnavailable: document.getElementById('availability-watchdog-ignoreUnavailable').checked }).then(function () {
      closeModal(availabilityWatchdogFormWrapper);
      editingWatchdogDeviceId = null;
      return page.loadAll();
    }).catch(showError);
  });

  // Re-rendered from the last data received rather than hiding/showing existing rows (like
  // applyDeviceFilter above does) — this list can be 100+ devices long, in a house that size
  // scrolling past every one just to find a name is the actual complaint being fixed.
  var availabilityFilterEl = document.getElementById('availability-filter');
  var lastAvailabilityDevices = [];
  var lastAvailabilityWatchdogs = [];
  availabilityFilterEl.addEventListener('input', function () { renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs); });

  // Unavailable first, then the longest-unseen.
  function byAvailabilityRisk(a, b) {
    if (a.available !== b.available) return a.available ? 1 : -1;
    return (a.lastSeenAt || '').localeCompare(b.lastSeenAt || '');
  }

  // The devices shown in the three sections of the list: those with a watchdog (listed first, so a watchdog that was
  // just added is easy to find in a list of 300 devices), the ones the scan ignores, and everything else. A tapped scan
  // tile narrows the list to the devices the scan put in that group, and then only "everything else" is shown.
  function splitAvailabilityDevices(filtered, watchdogByDeviceId) {
    var scanOn = lastScan && lastScan.enabled;
    var watched = filtered.filter(function (d) { return watchdogByDeviceId[d.id]; }).sort(byAvailabilityRisk);
    var ignored = scanOn ? filtered.filter(function (d) { return isScanIgnored(d) && !watchdogByDeviceId[d.id]; }).sort(byAvailabilityRisk) : [];
    var others = filtered.filter(function (d) { return !watchdogByDeviceId[d.id] && !(scanOn && isScanIgnored(d)); }).sort(byAvailabilityRisk);
    if (scanOn && scanFilter) {
      others = others.filter(function (d) {
        var problem = scanProblemById[d.id];
        if (scanFilter === 'ok') return !problem;
        if (!problem) return false;
        return scanFilter === 'battery' ? problem.lowBattery : problem.reason === scanFilter;
      });
      watched = [];
      ignored = [];
    }
    return { watched: watched, ignored: ignored, others: others };
  }

  // One device in the list: its name with status badges, the meta line and the actions that fit its state.
  // `nameCount` is how many devices carry each name: two with the same name (a washer and its second plug, a
  // re-paired device) get a short id so a watchdog can be told apart from the other one.
  function availabilityRow(device, watchdog, nameCount) {
    var scanOn = lastScan && lastScan.enabled;
    // A device that stays "available" while it has said nothing for days is not healthy: sleepy sensors
    // never flip the flag when their battery dies. The same silence rule the watchdog uses (its own hours,
    // or the default for devices without one) shows here as an amber "Silent" badge.
    var lastSeenMs = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
    var silentMs = isNaN(lastSeenMs) ? 0 : Math.max(0, Date.now() - lastSeenMs);
    var appLimit = lastScan && lastScan.appHours && device.ownerUri ? lastScan.appHours[device.ownerUri] : 0;
    var silentLimitHours = watchdog ? watchdog.thresholdHours : (appLimit || availabilityDefaults.defaultThresholdHours);
    var silent = device.available && silentMs > silentLimitHours * 3600000;
    var statusBadge = !device.available
      ? '<span class="badge badge-danger">' + t('Unavailable') + '</span>'
      : (silent ? '<span class="badge ' + (watchdog && watchdog.wentUnavailableAt ? 'badge-danger' : 'badge-warn') + '">' + t('Silent {time}', { time: silenceLabel(silentMs) }) + '</span>' : '<span class="badge badge-active">' + t('Available') + '</span>');
    var nameHtml = escapeHtml(device.name) + ' ' + statusBadge
      + (watchdog ? ' <span class="badge">' + t(watchdog.ignoreUnavailable ? 'Watchdog {hours}h, silence only' : 'Watchdog {hours}h', { hours: watchdog.thresholdHours }) + '</span>' : '')
      + (watchdog && watchdog.lowBattery ? ' <span class="badge badge-danger">' + t('Low battery {percent}%', { percent: Math.round(watchdog.battery) }) + '</span>' : '')
      + (watchdog && Number.isFinite(watchdog.battery) && !watchdog.lowBattery ? ' <span class="badge">' + t('Battery {percent}%', { percent: Math.round(watchdog.battery) }) + '</span>' : '')
      + (!watchdog && scanProblemById[device.id] && scanProblemById[device.id].lowBattery ? ' <span class="badge badge-danger">' + t('Low battery {percent}%', { percent: Math.round(scanProblemById[device.id].battery) }) + '</span>' : '');
    var metaBits = [
      escapeHtml(device.zoneName || ''),
      nameCount[device.name] > 1 ? t('same name as another device - id {id}', { id: escapeHtml(String(device.id).slice(0, 8)) }) : null,
      t('last seen {when}', { when: formatLastSeen(device.lastSeenAt) }),
      scanOn && device.ownerUri ? t('app {app}', { app: escapeHtml(shortApp(device.ownerUri)) }) : null,
      !device.available && device.unavailableMessage ? escapeHtml(device.unavailableMessage) : null
    ];
    var row = entityRow(nameHtml, metaBits);
    if (!device.available) row.classList.add('unavailable-row');
    var actionButtons = [actionLink(watchdog ? t('Edit watchdog') : t('Add watchdog'), function () { openAvailabilityWatchdogForm(device, watchdog); })];
    if (!watchdog && scanOn) {
      var appIgnored = Boolean(device.ownerUri && excludedAppIds[device.ownerUri]);
      var tracked = !appIgnored && !excludedIds[device.id];
      // On: the all-devices scan checks this device. Off: it is left out (it still shows in the list).
      actionButtons.unshift(trackSwitch(tracked, appIgnored, appIgnored ? t('Every device of this app is ignored: use Include app') : t('Check this device in the scan'), function (on) { setExclusion(device, !on); }));
      if (appIgnored) {
        actionButtons.push(actionLink(t('Include app'), function () { setAppExclusion(device.ownerUri, false); }));
      } else if (tracked && device.ownerUri) {
        actionButtons.push(actionLink(t('Ignore app'), function () {
          confirmAction(t('Ignore every device of the app "{app}" in the scan?', { app: shortApp(device.ownerUri) }), function () { setAppExclusion(device.ownerUri, true); });
        }));
      }
    }
    if (watchdog) {
      actionButtons.push(actionLink(t('Remove watchdog'), function () {
        confirmAction(t('Stop watching "{name}" for availability?', { name: device.name }), function () {
          api('DELETE', '/availability-watchdogs/' + device.id).then(page.loadAll).catch(showError);
        });
      }, true));
    }
    row.appendChild(entityActions(actionButtons));
    return row;
  }

  // A watchdog whose device is gone from Homey: nothing to show but its name, and a way to remove it.
  function missingWatchdogRow(w) {
    var row = entityRow(escapeHtml(w.name) + ' <span class="badge badge-danger">' + t('Not found') + '</span>', [escapeHtml(w.zoneName || ''), t('watchdog {hours}h', { hours: w.thresholdHours })]);
    row.appendChild(entityActions([actionLink(t('Remove watchdog'), function () {
      api('DELETE', '/availability-watchdogs/' + w.deviceId).then(page.loadAll).catch(showError);
    }, true)]));
    return row;
  }

  function renderAvailability(devices, watchdogs) {
    lastAvailabilityDevices = devices;
    lastAvailabilityWatchdogs = watchdogs;
    var container = document.getElementById('availability-body');
    renderAppList(devices, watchdogs);
    var missing = (watchdogs || []).filter(function (w) { return w.missing; });
    document.getElementById('availability-cleanup-btn').classList.toggle('hidden', !missing.length);
    if (!devices.length) { renderEmptyList(container, page.deviceListLoading ? t('Loading devices...') : t('No devices found.')); return; }
    var query = availabilityFilterEl.value.trim().toLowerCase();
    var filtered = query ? devices.filter(function (d) { return d.name.toLowerCase().indexOf(query) !== -1; }) : devices;
    if (!filtered.length) { renderEmptyList(container, t('No devices match "{query}".', { query: escapeHtml(query) })); return; }
    var watchdogByDeviceId = {};
    (watchdogs || []).forEach(function (w) { watchdogByDeviceId[w.deviceId] = w; });
    var nameCount = {};
    devices.forEach(function (d) { nameCount[d.name] = (nameCount[d.name] || 0) + 1; });
    var sections = splitAvailabilityDevices(filtered, watchdogByDeviceId);
    container.innerHTML = '';
    function appendSection(title) {
      var heading = document.createElement('div');
      heading.className = 'entity-section';
      heading.textContent = title;
      container.appendChild(heading);
    }
    function appendRows(list) {
      list.forEach(function (device) { container.appendChild(availabilityRow(device, watchdogByDeviceId[device.id], nameCount)); });
    }
    if (missing.length) {
      appendSection(t('Device no longer in Homey ({n})', { n: missing.length }));
      missing.forEach(function (w) { container.appendChild(missingWatchdogRow(w)); });
    }
    if (sections.watched.length) appendSection(t('Watched by a watchdog ({n})', { n: sections.watched.length }));
    appendRows(sections.watched);
    if (sections.watched.length && sections.others.length) appendSection(t('All other devices ({n})', { n: sections.others.length }));
    appendRows(sections.others);
    if (sections.ignored.length) {
      appendSection(t('Ignored by the scan ({n})', { n: sections.ignored.length }));
      appendRows(sections.ignored);
    }
  }

  page.setAvailabilityData = function (defaults, scan) { availabilityDefaults = defaults; lastScan = scan; };
  page.redrawAvailability = function (devices) { renderAvailability(devices, lastAvailabilityWatchdogs || []); };
  page.lastAvailabilityDevices = function () { return lastAvailabilityDevices; };
  page.renderAvailability = renderAvailability;
  page.renderScanTiles = renderScanTiles;
}
