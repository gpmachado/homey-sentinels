'use strict';

module.exports = {
  async getEvents({ homey }) {
    // Matches EVENT_LOG_MAX in app.js — the widget's own scrollable list already handles
    // showing more than fits the visible height, so there's no reason to under-fetch what's
    // actually stored.
    return homey.app.getRecentEvents(50);
  }
};
