'use strict';

/**
 * Sequelize migration: add reservation_token column to entry_orders
 * - Idempotent: only adds column if missing
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Check if column exists
    const [columns] = await queryInterface.sequelize.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'entry_orders'
        AND COLUMN_NAME = 'reservation_token'
    `);

    if (columns.length === 0) {
      await queryInterface.addColumn('entry_orders', 'reservation_token', {
        type: Sequelize.STRING(255),
        allowNull: true,
        after: 'status'
      });
      console.log('✅ Added reservation_token column to entry_orders table');
    } else {
      console.log('ℹ️  reservation_token column already exists in entry_orders table');
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Drop column only if exists
    const [columns] = await queryInterface.sequelize.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'entry_orders'
        AND COLUMN_NAME = 'reservation_token'
    `);

    if (columns.length > 0) {
      await queryInterface.removeColumn('entry_orders', 'reservation_token');
      console.log('✅ Removed reservation_token column from entry_orders table');
    } else {
      console.log('ℹ️  reservation_token column not found, skip drop');
    }
  }
};

