'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('positions', 'tp_order_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: 'amount'
    });
    await queryInterface.addColumn('positions', 'sl_order_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: 'tp_order_id'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('positions', 'tp_order_id');
    await queryInterface.removeColumn('positions', 'sl_order_id');
  }
};

