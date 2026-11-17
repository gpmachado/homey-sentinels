/* global t, escapeHtml, formatDuration */

// The Diagnostics tab: how the app itself is doing, read from GET /diagnostics when the tab is opened or Refresh is tapped
// (never on a timer). The screen is in the Homey language; the copied report stays in English on purpose, so whoever
// answers a forum post or an issue can read it.

// "45 s", "20 min", "5 h", "3 d": how long ago something happened.
function agoText(ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return '—';
  var seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + ' s';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' min';
  var hours = Math.floor(minutes / 60);
  return hours < 48 ? hours + ' h' : Math.floor(hours / 24) + ' d';
}

function kilobytes(bytes) { return Math.round(bytes / 1024) + ' KB'; }
function megabytes(bytes) { return Math.round(bytes / (1024 * 1024)) + ' MB'; }

// The parts of the report, as plain values: the screen and the copied text are both built from these.
function statusFacts(d) {
  var since = function (at) { return at ? d.now - at : null; };
  var build = d.app.build;
  return {
    version: d.app.version || '?',
    build: build ? build.commit + (build.dirty ? '+dirty' : '') : null,
    buildDate: build && build.date ? build.date.slice(0, 10) : null,
    runningMs: since(d.app.startedAt),
    sizeBytes: d.storage.sizeBytes,
    saveAgoMs: d.storage.lastSave ? since(d.storage.lastSave.at) : null,
    consolidationAgoMs: d.storage.lastConsolidation ? since(d.storage.lastConsolidation.at) : null,
    cpuAgoMs: d.load.cpuWarning ? since(d.load.cpuWarning.at) : null,
    memoryAgoMs: d.load.memoryWarning ? since(d.load.memoryWarning.at) : null,
    errorAgoMs: d.lastError ? since(d.lastError.at) : null,
    scanAgoMs: since(d.availabilityScanAt)
  };
}

function statusRow(label, value, warn) {
  return '<div class="status-row' + (warn ? ' status-warn' : '') + '"><span class="status-label">' + escapeHtml(label) + '</span>'
    + '<span class="status-value">' + escapeHtml(value) + '</span></div>';
}

function warningText(warning, agoMs) {
  if (!warning) return t('None since the app started');
  return t('{count} of {limit}, {time} ago', { count: warning.count, limit: warning.limit, time: agoText(agoMs) });
}

var KIND_LABELS = { activity: 'Activity', state: 'State', voltage: 'Voltage' };

function renderStatus(d) {
  var f = statusFacts(d);
  var app = statusRow(t('Version'), f.version + (f.build ? ' (' + f.build + (f.buildDate ? ', ' + f.buildDate : '') + ')' : ''))
    + statusRow(t('Runtime'), 'Node ' + d.app.node + (d.app.sqlite ? ', SQLite ' + d.app.sqlite : ''))
    + statusRow(t('Running for'), formatDuration(f.runningMs / 1000));

  var history = d.storage.degraded ? t('Not being saved: the database did not open. Restart the app.')
    : d.storage.database ? t('Database, {size}', { size: kilobytes(f.sizeBytes) }) : t('In the app settings (no database on this Homey)');
  var storage = statusRow(t('History'), history, d.storage.degraded)
    + d.storage.warnings.map(function (warning) { return statusRow(t('Warning'), warning, true); }).join('')
    + statusRow(t('Last save'), d.storage.lastSave ? t('{time} ago, in {ms} ms', { time: agoText(f.saveAgoMs), ms: d.storage.lastSave.ms }) : t('Not yet'))
    + statusRow(t('Last history consolidation'), d.storage.lastConsolidation
      ? t('{time} ago, in {ms} ms', { time: agoText(f.consolidationAgoMs), ms: d.storage.lastConsolidation.ms })
      : t('Not yet: 2 minutes after the start, then every 6 hours'));

  var load = statusRow(t('Memory'), t('{heap} in use, {process} for the whole app', { heap: megabytes(d.load.heapUsedBytes), process: megabytes(d.load.rssBytes) }))
    + statusRow(t('CPU warnings from Homey'), warningText(d.load.cpuWarning, f.cpuAgoMs), Boolean(d.load.cpuWarning))
    + statusRow(t('Memory warnings from Homey'), warningText(d.load.memoryWarning, f.memoryAgoMs), Boolean(d.load.memoryWarning))
    + statusRow(t('Device values watched'), String(d.subscriptions))
    + statusRow(t('Detailed log'), d.detailedLog ? t('On') : t('Off'), d.detailedLog)
    + statusRow(t('Last error'), d.lastError ? t('{time} ago: {message}', { time: agoText(f.errorAgoMs), message: d.lastError.message }) : t('None since the app started'), Boolean(d.lastError));

  var monitors = d.monitors.length ? d.monitors.map(function (monitor) {
    var bits = [monitor.lastReadingAt ? t('last reading {time} ago', { time: agoText(d.now - monitor.lastReadingAt) }) : t('no reading yet')];
    if (monitor.calibrating) bits.push(t('calibrating'));
    if (monitor.deviceMissing) bits.push(t('device missing'));
    return statusRow(monitor.name + ' · ' + t(KIND_LABELS[monitor.kind]), bits.join(', '), monitor.deviceMissing);
  }).join('') : statusRow(t('Monitors'), t('None yet'));
  monitors += statusRow(t('Groups and watchdogs'), t('{groups} groups, {watchdogs} watchdogs', { groups: d.counts.groups, watchdogs: d.counts.watchdogs }))
    + statusRow(t('Availability scan'), d.availabilityScanAt ? t('Last run {time} ago', { time: agoText(f.scanAgoMs) }) : t('Not run since the app started'));

  document.getElementById('status-app').innerHTML = app;
  document.getElementById('status-storage').innerHTML = storage;
  document.getElementById('status-load').innerHTML = load;
  document.getElementById('status-monitors').innerHTML = monitors;
}

