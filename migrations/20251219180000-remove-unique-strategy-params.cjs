'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Remove unique constraint unique_strategy_params from strategies table
    try {
      // First check if index exists
      const indexes = await queryInterface.showIndex('strategies');
      const indexExists = indexes.some(idx => idx.name === 'unique_strategy_params');
      
      if (indexExists) {
        await queryInterface.removeIndex('strategies', 'unique_strategy_params');
        console.log('✅ Removed unique constraint unique_strategy_params from strategies table');
      } else {
        console.log('⚠️  Constraint unique_strategy_params does not exist, skipping...');
      }
    } catch (error) {
      // If index doesn't exist, that's okay
      const errorMsg = error.message || '';
      if (errorMsg.includes("Unknown key name") || 
          errorMsg.includes("doesn't exist") || 
          errorMsg.includes("Can't DROP") ||
          errorMsg.includes("check that column/key exists")) {
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

