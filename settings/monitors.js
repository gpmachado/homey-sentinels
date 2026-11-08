/* global openModal, closeModal, formatEnergy, formatDuration, escapeHtml, renderSparkline, entityRow, actionLink, entityActions, renderEmptyList, byName */

// The Activity, State and Voltage lists and the actions on their rows.
function setupMonitorLists(page) {
  var Homey = page.Homey, api = page.api, showError = page.showError, confirmAction = page.confirmAction, openUsagePattern = page.openUsagePattern;

  // A modal form that PUTs its fields to one monitor or counter and then re-renders that list. The caller fills
  // the fields and calls open(id); Cancel and a successful save forget the id, so a stray submit with nothing
  // open does nothing. `listPath` is the list's own endpoint, fetched again after a save.
  function setupModalForm(spec) {
    var wrapper = document.getElementById(spec.wrapperId);
    var currentId = null;
    document.getElementById(spec.cancelId).addEventListener('click', function () {
      currentId = null;
      closeModal(wrapper);
    });
    document.getElementById(spec.formId).addEventListener('submit', function (event) {
      event.preventDefault();
      if (!currentId) return;
      api('PUT', spec.putPath(currentId), spec.payload()).then(function () {
        closeModal(wrapper);
        currentId = null;
        return api('GET', spec.listPath + '?period=' + page.monitorPeriod);
      }).then(spec.render).catch(showError);
    });
    return { open: function (id) { currentId = id; openModal(wrapper); } };
  }

  // The Reset and Delete links every monitor and counter row has: confirm, call the API, fetch that list again and
  // draw it. `path` is the list's endpoint, `resetKeeps` finishes the Reset sentence, `deleteWhat` is the noun in the
  // Delete one.
  function resetAndDeleteLinks(spec) {
    function run(method, path, text) {
      confirmAction(text, function () {
        api(method, path)
          .then(function () { return api('GET', spec.path + '?period=' + page.monitorPeriod); })
          .then(spec.render)
          .catch(showError);
      });
    }
    return [
      actionLink('Reset', function () { run('POST', spec.path + '/' + spec.item.id + '/reset', 'Reset statistics for "' + spec.item.name + '"? ' + spec.resetKeeps); }),
      actionLink('Delete', function () { run('DELETE', spec.path + '/' + spec.item.id, 'Delete ' + spec.deleteWhat + ' "' + spec.item.name + '"?'); }, true)
    ];
  }

  // Shown on a monitor whose device was deleted from Homey (see "If a device is deleted" in the HOWTO).
  function deviceMissingBadge(monitor) {
    return monitor.deviceMissing ? ' <span class="badge badge-danger" title="The device was deleted from Homey; this monitor no longer receives data. Delete it if it is not needed.">Device missing</span>' : '';
  }

  // The list every monitor kind draws: clear the container, say so when it is empty, otherwise one row per item by
  // name. `describe(item)` gives { nameHtml, metaBits, sparkline }, `actions(item)` the kind's own links (Edit,
  // Messages); Reset and Delete come from resetAndDeleteLinks, with `path`, `render` and `deleteWhat` from the spec.
  // The links only make sense against "today": they would otherwise act on the monitor itself while the row is showing a
  // week/month rollup, which reads as if the action applied to that whole period instead of the monitor as a whole.
  function renderEntityList(spec) {
    var container = document.getElementById(spec.containerId);
    container.innerHTML = '';
    if (!spec.items.length) { renderEmptyList(container, spec.empty); return; }
    spec.items.slice().sort(byName).forEach(function (item) {
      var shown = spec.describe(item);
      var row = entityRow(shown.nameHtml, shown.metaBits, shown.sparkline);
      if (page.monitorPeriod === 'day') {
        row.appendChild(entityActions(spec.actions(item).concat(resetAndDeleteLinks({
          item: item, path: spec.path, render: spec.render,
          resetKeeps: 'This keeps the monitor and its settings, only the history is wiped.', deleteWhat: spec.deleteWhat
        })), 2));
      }
      container.appendChild(row);
    });
  }

  function renderMonitors(monitors) {
    renderEntityList({
      containerId: 'monitors-body', items: monitors, empty: 'No activity monitors yet. Click "Add activity monitor" to watch a power device.',
      path: '/monitors', render: renderMonitors, deleteWhat: 'monitor',
      describe: function (monitor) {
        var isActive = monitor.state === 'ACTIVE';
        var avgPower = monitor.averagePower !== null && monitor.averagePower !== undefined ? Math.round(monitor.averagePower) + ' W' : '—';
        var suggestion = monitor.suggestedThreshold;
        var progress = monitor.calibrationProgress;
        // "Calibrating" used to be a bare spinner with no visible progress. With `progress` this says how far
        // it got and, once enough samples exist without a clear standby/active split, why it's stuck — instead
        // of a monitor that silently looks broken for days (see the pump that stayed "calibrating" over a week).
        var calibratingTitle = 'Using ' + (monitor.threshold !== null && monitor.threshold !== undefined ? Math.round(monitor.threshold) + ' W' : 'a default threshold') + ' as a starting value until enough history confirms this device\'s real standby/active power split.';
        if (progress) {
          if (progress.status === 'collecting') calibratingTitle = progress.valuesCollected + ' of ' + progress.valuesNeeded + ' power samples collected so far.';
          else if (progress.status === 'inconclusive') {
            calibratingTitle = progress.valuesCollected + ' samples collected (' + progress.min + '-' + progress.max + ' W), but no clear standby/active split yet'
              + (progress.standbyHigh !== null ? ': the closest split seen is standby up to ' + progress.standbyHigh + ' W, active from ' + progress.activeLow + ' W, not different enough to trust.' : '.');
          }
          else if (progress.status === 'ready') {
            // A split was found but the app only looks again after a back-off of up to 30 minutes, so this is
            // visible for a while rather than for a moment.
            calibratingTitle = 'A clear split was found (standby up to ' + progress.standbyHigh + ' W, active from ' + progress.activeLow + ' W): about '
              + Math.round(progress.suggestedThreshold) + ' W will be applied at the next calibration check, which can take up to 30 minutes.';
          }
        }
        var stateBadge = monitor.calibrating
          ? '<span class="badge badge-calibrating" title="' + escapeHtml(calibratingTitle) + '">Calibrating' + (progress && progress.status === 'collecting' ? ' (' + progress.valuesCollected + '/' + progress.valuesNeeded + ')' : '') + '</span>'
          : '<span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + (isActive ? 'Active' : 'Standby') + '</span>';
        var nameHtml = escapeHtml(monitor.name) + ' ' + stateBadge + deviceMissingBadge(monitor);
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
          !monitor.calibrating && !monitor.hasCompletedCycles ? '<span class="hint">No completed cycles yet — stats need at least one.</span>' : null,
          monitor.rebuiltFromInsights ? '<span class="chip" title="Cycles and periods before this monitor started recording were estimated from Homey Insights (' + monitor.rebuiltFromInsights.cycles + ' cycles, from ' + escapeHtml(new Date(monitor.rebuiltFromInsights.from).toLocaleString()) + '). Coarser than live data. Reset the monitor to drop them.">history from Insights</span>' : null
        ];
        return { nameHtml: nameHtml, metaBits: metaBits, sparkline: renderSparkline(monitor.dailyBreakdown) };
      },
      actions: function (monitor) {
        var links = [
          actionLink('Edit', function () { page.openActivityEditForm(monitor); }),
          actionLink('Messages', function () { page.openActivityMessageForm(monitor); }),
          actionLink('Pattern', function () { openUsagePattern(monitor); })
        ];
        if (!monitor.mode && !monitor.rebuiltFromInsights) links.push(actionLink('Rebuild from Insights', function () { rebuildFromInsights(monitor); }));
        return links;
      }
    });
  }

  // Asks the app to estimate the history from before this monitor existed out of Homey's Insights (the last 7 days).
  function rebuildFromInsights(monitor) {
    confirmAction('Estimate the history of "' + monitor.name + '" before it started recording from Homey Insights (last 7 days)? Cycles, time and energy of those days are added in front of what it recorded itself. They are estimates, coarser than live data; Reset removes them.', function () {
      api('POST', '/monitors/' + monitor.id + '/rebuild-history')
        .then(function (result) {
          Homey.alert('Added ' + result.cycles + ' estimated cycle' + (result.cycles === 1 ? '' : 's') + ' from ' + new Date(result.from).toLocaleString() + ' to ' + new Date(result.to).toLocaleString() + '.');
          return api('GET', '/monitors?period=' + page.monitorPeriod);
        })
        .then(renderMonitors)
        .catch(showError);
    });
  }

  function renderStateMonitors(monitors) {
    renderEntityList({
      containerId: 'state-monitors-body', items: monitors, empty: 'No state monitors yet. Click "Add state monitor" for a door, a motion sensor or a switch.',
      path: '/state-monitors', render: renderStateMonitors, deleteWhat: 'monitor',
      describe: function (monitor) {
        var isActive = monitor.state === 'ACTIVE';
        var stateLabel = isActive ? monitor.trueLabel : monitor.falseLabel;
        var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + escapeHtml(stateLabel) + '</span>' + deviceMissingBadge(monitor);
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
        return { nameHtml: nameHtml, metaBits: metaBits, sparkline: renderSparkline(monitor.dailyBreakdown, 'trueDuration', formatDuration) };
      },
      actions: function (monitor) {
        return [
          actionLink('Edit', function () { page.openStateEditForm(monitor); }),
          actionLink('Messages', function () { page.openStateMessageForm(monitor); }),
          actionLink('Pattern', function () { openUsagePattern(monitor); })
        ];
      }
    });
  }

  function renderVoltageMonitors(monitors) {
    renderEntityList({
      containerId: 'voltage-monitors-body', items: monitors, empty: 'No voltage monitors yet. Click "Add voltage monitor" to watch a phase.',
      path: '/voltage-monitors', render: renderVoltageMonitors, deleteWhat: 'voltage monitor',
      describe: function (monitor) {
        var isNormal = monitor.state === 'NORMAL';
        var range = (monitor.minVoltage !== null && monitor.maxVoltage !== null)
          ? monitor.minVoltage.toFixed(1) + '–' + monitor.maxVoltage.toFixed(1) + ' V' : '—';
        var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isNormal ? 'badge-active' : 'badge-danger') + '">' + escapeHtml(monitor.state) + '</span>' + deviceMissingBadge(monitor);
        var metaBits = [
          escapeHtml(monitor.deviceName),
          (monitor.currentVoltage !== null ? monitor.currentVoltage.toFixed(1) + ' V now' : 'no reading'),
          'range ' + range,
          (monitor.undervoltageCount || 0) + ' under · ' + (monitor.overvoltageCount || 0) + ' over'
        ];
        return { nameHtml: nameHtml, metaBits: metaBits };
      },
      actions: function (monitor) {
        return [
          actionLink('Edit', function () { page.openVoltageEditForm(monitor); }),
          actionLink('Messages', function () { page.openVoltageMessageForm(monitor); })
        ];
      }
    });
  }

  page.setupModalForm = setupModalForm;
  page.renderMonitors = renderMonitors;
  page.renderStateMonitors = renderStateMonitors;
  page.renderVoltageMonitors = renderVoltageMonitors;
}
