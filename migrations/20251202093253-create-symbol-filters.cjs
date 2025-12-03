'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('symbol_filters', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      exchange: {
        type: Sequelize.STRING,
        allowNull: false
      },
      symbol: {
        type: Sequelize.STRING,
        allowNull: false
      },
      tick_size: {
        type: Sequelize.STRING,
        allowNull: false
      },
      step_size: {
        type: Sequelize.STRING,
        allowNull: false
      },
      min_notional: {
        type: Sequelize.STRING,
        allowNull: false
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('symbol_filters', ['exchange', 'symbol'], {
      unique: true,
      name: 'idx_exchange_symbol'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('symbol_filters');
  }
};
