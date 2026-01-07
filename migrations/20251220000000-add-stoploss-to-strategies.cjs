'use strict';

/**
 * Migration: Add stoploss column to strategies table
 * 
 * This migration adds a stoploss column to the strategies table.
 * If stoploss > 0, it will be used as the initial stop loss price.
 * If stoploss <= 0 or NULL, no stop loss will be set.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Check if column already exists before adding
    const tableDescription = await queryInterface.describeTable('strategies');
    
    if (!tableDescription.stoploss) {
      await queryInterface.addColumn('strategies', 'stoploss', {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null,
        comment: 'Stop loss percentage (same format as take_profit: e.g., 50 = 5%). If > 0, used to calculate initial SL from entry price. If <= 0 or NULL, no SL is set.'
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('strategies', 'stoploss');
  }
};

