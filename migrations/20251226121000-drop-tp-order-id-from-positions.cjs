'use strict';

module.exports = {
  up: async (queryInterface) => {
    const tableDescription = await queryInterface.describeTable('positions');
    if (tableDescription.tp_order_id) {
      await queryInterface.removeColumn('positions', 'tp_order_id');
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Re-add tp_order_id for rollback compatibility
    const tableDescription = await queryInterface.describeTable('positions');
    if (!tableDescription.tp_order_id) {
      await queryInterface.addColumn('positions', 'tp_order_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
        after: 'amount'
      });
    }
  }
};

