'use strict';

module.exports = {
  async getSummary({ homey }) {
    return homey.app.getWatchdogsWidgetSummary();
  },

  async runCheck({ homey }) {
    return homey.app.inAppContext(() => homey.app.checkWatchdogsNow());
  }
};
