'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('positions', 'order_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Reverting might fail if there are existing NULL values.
    // It's better to handle them before reverting.
    await queryInterface.changeColumn('positions', 'order_id', {
      type: Sequelize.STRING(100),
      allowNull: false,
    });
  }
};

