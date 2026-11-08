/* global formatPreviewTime */

// The live example under every message box, the token buttons and the Fill default wording buttons.
function setupMessages(page) {
  var api = page.api, showError = page.showError, confirmAction = page.confirmAction;

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
    average_power: 540, max_power: 780, average_current: 2.4, max_current: 3.3, count: 3
  };
  var statePreviewData = {
    device: 'Example sensor', monitor: 'Front door', label: 'Open', time: previewTime,
    duration: 720, duration_human: '12 min', energy: 0, energy_today: 0,
    average_power: 0, max_power: 0, average_current: 0, max_current: 0, count: 2
  };
  var voltagePreviewData = {
    device: 'Example meter', monitor: 'Main voltage', voltage: 228.5, time: previewTime,
    event_type: 'undervoltage', duration: 320, duration_human: '5 min', min_voltage: 210, max_voltage: 240, average_voltage: 229,
    power: 850, energy: 12.4
  };
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
  bindMessagePreview('messageTemplateZero', 'group-message-preview-zero', groupPreviewZeroData);
  bindMessagePreview('messageTemplateOne', 'group-message-preview-one', groupPreviewOneData);
  bindMessagePreview('messageTemplateMany', 'group-message-preview-many', groupPreviewData);

  // "Fill default wording" on a monitor's message form: the ready-made sentences in the Default message language (asked again on
  // every click, so a language just changed applies at once). A confirm first when a box already has text.
  function setupFillDefaultWording(buttonId, presetKey, fieldIds) {
    document.getElementById(buttonId).addEventListener('click', function () {
      api('GET', '/default-wording').then(function (info) {
        var preset = info[presetKey];
        if (!preset) return;
        var apply = function () {
          Object.keys(fieldIds).forEach(function (name) { document.getElementById(fieldIds[name]).value = preset[name] || ''; });
          refreshMessagePreviews();
        };
        var hasText = Object.keys(fieldIds).some(function (name) { return document.getElementById(fieldIds[name]).value; });
        if (hasText) confirmAction('This will overwrite the current message wording. Continue?', apply); else apply();
      }).catch(showError);
    });
  }
  setupFillDefaultWording('activity-message-fill-btn', 'activityMessageDefaults', { started: 'activity-messageTemplateStarted', finished: 'activity-messageTemplateFinished' });
  setupFillDefaultWording('state-message-fill-btn', 'stateMessageDefaults', { started: 'state-messageTemplateStarted', finished: 'state-messageTemplateFinished' });
  setupFillDefaultWording('voltage-message-fill-btn', 'voltageMessageDefaults', { undervoltage: 'messageTemplateUndervoltage', overvoltage: 'messageTemplateOvervoltage', normalized: 'messageTemplateNormalized' });

  page.refreshMessagePreviews = refreshMessagePreviews;
  page.activityPreviewData = activityPreviewData;
  page.statePreviewData = statePreviewData;
  page.voltagePreviewData = voltagePreviewData;
  page.groupPreviewZeroData = groupPreviewZeroData;
  page.groupPreviewOneData = groupPreviewOneData;
  page.groupPreviewData = groupPreviewData;
}

// The Message format section: the decimal comma and the Default message language.
function setupMessageFormat(page) {
  var Homey = page.Homey, api = page.api, refreshMessagePreviews = page.refreshMessagePreviews;

  // Message format: one switch for every message the app writes.
  var decimalCommaBox = document.getElementById('message-decimal-comma');
  // Default message language: "Same as Homey" (blank) or one of the languages the app has wording for.
  var messageLanguageSelect = document.getElementById('message-language');
  function fillMessageLanguages(info, chosen) {
    messageLanguageSelect.innerHTML = '';
    var current = info.languages.filter(function (language) { return language.code === info.language; })[0];
    [{ code: '', name: 'Same as Homey' + (!chosen && current ? ' (now ' + current.name + ')' : '') }].concat(info.languages).forEach(function (language) {
      var option = document.createElement('option');
      option.value = language.code;
      option.textContent = language.name;
      messageLanguageSelect.appendChild(option);
    });
    messageLanguageSelect.value = chosen || '';
  }
  messageLanguageSelect.addEventListener('change', function () {
    var previous = messageLanguageSelect.getAttribute('data-saved') || '';
    api('POST', '/message-settings', { messageLanguage: messageLanguageSelect.value }).then(function (saved) {
      messageLanguageSelect.setAttribute('data-saved', saved.messageLanguage);
      return api('GET', '/default-wording').then(function (info) { fillMessageLanguages(info, saved.messageLanguage); });
    }).catch(function (error) {
      messageLanguageSelect.value = previous;
      Homey.alert(error.message || String(error));
    });
  });
  api('GET', '/message-settings').then(function (settings) {
    api('GET', '/default-wording').then(function (info) {
      messageLanguageSelect.setAttribute('data-saved', settings.messageLanguage || '');
      fillMessageLanguages(info, settings.messageLanguage);
    }).catch(function () {});
    decimalCommaBox.checked = settings.decimalComma === true;
  }).catch(function () {});
  decimalCommaBox.addEventListener('change', function () {
    api('POST', '/message-settings', { decimalComma: decimalCommaBox.checked }).then(function () {
      refreshMessagePreviews();
    }).catch(function (error) {
      decimalCommaBox.checked = !decimalCommaBox.checked;
      Homey.alert(error.message || String(error));
    });
  });
}
