'use strict';

module.exports = {
  async getSummary({ homey }) {
    return homey.app.getWatchdogsWidgetSummary();
  }
};
