// Runs the same scripted clicks as a user would and returns everything observable. Executed in the page.
window.runTrace = async () => {
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const link = (container, label) => [...$(container).querySelectorAll('button')].find((b) => b.textContent === label);
  const hidden = (id) => $(id).classList.contains('hidden');
  const trace = [];
  const rec = (name, data) => trace.push({ name, data });
  const mark = () => window.__log.length;
  const since = (m) => window.__log.slice(m);
  const submit = (formId) => $(formId).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const fields = (ids) => Object.fromEntries(ids.map((id) => [id, $(id).value]));
  await wait(400);
  rec('initial', { calls: window.__log.map((x) => x.call || x.alert || x.confirm).filter(Boolean).length, rows: ['monitors-body', 'state-monitors-body', 'voltage-monitors-body'].map((id) => $(id).querySelectorAll('.entity-row').length) });

  const forms = [
    { name: 'activity edit', body: 'monitors-body', open: 'Edit', wrapper: 'activity-edit-form-wrapper', form: 'activity-edit-form', cancel: 'activity-edit-cancel-btn', ids: ['activity-edit-name', 'activity-edit-device', 'activity-edit-threshold', 'activity-edit-continuity', 'activity-edit-confirmation'], set: { 'activity-edit-name': 'Pump renamed', 'activity-edit-threshold': '55' } },
    { name: 'activity messages', body: 'monitors-body', open: 'Messages', wrapper: 'activity-message-form-wrapper', form: 'activity-message-form', cancel: 'activity-message-cancel-btn', ids: ['activity-messageTemplateStarted', 'activity-messageTemplateFinished'], set: { 'activity-messageTemplateFinished': 'done %monitor%' } },
    { name: 'state edit', body: 'state-monitors-body', open: 'Edit', wrapper: 'state-edit-form-wrapper', form: 'state-edit-form', cancel: 'state-edit-cancel-btn', ids: ['state-edit-name', 'state-edit-device', 'state-edit-true-label', 'state-edit-false-label', 'state-edit-active-values'], set: { 'state-edit-true-label': 'Ajar' } },
    { name: 'state messages', body: 'state-monitors-body', open: 'Messages', wrapper: 'state-message-form-wrapper', form: 'state-message-form', cancel: 'state-message-cancel-btn', ids: ['state-messageTemplateStarted', 'state-messageTemplateFinished'], set: { 'state-messageTemplateStarted': 'opened' } },
    { name: 'voltage edit', body: 'voltage-monitors-body', open: 'Edit', wrapper: 'voltage-edit-form-wrapper', form: 'voltage-edit-form', cancel: 'voltage-edit-cancel-btn', ids: ['voltage-edit-name', 'voltage-edit-device', 'voltage-edit-min', 'voltage-edit-max', 'voltage-edit-stabilization'], set: { 'voltage-edit-max': '245' } },
    { name: 'voltage messages', body: 'voltage-monitors-body', open: 'Messages', wrapper: 'voltage-message-form-wrapper', form: 'voltage-message-form', cancel: 'voltage-message-cancel-btn', ids: ['messageTemplateUndervoltage', 'messageTemplateOvervoltage', 'messageTemplateNormalized'], set: { messageTemplateOvervoltage: 'high %voltage%' } },
  ];
  for (const f of forms) {
    // submitting with nothing open must do nothing
    let m = mark(); submit(f.form); await wait(); rec(f.name + ' | submit while closed', since(m));
    // open, read the pre-filled values
    click(link(f.body, f.open)); await wait();
    rec(f.name + ' | opened', { hidden: hidden(f.wrapper), fields: fields(f.ids) });
    // cancel closes, then a stale submit does nothing
    click($(f.cancel)); await wait();
    m = mark(); submit(f.form); await wait();
    rec(f.name + ' | cancelled', { hidden: hidden(f.wrapper), after: since(m) });
    // open, change, submit
    click(link(f.body, f.open)); await wait();
    Object.entries(f.set).forEach(([id, v]) => { $(id).value = v; });
    m = mark(); submit(f.form); await wait(120);
    rec(f.name + ' | submitted', { hiddenAfter: hidden(f.wrapper), calls: since(m) });
    m = mark(); submit(f.form); await wait();
    rec(f.name + ' | second submit (id cleared)', since(m));
  }
  // preview + header text shown in a message form
  click(link('voltage-monitors-body', 'Messages')); await wait();
  rec('voltage message header + preview', { name: $('voltage-message-form-name').textContent, preview: $('voltage-message-preview-undervoltage').textContent });
  click($('voltage-message-cancel-btn'));

  // token inserters: focus a target, put a caret, click a token button
  const insert = async (name, openFn, targetId, btnSelector, focusTarget = true) => {
    await openFn(); const t = $(targetId); t.value = 'abcd';
    if (focusTarget) t.dispatchEvent(new Event('focus'));
    t.setSelectionRange(1, 2);
    click(document.querySelector(btnSelector)); await wait(20);
    const first = t.value;
    t.value = 'abcd'; t.setSelectionRange(0, 0); click(document.querySelector(btnSelector));
    rec('token insert | ' + name, { caretMiddle: first, caretZero: t.value });
  };
  await insert('voltage', async () => { click(link('voltage-monitors-body', 'Messages')); await wait(); }, 'messageTemplateOvervoltage', '.voltage-token-btn[data-token="%voltage%"]');
  click($('voltage-message-cancel-btn'));
  await insert('activity', async () => { click(link('monitors-body', 'Messages')); await wait(); }, 'activity-messageTemplateStarted', '.activity-token-btn[data-token="%power%"]');
  click($('activity-message-cancel-btn'));
  await insert('state', async () => { click(link('state-monitors-body', 'Messages')); await wait(); }, 'state-messageTemplateStarted', '.state-token-btn[data-token="%label%"]');
  click($('state-message-cancel-btn'));
  await insert('group', async () => {}, 'messageTemplateMany', '.token-btn[data-token="%items%"]');

  // Reset and Delete on every list: confirm text, calls, and the list re-fetched afterwards
  for (const [body, labels] of [['monitors-body', ['Reset', 'Delete']], ['state-monitors-body', ['Reset', 'Delete']], ['voltage-monitors-body', ['Reset', 'Delete']]]) {
    for (const label of labels) {
      const m = mark(); click(link(body, label)); await wait(120);
      rec('row action | ' + body + ' | ' + label, { calls: since(m), rowsAfter: $(body).querySelectorAll('.entity-row').length });
    }
  }
  // The three Add forms: capability first, then the zones that have it, then the devices
  const opts = (id) => [...$(id).options].map((o) => o.value + '=' + o.textContent);
  const pick = (id) => ({ capability: $(id + '-capability').value, capabilities: opts(id + '-capability'), zones: opts(id + '-zone'), devices: opts(id + '-device') });
  const change = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
  for (const [kind, button, payload] of [['activity', 'add-activity-monitor-btn', { 'activity-add-name': 'New pump' }], ['voltage', 'add-voltage-monitor-btn', { 'voltage-add-min': '210', 'voltage-add-max': '240' }], ['state', 'add-state-monitor-btn', {}]]) {
    click($(button)); await wait();
    rec('add ' + kind + ' | opened', pick(kind + '-add'));
    const caps = [...$(kind + '-add-capability').options].map((o) => o.value).filter(Boolean);
    if (caps.length > 1) { change($(kind + '-add-capability'), caps[caps.length - 1]); await wait(); rec('add ' + kind + ' | other capability', Object.assign(pick(kind + '-add'), { activeValuesHidden: kind === 'state' ? $('state-add-active-values-wrap').classList.contains('hidden') : null })); }
    const zones = [...$(kind + '-add-zone').options].map((o) => o.value).filter(Boolean);
    if (zones.length) { change($(kind + '-add-zone'), zones[0]); await wait(); rec('add ' + kind + ' | zone ' + zones[0], pick(kind + '-add')); }
    Object.entries(payload).forEach(([id, v]) => { $(id).value = v; });
    const m = mark(); submit(kind + '-add-form'); await wait(120);
    rec('add ' + kind + ' | submitted', since(m));
    click($(kind + '-add-cancel-btn')); await wait();
  }

  // Default message language: the options, choosing one, and the group's Fill default wording using the app's wording
  const lang = $('message-language');
  rec('message language | options', { options: [...lang.options].map((o) => o.value + '=' + o.textContent), value: lang.value });
  let lm = mark(); lang.value = 'pt'; lang.dispatchEvent(new Event('change')); await wait(120);
  rec('message language | chosen', { calls: since(lm), value: lang.value });
  $('type').value = 'contact'; $('expectedState').value = 'false';
  ['messageTemplateZero', 'messageTemplateOne', 'messageTemplateMany'].forEach((id) => { $(id).value = ''; });
  lm = mark(); click($('fill-wording-btn')); await wait(120);
  rec('fill default wording', { calls: since(lm), fields: fields(['messageTemplateZero', 'messageTemplateOne', 'messageTemplateMany']) });
  // a week period hides the actions
  rec('actions per list on day period', ['monitors-body', 'state-monitors-body', 'voltage-monitors-body'].map((id) => [...$(id).querySelectorAll('.btn-link')].map((b) => b.textContent)));
  return trace;
};
