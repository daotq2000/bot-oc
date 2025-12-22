'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Check if column already exists before adding
    const tableDescription = await queryInterface.describeTable('bots');
    
    if (!tableDescription.max_concurrent_trades) {
      // Add max_concurrent_trades column to bots table
      await queryInterface.addColumn('bots', 'max_concurrent_trades', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 5,
        comment: 'Maximum number of concurrent open positions allowed for this bot'
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Remove max_concurrent_trades column
    await queryInterface.removeColumn('bots', 'max_concurrent_trades');
  }
};

