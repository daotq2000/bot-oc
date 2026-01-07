'use strict';

/**
 * Add useful composite indexes for high-traffic tables:
 * - positions: filters by bot/status/symbol/strategy + ordering by opened_at
 * - strategies: common filters by bot + is_active and bot + symbol + interval
 * - price_alert_config: active configs per exchange, ordered by created_at
 * - app_configs: lookup by config_key
 * - entry_orders: open orders ordered by created_at, lookup by bot+order_id
 *
 * Each index is added only if it does not already exist to keep migration idempotent.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const addIndexIfMissing = async (table, fields, options = {}) => {
      const name = options.name;
      if (!name) throw new Error('Index name is required');
      const indexes = await queryInterface.showIndex(table);
      const exists = indexes.some(idx => idx.name === name);
      if (!exists) {
        await queryInterface.addIndex(table, fields, options);
        console.log(`✅ Added index ${name} on ${table}(${fields.join(',')})`);
      } else {
        console.log(`ℹ️  Index ${name} already exists on ${table}, skipping`);
      }
    };

    // positions
    await addIndexIfMissing('positions', ['bot_id', 'status', 'opened_at'], { name: 'idx_positions_bot_status_opened_at' });
    await addIndexIfMissing('positions', ['symbol', 'status'], { name: 'idx_positions_symbol_status' });
    await addIndexIfMissing('positions', ['strategy_id', 'status'], { name: 'idx_positions_strategy_status' });
    await addIndexIfMissing('positions', ['order_id'], { name: 'idx_positions_order_id' });

    // strategies
    await addIndexIfMissing('strategies', ['bot_id', 'is_active'], { name: 'idx_strategies_bot_active' });
    await addIndexIfMissing('strategies', ['bot_id', 'symbol', 'interval'], { name: 'idx_strategies_bot_symbol_interval' });

    // price_alert_config
    await addIndexIfMissing('price_alert_config', ['is_active', 'exchange', 'created_at'], { name: 'idx_price_alert_config_active_ex_created' });
    await addIndexIfMissing('price_alert_config', ['exchange', 'created_at'], { name: 'idx_price_alert_config_ex_created' });

    // app_configs
    await addIndexIfMissing('app_configs', ['config_key'], { name: 'idx_app_configs_key', unique: true });

    // entry_orders
    await addIndexIfMissing('entry_orders', ['status', 'created_at'], { name: 'idx_entry_orders_status_created' });
    await addIndexIfMissing('entry_orders', ['bot_id', 'order_id'], { name: 'idx_entry_orders_bot_order' });
  },

  down: async (queryInterface, Sequelize) => {
    const removeIndexIfExists = async (table, name) => {
      const indexes = await queryInterface.showIndex(table);
      const exists = indexes.some(idx => idx.name === name);
      if (exists) {
        await queryInterface.removeIndex(table, name);
        console.log(`🗑️  Removed index ${name} from ${table}`);
      } else {
        console.log(`ℹ️  Index ${name} does not exist on ${table}, skipping`);
      }
    };

    await removeIndexIfExists('entry_orders', 'idx_entry_orders_bot_order');
    await removeIndexIfExists('entry_orders', 'idx_entry_orders_status_created');
    await removeIndexIfExists('app_configs', 'idx_app_configs_key');
    await removeIndexIfExists('price_alert_config', 'idx_price_alert_config_ex_created');
    await removeIndexIfExists('price_alert_config', 'idx_price_alert_config_active_ex_created');
    await removeIndexIfExists('strategies', 'idx_strategies_bot_symbol_interval');
    await removeIndexIfExists('strategies', 'idx_strategies_bot_active');
    await removeIndexIfExists('positions', 'idx_positions_order_id');
    await removeIndexIfExists('positions', 'idx_positions_strategy_status');
    await removeIndexIfExists('positions', 'idx_positions_symbol_status');
    await removeIndexIfExists('positions', 'idx_positions_bot_status_opened_at');
  }
};


