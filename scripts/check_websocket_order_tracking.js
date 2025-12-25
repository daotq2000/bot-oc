/**
 * Script kiểm tra WebSocket order tracking
 * - Kiểm tra xem WebSocket có được connect không
 * - Kiểm tra xem OrderStatusCache có được update không
 * - Kiểm tra xem PositionService có check cache đúng không
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { orderStatusCache } from '../src/services/OrderStatusCache.js';
import logger from '../src/utils/logger.js';

async function checkWebSocketOrderTracking() {
  try {
    logger.info('=== KIỂM TRA WEBSOCKET ORDER TRACKING ===\n');

    // 1. Kiểm tra các bot có WebSocket listener không
    logger.info('1. KIỂM TRA BOT CONFIGURATION:\n');
    const bots = await Bot.findAll(true); // Active bots only
    
    logger.info(`Tổng số bot active: ${bots.length}\n`);
    
    const binanceBots = bots.filter(b => (b.exchange || '').toLowerCase() === 'binance');
    logger.info(`Bot Binance (có WebSocket): ${binanceBots.length}`);
    logger.info(`Bot khác (không có WebSocket): ${bots.length - binanceBots.length}\n`);

    for (const bot of binanceBots) {
      logger.info(`  Bot ${bot.id}: ${bot.bot_name || 'N/A'} (${bot.exchange})`);
    }

    // 2. Kiểm tra position có TP/SL order ID
    logger.info('\n2. KIỂM TRA POSITION VỚI TP/SL ORDER:\n');
    const openPositions = await Position.findAll({ status: 'open' });
    
    logger.info(`Tổng số position đang mở: ${openPositions.length}\n`);

    const positionsWithTP = openPositions.filter(p => p.tp_order_id);
    const positionsWithSL = openPositions.filter(p => p.sl_order_id);
    
    logger.info(`Position có TP order: ${positionsWithTP.length}`);
    logger.info(`Position có SL order: ${positionsWithSL.length}\n`);

    // 3. Kiểm tra OrderStatusCache
    logger.info('3. KIỂM TRA ORDERSTATUSCACHE:\n');
    
    // Lấy một số TP order IDs để check
    const tpOrderIds = positionsWithTP.slice(0, 10).map(p => ({
      positionId: p.id,
      orderId: p.tp_order_id,
      symbol: p.symbol,
      botId: p.bot_id,
      exchange: p.exchange || 'binance'
    }));

    logger.info(`Kiểm tra ${tpOrderIds.length} TP orders trong cache:\n`);
    logger.info('Position ID | Order ID | Symbol | Bot | Exchange | Cached | Status');
    logger.info('─'.repeat(90));

    for (const item of tpOrderIds) {
      const cached = orderStatusCache.getOrderStatus(item.orderId, item.exchange);
      const cachedStatus = cached ? '✅' : '❌';
      const status = cached?.status || 'N/A';
      logger.info(
        `${item.positionId.toString().padStart(11)} | ${item.orderId.padEnd(10)} | ${item.symbol.padEnd(8)} | ${item.botId.toString().padStart(3)} | ${item.exchange.padEnd(8)} | ${cachedStatus.padEnd(6)} | ${status}`
      );
    }

    // 4. Kiểm tra position đã close nhưng có thể thiếu PNL
    logger.info('\n4. KIỂM TRA POSITION ĐÃ CLOSE:\n');
    
    const dbModule = await import('../src/config/database.js');
    const pool = dbModule.default;
    const [closedPositions] = await pool.execute(
      `SELECT id, symbol, bot_id, side, status, close_reason, tp_order_id, close_price, pnl, updated_at
       FROM positions 
       WHERE status = 'closed' AND close_reason = 'tp_hit'
       ORDER BY updated_at DESC 
       LIMIT 10`
    );

    logger.info(`Tìm thấy ${closedPositions.length} position đã close với tp_hit (10 gần nhất):\n`);
    logger.info('ID | Symbol | Bot | Side | TP Order ID | Close Price | PNL | Updated At');
    logger.info('─'.repeat(100));

    for (const pos of closedPositions) {
      const pnlStatus = pos.pnl !== null && pos.pnl !== undefined ? '✅' : '❌';
      logger.info(
        `${pos.id.toString().padStart(3)} | ${pos.symbol.padEnd(8)} | ${pos.bot_id.toString().padStart(3)} | ${pos.side.padEnd(5)} | ${(pos.tp_order_id || 'N/A').padEnd(12)} | ${(pos.close_price ? pos.close_price.toFixed(4) : 'N/A').padEnd(11)} | ${pnlStatus.padEnd(3)} | ${pos.updated_at ? new Date(pos.updated_at).toISOString().split('T')[0] : 'N/A'}`
      );
    }

    // 5. Phân tích vấn đề
    logger.info('\n5. PHÂN TÍCH VẤN ĐỀ:\n');
    logger.info('─'.repeat(80));

    // Kiểm tra xem có position nào có TP order nhưng không có trong cache không
    const missingInCache = [];
    for (const pos of positionsWithTP.slice(0, 20)) {
      const exchange = pos.exchange || 'binance';
      const cached = orderStatusCache.getOrderStatus(pos.tp_order_id, exchange);
      if (!cached) {
        missingInCache.push({
          positionId: pos.id,
          orderId: pos.tp_order_id,
          symbol: pos.symbol,
          botId: pos.bot_id,
          exchange: exchange
        });
      }
    }

    if (missingInCache.length > 0) {
      logger.warn(`⚠️  Tìm thấy ${missingInCache.length} TP orders không có trong cache:\n`);
      for (const item of missingInCache) {
        logger.warn(`  Position ${item.positionId}: TP order ${item.orderId} (${item.symbol}, bot ${item.botId}, exchange: ${item.exchange})`);
      }
      logger.warn(`\n💡 Nguyên nhân có thể:`);
      logger.warn(`  1. WebSocket chưa nhận được ORDER_TRADE_UPDATE event cho order này`);
      logger.warn(`  2. Order ID không match (có thể do format khác nhau)`);
      logger.warn(`  3. Exchange name không match (binance vs Binance)`);
      logger.warn(`  4. WebSocket bị disconnect và chưa reconnect`);
    } else {
      logger.info('✅ Tất cả TP orders đều có trong cache');
    }

    // 6. Kiểm tra WebSocket connection status
    logger.info('\n6. KHUYẾN NGHỊ:\n');
    logger.info('─'.repeat(80));
    logger.info('1. Kiểm tra logs để tìm: [EntryOrderMonitor] User-data WebSocket connected');
    logger.info('2. Kiểm tra logs để tìm: [EntryOrderMonitor] ORDER_TRADE_UPDATE raw event received');
    logger.info('3. Kiểm tra logs để tìm: [OrderStatusCache] Updated order');
    logger.info('4. Kiểm tra logs để tìm: [TP/SL Check] TP order filled (from WebSocket cache)');
    logger.info('5. Kiểm tra xem WebSocket có bị disconnect không');
    logger.info('6. Kiểm tra xem exchange name có được normalize đúng không (binance vs Binance)\n');

  } catch (error) {
    logger.error('Lỗi khi kiểm tra:', error);
    throw error;
  }
}

// Chạy kiểm tra
checkWebSocketOrderTracking()
  .then(() => {
    logger.info('\n✅ Hoàn thành kiểm tra');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Lỗi:', error);
    process.exit(1);
  });

