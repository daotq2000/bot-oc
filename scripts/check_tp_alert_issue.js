/**
 * Script kiểm tra chi tiết vấn đề TP alert không được gửi
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { Strategy } from '../src/models/Strategy.js';
import logger from '../src/utils/logger.js';

async function checkTPAlertIssue() {
  try {
    logger.info('=== KIỂM TRA VẤN ĐỀ TP ALERT ===\n');

    // Tìm position LABUSDT, bot_id = 5 đã close với tp_hit
    const { default: pool } = await import('../src/config/database.js');
    const [positions] = await pool.execute(
      `SELECT * FROM positions 
       WHERE symbol = ? AND bot_id = ? AND status = 'closed' AND close_reason = 'tp_hit'
       ORDER BY updated_at DESC LIMIT 5`,
      ['LABUSDT', 5]
    );

    if (positions.length === 0) {
      logger.info('❌ Không tìm thấy position LABUSDT, bot_id = 5 đã close với tp_hit\n');
      
      // Tìm position đã close với bất kỳ reason nào
      const [allClosed] = await pool.execute(
        `SELECT id, symbol, bot_id, status, close_reason, close_price, pnl, updated_at 
         FROM positions 
         WHERE symbol = ? AND bot_id = ? AND status = 'closed'
         ORDER BY updated_at DESC LIMIT 5`,
        ['LABUSDT', 5]
      );
      
      if (allClosed.length > 0) {
        logger.info(`Tìm thấy ${allClosed.length} position(s) đã close (không phải tp_hit):\n`);
        for (const p of allClosed) {
          logger.info(`  ID: ${p.id}, Close Reason: ${p.close_reason}, Updated: ${p.updated_at}`);
        }
      }
      
      return;
    }

    logger.info(`Tìm thấy ${positions.length} position(s) LABUSDT, bot_id = 5 đã close với tp_hit\n`);

    for (const pos of positions) {
      logger.info(`\n📊 POSITION ID: ${pos.id}`);
      logger.info('═'.repeat(80));
      
      // Lấy bot info
      let bot = null;
      if (pos.bot_id) {
        try {
          bot = await Bot.findById(pos.bot_id);
        } catch (e) {
          logger.warn(`Không thể lấy bot: ${e?.message}`);
        }
      }

      // Lấy strategy info
      let strategy = null;
      if (pos.strategy_id) {
        try {
          strategy = await Strategy.findById(pos.strategy_id);
        } catch (e) {
          logger.warn(`Không thể lấy strategy: ${e?.message}`);
        }
      }

      // Lấy position với bot info từ Position.findById
      let positionWithBotInfo = null;
      try {
        positionWithBotInfo = await Position.findById(pos.id);
      } catch (e) {
        logger.warn(`Không thể lấy position với bot info: ${e?.message}`);
      }

      logger.info(`\n📋 THÔNG TIN POSITION:`);
      logger.info(`  Symbol: ${pos.symbol}`);
      logger.info(`  Side: ${pos.side}`);
      logger.info(`  Status: ${pos.status}`);
      logger.info(`  Close Reason: ${pos.close_reason}`);
      logger.info(`  Entry Price: ${pos.entry_price}`);
      logger.info(`  Close Price: ${pos.close_price}`);
      logger.info(`  Amount: ${pos.amount}`);
      logger.info(`  PNL: ${pos.pnl}`);
      logger.info(`  Created At: ${pos.created_at}`);
      logger.info(`  Updated At: ${pos.updated_at}`);

      logger.info(`\n🤖 THÔNG TIN BOT:`);
      if (bot) {
        logger.info(`  Bot ID: ${bot.id}`);
        logger.info(`  Bot Name: ${bot.bot_name || 'N/A'}`);
        logger.info(`  Telegram Chat ID: ${bot.telegram_chat_id || 'N/A'}`);
        logger.info(`  Telegram Alert Channel ID: ${bot.telegram_alert_channel_id || 'N/A'}`);
      } else {
        logger.warn(`  ❌ Không tìm thấy bot`);
      }

      logger.info(`\n📈 THÔNG TIN STRATEGY:`);
      if (strategy) {
        logger.info(`  Strategy ID: ${strategy.id}`);
        logger.info(`  Interval: ${strategy.interval || 'N/A'}`);
        logger.info(`  OC: ${strategy.oc || 'N/A'}`);
        logger.info(`  Extend: ${strategy.extend || 'N/A'}`);
        logger.info(`  Take Profit: ${strategy.take_profit || 'N/A'}`);
      } else {
        logger.warn(`  ❌ Không tìm thấy strategy`);
      }

      logger.info(`\n🔍 PHÂN TÍCH VẤN ĐỀ:`);
      logger.info('─'.repeat(80));

      // Kiểm tra các điều kiện cần thiết
      const checks = {
        hasCloseReason: pos.close_reason === 'tp_hit',
        hasClosePrice: pos.close_price && Number(pos.close_price) > 0,
        hasPNL: pos.pnl !== null && pos.pnl !== undefined,
        hasEntryPrice: pos.entry_price && Number(pos.entry_price) > 0,
        hasAmount: pos.amount && Number(pos.amount) > 0,
        hasBot: bot !== null,
        hasTelegramChannel: bot && (bot.telegram_alert_channel_id || bot.telegram_chat_id),
        hasPositionWithBotInfo: positionWithBotInfo !== null,
        hasBotNameInPosition: positionWithBotInfo && positionWithBotInfo.bot_name,
      };

      logger.info(`\n✅/❌ CHECKLIST:`);
      for (const [key, value] of Object.entries(checks)) {
        const icon = value ? '✅' : '❌';
        logger.info(`  ${icon} ${key}: ${value}`);
      }

      // Phân tích nguyên nhân
      logger.info(`\n💡 NGUYÊN NHÂN CÓ THỂ:`);
      if (!checks.hasCloseReason) {
        logger.info(`  ❌ Close reason không phải 'tp_hit' (là: ${pos.close_reason})`);
      }
      if (!checks.hasBot) {
        logger.info(`  ❌ Không tìm thấy bot (bot_id: ${pos.bot_id})`);
      }
      if (!checks.hasTelegramChannel) {
        logger.info(`  ❌ Bot không có telegram_alert_channel_id hoặc telegram_chat_id`);
        logger.info(`     - telegram_alert_channel_id: ${bot?.telegram_alert_channel_id || 'NULL'}`);
        logger.info(`     - telegram_chat_id: ${bot?.telegram_chat_id || 'NULL'}`);
      }
      if (!checks.hasPositionWithBotInfo) {
        logger.info(`  ❌ Không thể lấy position với bot info từ Position.findById()`);
      }
      if (!checks.hasBotNameInPosition) {
        logger.info(`  ❌ Position không có bot_name (cần cho Telegram alert)`);
      }

      // Kiểm tra logs
      logger.info(`\n📋 KHUYẾN NGHỊ:`);
      logger.info(`  1. Kiểm tra logs để tìm: [Notification] Preparing to send close summary`);
      logger.info(`  2. Kiểm tra logs để tìm: [Notification] ✅ Successfully sent close summary alert`);
      logger.info(`  3. Kiểm tra logs để tìm: [Notification] ❌ Failed to send close summary alert`);
      logger.info(`  4. Kiểm tra logs để tìm: [CloseSummaryAlert] No channel ID available`);
      logger.info(`  5. Kiểm tra xem TelegramService có được khởi tạo đúng cách không`);
      logger.info(`  6. Kiểm tra xem bot có telegram_alert_channel_id hoặc telegram_chat_id không\n`);

      // Thử tính toán stats
      if (pos.bot_id) {
        try {
          const stats = await Position.getBotStats(pos.bot_id);
          logger.info(`\n📊 BOT STATS:`);
          logger.info(`  Wins: ${stats?.wins || 0}`);
          logger.info(`  Loses: ${stats?.loses || 0}`);
          logger.info(`  Total PNL: ${stats?.total_pnl || 0}`);
        } catch (e) {
          logger.warn(`  Không thể lấy bot stats: ${e?.message}`);
        }
      }
    }

  } catch (error) {
    logger.error('Lỗi khi kiểm tra:', error);
    throw error;
  }
}

// Chạy kiểm tra
checkTPAlertIssue()
  .then(() => {
    logger.info('\n✅ Hoàn thành kiểm tra');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Lỗi:', error);
    process.exit(1);
  });

