'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add max_amount_per_coin to bots table if it doesn't exist
    const tableDescription = await queryInterface.describeTable('bots');

    if (!tableDescription.max_amount_per_coin) {
      await queryInterface.addColumn('bots', 'max_amount_per_coin', {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true,
        defaultValue: null,
        comment: 'Maximum total USDT amount allowed per coin for this bot (0/NULL = no limit)'
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Remove max_amount_per_coin column
    await queryInterface.removeColumn('bots', 'max_amount_per_coin');
  }
};


