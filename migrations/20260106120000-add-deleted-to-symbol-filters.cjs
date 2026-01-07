'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('symbol_filters', 'deleted', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      after: 'max_leverage' // Place it after the last column for neatness
    });

    await queryInterface.addIndex('symbol_filters', ['exchange', 'deleted']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('symbol_filters', 'deleted');
    await queryInterface.removeIndex('symbol_filters', ['exchange', 'deleted']);
  }
};
