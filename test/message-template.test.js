'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMessage, formatList } = require('../lib/message-template');

test('substitutes plain placeholders', () => {
  assert.equal(renderMessage('%group% ok', { group: 'Portas' }), 'Portas ok');
});
test('pluralizes based on an exact count of 1', () => {
  assert.equal(renderMessage('%count% %count:vez|vezes%', { count: 1 }), '1 vez');
  assert.equal(renderMessage('%count% %count:vez|vezes%', { count: 3 }), '3 vezes');
  assert.equal(renderMessage('%count% %count:vez|vezes%', { count: 0 }), '0 vezes');
});
test('renders an empty string for a missing template', () => {
  assert.equal(renderMessage('', { count: 1 }), '');
  assert.equal(renderMessage(undefined, { count: 1 }), '');
});
test('formats a natural-language list with a custom conjunction', () => {
  assert.equal(formatList([]), '');
  assert.equal(formatList(['Cozinha']), 'Cozinha');
  assert.equal(formatList(['Cozinha', 'Sala']), 'Cozinha e Sala');
  assert.equal(formatList(['Cozinha', 'Sala', 'Varanda']), 'Cozinha, Sala e Varanda');
  assert.equal(formatList(['Cozinha', 'Sala'], 'and'), 'Cozinha and Sala');
});
