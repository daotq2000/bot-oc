'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Remove unique constraint unique_strategy_params from strategies table
    try {
      await queryInterface.removeIndex('strategies', 'unique_strategy_params');
      console.log('✅ Removed unique constraint unique_strategy_params from strategies table');
    } catch (error) {
      // If index doesn't exist, that's okay
      if (error.message.includes("Unknown key name") || error.message.includes("doesn't exist")) {
        console.log('⚠️  Constraint unique_strategy_params does not exist, skipping...');
      } else {
        throw error;
      }
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Re-add unique constraint (if needed for rollback)
    // Note: This might fail if duplicate entries exist
    try {
      await queryInterface.addIndex('strategies', ['symbol', 'side', 'interval', 'oc'], {
        unique: true,
        name: 'unique_strategy_params'
      });
      console.log('✅ Re-added unique constraint unique_strategy_params to strategies table');
    } catch (error) {
      console.warn('⚠️  Could not re-add unique constraint:', error.message);
    }
  }
};

