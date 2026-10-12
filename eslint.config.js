'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', '.homeybuild/', 'analise/', 'logs/'] },
  js.configs.recommended,
  // This codebase writes `catch (error) { /* why it is fine */ }` and destructures to leave a field out, so neither counts as unused.
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true }] } },
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } } },
  // The Settings page and the harness stand-in run in the browser as plain scripts; onHomeyReady is called by Homey.
  {
    files: ['settings/**/*.js', 'test/settings-harness/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, Homey: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] }
  }
];
