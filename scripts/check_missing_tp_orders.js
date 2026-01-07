/**
 * Script kiểm tra và báo cáo các position thiếu TP order
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import logger from '../src/utils/logger.js';

async function checkMissingTPOrders() {
  try {
    logger.info('=== KIỂM TRA POSITION THIẾU TP ORDER ===\n');

    // Lấy tất cả position đang mở
    const openPositions = await Position.findAll({ status: 'open' });
    
    logger.info(`Tổng số position đang mở: ${openPositions.length}\n`);

    const missingTP = [];
    const hasTP = [];
    const noTPPrice = [];
    const tpPending = [];

    for (const pos of openPositions) {
      const hasTPOrder = pos.tp_order_id && pos.tp_order_id.trim() !== '';
      const hasTPPrice = pos.take_profit_price && Number(pos.take_profit_price) > 0;
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

      if (isTPSLPending) {
        tpPending.push({
          id: pos.id,
          bot_id: pos.bot_id,
          symbol: pos.symbol,
          side: pos.side,
          tp_sl_pending: pos.tp_sl_pending,
          tp_order_id: pos.tp_order_id,
          take_profit_price: pos.take_profit_price,
          strategy_take_profit: strategyTakeProfit,
        });
      } else if (!hasTPOrder && shouldHaveTP) {
        missingTP.push({
          id: pos.id,
          bot_id: pos.bot_id,
          symbol: pos.symbol,
          side: pos.side,
          tp_order_id: pos.tp_order_id,
          take_profit_price: pos.take_profit_price,
          strategy_take_profit: strategyTakeProfit,
          created_at: pos.created_at,
        });
      } else if (!hasTPPrice && shouldHaveTP) {
        noTPPrice.push({
          id: pos.id,
          bot_id: pos.bot_id,
          symbol: pos.symbol,
          side: pos.side,
          take_profit_price: pos.take_profit_price,
          strategy_take_profit: strategyTakeProfit,
        });
      } else if (hasTPOrder) {
        hasTP.push({
          id: pos.id,
          bot_id: pos.bot_id,
          symbol: pos.symbol,
          side: pos.side,
          tp_order_id: pos.tp_order_id,
        });
      }
    }

    // Báo cáo
    logger.info(`📊 THỐNG KÊ:\n`);
    logger.info(`✅ Position có TP order: ${hasTP.length}`);
    logger.info(`⚠️  Position thiếu TP order (cần fix): ${missingTP.length}`);
    logger.info(`⚠️  Position thiếu TP price: ${noTPPrice.length}`);
    logger.info(`⏳ Position đang chờ TP/SL (tp_sl_pending=true): ${tpPending.length}\n`);

    if (tpPending.length > 0) {
      logger.info(`\n⏳ POSITION ĐANG CHỜ TP/SL (tp_sl_pending=true):\n`);
      logger.info('ID | Bot | Symbol | Side | TP Order ID | TP Price | Strategy TP');
      logger.info('─'.repeat(80));
      for (const p of tpPending) {
        logger.info(
          `${p.id.toString().padStart(4)} | ${p.bot_id.toString().padStart(3)} | ${p.symbol.padEnd(10)} | ${p.side.padEnd(5)} | ${(p.tp_order_id || 'NULL').padEnd(12)} | ${(p.take_profit_price ? p.take_profit_price.toFixed(2) : 'NULL').padEnd(9)} | ${p.strategy_take_profit || 'NULL'}`
        );
      }
      logger.info('');
    }

    if (missingTP.length > 0) {
      logger.info(`\n⚠️  POSITION THIẾU TP ORDER (cần fix):\n`);
      logger.info('ID | Bot | Symbol | Side | TP Order ID | TP Price | Strategy TP | Created At');
      logger.info('─'.repeat(100));
      for (const p of missingTP) {
        logger.info(
          `${p.id.toString().padStart(4)} | ${p.bot_id.toString().padStart(3)} | ${p.symbol.padEnd(10)} | ${p.side.padEnd(5)} | ${(p.tp_order_id || 'NULL').padEnd(12)} | ${(p.take_profit_price ? p.take_profit_price.toFixed(2) : 'NULL').padEnd(9)} | ${(p.strategy_take_profit || 'NULL').toString().padEnd(12)} | ${p.created_at ? new Date(p.created_at).toISOString().split('T')[0] : 'N/A'}`
        );
      }
      logger.info('');
    }

    if (noTPPrice.length > 0) {
      logger.info(`\n⚠️  POSITION THIẾU TP PRICE:\n`);
      logger.info('ID | Bot | Symbol | Side | TP Price | Strategy TP');
      logger.info('─'.repeat(70));
      for (const p of noTPPrice) {
        logger.info(
          `${p.id.toString().padStart(4)} | ${p.bot_id.toString().padStart(3)} | ${p.symbol.padEnd(10)} | ${p.side.padEnd(5)} | ${(p.take_profit_price || 'NULL').toString().padEnd(9)} | ${p.strategy_take_profit || 'NULL'}`
        );
      }
      logger.info('');
    }

    // Tổng kết
    logger.info(`\n📋 TỔNG KẾT:\n`);
    logger.info(`Tổng position: ${openPositions.length}`);
    logger.info(`✅ Có TP order: ${hasTP.length} (${((hasTP.length / openPositions.length) * 100).toFixed(1)}%)`);
    logger.info(`⚠️  Thiếu TP order: ${missingTP.length} (${((missingTP.length / openPositions.length) * 100).toFixed(1)}%)`);
    logger.info(`⏳ Đang chờ TP/SL: ${tpPending.length} (${((tpPending.length / openPositions.length) * 100).toFixed(1)}%)\n`);

    if (missingTP.length > 0 || tpPending.length > 0) {
      logger.info(`\n💡 KHUYẾN NGHỊ:\n`);
      if (tpPending.length > 0) {
        logger.info(`- Có ${tpPending.length} position đang chờ TP/SL (tp_sl_pending=true). PositionMonitor sẽ tự động xử lý.`);
      }
      if (missingTP.length > 0) {
        logger.info(`- Có ${missingTP.length} position thiếu TP order. Chạy script fix_missing_tp_orders.js để fix.`);
      }
    }

    return {
      total: openPositions.length,
      hasTP: hasTP.length,
      missingTP: missingTP.length,
      noTPPrice: noTPPrice.length,
      tpPending: tpPending.length,
      missingTPList: missingTP,
      tpPendingList: tpPending,
    };
  } catch (error) {
    logger.error('Lỗi khi kiểm tra position thiếu TP:', error);
    throw error;
  }
}

// Chạy kiểm tra
checkMissingTPOrders()
  .then((result) => {
    logger.info('\n✅ Hoàn thành kiểm tra');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Lỗi:', error);
    process.exit(1);
  });

