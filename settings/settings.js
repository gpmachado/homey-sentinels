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

  // "YYYY-MM-DD HH:mm:ss" of a moment, in the browser's own local time — a stand-in for the real %time% token
  // (lib/time.js#localTimeText renders the same shape in the app's configured time zone). Good enough for a
  // preview: exact only when the browser and the Homey are in the same time zone, which is the usual case.
  function formatPreviewTime(date) {
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' '
      + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  // Mirrors lib/cost.js so the %cost%/%cost_text% preview matches what a real message would show: kept to
  // cents, empty text with no price configured (0 is "not set", not "free"), the app's currency and decimal mark.
  function previewCostOf(kwh, pricePerKwh) {
    if (!isFinite(kwh) || !isFinite(pricePerKwh) || pricePerKwh <= 0) return 0;
    return Math.round(kwh * pricePerKwh * 100) / 100;
  }
  function previewCostText(cost, pricePerKwh, currency, decimalComma) {
    if (!isFinite(cost) || !isFinite(pricePerKwh) || pricePerKwh <= 0) return '';
    var digits = cost.toFixed(2);
    var number = decimalComma ? digits.replace('.', ',') : digits;
    return currency ? currency + ' ' + number : number;
  }

  // Message templates are deliberately rendered here with representative values. This makes
  // the value of a Flow message token visible before a user has to build a complete Flow or wait
  // for a real event. Unknown tokens stay marked instead of disappearing, so a typo is visible.
  function renderMessageExample(template, data) {
    if (!template || !template.trim()) return 'No message configured yet.';
    return template.replace(/%([a-zA-Z0-9_]+)(?::([^%|]*)\|([^%]*))?%/g, function (match, key, singular, plural) {
      if (singular !== undefined) {
        var count = Number(data[key]);
        return isFinite(count) && count === 1 ? singular : plural;
      }
      var value = data[key];
      if (value === undefined || value === null) return '‹' + key + '›';
      return String(value);
    });
  }

  var messagePreviewBindings = [];
  // Copies plain text to the clipboard from this webview (Homey's settings page, no HTTPS guarantee, so the
  // modern clipboard API may be unavailable) — falls back to the old select+execCommand trick, and gives up
  // quietly if neither works rather than throwing into a click handler.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () { copyTextFallback(text); });
    copyTextFallback(text);
    return Promise.resolve();
  }
  function copyTextFallback(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* best effort */ }
    document.body.removeChild(area);
  }

  function bindMessagePreview(inputId, previewId, data) {
    var input = document.getElementById(inputId);
    var preview = document.getElementById(previewId);
    if (!input || !preview) return;
    // A "ready-to-copy" button next to the example — the whole point of the preview is a finished sentence
    // the user can already judge or hand to someone else, not just read on screen.
    var wrapper = document.createElement('div');
    wrapper.className = 'message-preview-row';
    preview.parentNode.insertBefore(wrapper, preview);
    wrapper.appendChild(preview);
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'message-preview-copy-btn';
    copyBtn.textContent = 'Copy';
    wrapper.appendChild(copyBtn);
    var update = function () {
      var text = renderMessageExample(input.value, data);
      preview.textContent = text;
      preview.classList.toggle('message-preview-empty', !input.value.trim());
      copyBtn.disabled = !input.value.trim();
      copyBtn.title = input.value.trim() ? 'Copy "' + text + '"' : 'Type a template first';
    };
    copyBtn.addEventListener('click', function () {
      copyText(preview.textContent).then(function () {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('is-copied');
        setTimeout(function () { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('is-copied'); }, 1500);
      });
    });
    input.addEventListener('input', update);
    messagePreviewBindings.push(update);
    update();
  }
  function refreshMessagePreviews() { messagePreviewBindings.forEach(function (update) { update(); }); }

  // One realistic value per token these templates can actually receive (matching the real trigger payloads in
  // lib/app/activity.js, state.js, voltage.js) — every token below is a genuine one, so an unrecognized
  // ‹token› in the preview means a typo, never a token this preview simply forgot about.
  var previewTime = formatPreviewTime(new Date());

  // Name, category and a realistic example for every token a message template can use — matches the sample
  // data fed to the preview above, so hovering a button answers "what is this, and what will it look like"
  // without needing to type it first. Categories double as a colored left edge on the button (see style.css).
  var TOKEN_INFO = {
    device: { group: 'identification', type: 'text', example: 'Bomba do poço' },
    monitor: { group: 'identification', type: 'text', example: 'Bomba do poço' },
    label: { group: 'identification', type: 'text', example: 'Open' },
    counter: { group: 'identification', type: 'text', example: 'Doorbell' },
    group: { group: 'identification', type: 'text', example: 'Downstairs lights' },
    event_type: { group: 'identification', type: 'text', example: 'UNDERVOLTAGE' },
    time: { group: 'time', type: 'text', example: previewTime },
    duration: { group: 'time', type: 'number (seconds)', example: '2520' },
    duration_human: { group: 'time', type: 'text', example: '42 min' },
    energy: { group: 'energy', type: 'number (kWh)', example: '0.6' },
    energy_today: { group: 'energy', type: 'number (kWh)', example: '1.8' },
    power: { group: 'power', type: 'number (W)', example: '850' },
    average_power: { group: 'power', type: 'number (W)', example: '540' },
    max_power: { group: 'power', type: 'number (W)', example: '780' },
    average_current: { group: 'power', type: 'number (A)', example: '2.4' },
    max_current: { group: 'power', type: 'number (A)', example: '3.3' },
    voltage: { group: 'power', type: 'number (V)', example: '228.5' },
    min_voltage: { group: 'power', type: 'number (V)', example: '210' },
    max_voltage: { group: 'power', type: 'number (V)', example: '240' },
    average_voltage: { group: 'power', type: 'number (V)', example: '229' },
    cost: { group: 'cost', type: 'number', example: 'depends on the price set in Energy cost' },
    cost_today: { group: 'cost', type: 'number', example: 'depends on the price set in Energy cost' },
    cost_text: { group: 'cost', type: 'text', example: 'R$ 1.02 (empty with no price set)' },
    cost_today_text: { group: 'cost', type: 'text', example: 'R$ 2.55 (empty with no price set)' },
    count: { group: 'count', type: 'number', example: '3' },
    total: { group: 'count', type: 'number', example: '17' },
    items: { group: 'count', type: 'text', example: 'Kitchen, Hall and Porch' }
  };
  // "%count:time|times%" is its own token syntax, not a plain key — matched separately so it still gets a
  // tooltip instead of falling through to "no info for this token".
  function tokenInfoFor(rawToken) {
    var key = rawToken.replace(/^%/, '').replace(/%$/, '').split(':')[0];
    return TOKEN_INFO[key] || null;
  }
  Array.prototype.forEach.call(document.querySelectorAll('button[data-token]'), function (btn) {
    var info = tokenInfoFor(btn.getAttribute('data-token') || '');
    if (!info) return;
    btn.setAttribute('data-group', info.group);
    btn.title = info.type + ' — e.g. ' + info.example;
  });
  var activityPreviewData = {
    device: 'Example device', monitor: 'Washing machine', power: 850, time: previewTime,
    duration: 2520, duration_human: '42 min', energy: 0.6, energy_today: 1.8,
    average_power: 540, max_power: 780, average_current: 2.4, max_current: 3.3, count: 3,
    cost: 0, cost_today: 0, cost_text: '', cost_today_text: ''
  };
  var statePreviewData = {
    device: 'Example sensor', monitor: 'Front door', label: 'Open', time: previewTime,
    duration: 720, duration_human: '12 min', energy: 0, energy_today: 0,
    average_power: 0, max_power: 0, average_current: 0, max_current: 0, count: 2,
    cost: 0, cost_today: 0, cost_text: '', cost_today_text: ''
  };
  var voltagePreviewData = {
    device: 'Example meter', monitor: 'Main voltage', voltage: 228.5, time: previewTime,
    event_type: 'undervoltage', duration: 320, duration_human: '5 min', min_voltage: 210, max_voltage: 240, average_voltage: 229
  };
  var binaryPreviewData = { counter: 'Doorbell', count: 2, total: 17 };
  var groupPreviewZeroData = { group: 'Downstairs lights', count: 0, items: '' };
  var groupPreviewOneData = { group: 'Downstairs lights', count: 1, items: 'Kitchen' };
  var groupPreviewData = { group: 'Downstairs lights', count: 3, items: 'Kitchen, Hall and Porch' };
  bindMessagePreview('activity-messageTemplateStarted', 'activity-message-preview-started', activityPreviewData);
  bindMessagePreview('activity-messageTemplateFinished', 'activity-message-preview-finished', activityPreviewData);
  bindMessagePreview('state-messageTemplateStarted', 'state-message-preview-started', statePreviewData);
  bindMessagePreview('state-messageTemplateFinished', 'state-message-preview-finished', statePreviewData);
  bindMessagePreview('messageTemplateUndervoltage', 'voltage-message-preview-undervoltage', voltagePreviewData);
  bindMessagePreview('messageTemplateOvervoltage', 'voltage-message-preview-overvoltage', voltagePreviewData);
  bindMessagePreview('messageTemplateNormalized', 'voltage-message-preview-normalized', voltagePreviewData);
  bindMessagePreview('binary-messageTemplate', 'binary-message-preview', binaryPreviewData);
  bindMessagePreview('messageTemplateZero', 'group-message-preview-zero', groupPreviewZeroData);
  bindMessagePreview('messageTemplateOne', 'group-message-preview-one', groupPreviewOneData);
  bindMessagePreview('messageTemplateMany', 'group-message-preview-many', groupPreviewData);

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
  //
  // The wording itself lives in locales/<lang>.json under "messageWording", one set per
  // Homey-supported language with real translation confidence (en, nl, de, fr, it, sv, no, es,
  // da, pl — all Latin-alphabet; ru/ko/ar are skipped and Homey.__() falls back to English for
  // them, same as for any language not covered here). This only ever fills the *default* wording,
  // on an explicit click of "Fill default wording for this type" (with a confirm if something is
  // already there) — it never touches a template the user already wrote, matching what a
  // personalized message is for.
  document.getElementById('fill-wording-btn').addEventListener('click', function () {
    var base = 'messageWording.' + typeSelect.value + '.' + document.getElementById('expectedState').value + '.';
    var preset = { zero: Homey.__(base + 'zero'), one: Homey.__(base + 'one'), many: Homey.__(base + 'many') };
    if (!preset.zero || !preset.one || !preset.many) return;
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
    groupPreviewZeroData.group = 'Downstairs lights';
    groupPreviewOneData.group = 'Downstairs lights';
    groupPreviewData.group = 'Downstairs lights';
    refreshMessagePreviews();
    formTitle.textContent = 'New group';
    cancelBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
    closeModal(groupFormWrapper);
    renderDeviceList();
  }

  // Matches the wording of the #type <select> options exactly — showing the raw group.type
  // value ("switch", "light") read as a rough placeholder, not a real label, especially since
  // light/switch share the same onoff capability and are easy to pick between by mistake.
  var GROUP_TYPE_LABELS = { contact: 'Contact (doors/windows)', light: 'Light', switch: 'Switch/plug', valve: 'Valve', garage: 'Garage door' };
  var lastGroups = [];
  function renderGroups(groups) {
    lastGroups = groups;
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
      var gone = missingMembers(group);
      meta.textContent = (GROUP_TYPE_LABELS[group.type] || group.type) + ' · ' + group.devices.length + ' device(s) · expected: ' + (group.expectedState ? 'on/open' : 'off/closed')
        + (gone.length ? ' · no longer in Homey: ' + gone.map(function (m) { return m.name; }).join(', ') : '');
      var status = document.createElement('div');
      status.className = 'meta';
      status.textContent = 'Status not checked yet';
      // Whether the automatic 5-minute poll (not this on-demand check) currently thinks it already
      // reported a mismatch to Flow — the two can disagree if a mismatch resolved between two polls,
      // or the app restarted mid-mismatch, leaving group_mismatch_detected stuck and never firing
      // again until this is cleared.
      var flowStatus = document.createElement('div');
      flowStatus.className = 'meta';
      function renderFlowStatus() {
        flowStatus.textContent = group.mismatchSince
          ? 'Flow: mismatch reported since ' + new Date(group.mismatchSince).toLocaleString() + ' - will not fire again until it clears'
          : 'Flow: not currently reporting a mismatch';
        resetBtn.style.display = group.mismatchSince ? '' : 'none';
      }
      info.appendChild(title);
      info.appendChild(meta);
      info.appendChild(status);
      info.appendChild(flowStatus);
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
      var cleanBtn = actionLink('Clean up', function () {
        api('POST', '/groups/' + group.id + '/cleanup').then(function (result) {
          Homey.alert(result.removed.length
            ? 'Removed from the group (no longer in Homey): ' + result.removed.join(', ') + '. ' + result.remaining + ' device(s) left.'
            : 'Every device of this group is still in Homey.');
          return loadAll();
        }).catch(function (error) { Homey.alert(error.message || String(error)); });
      });
      var resetBtn = actionLink('Reset Flow status', function () {
        confirmAction('Let "' + group.name + '" report a new mismatch to Flow again? Use this if it stopped firing even though a mismatch is really happening.', function () {
          api('POST', '/groups/' + group.id + '/clear-mismatch').then(function (updated) {
            group.mismatchSince = updated.mismatchSince;
            renderFlowStatus();
          }).catch(function (error) { Homey.alert(error.message || String(error)); });
        });
      }, true);
      renderFlowStatus();
      buttons.appendChild(checkBtn);
      buttons.appendChild(editBtn);
      buttons.appendChild(cleanBtn);
      buttons.appendChild(resetBtn);
      row.appendChild(info);
      row.appendChild(buttons);
      groupsEl.appendChild(row);
    });
  }

  // Members of a group that the loaded device list no longer has (a sensor that was deleted from Homey). The
  // checkbox list is built from the current devices, so without this they were invisible and could not be
  // removed. Only judged once the list has loaded, or every member would look missing.
  function missingMembers(group) {
    if (!allDevices.length) return [];
    return group.devices.filter(function (member) { return !allDevices.some(function (device) { return device.id === member.id; }); });
  }
  var missingBox = document.getElementById('group-missing');
  function renderMissingBox(group) {
    missingBox.innerHTML = '';
    var missing = group ? missingMembers(group) : [];
    missingBox.classList.toggle('hidden', !missing.length);
    if (!missing.length) return;
    var title = document.createElement('div');
    title.textContent = 'No longer in Homey (not in the list above). They are removed from the group when you save.';
    missingBox.appendChild(title);
    missing.forEach(function (member) {
      var row = document.createElement('div');
      row.className = 'missing-name';
      var name = document.createElement('span');
      name.textContent = member.name;
      row.appendChild(name);
      row.appendChild(actionLink('Remove now', function () {
        api('POST', '/groups/' + group.id + '/cleanup').then(function () { return loadAll(); }).then(function () {
          resetForm();
        }).catch(function (error) { Homey.alert(error.message || String(error)); });
      }, true));
      missingBox.appendChild(row);
    });
  }

  function startEdit(group) {
    editingGroupId = group.id;
    formTitle.textContent = 'Editing: ' + group.name;
    groupPreviewZeroData.group = group.name;
    groupPreviewOneData.group = group.name;
    groupPreviewData.group = group.name;
    openModal(groupFormWrapper);
    document.getElementById('name').value = group.name;
    typeSelect.value = group.type;
    document.getElementById('expectedState').value = String(group.expectedState);
    renderDeviceList();
    setCheckedDeviceIds(group.devices.map(function (d) { return d.id; }));
    renderMissingBox(group);
    document.getElementById('conjunction').value = group.conjunction || '';
    document.getElementById('messageTemplateZero').value = group.messageTemplateZero || '';
    document.getElementById('messageTemplateOne').value = group.messageTemplateOne || '';
    document.getElementById('messageTemplateMany').value = group.messageTemplateMany || '';
    refreshMessagePreviews();
    cancelBtn.style.display = '';
    deleteBtn.style.display = '';
  }

  function formatLastSeen(iso) {
    if (!iso) return 'never';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return 'never';
    return date.toLocaleString();
  }

  // "6 d", "5 h", "20 min" — how long a device has been silent, for the Availability list.
  function silenceLabel(ms) {
    var minutes = Math.floor(ms / 60000);
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    return hours < 48 ? hours + ' h' : Math.floor(hours / 24) + ' d';
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
    monitors.slice().sort(byName).forEach(function (monitor) {
      var isActive = monitor.state === 'ACTIVE';
      var avgPower = monitor.averagePower !== null && monitor.averagePower !== undefined ? Math.round(monitor.averagePower) + ' W' : '—';
      var suggestion = monitor.suggestedThreshold;
      var progress = monitor.calibrationProgress;
      // "Calibrating" used to be a bare spinner with no visible progress. With `progress` this says how far
      // it got and, once enough samples exist without a clear standby/active split, why it's stuck — instead
      // of a monitor that silently looks broken for days (see the pump that stayed "calibrating" over a week).
      var calibratingTitle = 'Using a default 40 W threshold until enough history confirms this device\'s real standby/active power split.';
      if (progress) {
        if (progress.status === 'collecting') calibratingTitle = progress.valuesCollected + ' of ' + progress.valuesNeeded + ' power samples collected so far.';
        else if (progress.status === 'inconclusive') {
          calibratingTitle = progress.valuesCollected + ' samples collected (' + progress.min + '-' + progress.max + ' W), but no clear standby/active split yet'
            + (progress.standbyHigh !== null ? ': the closest split seen is standby up to ' + progress.standbyHigh + ' W, active from ' + progress.activeLow + ' W, not different enough to trust.' : '.');
        }
      }
      var stateBadge = monitor.calibrating
        ? '<span class="badge badge-calibrating" title="' + escapeHtml(calibratingTitle) + '">Calibrating' + (progress && progress.status === 'collecting' ? ' (' + progress.valuesCollected + '/' + progress.valuesNeeded + ')' : '') + '</span>'
        : '<span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + (isActive ? 'Active' : 'Standby') + '</span>';
      var nameHtml = escapeHtml(monitor.name) + ' ' + stateBadge + (monitor.deviceMissing ? ' <span class="badge badge-danger" title="The device was deleted from Homey; this monitor no longer receives data. Delete it if it is not needed.">Device missing</span>' : '');
      // Energy (a total accumulated over the whole period) and average power (a rate,
      // measured only while active) are easy to mistake for two readings of "the same
      // thing" when shown side by side with bare numbers — labeling each explicitly avoids
      // that, instead of relying on the reader to infer it from the unit alone.
      var metaBits = [
        escapeHtml(monitor.deviceName),
        monitor.cycleCount + ' cycle' + (monitor.cycleCount === 1 ? '' : 's'),
        '<span title="Total energy measured this period — active and standby draw combined.">' + formatEnergy(monitor.energy) + ' total</span>' + (monitor.energyQuality === 'meter_reset' ? ' <span class="badge badge-danger" title="A meter reset was detected in this period — energy may be understated.">reset</span>' : ''),
        '<span title="Average power measured only while active — not blended with standby time, and not the same as energy divided by the period length.">' + avgPower + ' while running</span>',
        monitor.threshold !== null && monitor.threshold !== undefined ? '<span class="chip" title="The Watts value that currently decides Active vs Standby for this monitor.">threshold ' + Math.round(monitor.threshold) + ' W</span>' : null,
        suggestion ? '<span class="chip chip-accent" title="Based on ' + suggestion.sampleCount + ' power samples, split between ' + Math.round(suggestion.low) + ' W and ' + Math.round(suggestion.high) + ' W">suggested ~' + Math.round(suggestion.threshold) + ' W</span>' : null,
        // A monitor with no completed cycle yet has nothing to show a median/trend from — without this the row
        // just looks empty ("—" everywhere), which reads as broken rather than "still watching, nothing to report".
        !monitor.calibrating && !monitor.hasCompletedCycles ? '<span class="hint">No completed cycles yet — stats need at least one.</span>' : null
      ];
      var row = entityRow(nameHtml, metaBits, renderSparkline(monitor.dailyBreakdown));
      // Messages/Reset/Delete only make sense against "today" — they'd otherwise act on
      // the monitor itself while the row is showing a week/month rollup, which reads as
      // if the action applied to that whole period instead of the monitor as a whole.
      if (monitorPeriod === 'day') {
        row.appendChild(entityActions([
          actionLink('Edit', function () { openActivityEditForm(monitor); }),
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
    monitors.slice().sort(byName).forEach(function (monitor) {
      var isActive = monitor.state === 'ACTIVE';
      var stateLabel = isActive ? monitor.trueLabel : monitor.falseLabel;
      var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + escapeHtml(stateLabel) + '</span>' + (monitor.deviceMissing ? ' <span class="badge badge-danger" title="The device was deleted from Homey; this monitor no longer receives data. Delete it if it is not needed.">Device missing</span>' : '');
      var metaBits = [
        escapeHtml(monitor.deviceName),
        monitor.cycleCount + ' session' + (monitor.cycleCount === 1 ? '' : 's'),
        escapeHtml(monitor.trueLabel) + ' ' + formatDuration(monitor.trueDuration),
        escapeHtml(monitor.falseLabel) + ' ' + formatDuration(monitor.falseDuration),
        // Only present when this monitor also tracks an auxiliary power capability — a
        // plain door/motion monitor's row stays exactly as it was. Labeled the same explicit
        // way as renderMonitors' energy/avg-power bits, for the same reason.
        monitor.energy !== undefined ? '<span title="Total energy measured this period — active and standby draw combined.">' + formatEnergy(monitor.energy) + ' total</span>' : null,
        monitor.averagePower !== null && monitor.averagePower !== undefined ? '<span title="Average power measured only while active — not blended with standby time, and not the same as energy divided by the period length.">' + Math.round(monitor.averagePower) + ' W while running</span>' : null
      ];
      var row = entityRow(nameHtml, metaBits, renderSparkline(monitor.dailyBreakdown, 'trueDuration', formatDuration));
      if (monitorPeriod === 'day') {
        row.appendChild(entityActions([
          actionLink('Edit', function () { openStateEditForm(monitor); }),
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
    monitors.slice().sort(byName).forEach(function (monitor) {
      var isNormal = monitor.state === 'NORMAL';
      var range = (monitor.minVoltage !== null && monitor.maxVoltage !== null)
        ? monitor.minVoltage.toFixed(1) + '–' + monitor.maxVoltage.toFixed(1) + ' V' : '—';
      var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isNormal ? 'badge-active' : 'badge-danger') + '">' + escapeHtml(monitor.state) + '</span>' + (monitor.deviceMissing ? ' <span class="badge badge-danger" title="The device was deleted from Homey; this monitor no longer receives data. Delete it if it is not needed.">Device missing</span>' : '');
      var metaBits = [
        escapeHtml(monitor.deviceName),
        (monitor.currentVoltage !== null ? monitor.currentVoltage.toFixed(1) + ' V now' : 'no reading'),
        'range ' + range,
        (monitor.undervoltageCount || 0) + ' under · ' + (monitor.overvoltageCount || 0) + ' over'
      ];
      var row = entityRow(nameHtml, metaBits);
      if (monitorPeriod === 'day') {
        row.appendChild(entityActions([
          actionLink('Edit', function () { openVoltageEditForm(monitor); }),
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

  var voltageEditFormWrapper = document.getElementById('voltage-edit-form-wrapper');
  var voltageEditForm = document.getElementById('voltage-edit-form');
  var editingVoltageRangeMonitorId = null;
  function openVoltageEditForm(monitor) {
    editingVoltageRangeMonitorId = monitor.id;
    document.getElementById('voltage-edit-form-name').textContent = monitor.name;
    document.getElementById('voltage-edit-name').value = monitor.name;
    populateCompatibleDeviceSelect(document.getElementById('voltage-edit-device'), monitor.capability, monitor.deviceId, monitor.deviceName);
    document.getElementById('voltage-edit-min').value = monitor.configuredMinVoltage;
    document.getElementById('voltage-edit-max').value = monitor.configuredMaxVoltage;
    document.getElementById('voltage-edit-stabilization').value = monitor.stabilizationMinutes;
    openModal(voltageEditFormWrapper);
  }
  document.getElementById('voltage-edit-cancel-btn').addEventListener('click', function () {
    editingVoltageRangeMonitorId = null;
    closeModal(voltageEditFormWrapper);
  });
  voltageEditForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingVoltageRangeMonitorId) return;
    var payload = {
      name: document.getElementById('voltage-edit-name').value,
      deviceId: document.getElementById('voltage-edit-device').value,
      minVoltage: document.getElementById('voltage-edit-min').value,
      maxVoltage: document.getElementById('voltage-edit-max').value,
      stabilizationMinutes: document.getElementById('voltage-edit-stabilization').value
    };
    api('PUT', '/voltage-monitors/' + editingVoltageRangeMonitorId, payload).then(function () {
      closeModal(voltageEditFormWrapper);
      editingVoltageRangeMonitorId = null;
      return api('GET', '/voltage-monitors?period=' + monitorPeriod);
    }).then(renderVoltageMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

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
    voltagePreviewData.device = monitor.name;
    voltagePreviewData.monitor = monitor.name;
    document.getElementById('messageTemplateUndervoltage').value = monitor.messageTemplateUndervoltage || '';
    document.getElementById('messageTemplateOvervoltage').value = monitor.messageTemplateOvervoltage || '';
    document.getElementById('messageTemplateNormalized').value = monitor.messageTemplateNormalized || '';
    refreshMessagePreviews();
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
  var activityEditFormWrapper = document.getElementById('activity-edit-form-wrapper');
  var activityEditForm = document.getElementById('activity-edit-form');
  var editingActivityMonitorSettingsId = null;
  function openActivityEditForm(monitor) {
    editingActivityMonitorSettingsId = monitor.id;
    document.getElementById('activity-edit-form-name').textContent = monitor.name;
    document.getElementById('activity-edit-name').value = monitor.name;
    populateCompatibleDeviceSelect(document.getElementById('activity-edit-device'), monitor.capability, monitor.deviceId, monitor.deviceName);
    document.getElementById('activity-edit-threshold').value = monitor.threshold;
    document.getElementById('activity-edit-continuity').value = monitor.continuityMinutes || 0;
    document.getElementById('activity-edit-confirmation').value = monitor.minConfirmationSeconds || 0;
    openModal(activityEditFormWrapper);
  }
  document.getElementById('activity-edit-cancel-btn').addEventListener('click', function () {
    editingActivityMonitorSettingsId = null;
    closeModal(activityEditFormWrapper);
  });
  activityEditForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingActivityMonitorSettingsId) return;
    var payload = {
      name: document.getElementById('activity-edit-name').value,
      deviceId: document.getElementById('activity-edit-device').value,
      threshold: document.getElementById('activity-edit-threshold').value,
      continuityMinutes: document.getElementById('activity-edit-continuity').value,
      minConfirmationSeconds: document.getElementById('activity-edit-confirmation').value
    };
    api('PUT', '/monitors/' + editingActivityMonitorSettingsId, payload).then(function () {
      closeModal(activityEditFormWrapper);
      editingActivityMonitorSettingsId = null;
      return api('GET', '/monitors?period=' + monitorPeriod);
    }).then(renderMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  function openActivityMessageForm(monitor) {
    editingActivityMonitorId = monitor.id;
    document.getElementById('activity-message-form-name').textContent = monitor.name;
    activityPreviewData.device = monitor.name;
    activityPreviewData.monitor = monitor.name;
    document.getElementById('activity-messageTemplateStarted').value = monitor.messageTemplateStarted || '';
    document.getElementById('activity-messageTemplateFinished').value = monitor.messageTemplateFinished || '';
    refreshMessagePreviews();
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
  var stateEditFormWrapper = document.getElementById('state-edit-form-wrapper');
  var stateEditForm = document.getElementById('state-edit-form');
  var editingStateMonitorLabelsId = null;
  function openStateEditForm(monitor) {
    editingStateMonitorLabelsId = monitor.id;
    document.getElementById('state-edit-form-name').textContent = monitor.name;
    document.getElementById('state-edit-name').value = monitor.name;
    populateCompatibleDeviceSelect(document.getElementById('state-edit-device'), monitor.capability, monitor.deviceId, monitor.deviceName);
    document.getElementById('state-edit-true-label').value = monitor.trueLabel || '';
    document.getElementById('state-edit-false-label').value = monitor.falseLabel || '';
    var isMultiValue = Array.isArray(monitor.activeValues) && monitor.activeValues.length > 0;
    document.getElementById('state-edit-active-values').value = isMultiValue ? monitor.activeValues.join(', ') : '';
    document.getElementById('state-edit-active-values-wrap').classList.toggle('hidden', !isMultiValue);
    document.getElementById('state-edit-active-values-hint').classList.toggle('hidden', !isMultiValue);
    openModal(stateEditFormWrapper);
  }
  document.getElementById('state-edit-cancel-btn').addEventListener('click', function () {
    editingStateMonitorLabelsId = null;
    closeModal(stateEditFormWrapper);
  });
  stateEditForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!editingStateMonitorLabelsId) return;
    var payload = {
      name: document.getElementById('state-edit-name').value,
      deviceId: document.getElementById('state-edit-device').value,
      trueLabel: document.getElementById('state-edit-true-label').value,
      falseLabel: document.getElementById('state-edit-false-label').value,
      activeValues: document.getElementById('state-edit-active-values').value
    };
    api('PUT', '/state-monitors/' + editingStateMonitorLabelsId, payload).then(function () {
      closeModal(stateEditFormWrapper);
      editingStateMonitorLabelsId = null;
      return api('GET', '/state-monitors?period=' + monitorPeriod);
    }).then(renderStateMonitors).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  function openStateMessageForm(monitor) {
    editingStateMonitorId = monitor.id;
    document.getElementById('state-message-form-name').textContent = monitor.name;
    statePreviewData.device = monitor.name;
    statePreviewData.monitor = monitor.name;
    document.getElementById('state-messageTemplateStarted').value = monitor.messageTemplateStarted || '';
    document.getElementById('state-messageTemplateFinished').value = monitor.messageTemplateFinished || '';
    refreshMessagePreviews();
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
    counters.slice().sort(byName).forEach(function (counter) {
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
    binaryPreviewData.counter = counter.name;
    binaryMessageInput.value = counter.messageTemplate || '';
    refreshMessagePreviews();
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
      document.getElementById('availability-scan-stamp').textContent = enabled ? 'The first scan runs a couple of minutes after the app starts. Press Scan now to run it.' : '';
      return;
    }
    var scan = lastScan.scan;
    scan.problems.forEach(function (p) { scanProblemById[p.id] = p; });
    var tiles = [
      ['stale', scan.counts.stale, 'Not reporting', 'is-bad'],
      ['unavailable', scan.counts.unavailable, 'Unavailable', 'is-bad'],
      ['battery', scan.counts.lowBattery, 'Low battery', 'is-warn'],
      ['ok', Math.max(0, scan.monitored - scan.problems.length), 'OK', '']
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
    var appHint = topApp && silentByApp[topApp] >= 5 ? silentByApp[topApp] + ' of the silent devices belong to ' + shortApp(topApp) + '; if they only report when used, press Ignore app on one of them. ' : '';
    document.getElementById('availability-scan-stamp').textContent = appHint + (ignoredApps.length ? 'Ignoring every device of: ' + ignoredApps.join(', ') + '. ' : '') + scan.monitored + ' devices without a watchdog checked, last scan ' + new Date(scan.at).toLocaleString() + '. Silent for more than ' + availabilityDefaults.defaultThresholdHours + ' h counts as not reporting.';
    wrapper.classList.remove('hidden');
  }
  document.getElementById('availability-scan-btn').addEventListener('click', function () {
    var button = document.getElementById('availability-scan-btn');
    button.disabled = true;
    api('POST', '/availability-scan').then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(function (error) { Homey.alert(error.message || String(error)); }).then(function () { button.disabled = false; });
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
      text.textContent = shortApp(app.uri) + ' - ' + app.devices + ' device' + (app.devices === 1 ? '' : 's') + (app.flagged ? ', ' + app.flagged + ' flagged' : '');
      label.appendChild(box);
      label.appendChild(text);
      // Its own silence limit, for an app whose devices are quiet for long stretches (solar panels at night).
      var hours = document.createElement('input');
      hours.type = 'number';
      hours.min = '1';
      hours.className = 'app-hours';
      hours.title = 'Hours of silence before this app\'s devices count as not reporting (empty = the default)';
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
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  }
  function setAppExclusion(uri, excluded) {
    api('POST', '/availability-exclusions', { app: uri, excluded: excluded }).then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  }
  function setExclusion(device, excluded) {
    api('POST', '/availability-exclusions', { deviceId: device.id, name: device.name, excluded: excluded }).then(function (summary) {
      lastScan = summary;
      renderScanTiles();
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  }
  var DEFAULT_FIELDS = ['defaultThresholdHours', 'startupGraceMinutes', 'unavailableDelaySeconds', 'batteryWarnPercent', 'batteryDelaySeconds', 'scanIntervalMinutes'];
  var defaultsFormWrapper = document.getElementById('availability-defaults-form-wrapper');
  function defaultsField(name) { return document.getElementById('availability-defaults-' + name); }
  function fillDefaultsForm(settings) {
    DEFAULT_FIELDS.forEach(function (name) { defaultsField(name).value = settings[name]; });
    defaultsField('timelineNotifications').checked = settings.timelineNotifications !== false;
    defaultsField('scanAll').checked = settings.scanAll !== false;
    defaultsField('scanAnnounceSilent').checked = settings.scanAnnounceSilent === true;
  }
  document.getElementById('availability-defaults-btn').addEventListener('click', function () {
    api('GET', '/availability-settings').then(function (settings) {
      availabilityDefaults = settings;
      fillDefaultsForm(settings);
      openModal(defaultsFormWrapper);
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  });
  document.getElementById('availability-defaults-cancel-btn').addEventListener('click', function () { closeModal(defaultsFormWrapper); });
  document.getElementById('availability-defaults-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var body = { timelineNotifications: defaultsField('timelineNotifications').checked, scanAll: defaultsField('scanAll').checked, scanAnnounceSilent: defaultsField('scanAnnounceSilent').checked };
    DEFAULT_FIELDS.forEach(function (name) { body[name] = Number(defaultsField(name).value); });
    api('POST', '/availability-settings', body).then(function (saved) {
      availabilityDefaults = saved;
      closeModal(defaultsFormWrapper);
      loadAll();
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  });
  document.getElementById('availability-cleanup-btn').addEventListener('click', function () {
    confirmAction('Remove every watchdog whose device is no longer in Homey?', function () {
      api('POST', '/availability-watchdogs-cleanup').then(loadAll).catch(function (error) { Homey.alert(error.message || String(error)); });
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
      return loadAll();
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  });

  // Re-rendered from the last data received rather than hiding/showing existing rows (like
  // applyDeviceFilter above does) — this list can be 100+ devices long, in a house that size
  // scrolling past every one just to find a name is the actual complaint being fixed.
  var availabilityFilterEl = document.getElementById('availability-filter');
  var lastAvailabilityDevices = [];
  var lastAvailabilityWatchdogs = [];
  availabilityFilterEl.addEventListener('input', function () { renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs); });

  function renderAvailability(devices, watchdogs) {
    lastAvailabilityDevices = devices;
    lastAvailabilityWatchdogs = watchdogs;
    var container = document.getElementById('availability-body');
    renderAppList(devices, watchdogs);
    var missingCount = (watchdogs || []).filter(function (w) { return w.missing; }).length;
    document.getElementById('availability-cleanup-btn').classList.toggle('hidden', !missingCount);
    if (!devices.length) { renderEmptyList(container, deviceListLoading ? 'Loading devices...' : 'No devices found.'); return; }
    var query = availabilityFilterEl.value.trim().toLowerCase();
    var filtered = query ? devices.filter(function (d) { return d.name.toLowerCase().indexOf(query) !== -1; }) : devices;
    if (!filtered.length) { renderEmptyList(container, 'No devices match "' + escapeHtml(query) + '".'); return; }
    var watchdogByDeviceId = {};
    (watchdogs || []).forEach(function (w) { watchdogByDeviceId[w.deviceId] = w; });
    // Unavailable first, then the longest-unseen; devices with a watchdog are listed first in their own
    // section, so a watchdog that was just added is easy to find in a list of 300 devices.
    function byRisk(a, b) {
      if (a.available !== b.available) return a.available ? 1 : -1;
      return (a.lastSeenAt || '').localeCompare(b.lastSeenAt || '');
    }
    // Two devices can carry the same name (a washer and its second plug, a re-paired device): show a
    // short id on those so a watchdog can be told apart from the other one.
    var nameCount = {};
    devices.forEach(function (d) { nameCount[d.name] = (nameCount[d.name] || 0) + 1; });
    var watched = filtered.filter(function (d) { return watchdogByDeviceId[d.id]; }).sort(byRisk);
    var scanOn = lastScan && lastScan.enabled;
    var ignored = scanOn ? filtered.filter(function (d) { return isScanIgnored(d) && !watchdogByDeviceId[d.id]; }).sort(byRisk) : [];
    var others = filtered.filter(function (d) { return !watchdogByDeviceId[d.id] && !(scanOn && isScanIgnored(d)); }).sort(byRisk);
    if (scanOn && scanFilter) {
      // A tapped scan tile narrows the list to the devices the scan put in that group.
      others = others.filter(function (d) {
        var problem = scanProblemById[d.id];
        if (scanFilter === 'ok') return !problem;
        if (!problem) return false;
        return scanFilter === 'battery' ? problem.lowBattery : problem.reason === scanFilter;
      });
      watched = [];
      ignored = [];
    }
    container.innerHTML = '';
    function renderRow(device) {
      var watchdog = watchdogByDeviceId[device.id];
      // A device that stays "available" while it has said nothing for days is not healthy: sleepy sensors
      // never flip the flag when their battery dies. The same silence rule the watchdog uses (its own hours,
      // or the default for devices without one) shows here as an amber "Silent" badge.
      var lastSeenMs = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
      var silentMs = isNaN(lastSeenMs) ? 0 : Math.max(0, Date.now() - lastSeenMs);
      var appLimit = lastScan && lastScan.appHours && device.ownerUri ? lastScan.appHours[device.ownerUri] : 0;
      var silentLimitHours = watchdog ? watchdog.thresholdHours : (appLimit || availabilityDefaults.defaultThresholdHours);
      var silent = device.available && silentMs > silentLimitHours * 3600000;
      var statusBadge = !device.available
        ? '<span class="badge badge-danger">Unavailable</span>'
        : (silent ? '<span class="badge ' + (watchdog && watchdog.wentUnavailableAt ? 'badge-danger' : 'badge-warn') + '">Silent ' + silenceLabel(silentMs) + '</span>' : '<span class="badge badge-active">Available</span>');
      var nameHtml = escapeHtml(device.name) + ' ' + statusBadge
        + (watchdog ? ' <span class="badge">Watchdog ' + watchdog.thresholdHours + 'h' + (watchdog.ignoreUnavailable ? ', silence only' : '') + '</span>' : '')
        + (watchdog && watchdog.lowBattery ? ' <span class="badge badge-danger">Low battery ' + Math.round(watchdog.battery) + '%</span>' : '')
        + (watchdog && Number.isFinite(watchdog.battery) && !watchdog.lowBattery ? ' <span class="badge">Battery ' + Math.round(watchdog.battery) + '%</span>' : '')
        + (!watchdog && scanProblemById[device.id] && scanProblemById[device.id].lowBattery ? ' <span class="badge badge-danger">Low battery ' + Math.round(scanProblemById[device.id].battery) + '%</span>' : '');
      var metaBits = [
        escapeHtml(device.zoneName || ''),
        nameCount[device.name] > 1 ? 'same name as another device - id ' + escapeHtml(String(device.id).slice(0, 8)) : null,
        'last seen ' + formatLastSeen(device.lastSeenAt),
        scanOn && device.ownerUri ? 'app ' + escapeHtml(shortApp(device.ownerUri)) : null,
        !device.available && device.unavailableMessage ? escapeHtml(device.unavailableMessage) : null
      ];
      var row = entityRow(nameHtml, metaBits);
      if (!device.available) row.classList.add('unavailable-row');
      var actionButtons = [actionLink(watchdog ? 'Edit watchdog' : 'Add watchdog', function () { openAvailabilityWatchdogForm(device, watchdog); })];
      if (!watchdog && scanOn) {
        if (device.ownerUri && excludedAppIds[device.ownerUri]) {
          actionButtons.push(actionLink('Include app', function () { setAppExclusion(device.ownerUri, false); }));
        } else if (excludedIds[device.id]) {
          actionButtons.push(actionLink('Include in scan', function () { setExclusion(device, false); }));
        } else {
          actionButtons.push(actionLink('Ignore', function () { setExclusion(device, true); }));
          if (device.ownerUri) {
            actionButtons.push(actionLink('Ignore app', function () {
              confirmAction('Ignore every device of the app "' + shortApp(device.ownerUri) + '" in the scan?', function () { setAppExclusion(device.ownerUri, true); });
            }));
          }
        }
      }
      if (watchdog) {
        actionButtons.push(actionLink('Remove watchdog', function () {
          confirmAction('Stop watching "' + device.name + '" for availability?', function () {
            api('DELETE', '/availability-watchdogs/' + device.id).then(loadAll).catch(function (error) { Homey.alert(error.message || String(error)); });
          });
        }, true));
      }
      row.appendChild(entityActions(actionButtons));
      container.appendChild(row);
    }
    function appendSection(title) {
      var heading = document.createElement('div');
      heading.className = 'entity-section';
      heading.textContent = title;
      container.appendChild(heading);
    }
    var missing = (watchdogs || []).filter(function (w) { return w.missing; });
    if (missing.length) {
      appendSection('Device no longer in Homey (' + missing.length + ')');
      missing.forEach(function (w) {
        var row = entityRow(escapeHtml(w.name) + ' <span class="badge badge-danger">Not found</span>', [escapeHtml(w.zoneName || ''), 'watchdog ' + w.thresholdHours + 'h']);
        row.appendChild(entityActions([actionLink('Remove watchdog', function () {
          api('DELETE', '/availability-watchdogs/' + w.deviceId).then(loadAll).catch(function (error) { Homey.alert(error.message || String(error)); });
        }, true)]));
        container.appendChild(row);
      });
    }
    if (watched.length) appendSection('Watched by a watchdog (' + watched.length + ')');
    watched.forEach(renderRow);
    if (watched.length && others.length) appendSection('All other devices (' + others.length + ')');
    others.forEach(renderRow);
    if (ignored.length) {
      appendSection('Ignored by the scan (' + ignored.length + ')');
      ignored.forEach(renderRow);
    }
  }

  // Shared by the three "Add monitor" forms below — same device-then-capability picker
  // idea as the Flow cards' own autocomplete, just backed by the already-cached
  // `allDevices` list instead of a live query.
  function byName(a, b) { return a.name.localeCompare(b.name); }
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
      .sort(byName)
      .forEach(function (device) {
        var opt = document.createElement('option');
        opt.value = device.id;
        opt.textContent = device.name + (device.zoneName ? ' (' + device.zoneName + ')' : '');
        selectEl.appendChild(opt);
      });
  }
  function populateCompatibleDeviceSelect(selectEl, capability, currentId, currentName) {
    selectEl.innerHTML = '';
    allDevices.filter(function (device) { return (device.capabilities || []).indexOf(capability) !== -1; })
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
    if (!requireDevices()) return;
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
    if (!requireDevices()) return;
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
    if (!requireDevices()) return;
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

  // The device list is read by the app on demand (it is large, and reading it costs the app memory), so
  // it can still be empty or stale when the page first asks: poll its status and re-render when the
  // read has finished.
  var deviceListLoading = false;
  var devicePollTimer = null;
  function waitForDevices(attempt) {
    deviceListLoading = true;
    clearTimeout(devicePollTimer);
    api('GET', '/devices/status').then(function (status) {
      if (status.loaded && !status.loading) {
        return api('GET', '/devices').then(function (list) {
          deviceListLoading = false;
          allDevices = list;
          renderDeviceList();
          renderAvailability(allDevices, lastAvailabilityWatchdogs || []);
          renderGroups(lastGroups); // the groups were drawn while the list was still loading: redo them to spot deleted members
        });
      }
      if (attempt < 60) {
        devicePollTimer = setTimeout(function () { waitForDevices(attempt + 1); }, 1500);
      } else {
        deviceListLoading = false;
        renderEmptyList(document.getElementById('availability-body'), 'The device list could not be loaded. Reload this page to try again.');
      }
    }).catch(function (error) { deviceListLoading = false; Homey.alert(error.message || String(error)); });
  }

  // The Add forms pick from the device list, which the app reads on demand.
  function requireDevices() {
    if (allDevices.length) return true;
    Homey.alert('The device list is still loading. Try again in a few seconds.');
    return false;
  }

  function loadAll() {
    return Promise.all([
      api('GET', '/devices'), api('GET', '/groups'), api('GET', '/monitors?period=' + monitorPeriod), api('GET', '/voltage-monitors?period=' + monitorPeriod),
      api('GET', '/binary-counters?period=' + monitorPeriod), api('GET', '/state-monitors?period=' + monitorPeriod), api('GET', '/availability-watchdogs'), api('GET', '/availability-settings'), api('GET', '/availability-scan')
    ]).then(function (results) {
      allDevices = results[0];
      availabilityDefaults = results[7];
      lastScan = results[8];
      renderScanTiles();
      renderDeviceList();
      renderGroups(results[1]);
      renderMonitors(results[2]);
      renderVoltageMonitors(results[3]);
      renderBinaryCounters(results[4]);
      renderStateMonitors(results[5]);
      deviceListLoading = !results[0].length;
      renderAvailability(results[0], results[6]);
      return api('GET', '/devices/status').then(function (status) {
        if (status.loading || !allDevices.length) waitForDevices(0);
      });
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

  // Message format: one switch for every message the app writes.
  var decimalCommaBox = document.getElementById('message-decimal-comma');
  var priceInput = document.getElementById('energy-price');
  var currencyInput = document.getElementById('energy-currency');
  // The %cost%/%cost_text% preview only makes sense with the real price, currency and decimal-comma setting —
  // recomputed here (once loaded, and again whenever the price/currency is saved) so it matches production.
  function applyCostPreview(settings) {
    var price = Number(settings.pricePerKwh) || 0;
    [activityPreviewData, statePreviewData].forEach(function (data) {
      data.cost = previewCostOf(data.energy, price);
      data.cost_today = previewCostOf(data.energy_today, price);
      data.cost_text = previewCostText(data.cost, price, settings.currency, settings.decimalComma);
      data.cost_today_text = previewCostText(data.cost_today, price, settings.currency, settings.decimalComma);
    });
    refreshMessagePreviews();
  }
  api('GET', '/message-settings').then(function (settings) {
    decimalCommaBox.checked = settings.decimalComma === true;
    priceInput.value = settings.pricePerKwh > 0 ? settings.pricePerKwh : '';
    currencyInput.value = settings.currency || '';
    applyCostPreview(settings);
  }).catch(function () {});
  document.getElementById('energy-cost-save').addEventListener('click', function () {
    api('POST', '/message-settings', { pricePerKwh: priceInput.value, currency: currencyInput.value }).then(function (saved) {
      priceInput.value = saved.pricePerKwh > 0 ? saved.pricePerKwh : '';
      currencyInput.value = saved.currency || '';
      applyCostPreview(saved);
      Homey.alert(saved.pricePerKwh > 0 ? 'Saved. Finished cycles now carry their estimated cost.' : 'Saved. The cost is off (no price set).');
    }).catch(function (error) { Homey.alert(error.message || String(error)); });
  });
  decimalCommaBox.addEventListener('change', function () {
    api('POST', '/message-settings', { decimalComma: decimalCommaBox.checked }).then(function (saved) {
      applyCostPreview(saved);
    }).catch(function (error) {
      decimalCommaBox.checked = !decimalCommaBox.checked;
      Homey.alert(error.message || String(error));
    });
  });

  // Everything that can go from fine to broken on its own — a device deleted mid-session, a watchdog firing,
  // a group's live mismatch — otherwise only ever appeared in the log: the page fetched every list once at
  // open and never again, so a "Device missing" badge (or any other status change) only reached the screen if
  // the person happened to reload it. Re-fetches the same lists loadAll() does, minus the full device
  // directory (/devices) and its 300+-row Availability re-render, which stay on their own, cheaper triggers.
  function refreshLiveStatus() {
    if (document.hidden) return;
    Promise.all([
      api('GET', '/groups'), api('GET', '/monitors?period=' + monitorPeriod), api('GET', '/voltage-monitors?period=' + monitorPeriod),
      api('GET', '/binary-counters?period=' + monitorPeriod), api('GET', '/state-monitors?period=' + monitorPeriod), api('GET', '/availability-watchdogs')
    ]).then(function (results) {
      renderGroups(results[0]);
      renderMonitors(results[1]);
      renderVoltageMonitors(results[2]);
      renderBinaryCounters(results[3]);
      renderStateMonitors(results[4]);
      lastAvailabilityWatchdogs = results[5];
      renderAvailability(lastAvailabilityDevices, lastAvailabilityWatchdogs);
    }).catch(function () { /* a miss here just tries again next tick */ });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshLiveStatus(); });
  setInterval(refreshLiveStatus, 60000);

  loadAll().catch(function (error) { Homey.alert(error.message || String(error)); });
}
