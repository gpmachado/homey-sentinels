// Stand-in for Homey's settings runtime with fixtures for every list, recording each API call and confirm.
(function () {
  var log = []; window.__log = log;
  var tmpl = { messageTemplateStarted: 'S %monitor%', messageTemplateFinished: 'F %monitor%', messageTemplateUndervoltage: 'U', messageTemplateOvervoltage: 'O', messageTemplateNormalized: 'N' };
  var lists = {
    '/groups': [{ id: 'g1', name: 'Doors', type: 'contact', expectedState: false, conjunction: 'and', devices: [{ id: 'd1', name: 'Sonoff' }, { id: 'd2', name: 'Plug' }], messageTemplateZero: 'Z', messageTemplateOne: 'O1', messageTemplateMany: 'M' }],
    '/monitors': [{ id: 'a1', name: 'Pump', deviceName: 'Sonoff', deviceId: 'd1', capability: 'measure_power', deviceMissing: false, state: 'STANDBY', threshold: 40, continuityMinutes: 2, minConfirmationSeconds: 5, cycleCount: 3, energy: 1.2, averagePower: 540, calibrating: false, suggestedThreshold: null, calibrationProgress: null, hasCompletedCycles: true, messageTemplateStarted: 'AS', messageTemplateFinished: 'AF' }],
    '/state-monitors': [{ id: 's1', name: 'Door', deviceName: 'Plug', deviceId: 'd2', capability: 'alarm_contact', deviceMissing: false, state: 'ACTIVE', trueLabel: 'Open', falseLabel: 'Closed', activeValues: null, cycleCount: 2, trueDuration: 720, falseDuration: 3600, messageTemplateStarted: 'SS', messageTemplateFinished: 'SF' },
      { id: 's2', name: 'Washer', deviceName: 'Plug', deviceId: 'd2', capability: 'machine_state', deviceMissing: false, state: 'STANDBY', trueLabel: 'Running', falseLabel: 'Idle', activeValues: ['Running', 'Rinse'], cycleCount: 1, trueDuration: 60, falseDuration: 600, messageTemplateStarted: 'WS', messageTemplateFinished: 'WF' }],
    '/voltage-monitors': [{ id: 'v1', name: 'Fase A', deviceName: 'Sonoff', deviceId: 'd1', capability: 'measure_voltage', deviceMissing: false, state: 'NORMAL', minVoltage: 210, maxVoltage: 240, configuredMinVoltage: 210, configuredMaxVoltage: 240, stabilizationMinutes: 5, currentVoltage: 229.8, undervoltageCount: 1, overvoltageCount: 0, messageTemplateUndervoltage: 'VU', messageTemplateOvervoltage: 'VO', messageTemplateNormalized: 'VN' }],
    '/devices': [
      { id: 'd1', name: 'Sonoff', zoneName: 'Well', capabilities: ['measure_power', 'meter_power', 'measure_voltage'], capabilitiesObj: { measure_power: { type: 'number', title: 'Power' }, measure_voltage: { type: 'number', title: 'Voltage' } } },
      { id: 'd9', name: 'Spare meter', zoneName: 'Well', capabilities: ['measure_power', 'measure_voltage'], capabilitiesObj: { measure_power: { type: 'number', title: 'Power' }, measure_voltage: { type: 'number', title: 'Voltage' } } },
      { id: 'd3', name: 'Lamp', zoneName: 'Hall', capabilities: ['onoff', 'measure_power'], capabilitiesObj: { onoff: { type: 'boolean', title: 'On/Off' }, measure_power: { type: 'number', title: 'Power' } } },
      { id: 'd4', name: 'Freezer plug', zoneName: 'Garage', capabilities: ['measure_power', 'meter_power'], capabilitiesObj: { measure_power: { type: 'number', title: 'Power' } } },
      { id: 'd5', name: 'Pump meter', zoneName: 'Well', capabilities: ['measure_power.a', 'measure_power.b', 'measure_power.c', 'measure_voltage.a', 'measure_voltage.b', 'measure_voltage.c'], capabilitiesObj: { 'measure_power.a': { type: 'number', title: 'Power Phase A' }, 'measure_power.b': { type: 'number', title: 'Power Phase B' }, 'measure_power.c': { type: 'number', title: 'Power Phase C' }, 'measure_voltage.a': { type: 'number', title: 'Voltage Phase A' }, 'measure_voltage.b': { type: 'number', title: 'Voltage Phase B' }, 'measure_voltage.c': { type: 'number', title: 'Voltage Phase C' } } },
      { id: 'd7', name: 'Inverter', zoneName: 'Garage', capabilities: ['measure_voltage.pv1', 'measure_voltage.pv2', 'measure_voltage.l1'], capabilitiesObj: { 'measure_voltage.pv1': { type: 'number', title: 'PV1 Voltage' }, 'measure_voltage.pv2': { type: 'number', title: 'PV2 Voltage' }, 'measure_voltage.l1': { type: 'number', title: 'L1 Voltage' } } },
      { id: 'd6', name: 'Washer', zoneName: 'Laundry', capabilities: ['WM-operation', 'WM-spin', 'button.reset_meter', 'speaker_next', 'description', 'onoff'], capabilitiesObj: { 'WM-operation': { type: 'enum', title: 'Operation' }, 'WM-spin': { type: 'enum', title: 'Spin speed' }, 'button.reset_meter': { type: 'boolean', title: 'Reset energy meter' }, speaker_next: { type: 'boolean', title: 'Next' }, description: { type: 'string', title: 'Description' }, onoff: { type: 'boolean', title: 'On/Off' } } },
      { id: 'd2', name: 'Plug', zoneName: 'Hall', capabilities: ['alarm_contact', 'machine_state'], capabilitiesObj: { alarm_contact: { type: 'boolean', title: 'Contact' }, machine_state: { type: 'enum', title: 'Machine state' } } }],
    '/devices/status': { loading: false }, '/availability-watchdogs': [], '/availability-settings': { defaultThresholdHours: 12 },
    '/availability-scan': { enabled: false, excludedDevices: [], excludedApps: [], excludedZones: [] }, '/message-settings': { messageLanguage: '', decimalComma: false, pricePerKwh: 0, currency: '' },
    '/default-wording': { language: 'en', languages: [{ code: 'en', name: 'English' }, { code: 'pt', name: 'Português' }, { code: 'de', name: 'Deutsch' }], messageWording: { contact: { 'false': { zero: 'All doors and windows are closed.', one: '%items% is open.', many: '%count% doors/windows open: %items%.' }, 'true': { zero: 'All open.', one: '%items% is closed.', many: '%count% closed: %items%.' } } } }
  };
  window.addEventListener('load', function () {
    var Homey = {
      api: function (method, path, body, cb) {
        if (typeof body === 'function') { cb = body; body = undefined; }
        log.push({ call: method + ' ' + path, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
        var key = path.split('?')[0];
        var result = method === 'GET' ? lists[key] : (key === '/message-settings' ? Object.assign({}, lists[key], body) : {});
        setTimeout(function () { result === undefined ? cb(new Error('no fixture ' + key)) : cb(null, result); }, 0);
      },
      getLanguage: function () { return 'en'; }, __: function (k) { return k; },
      alert: function (m) { log.push({ alert: String(m) }); }, ready: function () {}, getSettings: function () { return {}; }, on: function () {},
      confirm: function (message, x, cb) { log.push({ confirm: message }); cb(null, true); }
    };
    onHomeyReady(Homey);
  });
})();
