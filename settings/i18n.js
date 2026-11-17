/* global SETTINGS_TRANSLATIONS */

// The Settings page in the Homey language. The English text is its own key: t('Save') gives the translation for the
// language Homey runs in (settings/i18n-strings.js), or the English when there is none. `{name}` marks a value filled in
// by the caller: t('{n} cycles', { n: 3 }). The page's own HTML is translated once at start by translatePage(), text
// nodes and placeholder/title attributes alike, so index.html keeps plain English. Homey has no Portuguese, so the
// page has none either; the messages the app writes have their own language setting. Loaded first.
var uiLanguage = 'en';

// The code comes from locales/<lang>.json ("settingsLanguage"), which Homey picks by its own language.
function setUiLanguage(Homey) {
  var code = Homey && typeof Homey.__ === 'function' ? Homey.__('settingsLanguage') : null;
  uiLanguage = typeof code === 'string' && /^[a-z]{2}$/.test(code) ? code : 'en';
}

function t(text, values) {
  var table = typeof SETTINGS_TRANSLATIONS === 'object' && SETTINGS_TRANSLATIONS[uiLanguage];
  var translated = (table && table[text]) || text;
  if (!values) return translated;
  return translated.replace(/\{(\w+)\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

// Every text node and placeholder/title of the page's own HTML, trimmed, looked up as is; spacing around it is kept.
function translatePage(root) {
  if (uiLanguage === 'en') return;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(function (node) {
    var parent = node.parentNode && node.parentNode.nodeName;
    if (parent === 'SCRIPT' || parent === 'STYLE' || parent === 'CODE') return;
    var text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) return;
    var translated = t(text);
    if (translated === text) return;
    var lead = node.nodeValue.match(/^\s*/)[0];
    var trail = node.nodeValue.match(/\s*$/)[0];
    node.nodeValue = (lead ? ' ' : '') + translated + (trail ? ' ' : '');
  });
  Array.prototype.forEach.call(root.querySelectorAll('[placeholder], [title]'), function (el) {
    ['placeholder', 'title'].forEach(function (name) {
      var value = el.getAttribute(name);
      if (value) el.setAttribute(name, t(value));
    });
  });
}
