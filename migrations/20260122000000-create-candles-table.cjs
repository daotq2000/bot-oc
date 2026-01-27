'use strict';

/**
 * Create candles table + indexes used by Candle model:
 * - getCandles/getLatest: WHERE exchange=? AND symbol=? AND interval=? ORDER BY open_time DESC LIMIT N
 * - pruneByLimit: SELECT open_time ... ORDER BY open_time DESC LIMIT offset,1 then DELETE open_time < cutoff
 * - pruneByAge: DELETE ... close_time < threshold
 *
 * Notes:
 * - Uses UNIQUE(exchange, symbol, interval, open_time) to support UPSERT.
 * - Adds composite indexes to keep queries fast and pruning efficient.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    const exists = tables.map(t => String(t).toLowerCase()).includes('candles');

    if (!exists) {
      await queryInterface.createTable('candles', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        exchange: { type: Sequelize.STRING(20), allowNull: false },
        symbol: { type: Sequelize.STRING(20), allowNull: false },
        interval: { type: Sequelize.STRING(5), allowNull: false },
        open_time: { type: Sequelize.BIGINT, allowNull: false },
        open: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
        high: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
        low: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
        close: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
        volume: { type: Sequelize.DECIMAL(20, 8), allowNull: false, defaultValue: 0 },
        close_time: { type: Sequelize.BIGINT, allowNull: false }
      });
      console.log('✅ Created table candles');
    } else {
      console.log('ℹ️  Table candles already exists, skipping create');
    }

    const addIndexIfMissing = async (table, fields, options = {}) => {
      const name = options.name;
      if (!name) throw new Error('Index name is required');
      const indexes = await queryInterface.showIndex(table);
      const existsIdx = indexes.some(idx => idx.name === name);
      if (!existsIdx) {
        await queryInterface.addIndex(table, fields, options);
        console.log(`✅ Added index ${name} on ${table}(${fields.join(',')})`);
      } else {
        console.log(`ℹ️  Index ${name} already exists on ${table}, skipping`);
      }
    };

    // Unique candle key for UPSERT (also helps most queries)
    await addIndexIfMissing('candles', ['exchange', 'symbol', 'interval', 'open_time'], {
      name: 'unique_candle',
      unique: true
    });

    // Query helpers
    await addIndexIfMissing('candles', ['exchange', 'symbol', 'interval', 'open_time'], {
      name: 'idx_candles_ex_sym_int_open'
    });
    await addIndexIfMissing('candles', ['exchange', 'symbol', 'interval', 'close_time'], {
      name: 'idx_candles_ex_sym_int_close'
    });
    await addIndexIfMissing('candles', ['open_time'], { name: 'idx_candles_open_time' });
    await addIndexIfMissing('candles', ['close_time'], { name: 'idx_candles_close_time' });
  },

  down: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    const exists = tables.map(t => String(t).toLowerCase()).includes('candles');
    if (exists) {
      await queryInterface.dropTable('candles');
      console.log('🗑️  Dropped table candles');
    } else {
      console.log('ℹ️  Table candles does not exist, skipping drop');
    }
  }
};


