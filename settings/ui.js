// Helpers of the Settings page that keep no state of their own: formatting, building rows and buttons, modals. Loaded first.
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

// A labelled on/off switch for a row's actions; `onChange(checked)` runs when the person flips it.
function trackSwitch(checked, disabled, title, onChange) {
  var label = document.createElement('label');
  label.className = 'track-switch';
  label.title = title;
  var input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', function () { onChange(input.checked); });
  label.appendChild(input);
  label.appendChild(document.createTextNode('Track'));
  return label;
}

// A row's action links. With `visible` given, only that many stay on the row and the rest go into a "..." menu (a
// menu for a single link would be silly, so it takes at least two). Used by the monitor lists, whose rows grew to six links.
function entityActions(buttons, visible) {
  var wrap = document.createElement('div');
  wrap.className = 'entity-actions';
  var inRow = visible && buttons.length > visible + 1 ? buttons.slice(0, visible) : buttons;
  inRow.forEach(function (btn) { wrap.appendChild(btn); });
  if (inRow.length < buttons.length) {
    var menu = document.createElement('details');
    menu.className = 'more-menu';
    var summary = document.createElement('summary');
    summary.textContent = '\u22EF';
    summary.title = 'More actions';
    var list = document.createElement('div');
    list.className = 'more-menu-list';
    buttons.slice(inRow.length).forEach(function (btn) { list.appendChild(btn); });
    list.addEventListener('click', function () { menu.open = false; });
    menu.appendChild(summary);
    menu.appendChild(list);
    wrap.appendChild(menu);
  }
  return wrap;
}

// Any click outside an open "..." menu closes it.
document.addEventListener('click', function (event) {
  Array.prototype.forEach.call(document.querySelectorAll('.more-menu[open]'), function (menu) { if (!menu.contains(event.target)) menu.open = false; });
});

function renderEmptyList(container, message) {
  container.innerHTML = '<div class="entity-empty">' + message + '</div>';
}

function fieldValue(id) { return document.getElementById(id).value; }

// Tap a token button to put it into the message box focused last, at the caret (a caret at the very start
// counts as no caret, so the token goes to the end). `targetSelector` marks the boxes that take part; a form
// with a single box passes it as `initialTarget` and no selector.
function bindTokenInserter(buttonSelector, targetSelector, initialTarget) {
  var last = initialTarget;
  if (targetSelector) {
    Array.prototype.forEach.call(document.querySelectorAll(targetSelector), function (el) {
      el.addEventListener('focus', function () { last = el; });
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll(buttonSelector), function (btn) {
    btn.addEventListener('click', function () {
      var token = btn.getAttribute('data-token');
      var start = last.selectionStart || last.value.length;
      var end = last.selectionEnd || last.value.length;
      last.value = last.value.slice(0, start) + token + last.value.slice(end);
      last.focus();
    });
  });
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

function byName(a, b) { return a.name.localeCompare(b.name); }
