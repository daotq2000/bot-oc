/**
 * Script để fix các position thiếu TP order
 * - Set tp_sl_pending = true cho các position thiếu TP order
 * - PositionMonitor sẽ tự động đặt TP order cho các position này
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import logger from '../src/utils/logger.js';

async function fixMissingTPOrders() {
  try {
    logger.info('=== FIX POSITION THIẾU TP ORDER ===\n');

    // Lấy tất cả position đang mở
    const openPositions = await Position.findAll({ status: 'open' });
    
    logger.info(`Tổng số position đang mở: ${openPositions.length}\n`);

    const toFix = [];

    for (const pos of openPositions) {
      const hasTPOrder = pos.tp_order_id && pos.tp_order_id.trim() !== '';
      const isTPSLPending = pos.tp_sl_pending === true || pos.tp_sl_pending === 1;

      // Lấy strategy để kiểm tra take_profit
      let strategy = null;
      if (pos.strategy_id) {
        try {
          strategy = await Strategy.findById(pos.strategy_id);
        } catch (e) {
          logger.warn(`Không thể lấy strategy ${pos.strategy_id} cho position ${pos.id}`);
        }
      }

      const strategyTakeProfit = strategy?.take_profit;
      const shouldHaveTP = strategyTakeProfit !== undefined && strategyTakeProfit !== null && Number(strategyTakeProfit) > 0;

      // Nếu position nên có TP nhưng không có TP order và không có tp_sl_pending flag
      if (shouldHaveTP && !hasTPOrder && !isTPSLPending) {
        toFix.push({
          id: pos.id,
          bot_id: pos.bot_id,
          symbol: pos.symbol,
          side: pos.side,
          strategy_take_profit: strategyTakeProfit,
        });
      }
    }

    if (toFix.length === 0) {
      logger.info('✅ Không có position nào cần fix\n');
      return;
    }

    logger.info(`⚠️  Tìm thấy ${toFix.length} position cần fix:\n`);
    logger.info('ID | Bot | Symbol | Side | Strategy TP');
    logger.info('─'.repeat(60));
    for (const p of toFix) {
      logger.info(
        `${p.id.toString().padStart(4)} | ${p.bot_id.toString().padStart(3)} | ${p.symbol.padEnd(10)} | ${p.side.padEnd(5)} | ${p.strategy_take_profit || 'NULL'}`
      );
    }
    logger.info('');

    // Fix các position
    logger.info(`\n🔧 Đang fix ${toFix.length} position...\n`);
    let fixed = 0;
    let errors = 0;

    for (const p of toFix) {
      try {
        await Position.update(p.id, { tp_sl_pending: true });
        logger.info(`✅ Fixed position ${p.id} (${p.symbol} ${p.side}) - set tp_sl_pending = true`);
        fixed++;
      } catch (error) {
        logger.error(`❌ Failed to fix position ${p.id}: ${error?.message || error}`);
        errors++;
      }
    }

    logger.info(`\n📋 KẾT QUẢ:\n`);
    logger.info(`✅ Fixed: ${fixed}`);
    logger.info(`❌ Errors: ${errors}`);
    logger.info(`\n💡 PositionMonitor sẽ tự động đặt TP order cho các position này trong lần chạy tiếp theo.\n`);

  } catch (error) {
    logger.error('Lỗi khi fix position thiếu TP:', error);
    throw error;
  }
}

// Chạy fix
fixMissingTPOrders()
  .then(() => {
    logger.info('\n✅ Hoàn thành fix');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Lỗi:', error);
    process.exit(1);
  });
