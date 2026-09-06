var CAPABILITY_BY_TYPE = { contact: 'alarm_contact', light: 'onoff', switch: 'onoff', valve: 'onoff', garage: 'garagedoor_closed' };
var allDevices = [];
var editingGroupId = null;

// Every Add/Edit form's wrapper (already toggled via the same .hidden class as before) also
// carries .modal-overlay — see style.css — so opening one now centers it over a dimmed
// backdrop instead of pushing the list above it down the page. No scrollIntoView needed
// anymore: a fixed-position overlay is already centered regardless of where the trigger
// button was.
function openModal(wrapperEl) { wrapperEl.classList.remove('hidden'); }
function closeModal(wrapperEl) { wrapperEl.classList.add('hidden'); }
document.addEventListener('click', function (event) {
  if (event.target.classList.contains('modal-overlay')) closeModal(event.target);
});
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  Array.prototype.forEach.call(document.querySelectorAll('.modal-overlay:not(.hidden)'), closeModal);
});

function onHomeyReady(Homey) {
  Homey.ready();

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

  var monitorPeriod = 'day';
  var periodBtns = Array.prototype.slice.call(document.querySelectorAll('.period-btn'));
  periodBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.getAttribute('data-period') === monitorPeriod) return;
      monitorPeriod = btn.getAttribute('data-period');
      periodBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
      api('GET', '/monitors?period=' + monitorPeriod).then(renderMonitors);
      api('GET', '/state-monitors?period=' + monitorPeriod).then(renderStateMonitors);
      api('GET', '/voltage-monitors?period=' + monitorPeriod).then(renderVoltageMonitors);
      api('GET', '/binary-counters?period=' + monitorPeriod).then(renderBinaryCounters);
    });
  });

  function formatEnergy(kwh) {
    if (kwh === null || kwh === undefined || !isFinite(kwh)) return '—';
    return kwh < 1 ? Math.round(kwh * 1000) + ' Wh' : kwh.toFixed(2) + ' kWh';
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return '—';
    var safeSeconds = Math.max(0, Math.round(seconds));
    if (safeSeconds < 60) return safeSeconds + 's';
    var minutes = Math.round(safeSeconds / 60);
    if (minutes < 60) return minutes + ' min';
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'min';
  }

  // Monitor/device names are free text (typed into a Flow card's `name` arg, or a
  // Homey device's own name) built straight into innerHTML template strings below —
  // without this, a name like <img src=x onerror="..."> would execute in this page.
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderSparkline(breakdown, field, formatter) {
    field = field || 'energy';
    formatter = formatter || formatEnergy;
    if (!breakdown || !breakdown.length) return '';
    var max = breakdown.reduce(function (m, day) { return Math.max(m, day[field] || 0); }, 0);
    var bars = breakdown.map(function (day) {
      var height = max > 0 ? Math.max(8, Math.round((day[field] / max) * 100)) : 8;
      return '<div class="bar" style="height:' + height + '%" title="' + day.date + ': ' + formatter(day[field]) + '"></div>';
    }).join('');
    return '<div class="sparkline" title="Daily trend">' + bars + '</div>';
  }

  // Shared by every entity list (monitors, counters, availability): the top line (name +
  // state badge) and one wrapping meta line of secondary stats, joined with " · " — the
  // same "fold everything into a sentence instead of a column" idea used by comparable
  // Homey apps for lists of many similar items.
  function entityRow(nameHtml, metaBits, sparklineHtml) {
    var row = document.createElement('div');
    row.className = 'entity-row';
    var main = document.createElement('div');
    main.className = 'entity-main';
    main.innerHTML = '<div class="entity-name">' + nameHtml + '</div>' +
      '<div class="entity-meta">' + metaBits.filter(Boolean).join(' · ') + (sparklineHtml || '') + '</div>';
    row.appendChild(main);
    return row;
  }

  function actionLink(label, onClick, danger) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-link' + (danger ? ' btn-danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function entityActions(buttons) {
    var wrap = document.createElement('div');
    wrap.className = 'entity-actions';
    buttons.forEach(function (btn) { wrap.appendChild(btn); });
    return wrap;
  }

  function renderEmptyList(container, message) {
    container.innerHTML = '<div class="entity-empty">' + message + '</div>';
  }

  var groupsEl = document.getElementById('groups');
  var devicesEl = document.getElementById('devices');
  var deviceFilterEl = document.getElementById('device-filter');
  deviceFilterEl.addEventListener('input', applyDeviceFilter);
  var form = document.getElementById('group-form');
  var typeSelect = document.getElementById('type');
  var cancelBtn = document.getElementById('cancel-btn');
  var deleteBtn = document.getElementById('delete-btn');
  var formTitle = document.getElementById('form-title');
  var groupFormWrapper = document.getElementById('group-form-wrapper');
  var addGroupBtn = document.getElementById('add-group-btn');
  addGroupBtn.addEventListener('click', function () {
    resetForm();
    openModal(groupFormWrapper);
  });

  function api(method, path, body) {
    return new Promise(function (resolve, reject) {
      function callback(err, result) { if (err) return reject(err); resolve(result); }
      if (body === undefined) Homey.api(method, path, callback);
      else Homey.api(method, path, body, callback);
    });
  }

  function checkedDeviceIds() {
    return Array.prototype.slice.call(devicesEl.querySelectorAll('input[type=checkbox]:checked')).map(function (el) { return el.value; });
  }

  function setCheckedDeviceIds(ids) {
    Array.prototype.forEach.call(devicesEl.querySelectorAll('input[type=checkbox]'), function (el) {
      el.checked = ids.indexOf(el.value) !== -1;
    });
  }

  function renderDeviceList() {
    var capability = CAPABILITY_BY_TYPE[typeSelect.value];
    var compatible = allDevices.filter(function (d) { return d.capabilities.indexOf(capability) !== -1; });
    document.getElementById('device-hint').textContent = compatible.length
      ? compatible.length + ' device(s) with capability ' + capability + '.'
      : 'No device with capability ' + capability + ' was found.';
    devicesEl.innerHTML = '';
    compatible.forEach(function (device) {
      var wrapper = document.createElement('label');
      wrapper.dataset.name = device.name.toLowerCase();
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = device.id;
      wrapper.appendChild(checkbox);
      wrapper.appendChild(document.createTextNode(device.name));
      devicesEl.appendChild(wrapper);
    });
    applyDeviceFilter();
  }

  // Filters by hiding rather than removing — a device checked before typing a filter (or
  // one that scrolls out of view while a search is active) must stay checked underneath,
  // not lose its state just because it's momentarily not shown.
  function applyDeviceFilter() {
    var query = deviceFilterEl.value.trim().toLowerCase();
    Array.prototype.forEach.call(devicesEl.children, function (wrapper) {
      wrapper.style.display = !query || wrapper.dataset.name.indexOf(query) !== -1 ? '' : 'none';
    });
  }

  var lastTokenTarget = document.getElementById('messageTemplateMany');
  Array.prototype.forEach.call(document.querySelectorAll('.token-target'), function (el) {
    el.addEventListener('focus', function () { lastTokenTarget = el; });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.token-btn'), function (btn) {
    btn.addEventListener('click', function () {
      var token = btn.getAttribute('data-token');
      var start = lastTokenTarget.selectionStart || lastTokenTarget.value.length;
      var end = lastTokenTarget.selectionEnd || lastTokenTarget.value.length;
      lastTokenTarget.value = lastTokenTarget.value.slice(0, start) + token + lastTokenTarget.value.slice(end);
      lastTokenTarget.focus();
    });
  });

  // "No mismatches" reads naturally when the expected state is the everyday-normal one
  // (lights off, doors closed) — the common case. Keyed by type + expected state so the
  // wording still makes sense if someone flips it (e.g. a group that expects lights ON).
  var MESSAGE_WORDING_PRESETS = {
    'light:false': { zero: 'All lights are off.', one: '%items% is on.', many: '%count% lights on: %items%.' },
    'light:true': { zero: 'All lights are on.', one: '%items% is off.', many: '%count% lights off: %items%.' },
    'switch:false': { zero: 'All switches are off.', one: '%items% is on.', many: '%count% switches on: %items%.' },
    'switch:true': { zero: 'All switches are on.', one: '%items% is off.', many: '%count% switches off: %items%.' },
    'contact:false': { zero: 'All doors and windows are closed.', one: '%items% is open.', many: '%count% doors/windows open: %items%.' },
    'contact:true': { zero: 'All doors and windows are open.', one: '%items% is closed.', many: '%count% doors/windows closed: %items%.' },
    'valve:false': { zero: 'All valves are closed.', one: '%items% is open.', many: '%count% valves open: %items%.' },
    'valve:true': { zero: 'All valves are open.', one: '%items% is closed.', many: '%count% valves closed: %items%.' },
    'garage:false': { zero: 'All garage doors are closed.', one: '%items% is open.', many: '%count% garage doors open: %items%.' },
    'garage:true': { zero: 'All garage doors are open.', one: '%items% is closed.', many: '%count% garage doors closed: %items%.' }
  };
  document.getElementById('fill-wording-btn').addEventListener('click', function () {
    var preset = MESSAGE_WORDING_PRESETS[typeSelect.value + ':' + document.getElementById('expectedState').value];
    if (!preset) return;
    var zero = document.getElementById('messageTemplateZero');
    var one = document.getElementById('messageTemplateOne');
    var many = document.getElementById('messageTemplateMany');
    var apply = function () { zero.value = preset.zero; one.value = preset.one; many.value = preset.many; };
    if (zero.value || one.value || many.value) {
      confirmAction('This will overwrite the current message wording. Continue?', apply);
    } else {
      apply();
    }
  });

  function resetForm() {
    editingGroupId = null;
    form.reset();
    formTitle.textContent = 'New group';
    cancelBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
    closeModal(groupFormWrapper);
    renderDeviceList();
  }

  function renderGroups(groups) {
    groupsEl.innerHTML = '';
    if (!groups.length) {
      groupsEl.innerHTML = '<p class="hint">No groups created yet.</p>';
      return;
    }
    groups.forEach(function (group) {
      var row = document.createElement('div');
      row.className = 'group-row';
      var info = document.createElement('div');
      info.className = 'entity-main';
      var title = document.createElement('strong');
      title.textContent = group.name;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = group.type + ' · ' + group.devices.length + ' device(s) · expected: ' + (group.expectedState ? 'on/open' : 'off/closed');
      var status = document.createElement('div');
      status.className = 'meta';
      status.textContent = 'Status not checked yet';
      info.appendChild(title);
      info.appendChild(meta);
      info.appendChild(status);
      var buttons = entityActions([]);
      var checkBtn = actionLink('Check now', function () {
        checkBtn.disabled = true;
        api('GET', '/groups/' + group.id + '/check').then(function (result) {
          checkBtn.disabled = false;
          status.innerHTML = (result.mismatchCount === 0
            ? '<span class="badge-ok">' + result.matchCount + '/' + result.checkedCount + ' matching</span>'
            : '<span class="badge-nok">' + result.mismatchCount + ' mismatch(es)</span> — ' + escapeHtml(result.mismatchList.split('\n').join(', ')));
        }).catch(function (error) {
          checkBtn.disabled = false;
          Homey.alert(error.message || String(error));
        });
      });
      var editBtn = actionLink('Edit', function () { startEdit(group); });
      buttons.appendChild(checkBtn);
      buttons.appendChild(editBtn);
      row.appendChild(info);
      row.appendChild(buttons);
      groupsEl.appendChild(row);
    });
  }

  function startEdit(group) {
    editingGroupId = group.id;
    formTitle.textContent = 'Editing: ' + group.name;
    openModal(groupFormWrapper);
    document.getElementById('name').value = group.name;
    typeSelect.value = group.type;
    document.getElementById('expectedState').value = String(group.expectedState);
    renderDeviceList();
    setCheckedDeviceIds(group.devices.map(function (d) { return d.id; }));
    document.getElementById('conjunction').value = group.conjunction || '';
    document.getElementById('messageTemplateZero').value = group.messageTemplateZero || '';
    document.getElementById('messageTemplateOne').value = group.messageTemplateOne || '';
    document.getElementById('messageTemplateMany').value = group.messageTemplateMany || '';
    cancelBtn.style.display = '';
    deleteBtn.style.display = '';
  }

  function formatLastSeen(iso) {
    if (!iso) return 'never';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return 'never';
    return date.toLocaleString();
  }

  function confirmAction(message, onConfirmed) {
    Homey.confirm(message, null, function (err, confirmed) {
      if (err || !confirmed) return;
      onConfirmed();
    });
  }

  function renderMonitors(monitors) {
    var container = document.getElementById('monitors-body');
    container.innerHTML = '';
    if (!monitors.length) { renderEmptyList(container, 'No activity monitors created yet.'); return; }
    monitors.forEach(function (monitor) {
      var isActive = monitor.state === 'ACTIVE';
      var avgPower = monitor.averagePower !== null && monitor.averagePower !== undefined ? Math.round(monitor.averagePower) + ' W' : '—';
      var suggestion = monitor.suggestedThreshold;
      var stateBadge = monitor.calibrating
        ? '<span class="badge badge-calibrating" title="Using a default 40 W threshold until enough history confirms this device\'s real standby/active power split.">Calibrating</span>'
        : '<span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + (isActive ? 'Active' : 'Standby') + '</span>';
      var nameHtml = escapeHtml(monitor.name) + ' ' + stateBadge;
      var metaBits = [
        escapeHtml(monitor.deviceName),
        monitor.cycleCount + ' cycle' + (monitor.cycleCount === 1 ? '' : 's'),
        formatEnergy(monitor.energy) + (monitor.energyQuality === 'meter_reset' ? ' <span class="badge badge-danger" title="A meter reset was detected in this period — energy may be understated.">reset</span>' : ''),
        'avg ' + avgPower,
        monitor.threshold !== null && monitor.threshold !== undefined ? '<span class="chip" title="The Watts value that currently decides Active vs Standby for this monitor.">threshold ' + Math.round(monitor.threshold) + ' W</span>' : null,
        suggestion ? '<span class="chip chip-accent" title="Based on ' + suggestion.sampleCount + ' power samples, split between ' + Math.round(suggestion.low) + ' W and ' + Math.round(suggestion.high) + ' W">suggested ~' + Math.round(suggestion.threshold) + ' W</span>' : null
      ];
      var row = entityRow(nameHtml, metaBits, renderSparkline(monitor.dailyBreakdown));
      // Messages/Reset/Delete only make sense against "today" — they'd otherwise act on
      // the monitor itself while the row is showing a week/month rollup, which reads as
      // if the action applied to that whole period instead of the monitor as a whole.
      if (monitorPeriod === 'day') {
        row.appendChild(entityActions([
          actionLink('Messages', function () { openActivityMessageForm(monitor); }),
          actionLink('Reset', function () {
            confirmAction('Reset statistics for "' + monitor.name + '"? This keeps the monitor and its settings, only the history is wiped.', function () {
              api('POST', '/monitors/' + monitor.id + '/reset')
                .then(function () { return api('GET', '/monitors?period=' + monitorPeriod); })
                .then(renderMonitors)
                .catch(function (error) { Homey.alert(error.message || String(error)); });
            });
          }),
          actionLink('Delete', function () {
            confirmAction('Delete monitor "' + monitor.name + '"?', function () {
              api('DELETE', '/monitors/' + monitor.id)
                .then(function () { return api('GET', '/monitors?period=' + monitorPeriod); })
                .then(renderMonitors)
                .catch(function (error) { Homey.alert(error.message || String(error)); });
            });
          }, true)
        ]));
      }
      container.appendChild(row);
    });
  }

  function renderStateMonitors(monitors) {
    var container = document.getElementById('state-monitors-body');
    container.innerHTML = '';
    if (!monitors.length) { renderEmptyList(container, 'No state monitors created yet.'); return; }
    monitors.forEach(function (monitor) {
      var isActive = monitor.state === 'ACTIVE';
      var stateLabel = isActive ? monitor.trueLabel : monitor.falseLabel;
      var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + escapeHtml(stateLabel) + '</span>';
      var metaBits = [
        escapeHtml(monitor.deviceName),
        monitor.cycleCount + ' session' + (monitor.cycleCount === 1 ? '' : 's'),
        escapeHtml(monitor.trueLabel) + ' ' + formatDuration(monitor.trueDuration),
        escapeHtml(monitor.falseLabel) + ' ' + formatDuration(monitor.falseDuration),
        // Only present when this monitor also tracks an auxiliary power capability — a
        // plain door/motion monitor's row stays exactly as it was.
        monitor.energy !== undefined ? formatEnergy(monitor.energy) : null,
        monitor.averagePower !== null && monitor.averagePower !== undefined ? 'avg ' + Math.round(monitor.averagePower) + ' W' : null
      ];
      var row = entityRow(nameHtml, metaBits, renderSparkline(monitor.dailyBreakdown, 'trueDuration', formatDuration));
      if (monitorPeriod === 'day') {
        row.appendChild(entityActions([
          actionLink('Messages', function () { openStateMessageForm(monitor); }),
          actionLink('Reset', function () {
            confirmAction('Reset statistics for "' + monitor.name + '"? This keeps the monitor and its settings, only the history is wiped.', function () {
              api('POST', '/state-monitors/' + monitor.id + '/reset')
                .then(function () { return api('GET', '/state-monitors?period=' + monitorPeriod); })
                .then(renderStateMonitors)
                .catch(function (error) { Homey.alert(error.message || String(error)); });
            });
          }),
          actionLink('Delete', function () {
            confirmAction('Delete monitor "' + monitor.name + '"?', function () {
              api('DELETE', '/state-monitors/' + monitor.id)
                .then(function () { return api('GET', '/state-monitors?period=' + monitorPeriod); })
                .then(renderStateMonitors)
                .catch(function (error) { Homey.alert(error.message || String(error)); });
            });
          }, true)
        ]));
      }
      container.appendChild(row);
    });
  }

  function renderVoltageMonitors(monitors) {
    var container = document.getElementById('voltage-monitors-body');
    container.innerHTML = '';
    if (!monitors.length) { renderEmptyList(container, 'No voltage monitors created yet.'); return; }
    monitors.forEach(function (monitor) {
      var isNormal = monitor.state === 'NORMAL';
      var range = (monitor.minVoltage !== null && monitor.maxVoltage !== null)
        ? monitor.minVoltage.toFixed(1) + '–' + monitor.maxVoltage.toFixed(1) + ' V' : '—';
      var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isNormal ? 'badge-active' : 'badge-danger') + '">' + escapeHtml(monitor.state) + '</span>';
      var metaBits = [
        escapeHtml(monitor.deviceName),
        (monitor.currentVoltage !== null ? monitor.currentVoltage.toFixed(1) + ' V now' : 'no reading'),
        'range ' + range,
        (monitor.undervoltageCount || 0) + ' under · ' + (monitor.overvoltageCount || 0) + ' over'
      ];
      var row = entityRow(nameHtml, metaBits);
      if (monitorPeriod === 'day') {
        row.appendChild(entityActions([
          actionLink('Messages', function () { openVoltageMessageForm(monitor); }),
          actionLink('Reset', function () {
            confirmAction('Reset statistics for "' + monitor.name + '"? This keeps the monitor and its settings, only the history is wiped.', function () {
              api('POST', '/voltage-monitors/' + monitor.id + '/reset')
                .then(function () { return api('GET', '/voltage-monitors?period=' + monitorPeriod); })
                .then(renderVoltageMonitors)
                .catch(function (error) { Homey.alert(error.message || String(error)); });
            });
          }),
          actionLink('Delete', function () {
            confirmAction('Delete voltage monitor "' + monitor.name + '"?', function () {
              api('DELETE', '/voltage-monitors/' + monitor.id)
                .then(function () { return api('GET', '/voltage-monitors?period=' + monitorPeriod); })
                .then(renderVoltageMonitors)
                .catch(function (error) { Homey.alert(error.message || String(error)); });
            });
          }, true)
        ]));
      }
      container.appendChild(row);
    });
  }

  var voltageMessageFormWrapper = document.getElementById('voltage-message-form-wrapper');
  var voltageMessageForm = document.getElementById('voltage-message-form');
  var editingVoltageMonitorId = null;
  var lastVoltageTokenTarget = document.getElementById('messageTemplateNormalized');
  Array.prototype.forEach.call(document.querySelectorAll('.voltage-token-target'), function (el) {
    el.addEventListener('focus', function () { lastVoltageTokenTarget = el; });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.voltage-token-btn'), function (btn) {
    btn.addEventListener('click', function () {
      var token = btn.getAttribute('data-token');
      var start = lastVoltageTokenTarget.selectionStart || lastVoltageTokenTarget.value.length;
      var end = lastVoltageTokenTarget.selectionEnd || lastVoltageTokenTarget.value.length;
      lastVoltageTokenTarget.value = lastVoltageTokenTarget.value.slice(0, start) + token + lastVoltageTokenTarget.value.slice(end);
      lastVoltageTokenTarget.focus();
    });
  });

  function openVoltageMessageForm(monitor) {
    editingVoltageMonitorId = monitor.id;
    document.getElementById('voltage-message-form-name').textContent = monitor.name;
    document.getElementById('messageTemplateUndervoltage').value = monitor.messageTemplateUndervoltage || '';
    document.getElementById('messageTemplateOvervoltage').value = monitor.messageTemplateOvervoltage || '';
    document.getElementById('messageTemplateNormalized').value = monitor.messageTemplateNormalized || '';
    openModal(voltageMessageFormWrapper);
  }
  document.getElementById('voltage-message-cancel-btn').addEventListener('click', function () {
    editingVoltageMonitorId = null;
    closeModal(voltageMessageFormWrapper);
  });
  voltageMessageForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingVoltageMonitorId) return;
    var payload = {
      messageTemplateUndervoltage: document.getElementById('messageTemplateUndervoltage').value,
      messageTemplateOvervoltage: document.getElementById('messageTemplateOvervoltage').value,
      messageTemplateNormalized: document.getElementById('messageTemplateNormalized').value
    };
    api('PUT', '/voltage-monitors/' + editingVoltageMonitorId + '/messages', payload).then(function () {
      closeModal(voltageMessageFormWrapper);
      editingVoltageMonitorId = null;
      return api('GET', '/voltage-monitors?period=' + monitorPeriod);
    }).then(renderVoltageMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  var activityMessageFormWrapper = document.getElementById('activity-message-form-wrapper');
  var activityMessageForm = document.getElementById('activity-message-form');
  var editingActivityMonitorId = null;
  var lastActivityTokenTarget = document.getElementById('activity-messageTemplateFinished');
  Array.prototype.forEach.call(document.querySelectorAll('.activity-token-target'), function (el) {
    el.addEventListener('focus', function () { lastActivityTokenTarget = el; });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.activity-token-btn'), function (btn) {
    btn.addEventListener('click', function () {
      var token = btn.getAttribute('data-token');
      var start = lastActivityTokenTarget.selectionStart || lastActivityTokenTarget.value.length;
      var end = lastActivityTokenTarget.selectionEnd || lastActivityTokenTarget.value.length;
      lastActivityTokenTarget.value = lastActivityTokenTarget.value.slice(0, start) + token + lastActivityTokenTarget.value.slice(end);
      lastActivityTokenTarget.focus();
    });
  });
  function openActivityMessageForm(monitor) {
    editingActivityMonitorId = monitor.id;
    document.getElementById('activity-message-form-name').textContent = monitor.name;
    document.getElementById('activity-messageTemplateStarted').value = monitor.messageTemplateStarted || '';
    document.getElementById('activity-messageTemplateFinished').value = monitor.messageTemplateFinished || '';
    openModal(activityMessageFormWrapper);
  }
  document.getElementById('activity-message-cancel-btn').addEventListener('click', function () {
    editingActivityMonitorId = null;
    closeModal(activityMessageFormWrapper);
  });
  activityMessageForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingActivityMonitorId) return;
    var payload = {
      messageTemplateStarted: document.getElementById('activity-messageTemplateStarted').value,
      messageTemplateFinished: document.getElementById('activity-messageTemplateFinished').value
    };
    api('PUT', '/monitors/' + editingActivityMonitorId + '/messages', payload).then(function () {
      closeModal(activityMessageFormWrapper);
      editingActivityMonitorId = null;
      return api('GET', '/monitors?period=' + monitorPeriod);
    }).then(renderMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  var stateMessageFormWrapper = document.getElementById('state-message-form-wrapper');
  var stateMessageForm = document.getElementById('state-message-form');
  var editingStateMonitorId = null;
  var lastStateTokenTarget = document.getElementById('state-messageTemplateFinished');
  Array.prototype.forEach.call(document.querySelectorAll('.state-token-target'), function (el) {
    el.addEventListener('focus', function () { lastStateTokenTarget = el; });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.state-token-btn'), function (btn) {
    btn.addEventListener('click', function () {
      var token = btn.getAttribute('data-token');
      var start = lastStateTokenTarget.selectionStart || lastStateTokenTarget.value.length;
      var end = lastStateTokenTarget.selectionEnd || lastStateTokenTarget.value.length;
      lastStateTokenTarget.value = lastStateTokenTarget.value.slice(0, start) + token + lastStateTokenTarget.value.slice(end);
      lastStateTokenTarget.focus();
    });
  });
  function openStateMessageForm(monitor) {
    editingStateMonitorId = monitor.id;
    document.getElementById('state-message-form-name').textContent = monitor.name;
    document.getElementById('state-messageTemplateStarted').value = monitor.messageTemplateStarted || '';
    document.getElementById('state-messageTemplateFinished').value = monitor.messageTemplateFinished || '';
    openModal(stateMessageFormWrapper);
  }
  document.getElementById('state-message-cancel-btn').addEventListener('click', function () {
    editingStateMonitorId = null;
    closeModal(stateMessageFormWrapper);
  });
  stateMessageForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingStateMonitorId) return;
    var payload = {
      messageTemplateStarted: document.getElementById('state-messageTemplateStarted').value,
      messageTemplateFinished: document.getElementById('state-messageTemplateFinished').value
    };
    api('PUT', '/state-monitors/' + editingStateMonitorId + '/messages', payload).then(function () {
      closeModal(stateMessageFormWrapper);
      editingStateMonitorId = null;
      return api('GET', '/state-monitors?period=' + monitorPeriod);
    }).then(renderStateMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  function renderBinaryCounters(counters) {
    var container = document.getElementById('binary-counters-body');
    container.innerHTML = '';
    if (!counters.length) { renderEmptyList(container, 'No binary counters created yet. Use the "Add binary counter" Flow action to create one.'); return; }
    counters.forEach(function (counter) {
      var metaBits = [
        formatNumberOrDash(counter.eventCount) + ' event' + (counter.eventCount === 1 ? '' : 's'),
        'total ' + formatNumberOrDash(counter.totalCount),
        'last ' + formatLastSeen(counter.lastEventAt)
      ];
      var row = entityRow(escapeHtml(counter.name), metaBits);
      if (monitorPeriod === 'day') {
      row.appendChild(entityActions([
        actionLink('Message', function () { openBinaryMessageForm(counter); }),
        actionLink('Reset', function () {
          confirmAction('Reset statistics for "' + counter.name + '"? This keeps the counter and its message, only the count/history is wiped.', function () {
            api('POST', '/binary-counters/' + counter.id + '/reset')
              .then(function () { return api('GET', '/binary-counters?period=' + monitorPeriod); })
              .then(renderBinaryCounters)
              .catch(function (error) { Homey.alert(error.message || String(error)); });
          });
        }),
        actionLink('Delete', function () {
          confirmAction('Delete binary counter "' + counter.name + '"?', function () {
            api('DELETE', '/binary-counters/' + counter.id)
              .then(function () { return api('GET', '/binary-counters?period=' + monitorPeriod); })
              .then(renderBinaryCounters)
              .catch(function (error) { Homey.alert(error.message || String(error)); });
          });
        }, true)
      ]));
      }
      container.appendChild(row);
    });
  }
  function formatNumberOrDash(value) { return value === null || value === undefined ? '—' : String(value); }

  var binaryMessageFormWrapper = document.getElementById('binary-message-form-wrapper');
  var binaryMessageForm = document.getElementById('binary-message-form');
  var editingBinaryCounterId = null;
  var binaryMessageInput = document.getElementById('binary-messageTemplate');
  Array.prototype.forEach.call(document.querySelectorAll('.binary-token-btn'), function (btn) {
    btn.addEventListener('click', function () {
      var token = btn.getAttribute('data-token');
      var start = binaryMessageInput.selectionStart || binaryMessageInput.value.length;
      var end = binaryMessageInput.selectionEnd || binaryMessageInput.value.length;
      binaryMessageInput.value = binaryMessageInput.value.slice(0, start) + token + binaryMessageInput.value.slice(end);
      binaryMessageInput.focus();
    });
  });
  function openBinaryMessageForm(counter) {
    editingBinaryCounterId = counter.id;
    document.getElementById('binary-message-form-name').textContent = counter.name;
    binaryMessageInput.value = counter.messageTemplate || '';
    openModal(binaryMessageFormWrapper);
  }
  document.getElementById('binary-message-cancel-btn').addEventListener('click', function () {
    editingBinaryCounterId = null;
    closeModal(binaryMessageFormWrapper);
  });
  binaryMessageForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingBinaryCounterId) return;
    api('PUT', '/binary-counters/' + editingBinaryCounterId + '/message', { messageTemplate: binaryMessageInput.value }).then(function () {
      closeModal(binaryMessageFormWrapper);
      editingBinaryCounterId = null;
      return api('GET', '/binary-counters?period=' + monitorPeriod);
    }).then(renderBinaryCounters).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  var availabilityWatchdogFormWrapper = document.getElementById('availability-watchdog-form-wrapper');
  var availabilityWatchdogForm = document.getElementById('availability-watchdog-form');
  var availabilityWatchdogThresholdInput = document.getElementById('availability-watchdog-thresholdHours');
  var editingWatchdogDeviceId = null;
  function openAvailabilityWatchdogForm(device, watchdog) {
    editingWatchdogDeviceId = device.id;
    document.getElementById('availability-watchdog-form-name').textContent = device.name;
    availabilityWatchdogThresholdInput.value = watchdog ? watchdog.thresholdHours : 12;
    openModal(availabilityWatchdogFormWrapper);
  }
  document.getElementById('availability-watchdog-cancel-btn').addEventListener('click', function () {
    editingWatchdogDeviceId = null;
    closeModal(availabilityWatchdogFormWrapper);
  });
  availabilityWatchdogForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingWatchdogDeviceId) return;
    api('POST', '/availability-watchdogs', { deviceId: editingWatchdogDeviceId, thresholdHours: Number(availabilityWatchdogThresholdInput.value) }).then(function () {
      closeModal(availabilityWatchdogFormWrapper);
      editingWatchdogDeviceId = null;
      return loadAll();
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  function renderAvailability(devices, watchdogs) {
    var container = document.getElementById('availability-body');
    if (!devices.length) { renderEmptyList(container, 'No devices found.'); return; }
    var watchdogByDeviceId = {};
    (watchdogs || []).forEach(function (w) { watchdogByDeviceId[w.deviceId] = w; });
    var sorted = devices.slice().sort(function (a, b) {
      if (a.available !== b.available) return a.available ? 1 : -1;
      return (a.lastSeenAt || '').localeCompare(b.lastSeenAt || '');
    });
    container.innerHTML = '';
    sorted.forEach(function (device) {
      var watchdog = watchdogByDeviceId[device.id];
      var nameHtml = escapeHtml(device.name) + ' <span class="badge ' + (device.available ? 'badge-active' : 'badge-danger') + '">' + (device.available ? 'Available' : 'Unavailable') + '</span>'
        + (watchdog ? ' <span class="badge">Watchdog ' + watchdog.thresholdHours + 'h</span>' : '');
      var metaBits = [
        escapeHtml(device.zoneName || ''),
        'last seen ' + formatLastSeen(device.lastSeenAt),
        !device.available && device.unavailableMessage ? escapeHtml(device.unavailableMessage) : null
      ];
      var row = entityRow(nameHtml, metaBits);
      if (!device.available) row.classList.add('unavailable-row');
      var actionButtons = [actionLink(watchdog ? 'Edit watchdog' : 'Add watchdog', function () { openAvailabilityWatchdogForm(device, watchdog); })];
      if (watchdog) {
        actionButtons.push(actionLink('Remove watchdog', function () {
          confirmAction('Stop watching "' + device.name + '" for availability?', function () {
            api('DELETE', '/availability-watchdogs/' + device.id).then(loadAll).catch(function (error) { Homey.alert(error.message || String(error)); });
          });
        }, true));
      }
      row.appendChild(entityActions(actionButtons));
      container.appendChild(row);
    });
  }

  // Shared by the three "Add monitor" forms below — same device-then-capability picker
  // idea as the Flow cards' own autocomplete, just backed by the already-cached
  // `allDevices` list instead of a live query.
  function byDeviceName(a, b) { return a.name.localeCompare(b.name); }
  function findDevice(id) { return allDevices.filter(function (d) { return d.id === id; })[0]; }
  function eligibleCapabilities(device, kind) {
    if (!device) return [];
    var caps = device.capabilities || [];
    if (kind === 'voltage') return caps.filter(function (c) { return c.indexOf('measure_voltage') === 0; });
    if (kind === 'state') return caps.filter(function (c) {
      var type = device.capabilitiesObj && device.capabilitiesObj[c] && device.capabilitiesObj[c].type;
      return type === 'boolean' || type === 'enum' || type === 'string';
    });
    return caps;
  }
  // A flat, alphabetical device list gets unwieldy fast on a real setup (50+ devices) —
  // same problem gpm.linked.switches' own device picker solved with a zone filter above
  // the device list itself. `getDevices()` only gives us each device's resolved zoneName
  // (no zoneId), so filtering matches on that string directly — fine, since it's what's
  // actually shown to the user anyway.
  function populateZoneSelect(selectEl) {
    var current = selectEl.value;
    selectEl.innerHTML = '';
    var allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All zones';
    selectEl.appendChild(allOpt);
    var seen = {};
    allDevices.forEach(function (d) { if (d.zoneName) seen[d.zoneName] = true; });
    Object.keys(seen).sort().forEach(function (zone) {
      var opt = document.createElement('option');
      opt.value = zone;
      opt.textContent = zone;
      selectEl.appendChild(opt);
    });
    selectEl.value = current || '';
  }
  function populateDeviceSelect(selectEl, zoneName) {
    selectEl.innerHTML = '';
    allDevices.slice()
      .filter(function (device) { return !zoneName || device.zoneName === zoneName; })
      .sort(byDeviceName)
      .forEach(function (device) {
        var opt = document.createElement('option');
        opt.value = device.id;
        opt.textContent = device.name + (device.zoneName ? ' (' + device.zoneName + ')' : '');
        selectEl.appendChild(opt);
      });
  }
  function populateCapabilitySelect(selectEl, device, kind, preselect) {
    selectEl.innerHTML = '';
    eligibleCapabilities(device, kind).forEach(function (cap) {
      var opt = document.createElement('option');
      opt.value = cap;
      var title = device.capabilitiesObj && device.capabilitiesObj[cap] && device.capabilitiesObj[cap].title;
      opt.textContent = (title || cap) + ' (' + cap + ')';
      selectEl.appendChild(opt);
    });
    if (preselect) selectEl.value = preselect;
  }

  // Wires the Zone -> Device -> Capability cascade shared by all three "Add monitor" forms —
  // previously each form (Activity/Voltage/State) hand-wired its own near-identical
  // refreshXDevices/refreshXCapabilities pair on top of the populate* functions above; this
  // factory is the one place that logic lives now. `options.preselectCapability` mirrors
  // Activity's "default to measure_power" behavior; `options.onCapabilityChange` is how State
  // hooks in its "show the active-values field for a multi-value capability" behavior.
  function setupDeviceCapabilityPicker(prefix, kind, options) {
    options = options || {};
    var zoneEl = document.getElementById(prefix + '-zone');
    var deviceEl = document.getElementById(prefix + '-device');
    var capabilityEl = document.getElementById(prefix + '-capability');
    function refreshCapabilities() {
      populateCapabilitySelect(capabilityEl, findDevice(deviceEl.value), kind, options.preselectCapability);
      if (options.onCapabilityChange) options.onCapabilityChange();
    }
    function refreshDevices() {
      populateDeviceSelect(deviceEl, zoneEl.value);
      refreshCapabilities();
    }
    zoneEl.addEventListener('change', refreshDevices);
    deviceEl.addEventListener('change', refreshCapabilities);
    if (options.onCapabilityChange) capabilityEl.addEventListener('change', options.onCapabilityChange);
    return { zoneEl: zoneEl, refreshDevices: refreshDevices };
  }

  // --- Add activity monitor ---
  var activityAddWrapper = document.getElementById('activity-add-form-wrapper');
  var activityAddForm = document.getElementById('activity-add-form');
  var activityAddDevice = document.getElementById('activity-add-device');
  var activityAddCapability = document.getElementById('activity-add-capability');
  var activityPicker = setupDeviceCapabilityPicker('activity-add', 'activity', { preselectCapability: 'measure_power' });
  document.getElementById('add-activity-monitor-btn').addEventListener('click', function () {
    activityAddForm.reset();
    populateZoneSelect(activityPicker.zoneEl);
    activityPicker.refreshDevices();
    openModal(activityAddWrapper);
  });
  document.getElementById('activity-add-cancel-btn').addEventListener('click', function () { closeModal(activityAddWrapper); });
  activityAddForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var payload = {
      deviceId: activityAddDevice.value,
      capability: activityAddCapability.value,
      name: document.getElementById('activity-add-name').value,
      threshold: document.getElementById('activity-add-threshold').value
    };
    api('POST', '/monitors', payload).then(function () {
      closeModal(activityAddWrapper);
      return api('GET', '/monitors?period=' + monitorPeriod);
    }).then(renderMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  // --- Add voltage monitor ---
  var voltageAddWrapper = document.getElementById('voltage-add-form-wrapper');
  var voltageAddForm = document.getElementById('voltage-add-form');
  var voltageAddDevice = document.getElementById('voltage-add-device');
  var voltageAddCapability = document.getElementById('voltage-add-capability');
  var voltagePicker = setupDeviceCapabilityPicker('voltage-add', 'voltage');
  document.getElementById('add-voltage-monitor-btn').addEventListener('click', function () {
    voltageAddForm.reset();
    populateZoneSelect(voltagePicker.zoneEl);
    voltagePicker.refreshDevices();
    openModal(voltageAddWrapper);
  });
  document.getElementById('voltage-add-cancel-btn').addEventListener('click', function () { closeModal(voltageAddWrapper); });
  voltageAddForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var payload = {
      deviceId: voltageAddDevice.value,
      capability: voltageAddCapability.value,
      name: document.getElementById('voltage-add-name').value,
      minVoltage: document.getElementById('voltage-add-min').value,
      maxVoltage: document.getElementById('voltage-add-max').value,
      stabilizationMinutes: document.getElementById('voltage-add-stabilization').value
    };
    api('POST', '/voltage-monitors', payload).then(function () {
      closeModal(voltageAddWrapper);
      return api('GET', '/voltage-monitors?period=' + monitorPeriod);
    }).then(renderVoltageMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  // --- Add state monitor ---
  var stateAddWrapper = document.getElementById('state-add-form-wrapper');
  var stateAddForm = document.getElementById('state-add-form');
  var stateAddDevice = document.getElementById('state-add-device');
  var stateAddCapability = document.getElementById('state-add-capability');
  var stateAddActiveValuesWrap = document.getElementById('state-add-active-values-wrap');
  var stateAddActiveValuesHint = document.getElementById('state-add-active-values-hint');
  function refreshStateActiveValuesVisibility() {
    var device = findDevice(stateAddDevice.value);
    var type = device && device.capabilitiesObj && device.capabilitiesObj[stateAddCapability.value] && device.capabilitiesObj[stateAddCapability.value].type;
    var needsActiveValues = type === 'enum' || type === 'string';
    stateAddActiveValuesWrap.classList.toggle('hidden', !needsActiveValues);
    stateAddActiveValuesHint.classList.toggle('hidden', !needsActiveValues);
  }
  var statePicker = setupDeviceCapabilityPicker('state-add', 'state', { onCapabilityChange: refreshStateActiveValuesVisibility });
  document.getElementById('add-state-monitor-btn').addEventListener('click', function () {
    stateAddForm.reset();
    populateZoneSelect(statePicker.zoneEl);
    statePicker.refreshDevices();
    openModal(stateAddWrapper);
  });
  document.getElementById('state-add-cancel-btn').addEventListener('click', function () { closeModal(stateAddWrapper); });
  stateAddForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var payload = {
      deviceId: stateAddDevice.value,
      capability: stateAddCapability.value,
      trueLabel: document.getElementById('state-add-true-label').value,
      falseLabel: document.getElementById('state-add-false-label').value,
      name: document.getElementById('state-add-name').value,
      activeValues: document.getElementById('state-add-active-values').value
    };
    api('POST', '/state-monitors', payload).then(function () {
      closeModal(stateAddWrapper);
      return api('GET', '/state-monitors?period=' + monitorPeriod);
    }).then(renderStateMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  // --- Add binary counter ---
  var binaryAddWrapper = document.getElementById('binary-add-form-wrapper');
  var binaryAddForm = document.getElementById('binary-add-form');
  document.getElementById('add-binary-counter-btn').addEventListener('click', function () {
    binaryAddForm.reset();
    openModal(binaryAddWrapper);
  });
  document.getElementById('binary-add-cancel-btn').addEventListener('click', function () { closeModal(binaryAddWrapper); });
  binaryAddForm.addEventListener('submit', function (event) {
    event.preventDefault();
    api('POST', '/binary-counters', { name: document.getElementById('binary-add-name').value }).then(function () {
      closeModal(binaryAddWrapper);
      return api('GET', '/binary-counters?period=' + monitorPeriod);
    }).then(renderBinaryCounters).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  function loadAll() {
    return Promise.all([
      api('GET', '/devices'), api('GET', '/groups'), api('GET', '/monitors?period=' + monitorPeriod), api('GET', '/voltage-monitors?period=' + monitorPeriod),
      api('GET', '/binary-counters?period=' + monitorPeriod), api('GET', '/state-monitors?period=' + monitorPeriod), api('GET', '/availability-watchdogs')
    ]).then(function (results) {
      allDevices = results[0];
      renderDeviceList();
      renderGroups(results[1]);
      renderMonitors(results[2]);
      renderVoltageMonitors(results[3]);
      renderBinaryCounters(results[4]);
      renderStateMonitors(results[5]);
      renderAvailability(results[0], results[6]);
    });
  }

  typeSelect.addEventListener('change', function () {
    var previouslyChecked = checkedDeviceIds();
    renderDeviceList();
    setCheckedDeviceIds(previouslyChecked);
  });

  cancelBtn.addEventListener('click', resetForm);

  deleteBtn.addEventListener('click', function () {
    if (!editingGroupId) return;
    Homey.confirm('Delete this group?', null, function (err, confirmed) {
      if (err || !confirmed) return;
      api('DELETE', '/groups/' + editingGroupId).then(function () {
        resetForm();
        return loadAll();
      }).catch(function (error) { Homey.alert(error.message || String(error)); });
    });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var deviceIds = checkedDeviceIds();
    if (deviceIds.length < 2) {
      Homey.alert('Select at least two devices.');
      return;
    }
    var payload = {
      name: document.getElementById('name').value,
      type: typeSelect.value,
      expectedState: document.getElementById('expectedState').value === 'true',
      deviceIds: deviceIds,
      conjunction: document.getElementById('conjunction').value || 'and',
      messageTemplateZero: document.getElementById('messageTemplateZero').value,
      messageTemplateOne: document.getElementById('messageTemplateOne').value,
      messageTemplateMany: document.getElementById('messageTemplateMany').value
    };
    var request = editingGroupId
      ? api('PUT', '/groups/' + editingGroupId, payload)
      : api('POST', '/groups', payload);
    request.then(function () {
      resetForm();
      return loadAll();
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  loadAll().catch(function (error) { Homey.alert(error.message || String(error)); });
}
