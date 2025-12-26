'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tableDescription = await queryInterface.describeTable('positions');

    // New unified exit order id (TAKE_PROFIT_MARKET or STOP_MARKET)
    if (!tableDescription.exit_order_id) {
      await queryInterface.addColumn('positions', 'exit_order_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
        after: 'amount'
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('positions', 'exit_order_id');
  }
};

