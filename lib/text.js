'use strict';

// Any character above U+00FF makes V8 keep a whole string at two bytes per character, and
// ManagerSettings serialises every stored key into ONE string per write - so a single em dash
// anywhere in the stored data doubled the memory of every save. Latin-1 (all Portuguese, French,
// German and Norwegian letters) stays at one byte; this only maps the typographic punctuation the
// app itself generates (default messages, event-log lines) to plain ASCII. Text a user typed is
// deliberately left alone.
const MAP = { '\u2013': '-', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...', '\u00a0': ' ' };

function punctuationToAscii(text) {
  if (typeof text !== 'string') return text;
  // An em dash is written with or without spaces around it; either way it becomes " - ".
  return text.replace(/\s*\u2014\s*/g, ' - ').replace(/[\u2013\u2018\u2019\u201c\u201d\u2026\u00a0]/g, (char) => MAP[char]);
}

module.exports = { punctuationToAscii };
