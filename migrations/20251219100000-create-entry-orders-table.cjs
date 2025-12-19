'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('entry_orders', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      strategy_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'strategies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      bot_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'bots', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      order_id: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true
      },
      symbol: {
        type: Sequelize.STRING,
        allowNull: false
      },
      side: {
        type: Sequelize.STRING(10),
        allowNull: false
      },
      amount: {
        type: Sequelize.DECIMAL(20, 8),
        allowNull: false
      },
      entry_price: {
        type: Sequelize.DECIMAL(20, 8),
        allowNull: false
      },
      status: {
        type: Sequelize.ENUM('open', 'filled', 'canceled', 'expired'),
        allowNull: false,
        defaultValue: 'open'
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

    await queryInterface.addIndex('entry_orders', ['status']);
    await queryInterface.addIndex('entry_orders', ['strategy_id']);
    await queryInterface.addIndex('entry_orders', ['bot_id', 'status']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('entry_orders');
  }
};
