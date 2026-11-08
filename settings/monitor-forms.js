/* global openModal, closeModal, fieldValue, bindTokenInserter */

// The Add, Edit and Messages forms of the three kinds of monitor.
function setupMonitorForms(page) {
  var Homey = page.Homey, api = page.api, showError = page.showError, refreshMessagePreviews = page.refreshMessagePreviews, activityPreviewData = page.activityPreviewData, statePreviewData = page.statePreviewData, voltagePreviewData = page.voltagePreviewData, setupModalForm = page.setupModalForm, renderMonitors = page.renderMonitors, renderStateMonitors = page.renderStateMonitors, renderVoltageMonitors = page.renderVoltageMonitors, findDevice = page.findDevice, populateCompatibleDeviceSelect = page.populateCompatibleDeviceSelect, setupDeviceCapabilityPicker = page.setupDeviceCapabilityPicker;

  var voltageEditForm = setupModalForm({
    wrapperId: 'voltage-edit-form-wrapper', formId: 'voltage-edit-form', cancelId: 'voltage-edit-cancel-btn',
    listPath: '/voltage-monitors', render: renderVoltageMonitors,
    putPath: function (id) { return '/voltage-monitors/' + id; },
    payload: function () {
      return {
        name: fieldValue('voltage-edit-name'), deviceId: fieldValue('voltage-edit-device'),
        minVoltage: fieldValue('voltage-edit-min'), maxVoltage: fieldValue('voltage-edit-max'),
        stabilizationMinutes: fieldValue('voltage-edit-stabilization')
      };
    }
  });
  function openVoltageEditForm(monitor) {
    document.getElementById('voltage-edit-form-name').textContent = monitor.name;
    document.getElementById('voltage-edit-name').value = monitor.name;
    populateCompatibleDeviceSelect(document.getElementById('voltage-edit-device'), monitor.capability, monitor.deviceId, monitor.deviceName);
    document.getElementById('voltage-edit-min').value = monitor.configuredMinVoltage;
    document.getElementById('voltage-edit-max').value = monitor.configuredMaxVoltage;
    document.getElementById('voltage-edit-stabilization').value = monitor.stabilizationMinutes;
    voltageEditForm.open(monitor.id);
  }

  bindTokenInserter('.voltage-token-btn', '.voltage-token-target', document.getElementById('messageTemplateNormalized'));
  var voltageMessageForm = setupModalForm({
    wrapperId: 'voltage-message-form-wrapper', formId: 'voltage-message-form', cancelId: 'voltage-message-cancel-btn',
    listPath: '/voltage-monitors', render: renderVoltageMonitors,
    putPath: function (id) { return '/voltage-monitors/' + id + '/messages'; },
    payload: function () {
      return {
        messageTemplateUndervoltage: fieldValue('messageTemplateUndervoltage'),
        messageTemplateOvervoltage: fieldValue('messageTemplateOvervoltage'),
        messageTemplateNormalized: fieldValue('messageTemplateNormalized')
      };
    }
  });
  function openVoltageMessageForm(monitor) {
    document.getElementById('voltage-message-form-name').textContent = monitor.name;
    voltagePreviewData.device = monitor.name;
    voltagePreviewData.monitor = monitor.name;
    document.getElementById('messageTemplateUndervoltage').value = monitor.messageTemplateUndervoltage || '';
    document.getElementById('messageTemplateOvervoltage').value = monitor.messageTemplateOvervoltage || '';
    document.getElementById('messageTemplateNormalized').value = monitor.messageTemplateNormalized || '';
    refreshMessagePreviews();
    voltageMessageForm.open(monitor.id);
  }

  bindTokenInserter('.activity-token-btn', '.activity-token-target', document.getElementById('activity-messageTemplateFinished'));
  var activityEditForm = setupModalForm({
    wrapperId: 'activity-edit-form-wrapper', formId: 'activity-edit-form', cancelId: 'activity-edit-cancel-btn',
    listPath: '/monitors', render: renderMonitors,
    putPath: function (id) { return '/monitors/' + id; },
    payload: function () {
      return {
        name: fieldValue('activity-edit-name'), deviceId: fieldValue('activity-edit-device'),
        threshold: fieldValue('activity-edit-threshold'), continuityMinutes: fieldValue('activity-edit-continuity'),
        minConfirmationSeconds: fieldValue('activity-edit-confirmation')
      };
    }
  });
  function openActivityEditForm(monitor) {
    document.getElementById('activity-edit-form-name').textContent = monitor.name;
    document.getElementById('activity-edit-name').value = monitor.name;
    populateCompatibleDeviceSelect(document.getElementById('activity-edit-device'), monitor.capability, monitor.deviceId, monitor.deviceName);
    document.getElementById('activity-edit-threshold').value = monitor.threshold;
    document.getElementById('activity-edit-continuity').value = monitor.continuityMinutes || 0;
    document.getElementById('activity-edit-confirmation').value = monitor.minConfirmationSeconds || 0;
    activityEditForm.open(monitor.id);
  }

  var activityMessageForm = setupModalForm({
    wrapperId: 'activity-message-form-wrapper', formId: 'activity-message-form', cancelId: 'activity-message-cancel-btn',
    listPath: '/monitors', render: renderMonitors,
    putPath: function (id) { return '/monitors/' + id + '/messages'; },
    payload: function () {
      return { messageTemplateStarted: fieldValue('activity-messageTemplateStarted'), messageTemplateFinished: fieldValue('activity-messageTemplateFinished') };
    }
  });
  function openActivityMessageForm(monitor) {
    document.getElementById('activity-message-form-name').textContent = monitor.name;
    activityPreviewData.device = monitor.name;
    activityPreviewData.monitor = monitor.name;
    document.getElementById('activity-messageTemplateStarted').value = monitor.messageTemplateStarted || '';
    document.getElementById('activity-messageTemplateFinished').value = monitor.messageTemplateFinished || '';
    refreshMessagePreviews();
    activityMessageForm.open(monitor.id);
  }

  bindTokenInserter('.state-token-btn', '.state-token-target', document.getElementById('state-messageTemplateFinished'));
  var stateEditForm = setupModalForm({
    wrapperId: 'state-edit-form-wrapper', formId: 'state-edit-form', cancelId: 'state-edit-cancel-btn',
    listPath: '/state-monitors', render: renderStateMonitors,
    putPath: function (id) { return '/state-monitors/' + id; },
    payload: function () {
      return {
        name: fieldValue('state-edit-name'), deviceId: fieldValue('state-edit-device'),
        trueLabel: fieldValue('state-edit-true-label'), falseLabel: fieldValue('state-edit-false-label'),
        activeValues: fieldValue('state-edit-active-values')
      };
    }
  });
  function openStateEditForm(monitor) {
    document.getElementById('state-edit-form-name').textContent = monitor.name;
    document.getElementById('state-edit-name').value = monitor.name;
    populateCompatibleDeviceSelect(document.getElementById('state-edit-device'), monitor.capability, monitor.deviceId, monitor.deviceName);
    document.getElementById('state-edit-true-label').value = monitor.trueLabel || '';
    document.getElementById('state-edit-false-label').value = monitor.falseLabel || '';
    var isMultiValue = Array.isArray(monitor.activeValues) && monitor.activeValues.length > 0;
    document.getElementById('state-edit-active-values').value = isMultiValue ? monitor.activeValues.join(', ') : '';
    document.getElementById('state-edit-active-values-wrap').classList.toggle('hidden', !isMultiValue);
    document.getElementById('state-edit-active-values-hint').classList.toggle('hidden', !isMultiValue);
    stateEditForm.open(monitor.id);
  }

  var stateMessageForm = setupModalForm({
    wrapperId: 'state-message-form-wrapper', formId: 'state-message-form', cancelId: 'state-message-cancel-btn',
    listPath: '/state-monitors', render: renderStateMonitors,
    putPath: function (id) { return '/state-monitors/' + id + '/messages'; },
    payload: function () {
      return { messageTemplateStarted: fieldValue('state-messageTemplateStarted'), messageTemplateFinished: fieldValue('state-messageTemplateFinished') };
    }
  });
  function openStateMessageForm(monitor) {
    document.getElementById('state-message-form-name').textContent = monitor.name;
    statePreviewData.device = monitor.name;
    statePreviewData.monitor = monitor.name;
    document.getElementById('state-messageTemplateStarted').value = monitor.messageTemplateStarted || '';
    document.getElementById('state-messageTemplateFinished').value = monitor.messageTemplateFinished || '';
    refreshMessagePreviews();
    stateMessageForm.open(monitor.id);
  }

  // "Add monitor": the button opens a form whose pickers are filled from the loaded device list, Save POSTs the fields and
  // the list is fetched again. `picker` is the form's Capability / Zone / Device picker.
  function setupAddForm(spec) {
    var wrapper = document.getElementById(spec.wrapperId);
    var form = document.getElementById(spec.formId);
    document.getElementById(spec.buttonId).addEventListener('click', function () {
      if (!requireDevices()) return;
      form.reset();
      spec.picker.refresh();
      openModal(wrapper);
    });
    document.getElementById(spec.cancelId).addEventListener('click', function () { closeModal(wrapper); });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      api('POST', spec.path, spec.payload()).then(function () {
        closeModal(wrapper);
        return api('GET', spec.path + '?period=' + page.monitorPeriod);
      }).then(spec.render).catch(showError);
    });
  }

  setupAddForm({
    buttonId: 'add-activity-monitor-btn', wrapperId: 'activity-add-form-wrapper', formId: 'activity-add-form', cancelId: 'activity-add-cancel-btn',
    picker: setupDeviceCapabilityPicker('activity-add', 'activity', { preselectCapability: 'measure_power' }),
    path: '/monitors', render: renderMonitors,
    payload: function () {
      return {
        deviceId: fieldValue('activity-add-device'), capability: fieldValue('activity-add-capability'),
        name: fieldValue('activity-add-name'), threshold: fieldValue('activity-add-threshold')
      };
    }
  });

  setupAddForm({
    buttonId: 'add-voltage-monitor-btn', wrapperId: 'voltage-add-form-wrapper', formId: 'voltage-add-form', cancelId: 'voltage-add-cancel-btn',
    picker: setupDeviceCapabilityPicker('voltage-add', 'voltage'),
    path: '/voltage-monitors', render: renderVoltageMonitors,
    payload: function () {
      return {
        deviceId: fieldValue('voltage-add-device'), capability: fieldValue('voltage-add-capability'), name: fieldValue('voltage-add-name'),
        minVoltage: fieldValue('voltage-add-min'), maxVoltage: fieldValue('voltage-add-max'), stabilizationMinutes: fieldValue('voltage-add-stabilization')
      };
    }
  });

  // A multi-state capability needs to be told which value(s) count as active; a plain on/off one does not.
  function refreshStateActiveValuesVisibility() {
    var device = findDevice(fieldValue('state-add-device'));
    var capability = fieldValue('state-add-capability');
    var type = device && device.capabilitiesObj && device.capabilitiesObj[capability] && device.capabilitiesObj[capability].type;
    var needsActiveValues = type === 'enum' || type === 'string';
    document.getElementById('state-add-active-values-wrap').classList.toggle('hidden', !needsActiveValues);
    document.getElementById('state-add-active-values-hint').classList.toggle('hidden', !needsActiveValues);
  }
  var statePicker = setupDeviceCapabilityPicker('state-add', 'state', {
    onChange: refreshStateActiveValuesVisibility,
    showAll: function () { return document.getElementById('state-add-show-all').checked; }
  });
  document.getElementById('state-add-show-all').addEventListener('change', function () { statePicker.refresh(); });
  setupAddForm({
    buttonId: 'add-state-monitor-btn', wrapperId: 'state-add-form-wrapper', formId: 'state-add-form', cancelId: 'state-add-cancel-btn',
    picker: statePicker, path: '/state-monitors', render: renderStateMonitors,
    payload: function () {
      return {
        deviceId: fieldValue('state-add-device'), capability: fieldValue('state-add-capability'),
        trueLabel: fieldValue('state-add-true-label'), falseLabel: fieldValue('state-add-false-label'),
        name: fieldValue('state-add-name'), activeValues: fieldValue('state-add-active-values')
      };
    }
  });

  // The Add forms pick from the device list, which the app reads on demand.
  function requireDevices() {
    if (page.allDevices.length) return true;
    Homey.alert('The device list is still loading. Try again in a few seconds.');
    return false;
  }

  page.openActivityEditForm = openActivityEditForm;
  page.openActivityMessageForm = openActivityMessageForm;
  page.openStateEditForm = openStateEditForm;
  page.openStateMessageForm = openStateMessageForm;
  page.openVoltageEditForm = openVoltageEditForm;
  page.openVoltageMessageForm = openVoltageMessageForm;
}
