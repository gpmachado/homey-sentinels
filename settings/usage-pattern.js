/* global openModal, closeModal, formatEnergy, formatDuration, escapeHtml, entityRow, renderEmptyList */

// Two views of a monitor's history: standby energy by monitor, and the weekday by hour usage pattern.
function setupUsagePattern(page) {
  var api = page.api, showError = page.showError;

  // Standby energy by monitor, loaded when the section is opened (and when its period changes).
  var standbyDetails = document.getElementById('standby-ranking');
  var standbyPeriod = document.getElementById('standby-period');
  function loadStandbyRanking() {
    api('GET', '/standby-ranking?period=' + standbyPeriod.value).then(function (ranking) {
      var container = document.getElementById('standby-body');
      container.innerHTML = '';
      if (!ranking.rows.length) { renderEmptyList(container, 'No standby energy recorded in this period.'); return; }
      ranking.rows.forEach(function (row) {
        container.appendChild(entityRow(escapeHtml(row.name) + ' <span class="badge">' + row.kind + '</span>', [
          formatEnergy(row.standbyEnergy) + ' idle', row.sharePercent + '% of the total'
        ]));
      });
      var total = document.createElement('p');
      total.className = 'hint';
      total.textContent = 'Total idle: ' + formatEnergy(ranking.totalStandbyEnergy);
      container.appendChild(total);
    }).catch(showError);
  }
  standbyDetails.addEventListener('toggle', function () { if (standbyDetails.open) loadStandbyRanking(); });
  standbyPeriod.addEventListener('change', function () { if (standbyDetails.open) loadStandbyRanking(); });

  // When this monitor is used: cycles started or time on, by weekday and hour, from its own cycles (the app works it
  // out; the sentence on top comes in the Default message language).
  var patternWrapper = document.getElementById('pattern-wrapper');
  var patternPeriod = document.getElementById('pattern-period');
  var patternMetric = document.getElementById('pattern-metric');
  var patternMonitor = null;
  var patternData = null;
  var PATTERN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function openUsagePattern(monitor) {
    patternMonitor = monitor;
    patternData = null;
    document.getElementById('pattern-title').textContent = 'Usage pattern: ' + monitor.name;
    document.getElementById('pattern-message').textContent = 'Loading…';
    document.getElementById('pattern-grid').innerHTML = '';
    openModal(patternWrapper);
    loadUsagePattern();
  }
  function loadUsagePattern() {
    var asked = patternMonitor;
    api('GET', '/usage-pattern/' + asked.id + '?period=' + patternPeriod.value).then(function (data) {
      if (patternMonitor !== asked) return;
      patternData = data;
      renderUsagePattern();
    }).catch(function (error) { closeModal(patternWrapper); showError(error); });
  }
  function patternValueText(value) {
    var metric = patternMetric.value;
    if (metric === 'starts') return value + ' cycle' + (value === 1 ? '' : 's');
    if (metric === 'energy') return (Math.round(value * 100) / 100) + ' kWh';
    if (metric === 'power') return value + ' W';
    return formatDuration(value);
  }
  function renderUsagePattern() {
    document.getElementById('pattern-message').textContent = patternData.message;
    var matrix = patternData[patternMetric.value];
    var biggest = Math.max.apply(null, matrix.map(function (row) { return Math.max.apply(null, row); }));
    var grid = document.getElementById('pattern-grid');
    grid.innerHTML = '';
    function label(text) {
      var el = document.createElement('div');
      el.className = 'pattern-label';
      el.textContent = text;
      return el;
    }
    grid.appendChild(label(''));
    for (var hour = 0; hour < 24; hour += 1) grid.appendChild(label(hour % 6 === 0 ? String(hour) : ''));
    matrix.forEach(function (row, day) {
      grid.appendChild(label(PATTERN_DAYS[day]));
      row.forEach(function (value, hourOfDay) {
        var cell = document.createElement('div');
        cell.className = 'pattern-cell';
        cell.title = PATTERN_DAYS[day] + ' ' + (hourOfDay < 10 ? '0' : '') + hourOfDay + ':00 - ' + patternValueText(value);
        if (value > 0 && biggest > 0) {
          var fill = document.createElement('i');
          fill.style.opacity = String(Math.max(0.15, value / biggest));
          cell.appendChild(fill);
        }
        grid.appendChild(cell);
      });
    });
  }
  patternPeriod.addEventListener('change', loadUsagePattern);
  patternMetric.addEventListener('change', function () { if (patternData) renderUsagePattern(); });
  document.getElementById('pattern-close-btn').addEventListener('click', function () { patternMonitor = null; closeModal(patternWrapper); });

  page.openUsagePattern = openUsagePattern;
}
