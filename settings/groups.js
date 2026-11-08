var CAPABILITY_BY_TYPE = { contact: 'alarm_contact', light: 'onoff', switch: 'onoff', valve: 'onoff', garage: 'garagedoor_closed' };

/* global openModal, closeModal, escapeHtml, actionLink, entityActions, bindTokenInserter */

// The Groups tab: the list, the form and its device checklist.
function setupGroups(page) {
  var Homey = page.Homey, api = page.api, showError = page.showError, confirmAction = page.confirmAction, refreshMessagePreviews = page.refreshMessagePreviews, groupPreviewZeroData = page.groupPreviewZeroData, groupPreviewOneData = page.groupPreviewOneData, groupPreviewData = page.groupPreviewData;

  var editingGroupId = null;

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
    var compatible = page.allDevices.filter(function (d) { return d.capabilities.indexOf(capability) !== -1; });
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

  bindTokenInserter('.token-btn', '.token-target', document.getElementById('messageTemplateMany'));

  // "No mismatches" reads naturally when the expected state is the everyday-normal one
  // (lights off, doors closed) — the common case. Keyed by type + expected state so the
  // wording still makes sense if someone flips it (e.g. a group that expects lights ON).
  //
  // The wording itself lives in locales/<lang>.json under "messageWording", one set per language with real
  // translation confidence (en, pt, nl, de, fr, it, sv, no, es, da: all Latin-alphabet; ru/ko/ar are skipped and Polish
  // was pulled for a native check). The app picks the language (Settings -> Message format -> Default message
  // language, else Homey's, else English) and serves it from /default-wording, asked again on every click so a
  // language just changed applies at once. This only ever fills the *default* wording, on an explicit click of
  // "Fill default wording for this type" (with a confirm if something is already there): it never touches a
  // template the user already wrote, matching what a personalized message is for.
  document.getElementById('fill-wording-btn').addEventListener('click', function () {
    var type = typeSelect.value;
    var state = document.getElementById('expectedState').value;
    api('GET', '/default-wording').then(function (info) {
      var preset = info.messageWording[type] && info.messageWording[type][state];
      if (!preset || !preset.zero || !preset.one || !preset.many) return;
      var zero = document.getElementById('messageTemplateZero');
      var one = document.getElementById('messageTemplateOne');
      var many = document.getElementById('messageTemplateMany');
      var apply = function () { zero.value = preset.zero; one.value = preset.one; many.value = preset.many; document.getElementById('conjunction').value = info.groupConjunction; refreshMessagePreviews(); };
      if (zero.value || one.value || many.value) {
        confirmAction('This will overwrite the current message wording. Continue?', apply);
      } else {
        apply();
      }
    }).catch(showError);
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
      groupsEl.innerHTML = '<p class="hint">No groups yet. Click "Add group" to check several doors, lights or switches at once.</p>';
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
          return page.loadAll();
        }).catch(showError);
      });
      var resetBtn = actionLink('Reset Flow status', function () {
        confirmAction('Let "' + group.name + '" report a new mismatch to Flow again? Use this if it stopped firing even though a mismatch is really happening.', function () {
          api('POST', '/groups/' + group.id + '/clear-mismatch').then(function (updated) {
            group.mismatchSince = updated.mismatchSince;
            renderFlowStatus();
          }).catch(showError);
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
    if (!page.allDevices.length) return [];
    return group.devices.filter(function (member) { return !page.allDevices.some(function (device) { return device.id === member.id; }); });
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
        api('POST', '/groups/' + group.id + '/cleanup').then(function () { return page.loadAll(); }).then(function () {
          resetForm();
        }).catch(showError);
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
        return page.loadAll();
      }).catch(showError);
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
      conjunction: document.getElementById('conjunction').value,
      messageTemplateZero: document.getElementById('messageTemplateZero').value,
      messageTemplateOne: document.getElementById('messageTemplateOne').value,
      messageTemplateMany: document.getElementById('messageTemplateMany').value
    };
    var request = editingGroupId
      ? api('PUT', '/groups/' + editingGroupId, payload)
      : api('POST', '/groups', payload);
    request.then(function () {
      resetForm();
      return page.loadAll();
    }).catch(showError);
  });

  page.renderGroups = renderGroups;
  page.redrawGroups = function () { renderGroups(lastGroups); };
  page.renderDeviceList = renderDeviceList;
}
