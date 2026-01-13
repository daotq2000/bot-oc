'use strict';

/**
 * Migration: add entry_pending status to positions.status enum
 *
 * Project uses MySQL + sequelize-cli with CommonJS migrations (.cjs).
 * We extend status enum to include 'entry_pending' while preserving existing values.
 */
module.exports = {
  up: async (queryInterface) => {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect !== 'mysql') return;

    const [rows] = await queryInterface.sequelize.query(
      "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'positions' AND COLUMN_NAME = 'status' LIMIT 1"
    );

    const columnType = rows?.[0]?.COLUMN_TYPE || '';
    const m = String(columnType).match(/^enum\((.*)\)$/i);
    const raw = m?.[1] || '';

    const values = raw
      .split(',')
      .map(s => s.trim())
      .map(s => s.replace(/^'+|'+$/g, ''))
      .filter(Boolean);

    const current = values.length ? values : ['open', 'tp_pending', 'closed', 'cancelled'];

    if (current.includes('entry_pending')) return;

    const next = ['entry_pending', ...current.filter(v => v !== 'entry_pending')];
    const defaultValue = current.includes('open') ? 'open' : (current[0] || 'open');
    const enumSql = next.map(v => `'${v.replace(/'/g, "''")}'`).join(',');

    await queryInterface.sequelize.query(
      `ALTER TABLE positions MODIFY status ENUM(${enumSql}) NOT NULL DEFAULT '${defaultValue}'`
    );
  },

  down: async (queryInterface) => {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect !== 'mysql') return;

    const [rows] = await queryInterface.sequelize.query(
      "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'positions' AND COLUMN_NAME = 'status' LIMIT 1"
    );

    const columnType = rows?.[0]?.COLUMN_TYPE || '';
    const m = String(columnType).match(/^enum\((.*)\)$/i);
    const raw = m?.[1] || '';

    const values = raw
      .split(',')
      .map(s => s.trim())
      .map(s => s.replace(/^'+|'+$/g, ''))
      .filter(Boolean)
      .filter(v => v !== 'entry_pending');

    const next = values.length ? values : ['open', 'tp_pending', 'closed', 'cancelled'];
    const defaultValue = next.includes('open') ? 'open' : (next[0] || 'open');
    const enumSql = next.map(v => `'${v.replace(/'/g, "''")}'`).join(',');

    await queryInterface.sequelize.query(
      `ALTER TABLE positions MODIFY status ENUM(${enumSql}) NOT NULL DEFAULT '${defaultValue}'`
    );
  }
};

