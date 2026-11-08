/* global setupMessages, setupMessageFormat, setupGroups, setupUsagePattern, setupDevicePicker, setupMonitorLists, setupMonitorForms, setupAvailability, renderEmptyList */

// The entry point of the Settings page. Each part of the page is a setup function in its own file; `page` is what they
// share: the calls below, the two values that change (the period shown, the device list) and whatever each part adds for
// the others. Parts used while setting up must be set up first, so the order of the calls below matters.
function onHomeyReady(Homey) {
  Homey.ready();

  // What every failed call ends in: the error's own message, in Homey's alert.
  function showError(error) { Homey.alert(error.message || String(error)); }

  function api(method, path, body) {
    return new Promise(function (resolve, reject) {
      function callback(err, result) { if (err) return reject(err); resolve(result); }
      if (body === undefined) Homey.api(method, path, callback);
      else Homey.api(method, path, body, callback);
    });
  }

  function confirmAction(message, onConfirmed) {
    Homey.confirm(message, null, function (err, confirmed) {
      if (err || !confirmed) return;
      onConfirmed();
    });
  }

  var page = { Homey: Homey, api: api, showError: showError, confirmAction: confirmAction, monitorPeriod: 'day', allDevices: [], deviceListLoading: false, loadAll: loadAll };

  setupMessages(page);
  setupGroups(page);
  setupUsagePattern(page);
  setupDevicePicker(page);
  setupMonitorLists(page);
  setupMonitorForms(page);
  setupAvailability(page);
  setupMessageFormat(page);

  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  var tabPanels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));
  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      tabPanels.forEach(function (p) { p.classList.add('hidden'); });
      btn.classList.add('active');
      document.querySelector('.tab-panel[data-tab="' + btn.getAttribute('data-tab') + '"]').classList.remove('hidden');
    });
  });

  var subtabBtns = Array.prototype.slice.call(document.querySelectorAll('.subtab-btn'));
  var subtabPanels = Array.prototype.slice.call(document.querySelectorAll('.subtab-panel'));
  subtabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      subtabBtns.forEach(function (b) { b.classList.remove('active'); });
      subtabPanels.forEach(function (p) { p.classList.add('hidden'); });
      btn.classList.add('active');
      document.querySelector('.subtab-panel[data-subtab="' + btn.getAttribute('data-subtab') + '"]').classList.remove('hidden');
    });
  });

  var periodBtns = Array.prototype.slice.call(document.querySelectorAll('.period-btn'));
  periodBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.getAttribute('data-period') === page.monitorPeriod) return;
      page.monitorPeriod = btn.getAttribute('data-period');
      periodBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
      api('GET', '/monitors?period=' + page.monitorPeriod).then(page.renderMonitors);
      api('GET', '/state-monitors?period=' + page.monitorPeriod).then(page.renderStateMonitors);
      api('GET', '/voltage-monitors?period=' + page.monitorPeriod).then(page.renderVoltageMonitors);
    });
  });

  // The device list is read by the app on demand (it is large, and reading it costs the app memory), so
  // it can still be empty or stale when the page first asks: poll its status and re-render when the
  // read has finished.
  var devicePollTimer = null;
  function waitForDevices(attempt) {
    page.deviceListLoading = true;
    clearTimeout(devicePollTimer);
    api('GET', '/devices/status').then(function (status) {
      if (status.loaded && !status.loading) {
        return api('GET', '/devices').then(function (list) {
          page.deviceListLoading = false;
          page.allDevices = list;
          page.renderDeviceList();
          page.redrawAvailability(page.allDevices);
          page.redrawGroups(); // the groups were drawn while the list was still loading: redo them to spot deleted members
        });
      }
      if (attempt < 60) {
        devicePollTimer = setTimeout(function () { waitForDevices(attempt + 1); }, 1500);
      } else {
        page.deviceListLoading = false;
        renderEmptyList(document.getElementById('availability-body'), 'The device list could not be loaded. Reload this page to try again.');
      }
    }).catch(function (error) { page.deviceListLoading = false; Homey.alert(error.message || String(error)); });
  }

  // The lists that can change on their own. Shared by the first load and the 60 s refresh below, so a new list
  // is added in one place (they had drifted into two hand-copied endpoint lists).
  function fetchLiveLists() {
    return Promise.all([
      api('GET', '/groups'), api('GET', '/monitors?period=' + page.monitorPeriod), api('GET', '/voltage-monitors?period=' + page.monitorPeriod),
      api('GET', '/state-monitors?period=' + page.monitorPeriod), api('GET', '/availability-watchdogs')
    ]).then(function (r) { return { groups: r[0], monitors: r[1], voltage: r[2], state: r[3], watchdogs: r[4] }; });
  }
  function renderLiveLists(lists, devices) {
    page.renderGroups(lists.groups);
    page.renderMonitors(lists.monitors);
    page.renderVoltageMonitors(lists.voltage);
    page.renderStateMonitors(lists.state);
    page.renderAvailability(devices, lists.watchdogs);
  }

  function loadAll() {
    return Promise.all([api('GET', '/devices'), fetchLiveLists(), api('GET', '/availability-settings'), api('GET', '/availability-scan')]).then(function (results) {
      page.allDevices = results[0];
      page.setAvailabilityData(results[2], results[3]);
      page.renderScanTiles();
      page.renderDeviceList();
      page.deviceListLoading = !results[0].length;
      renderLiveLists(results[1], page.allDevices);
      return api('GET', '/devices/status').then(function (status) {
        if (status.loading || !page.allDevices.length) waitForDevices(0);
      });
    });
  }

  // Everything that can go from fine to broken on its own — a device deleted mid-session, a watchdog firing,
  // a group's live mismatch — otherwise only ever appeared in the log: the page fetched every list once at
  // open and never again, so a "Device missing" badge (or any other status change) only reached the screen if
  // the person happened to reload it. Re-fetches the same lists loadAll() does, minus the full device
  // directory (/devices) and its 300+-row Availability re-render, which stay on their own, cheaper triggers.
  function refreshLiveStatus() {
    if (document.hidden) return;
    fetchLiveLists().then(function (lists) {
      renderLiveLists(lists, page.lastAvailabilityDevices());
    }).catch(function () { /* a miss here just tries again next tick */ });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshLiveStatus(); });
  setInterval(refreshLiveStatus, 60000);


  loadAll().catch(showError);
}
