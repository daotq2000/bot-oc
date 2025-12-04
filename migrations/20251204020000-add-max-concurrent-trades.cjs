'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add max_concurrent_trades column to bots table
    await queryInterface.addColumn('bots', 'max_concurrent_trades', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 5,
      comment: 'Maximum number of concurrent open positions allowed for this bot'
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Remove max_concurrent_trades column
    await queryInterface.removeColumn('bots', 'max_concurrent_trades');
  }
};

