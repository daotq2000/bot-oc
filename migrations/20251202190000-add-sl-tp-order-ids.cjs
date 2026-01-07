'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Check if columns already exist before adding
    const tableDescription = await queryInterface.describeTable('positions');
    
    if (!tableDescription.tp_order_id) {
      await queryInterface.addColumn('positions', 'tp_order_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
        after: 'amount'
      });
    }
    
    if (!tableDescription.sl_order_id) {
      await queryInterface.addColumn('positions', 'sl_order_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
        after: 'tp_order_id'
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('positions', 'tp_order_id');
    await queryInterface.removeColumn('positions', 'sl_order_id');
  }
};

