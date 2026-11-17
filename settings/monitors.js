/* global t, openModal, closeModal, formatEnergy, formatDuration, escapeHtml, renderSparkline, entityRow, actionLink, entityActions, renderEmptyList, byName */

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
      actionLink(t('Reset'), function () { run('POST', spec.path + '/' + spec.item.id + '/reset', t('Reset statistics for "{name}"?', { name: spec.item.name }) + ' ' + spec.resetKeeps); }),
      actionLink(t('Delete'), function () { run('DELETE', spec.path + '/' + spec.item.id, t(spec.deleteWhat, { name: spec.item.name })); }, true)
    ];
  }

  // Shown on a monitor whose device was deleted from Homey (see "If a device is deleted" in the HOWTO).
  function deviceMissingBadge(monitor) {
    return monitor.deviceMissing ? ' <span class="badge badge-danger" title="' + escapeHtml(t('The device was deleted from Homey; this monitor no longer receives data. Delete it if it is not needed.')) + '">' + t('Device missing') + '</span>' : '';
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
          resetKeeps: t('This keeps the monitor and its settings, only the history is wiped.'), deleteWhat: spec.deleteWhat
        })), 2));
      }
      container.appendChild(row);
    });
  }

  function renderMonitors(monitors) {
    renderEntityList({
      containerId: 'monitors-body', items: monitors, empty: t('No activity monitors yet. Click "Add activity monitor" to watch a power device.'),
      path: '/monitors', render: renderMonitors, deleteWhat: 'Delete monitor "{name}"?',
      describe: function (monitor) {
        var isActive = monitor.state === 'ACTIVE';
        var avgPower = monitor.averagePower !== null && monitor.averagePower !== undefined ? Math.round(monitor.averagePower) + ' W' : '—';
        var suggestion = monitor.suggestedThreshold;
        var progress = monitor.calibrationProgress;
        // "Calibrating" used to be a bare spinner with no visible progress. With `progress` this says how far
        // it got and, once enough samples exist without a clear standby/active split, why it's stuck — instead
        // of a monitor that silently looks broken for days (see the pump that stayed "calibrating" over a week).
        var calibratingTitle = monitor.threshold !== null && monitor.threshold !== undefined
          ? t('Using {watts} W as a starting value until enough history confirms this device\'s real standby/active power split.', { watts: Math.round(monitor.threshold) })
          : t('Using a default threshold as a starting value until enough history confirms this device\'s real standby/active power split.');
        if (progress) {
          if (progress.status === 'collecting') calibratingTitle = t('{collected} of {needed} power samples collected so far.', { collected: progress.valuesCollected, needed: progress.valuesNeeded });
          else if (progress.status === 'inconclusive') {
            calibratingTitle = progress.standbyHigh !== null
              ? t('{collected} samples collected ({min}-{max} W), but no clear standby/active split yet: the closest split seen is standby up to {standby} W, active from {active} W, not different enough to trust.', { collected: progress.valuesCollected, min: progress.min, max: progress.max, standby: progress.standbyHigh, active: progress.activeLow })
              : t('{collected} samples collected ({min}-{max} W), but no clear standby/active split yet.', { collected: progress.valuesCollected, min: progress.min, max: progress.max });
          }
          else if (progress.status === 'ready') {
            // A split was found but the app only looks again after a back-off of up to 30 minutes, so this is
            // visible for a while rather than for a moment.
            calibratingTitle = t('A clear split was found (standby up to {standby} W, active from {active} W): about {watts} W will be applied at the next calibration check, which can take up to 30 minutes.', { standby: progress.standbyHigh, active: progress.activeLow, watts: Math.round(progress.suggestedThreshold) });
          }
        }
        var stateBadge = monitor.calibrating
          ? '<span class="badge badge-calibrating" title="' + escapeHtml(calibratingTitle) + '">' + t('Calibrating') + (progress && progress.status === 'collecting' ? ' (' + progress.valuesCollected + '/' + progress.valuesNeeded + ')' : '') + '</span>'
          : '<span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + (isActive ? t('Active') : t('Standby')) + '</span>';
        var nameHtml = escapeHtml(monitor.name) + ' ' + stateBadge + deviceMissingBadge(monitor);
        // Energy (a total accumulated over the whole period) and average power (a rate,
        // measured only while active) are easy to mistake for two readings of "the same
        // thing" when shown side by side with bare numbers — labeling each explicitly avoids
        // that, instead of relying on the reader to infer it from the unit alone.
        var metaBits = [
          escapeHtml(monitor.deviceName),
          t(monitor.cycleCount === 1 ? '{n} cycle' : '{n} cycles', { n: monitor.cycleCount }),
          '<span title="' + escapeHtml(t('Total energy measured this period — active and standby draw combined.')) + '">' + t('{energy} total', { energy: formatEnergy(monitor.energy) }) + '</span>' + (monitor.energyQuality === 'meter_reset' ? ' <span class="badge badge-danger" title="' + escapeHtml(t('A meter reset was detected in this period — energy may be understated.')) + '">' + t('reset') + '</span>' : ''),
          '<span title="' + escapeHtml(t('Average power measured only while active — not blended with standby time, and not the same as energy divided by the period length.')) + '">' + t('{power} while running', { power: avgPower }) + '</span>',
          monitor.threshold !== null && monitor.threshold !== undefined ? '<span class="chip" title="' + escapeHtml(t('The Watts value that currently decides Active vs Standby for this monitor.')) + '">' + t('threshold {watts} W', { watts: Math.round(monitor.threshold) }) + '</span>' : null,
          suggestion ? '<span class="chip chip-accent" title="' + escapeHtml(t('Based on {samples} power samples, split between {low} W and {high} W', { samples: suggestion.sampleCount, low: Math.round(suggestion.low), high: Math.round(suggestion.high) })) + '">' + t('suggested ~{watts} W', { watts: Math.round(suggestion.threshold) }) + '</span>' : null,
          // A monitor with no completed cycle yet has nothing to show a median/trend from — without this the row
          // just looks empty ("—" everywhere), which reads as broken rather than "still watching, nothing to report".
          !monitor.calibrating && !monitor.hasCompletedCycles ? '<span class="hint">' + t('No completed cycles yet — stats need at least one.') + '</span>' : null,
          monitor.rebuiltFromInsights ? '<span class="chip" title="' + escapeHtml(t('Cycles and periods before this monitor started recording were estimated from Homey Insights ({cycles} cycles, from {from}). Coarser than live data. Reset the monitor to drop them.', { cycles: monitor.rebuiltFromInsights.cycles, from: new Date(monitor.rebuiltFromInsights.from).toLocaleString() })) + '">' + t('history from Insights') + '</span>' : null
        ];
        return { nameHtml: nameHtml, metaBits: metaBits, sparkline: renderSparkline(monitor.dailyBreakdown) };
      },
      actions: function (monitor) {
        var links = [
          actionLink(t('Edit'), function () { page.openActivityEditForm(monitor); }),
          actionLink(t('Messages'), function () { page.openActivityMessageForm(monitor); }),
          actionLink(t('Pattern'), function () { openUsagePattern(monitor); })
        ];
        if (!monitor.mode && !monitor.rebuiltFromInsights) links.push(actionLink(t('Rebuild from Insights'), function () { rebuildFromInsights(monitor); }));
        return links;
      }
    });
  }

  // Asks the app to estimate the history from before this monitor existed out of Homey's Insights (the last 7 days).
  function rebuildFromInsights(monitor) {
    confirmAction(t('Estimate the history of "{name}" before it started recording from Homey Insights (last 7 days)? Cycles, time and energy of those days are added in front of what it recorded itself. They are estimates, coarser than live data; Reset removes them.', { name: monitor.name }), function () {
      api('POST', '/monitors/' + monitor.id + '/rebuild-history')
        .then(function (result) {
          Homey.alert(t(result.cycles === 1 ? 'Added {n} estimated cycle from {from} to {to}.' : 'Added {n} estimated cycles from {from} to {to}.', { n: result.cycles, from: new Date(result.from).toLocaleString(), to: new Date(result.to).toLocaleString() }));
          return api('GET', '/monitors?period=' + page.monitorPeriod);
        })
        .then(renderMonitors)
        .catch(showError);
    });
  }

  function renderStateMonitors(monitors) {
    renderEntityList({
      containerId: 'state-monitors-body', items: monitors, empty: t('No state monitors yet. Click "Add state monitor" for a door, a motion sensor or a switch.'),
      path: '/state-monitors', render: renderStateMonitors, deleteWhat: 'Delete monitor "{name}"?',
      describe: function (monitor) {
        var isActive = monitor.state === 'ACTIVE';
        var stateLabel = isActive ? monitor.trueLabel : monitor.falseLabel;
        var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isActive ? 'badge-active' : 'badge-standby') + '">' + escapeHtml(stateLabel) + '</span>' + deviceMissingBadge(monitor);
        var metaBits = [
          escapeHtml(monitor.deviceName),
          t(monitor.cycleCount === 1 ? '{n} session' : '{n} sessions', { n: monitor.cycleCount }),
          escapeHtml(monitor.trueLabel) + ' ' + formatDuration(monitor.trueDuration),
          escapeHtml(monitor.falseLabel) + ' ' + formatDuration(monitor.falseDuration),
          // Only present when this monitor also tracks an auxiliary power capability — a
          // plain door/motion monitor's row stays exactly as it was. Labeled the same explicit
          // way as renderMonitors' energy/avg-power bits, for the same reason.
          monitor.energy !== undefined ? '<span title="' + escapeHtml(t('Total energy measured this period — active and standby draw combined.')) + '">' + t('{energy} total', { energy: formatEnergy(monitor.energy) }) + '</span>' : null,
          monitor.averagePower !== null && monitor.averagePower !== undefined ? '<span title="' + escapeHtml(t('Average power measured only while active — not blended with standby time, and not the same as energy divided by the period length.')) + '">' + t('{power} while running', { power: Math.round(monitor.averagePower) + ' W' }) + '</span>' : null
        ];
        return { nameHtml: nameHtml, metaBits: metaBits, sparkline: renderSparkline(monitor.dailyBreakdown, 'trueDuration', formatDuration) };
      },
      actions: function (monitor) {
        return [
          actionLink(t('Edit'), function () { page.openStateEditForm(monitor); }),
          actionLink(t('Messages'), function () { page.openStateMessageForm(monitor); }),
          actionLink(t('Pattern'), function () { openUsagePattern(monitor); })
        ];
      }
    });
  }

  function renderVoltageMonitors(monitors) {
    renderEntityList({
      containerId: 'voltage-monitors-body', items: monitors, empty: t('No voltage monitors yet. Click "Add voltage monitor" to watch a phase.'),
      path: '/voltage-monitors', render: renderVoltageMonitors, deleteWhat: 'Delete voltage monitor "{name}"?',
      describe: function (monitor) {
        var isNormal = monitor.state === 'NORMAL';
        var range = (monitor.minVoltage !== null && monitor.maxVoltage !== null)
          ? monitor.minVoltage.toFixed(1) + '–' + monitor.maxVoltage.toFixed(1) + ' V' : '—';
        var nameHtml = escapeHtml(monitor.name) + ' <span class="badge ' + (isNormal ? 'badge-active' : 'badge-danger') + '">' + escapeHtml(t(monitor.state)) + '</span>' + deviceMissingBadge(monitor);
        var metaBits = [
          escapeHtml(monitor.deviceName),
          (monitor.currentVoltage !== null ? t('{voltage} V now', { voltage: monitor.currentVoltage.toFixed(1) }) : t('no reading')),
          t('range {range}', { range: range }),
          t('{under} under · {over} over', { under: monitor.undervoltageCount || 0, over: monitor.overvoltageCount || 0 })
        ];
        return { nameHtml: nameHtml, metaBits: metaBits };
      },
      actions: function (monitor) {
        return [
          actionLink(t('Edit'), function () { page.openVoltageEditForm(monitor); }),
          actionLink(t('Messages'), function () { page.openVoltageMessageForm(monitor); })
        ];
      }
    });
  }

  page.setupModalForm = setupModalForm;
  page.renderMonitors = renderMonitors;
  page.renderStateMonitors = renderStateMonitors;
  page.renderVoltageMonitors = renderVoltageMonitors;
}