// The copied report: short, plain English, no device names.
function statusReport(d) {
  var f = statusFacts(d);
  var warning = function (w, ago) { return w ? w.count + '/' + w.limit + ' (' + agoText(ago) + ' ago)' : 'none'; };
  var lines = [
    'Sentinels ' + f.version + (f.build ? ', build ' + f.build + (f.buildDate ? ' (' + f.buildDate + ')' : '') : '') + ', Node ' + d.app.node + (d.app.sqlite ? ', SQLite ' + d.app.sqlite : '') + ', running for ' + formatDuration(f.runningMs / 1000),
    'History: ' + (d.storage.degraded ? 'NOT SAVED (database did not open)' : d.storage.database ? 'database ' + kilobytes(f.sizeBytes) : 'settings key')
      + '; last save ' + (d.storage.lastSave ? agoText(f.saveAgoMs) + ' ago (' + d.storage.lastSave.ms + ' ms)' : 'not yet')
      + '; last consolidation ' + (d.storage.lastConsolidation ? agoText(f.consolidationAgoMs) + ' ago (' + d.storage.lastConsolidation.ms + ' ms, ' + d.storage.lastConsolidation.changed + ' changed)' : 'not yet')
  ];
  d.storage.warnings.forEach(function (w) { lines.push('Storage warning: ' + w); });
  lines.push('Memory: heap ' + megabytes(d.load.heapUsedBytes) + ', process ' + megabytes(d.load.rssBytes)
    + '; CPU warnings ' + warning(d.load.cpuWarning, f.cpuAgoMs) + '; memory warnings ' + warning(d.load.memoryWarning, f.memoryAgoMs));
  lines.push('Watched values ' + d.subscriptions + '; detailed log ' + (d.detailedLog ? 'on' : 'off')
    + '; last error ' + (d.lastError ? agoText(f.errorAgoMs) + ' ago: ' + d.lastError.message : 'none'));
  var counts = {};
  d.monitors.forEach(function (m) { counts[m.kind] = (counts[m.kind] || 0) + 1; });
  lines.push('Monitors: ' + (counts.activity || 0) + ' activity, ' + (counts.state || 0) + ' state, ' + (counts.voltage || 0) + ' voltage; '
    + d.counts.groups + ' groups, ' + d.counts.watchdogs + ' watchdogs; availability scan ' + (d.availabilityScanAt ? agoText(f.scanAgoMs) + ' ago' : 'not run'));
  d.monitors.forEach(function (m, index) {
    var bits = [m.lastReadingAt ? 'last reading ' + agoText(d.now - m.lastReadingAt) + ' ago' : 'no reading yet'];
    if (m.calibrating) bits.push('calibrating');
    if (m.deviceMissing) bits.push('DEVICE MISSING');
    lines.push('  ' + m.kind + ' #' + (index + 1) + ': ' + bits.join(', '));
  });
  return lines.join('\n');
}

function setupDiagnostics(page) {
  var last = null;
  var reportBox = document.getElementById('status-report');
  var copyBtn = document.getElementById('status-copy-btn');

  function load() {
    return page.api('GET', '/diagnostics').then(function (d) { last = d; renderStatus(d); }).catch(page.showError);
  }
  page.loadDiagnostics = load;

  document.getElementById('status-refresh-btn').addEventListener('click', load);
  // The settings page runs in a frame where the clipboard API can be refused: the report is also shown, selected, so it
  // can be copied by hand.
  copyBtn.addEventListener('click', function () {
    if (!last) return;
    reportBox.value = statusReport(last);
    reportBox.classList.remove('hidden');
    reportBox.focus();
    reportBox.select();
    var copied;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    if (!copied && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(reportBox.value).catch(function () {});
    copyBtn.textContent = copied ? t('Copied') : t('Copy report');
  });
}
