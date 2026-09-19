'use strict';

module.exports = {
  async getSummary({ homey, query }) {
    return homey.app.getWidgetSummary(query.id, query.period);
  },

  async getList({ homey, query }) {
    return homey.app.getWidgetList(query.kind);
  }
};
