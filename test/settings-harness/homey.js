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
    '/devices': [{ id: 'd1', name: 'Sonoff', zoneName: 'Well', capabilities: ['measure_power', 'meter_power', 'measure_voltage'], capabilitiesObj: { measure_power: { type: 'number' }, measure_voltage: { type: 'number' } } },
      { id: 'd9', name: 'Spare meter', zoneName: 'Well', capabilities: ['measure_power', 'measure_voltage'], capabilitiesObj: {} },
      { id: 'd2', name: 'Plug', zoneName: 'Hall', capabilities: ['alarm_contact', 'machine_state'], capabilitiesObj: { alarm_contact: { type: 'boolean' }, machine_state: { type: 'enum' } } }],
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
