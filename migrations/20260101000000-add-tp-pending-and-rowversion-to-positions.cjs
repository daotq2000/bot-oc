/*
 * Migration: add tp_pending status + row_version + tp_order_id/tp_price to positions
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. Add new enum value 'tp_pending' (assumes status is ENUM). Different dialects require different SQL.
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'mysql') {
      await queryInterface.sequelize.query("ALTER TABLE positions MODIFY status ENUM('open','tp_pending','closed') NOT NULL DEFAULT 'open'");
    } else if (dialect === 'postgres') {
      // Postgres: You must add value before using it
      await queryInterface.sequelize.query("ALTER TYPE \"enum_positions_status\" ADD VALUE IF NOT EXISTS 'tp_pending'");
    }

    // 2. Add columns tp_order_id, tp_price, row_version
    // Idempotent: skip if column already exists (fixes "Duplicate column" errors)
    const table = await queryInterface.describeTable('positions');

    if (!table.tp_order_id) {
      await queryInterface.addColumn('positions', 'tp_order_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        after: 'exit_order_id', // for MySQL; ignored by others
      });
    }

    if (!table.tp_price) {
      await queryInterface.addColumn('positions', 'tp_price', {
        type: Sequelize.DECIMAL(30, 8),
        allowNull: true,
        after: 'tp_order_id',
      });
    }

    if (!table.row_version) {
      await queryInterface.addColumn('positions', 'row_version', {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 0,
        after: 'tp_price',
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Remove columns
    await queryInterface.removeColumn('positions', 'tp_order_id');
    await queryInterface.removeColumn('positions', 'tp_price');
    await queryInterface.removeColumn('positions', 'row_version');

    // Revert ENUM if MySQL
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'mysql') {
      await queryInterface.sequelize.query("ALTER TABLE positions MODIFY status ENUM('open','closed') NOT NULL DEFAULT 'open'");
    } else if (dialect === 'postgres') {
      // Postgres cannot easily drop enum value; ignore
    }
  },
};
