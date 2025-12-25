/**
 * Script đơn giản để kiểm tra position LABUSDT
 */

import { Position } from '../src/models/Position.js';
import logger from '../src/utils/logger.js';

async function checkLABUSDT() {
  try {
    logger.info('=== KIỂM TRA POSITION LABUSDT, BOT_ID = 5 ===\n');

    // Tìm tất cả position LABUSDT, bot_id = 5
    const positions = await Position.findAll({ 
      symbol: 'LABUSDT',
      bot_id: 5 
    });

    if (positions.length === 0) {
      logger.info('❌ Không tìm thấy position\n');
      return;
    }

    logger.info(`Tìm thấy ${positions.length} position(s)\n`);

    // Sắp xếp theo updated_at DESC
    positions.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

    for (const pos of positions) {
      logger.info(`\n📊 POSITION ID: ${pos.id}`);
      logger.info('─'.repeat(60));
      logger.info(`Status: ${pos.status}`);
      logger.info(`Close Reason: ${pos.close_reason || 'N/A'}`);
      logger.info(`Close Price: ${pos.close_price || 'N/A'}`);
      logger.info(`PNL: ${pos.pnl || 'N/A'}`);
      logger.info(`Bot Name: ${pos.bot_name || 'N/A'}`);
      logger.info(`Telegram Chat ID: ${pos.telegram_chat_id || 'N/A'}`);
      logger.info(`Telegram Alert Channel ID: ${pos.telegram_alert_channel_id || 'N/A'}`);
      logger.info(`Interval: ${pos.interval || 'N/A'}`);
      logger.info(`OC: ${pos.oc || 'N/A'}`);
      logger.info(`Extend: ${pos.extend || 'N/A'}`);
      logger.info(`Take Profit: ${pos.take_profit || 'N/A'}`);
      logger.info(`Updated At: ${pos.updated_at || pos.created_at}`);

      if (pos.status === 'closed' && pos.close_reason === 'tp_hit') {
        logger.info(`\n✅ Position đã close với tp_hit`);
        
        // Kiểm tra điều kiện gửi alert
        const hasChannel = pos.telegram_alert_channel_id || pos.telegram_chat_id;
        const hasBotName = pos.bot_name;
        const hasInterval = pos.interval;
        const hasOC = pos.oc;
        const hasExtend = pos.extend;
        const hasTP = pos.take_profit;
        
        logger.info(`\n🔍 Điều kiện gửi alert:`);
        logger.info(`  - Channel ID: ${hasChannel ? '✅' : '❌'} (${pos.telegram_alert_channel_id || pos.telegram_chat_id || 'N/A'})`);
        logger.info(`  - Bot Name: ${hasBotName ? '✅' : '❌'} (${pos.bot_name || 'N/A'})`);
        logger.info(`  - Interval: ${hasInterval ? '✅' : '❌'} (${pos.interval || 'N/A'})`);
        logger.info(`  - OC: ${hasOC ? '✅' : '❌'} (${pos.oc || 'N/A'})`);
        logger.info(`  - Extend: ${hasExtend ? '✅' : '❌'} (${pos.extend || 'N/A'})`);
        logger.info(`  - Take Profit: ${hasTP ? '✅' : '❌'} (${pos.take_profit || 'N/A'})`);

        if (!hasChannel) {
          logger.warn(`\n⚠️  VẤN ĐỀ: Bot không có telegram_alert_channel_id hoặc telegram_chat_id`);
          logger.warn(`   Cần set telegram_alert_channel_id hoặc telegram_chat_id cho bot_id = 5`);
        }
      }
    }

  } catch (error) {
    logger.error('Lỗi:', error);
    throw error;
  }
}

checkLABUSDT()
  .then(() => {
    logger.info('\n✅ Hoàn thành');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Lỗi:', error);
    process.exit(1);
  });

