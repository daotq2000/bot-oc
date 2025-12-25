#!/usr/bin/env node

/**
 * Script để fix các positions thiếu TP orders
 * - Tìm positions có tp_order_id nhưng order đã canceled
 * - Tìm positions không có tp_order_id
 * - Recreate TP orders cho các positions này
 */

import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';

dotenv.config();

async function fixMissingTpOrders(botId = 2) {
  console.log(`\n=== FIX MISSING TP ORDERS - BOT ${botId} ===\n`);

  try {
    // 1. Lấy bot info
    const bot = await Bot.findById(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }
    console.log(`📊 Bot: ${bot.bot_name} (${bot.exchange})`);

    // 2. Initialize PositionMonitor để dùng placeTpSlOrders
    const positionMonitor = new PositionMonitor();
    await positionMonitor.initialize();

    // 3. Lấy tất cả open positions
    const [positions] = await pool.execute(
      `SELECT p.*, s.symbol as strategy_symbol, s.oc, s.take_profit, s.reduce, s.up_reduce, s.stoploss
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE p.bot_id = ? AND p.status = 'open'
       ORDER BY p.opened_at DESC`,
      [botId]
    );

    console.log(`\n📋 Tìm thấy ${positions.length} open positions`);

    // 4. Phân loại positions cần fix
    const needsFix = [];
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();

    for (const position of positions) {
      let needsTp = false;
      let reason = '';

      if (!position.tp_order_id) {
        needsTp = true;
        reason = 'Không có TP order ID trong DB';
      } else {
        // Check xem TP order có còn tồn tại trên exchange không
        try {
          const orderStatus = await exchangeService.getOrderStatus(position.symbol, position.tp_order_id);
          const status = (orderStatus?.status || '').toLowerCase();
          
          if (status === 'filled' || status === 'canceled' || status === 'cancelled' || status === 'expired') {
            needsTp = true;
            reason = `TP order đã ${status} trên exchange`;
          }
        } catch (e) {
          // Nếu không check được, assume cần recreate
          needsTp = true;
          reason = `Không thể verify TP order: ${e?.message || e}`;
        }
      }

      if (needsTp) {
        needsFix.push({ position, reason });
      }
    }

    console.log(`\n🔧 Tìm thấy ${needsFix.length} positions cần fix TP orders:`);
    needsFix.forEach((item, idx) => {
      console.log(`   ${idx + 1}. Position ${item.position.id} (${item.position.symbol}, ${item.position.side}) - ${item.reason}`);
    });

    if (needsFix.length === 0) {
      console.log(`\n✅ Không có positions nào cần fix!`);
      return;
    }

    // 5. Fix từng position
    console.log(`\n🔨 Bắt đầu fix ${needsFix.length} positions...\n`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < needsFix.length; i++) {
      const { position, reason } = needsFix[i];
      console.log(`\n[${i + 1}/${needsFix.length}] Fixing Position ${position.id} (${position.symbol})...`);
      console.log(`   Reason: ${reason}`);

      try {
        // Clear tp_order_id nếu có để force recreate
        if (position.tp_order_id) {
          await Position.update(position.id, { tp_order_id: null });
          position.tp_order_id = null;
          console.log(`   ✅ Cleared tp_order_id from DB`);
        }

        // Reload position để có data mới nhất
        const freshPosition = await Position.findById(position.id);
        if (!freshPosition) {
          console.log(`   ⚠️  Position ${position.id} không còn tồn tại, skip`);
          continue;
        }

        // Gọi placeTpSlOrders để tạo TP order
        await positionMonitor.placeTpSlOrders(freshPosition);
        
        // Verify TP order đã được tạo
        const updatedPosition = await Position.findById(position.id);
        if (updatedPosition.tp_order_id) {
          console.log(`   ✅ TP order đã được tạo: ${updatedPosition.tp_order_id}`);
          successCount++;
        } else {
          console.log(`   ⚠️  TP order chưa được tạo (có thể do price quá gần market hoặc lỗi khác)`);
          failCount++;
        }

        // Delay giữa các requests để tránh rate limit
        if (i < needsFix.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(`   ❌ Lỗi khi fix position ${position.id}: ${error?.message || error}`);
        failCount++;
      }
    }

    // 6. Tổng kết
    console.log(`\n📊 TỔNG KẾT:`);
    console.log(`   - Tổng số positions cần fix: ${needsFix.length}`);
    console.log(`   - Thành công: ${successCount}`);
    console.log(`   - Thất bại: ${failCount}`);

    if (successCount > 0) {
      console.log(`\n✅ Đã fix thành công ${successCount} positions!`);
    }
    if (failCount > 0) {
      console.log(`\n⚠️  ${failCount} positions chưa được fix (có thể cần kiểm tra thủ công)`);
    }

  } catch (error) {
    console.error('\n❌ LỖI:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
}

const botId = process.argv[2] ? parseInt(process.argv[2]) : 2;
fixMissingTpOrders(botId)
  .then(() => {
    console.log('\n✅ Hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Thất bại:', error?.message || error);
    process.exit(1);
  });


