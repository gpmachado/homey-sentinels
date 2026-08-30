'use strict';

module.exports = {
  async getSummary({ homey, query }) {
    return homey.app.getWidgetSummary(query.id, query.period);
  }
};
