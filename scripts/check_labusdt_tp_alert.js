/**
 * Script kiểm tra position LABUSDT, bot_id = 5 đã hit TP nhưng không có alert Telegram
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { Strategy } from '../src/models/Strategy.js';
import logger from '../src/utils/logger.js';

async function checkLABUSDTTPAlert() {
  try {
    logger.info('=== KIỂM TRA POSITION LABUSDT, BOT_ID = 5 ===\n');

    // Tìm position LABUSDT, bot_id = 5
    const positions = await Position.findAll({ 
      symbol: 'LABUSDT',
      bot_id: 5 
    });

    if (positions.length === 0) {
      logger.info('❌ Không tìm thấy position LABUSDT, bot_id = 5\n');
      return;
    }

    logger.info(`Tìm thấy ${positions.length} position(s) LABUSDT, bot_id = 5\n`);

    // Sắp xếp theo created_at DESC để lấy position mới nhất
    positions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    for (const pos of positions) {
      logger.info(`\n📊 POSITION ID: ${pos.id}`);
      logger.info('─'.repeat(60));
      logger.info(`Symbol: ${pos.symbol}`);
      logger.info(`Bot ID: ${pos.bot_id}`);
      logger.info(`Side: ${pos.side}`);
      logger.info(`Status: ${pos.status}`);
      logger.info(`Entry Price: ${pos.entry_price}`);
      logger.info(`Close Price: ${pos.close_price || 'N/A'}`);
      logger.info(`Close Reason: ${pos.close_reason || 'N/A'}`);
      logger.info(`TP Order ID: ${pos.tp_order_id || 'N/A'}`);
      logger.info(`TP Price: ${pos.take_profit_price || 'N/A'}`);
      logger.info(`PNL: ${pos.pnl || 'N/A'}`);
      logger.info(`Created At: ${pos.created_at}`);
      logger.info(`Updated At: ${pos.updated_at}`);

      // Kiểm tra bot info
      if (pos.bot_id) {
        try {
          const bot = await Bot.findById(pos.bot_id);
          if (bot) {
            logger.info(`Bot Name: ${bot.bot_name || 'N/A'}`);
            logger.info(`Telegram Chat ID: ${bot.telegram_chat_id || 'N/A'}`);
            logger.info(`Telegram Alert Channel ID: ${bot.telegram_alert_channel_id || 'N/A'}`);
          }
        } catch (e) {
          logger.warn(`Không thể lấy bot info: ${e?.message || e}`);
        }
      }

      // Kiểm tra strategy info
      if (pos.strategy_id) {
        try {
          const strategy = await Strategy.findById(pos.strategy_id);
          if (strategy) {
            logger.info(`Strategy ID: ${strategy.id}`);
            logger.info(`Strategy Interval: ${strategy.interval || 'N/A'}`);
            logger.info(`Strategy OC: ${strategy.oc || 'N/A'}`);
            logger.info(`Strategy Extend: ${strategy.extend || 'N/A'}`);
            logger.info(`Strategy Take Profit: ${strategy.take_profit || 'N/A'}`);
          }
        } catch (e) {
          logger.warn(`Không thể lấy strategy info: ${e?.message || e}`);
        }
      }

      // Phân tích
      logger.info('\n🔍 PHÂN TÍCH:');
      logger.info('─'.repeat(60));

      if (pos.status === 'closed') {
        if (pos.close_reason === 'tp_hit') {
          logger.info('✅ Position đã được close với reason = tp_hit');
          
          // Kiểm tra xem có đủ thông tin để gửi alert không
          const hasBotInfo = pos.bot_id;
          const hasClosePrice = pos.close_price && Number(pos.close_price) > 0;
          const hasPNL = pos.pnl !== null && pos.pnl !== undefined;
          const hasEntryPrice = pos.entry_price && Number(pos.entry_price) > 0;
          const hasAmount = pos.amount && Number(pos.amount) > 0;

          logger.info(`\n📋 Thông tin cần thiết cho Telegram alert:`);
          logger.info(`  - Bot ID: ${hasBotInfo ? '✅' : '❌'}`);
          logger.info(`  - Close Price: ${hasClosePrice ? '✅' : '❌'} (${pos.close_price || 'N/A'})`);
          logger.info(`  - PNL: ${hasPNL ? '✅' : '❌'} (${pos.pnl || 'N/A'})`);
          logger.info(`  - Entry Price: ${hasEntryPrice ? '✅' : '❌'} (${pos.entry_price || 'N/A'})`);
          logger.info(`  - Amount: ${hasAmount ? '✅' : '❌'} (${pos.amount || 'N/A'})`);

          if (!hasBotInfo || !hasClosePrice || !hasPNL || !hasEntryPrice || !hasAmount) {
            logger.warn(`\n⚠️  THIẾU THÔNG TIN: Position thiếu một số thông tin cần thiết để gửi Telegram alert`);
          } else {
            logger.info(`\n✅ ĐỦ THÔNG TIN: Position có đủ thông tin để gửi Telegram alert`);
            logger.info(`\n💡 Có thể do:`);
            logger.info(`  1. TelegramService không được khởi tạo đúng cách`);
            logger.info(`  2. Lỗi khi gửi Telegram notification (check logs)`);
            logger.info(`  3. Position.close() không gọi sendTelegramCloseNotification()`);
          }
        } else {
          logger.info(`⚠️  Position đã close nhưng reason = ${pos.close_reason} (không phải tp_hit)`);
        }
      } else if (pos.status === 'open') {
        logger.info('⚠️  Position vẫn đang mở');
        
        // Kiểm tra xem TP order có filled không
        if (pos.tp_order_id) {
          logger.info(`\n💡 Có TP Order ID: ${pos.tp_order_id}`);
          logger.info(`   Cần kiểm tra xem order này có filled trên exchange không`);
        } else {
          logger.warn(`\n⚠️  Position không có TP Order ID`);
        }
      }

      logger.info('\n');
    }

    // Kiểm tra logs gần đây
    logger.info('\n📋 KHUYẾN NGHỊ:');
    logger.info('─'.repeat(60));
    logger.info('1. Kiểm tra logs để tìm lỗi khi gửi Telegram notification');
    logger.info('2. Kiểm tra xem PositionService.closePosition() có gọi sendTelegramCloseNotification() không');
    logger.info('3. Kiểm tra xem TelegramService có được khởi tạo đúng cách không');
    logger.info('4. Kiểm tra xem bot có telegram_alert_channel_id hoặc telegram_chat_id không\n');

  } catch (error) {
    logger.error('Lỗi khi kiểm tra position:', error);
    throw error;
  }
}

// Chạy kiểm tra
checkLABUSDTTPAlert()
  .then(() => {
    logger.info('\n✅ Hoàn thành kiểm tra');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Lỗi:', error);
    process.exit(1);
  });

