'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Check if column already exists before adding
    const tableDescription = await queryInterface.describeTable('symbol_filters');
    
    if (!tableDescription.max_leverage) {
      // Add max_leverage column to symbol_filters table
      await queryInterface.addColumn('symbol_filters', 'max_leverage', {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 125,
        comment: 'Maximum leverage allowed for this symbol on Binance Futures'
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Remove max_leverage column
    await queryInterface.removeColumn('symbol_filters', 'max_leverage');
  }
};

