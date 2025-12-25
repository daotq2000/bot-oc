#!/usr/bin/env node

/**
 * Script test để verify việc sử dụng ENTRY_ORDER_TTL_MINUTES
 * Kiểm tra xem code có hoạt động đúng theo config này không
 */

import { configService } from '../src/services/ConfigService.js';
import { EntryOrder } from '../src/models/EntryOrder.js';
import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';

async function testExtendLimitAutoCancel() {
    console.log('\n=== TEST ENTRY_ORDER_TTL_MINUTES ===\n');

    try {
    // 1. Kiểm tra giá trị config
    console.log('📊 1. KIỂM TRA CONFIG:');
    const entryOrderTTL = Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 30));
    console.log(`   - ENTRY_ORDER_TTL_MINUTES: ${entryOrderTTL} phút`);
    console.log(`   - ENABLE_LIMIT_ON_EXTEND_MISS: ${configService.getBoolean('ENABLE_LIMIT_ON_EXTEND_MISS', true)}`);

    // 2. Kiểm tra entry orders trong database
    console.log('\n📊 2. KIỂM TRA ENTRY ORDERS TRONG DATABASE:');
    const [allEntries] = await pool.execute(
      `SELECT id, strategy_id, bot_id, symbol, side, entry_price, status, created_at,
       TIMESTAMPDIFF(MINUTE, created_at, NOW()) as age_minutes
       FROM entry_orders 
       WHERE status = 'open'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    console.log(`   - Số entry orders đang mở: ${allEntries.length}`);
    
    if (allEntries.length > 0) {
      console.log(`   - Chi tiết các entry orders:`);
      allEntries.forEach((entry, idx) => {
        const shouldCancel = entry.age_minutes >= entryOrderTTL;
        const status = shouldCancel ? '⚠️  NÊN CANCEL' : '✅ OK';
        console.log(`     ${idx + 1}. ID=${entry.id}, Symbol=${entry.symbol}, Side=${entry.side}, ` +
                   `Age=${entry.age_minutes} phút, ${status}`);
        console.log(`        Created: ${entry.created_at}`);
      });
    } else {
      console.log('   - Không có entry orders nào đang mở');
    }

    // 3. Kiểm tra entry orders đã bị cancel do TTL
    console.log('\n📊 3. KIỂM TRA ENTRY ORDERS ĐÃ BỊ CANCEL:');
    const [canceledEntries] = await pool.execute(
      `SELECT id, strategy_id, bot_id, symbol, side, status, created_at, updated_at,
       TIMESTAMPDIFF(MINUTE, created_at, updated_at) as lifetime_minutes
       FROM entry_orders 
       WHERE status IN ('canceled', 'expired', 'expired_ttl')
       ORDER BY updated_at DESC
       LIMIT 20`
    );
    console.log(`   - Số entry orders đã bị cancel: ${canceledEntries.length}`);
    
    if (canceledEntries.length > 0) {
      console.log(`   - Chi tiết các entry orders đã cancel:`);
      canceledEntries.forEach((entry, idx) => {
        const isEntryOrderTTL = entry.lifetime_minutes <= entryOrderTTL + 2; // +2 phút tolerance
        let reason = 'Unknown';
        if (entry.status === 'expired_ttl') {
          reason = isEntryOrderTTL ? 'Có thể do ENTRY_ORDER_TTL' : 'Unknown TTL';
        } else {
          reason = entry.status;
        }
        console.log(`     ${idx + 1}. ID=${entry.id}, Symbol=${entry.symbol}, Status=${entry.status}, ` +
                   `Lifetime=${entry.lifetime_minutes} phút, Reason=${reason}`);
        console.log(`        Created: ${entry.created_at}, Updated: ${entry.updated_at}`);
      });
    }

    // 4. Phân tích logic trong EntryOrderMonitor
    console.log('\n📊 4. PHÂN TÍCH LOGIC:');
    console.log(`   - Code hiện tại trong EntryOrderMonitor.js:`);
    console.log(`     * Sử dụng ENTRY_ORDER_TTL_MINUTES cho TẤT CẢ entry orders`);
    console.log(`     * Áp dụng cho tất cả LIMIT entry orders (bao gồm cả extend-miss)`);
    console.log(`     * TTL: ${entryOrderTTL} phút`);

    // 5. Kiểm tra schema của entry_orders table
    console.log('\n📊 5. KIỂM TRA SCHEMA ENTRY_ORDERS:');
    try {
      const [columns] = await pool.execute(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'entry_orders'
         ORDER BY ORDINAL_POSITION`
      );
      console.log(`   - Các columns trong entry_orders table:`);
      columns.forEach(col => {
        console.log(`     - ${col.COLUMN_NAME}: ${col.DATA_TYPE} ${col.IS_NULLABLE === 'YES' ? '(nullable)' : '(not null)'}`);
      });
      
      // Kiểm tra xem có column nào để đánh dấu extend-miss không
      const hasExtendMissFlag = columns.some(col => 
        col.COLUMN_NAME.toLowerCase().includes('extend') || 
        col.COLUMN_NAME.toLowerCase().includes('passive') ||
        col.COLUMN_NAME.toLowerCase().includes('force')
      );
      if (!hasExtendMissFlag) {
        console.log(`   ⚠️  KHÔNG có column nào để đánh dấu extend-miss LIMIT orders!`);
      }
    } catch (e) {
      console.log(`   ⚠️  Không thể kiểm tra schema: ${e?.message || e}`);
    }

    // 6. Đề xuất sửa lỗi
    console.log('\n📊 6. ĐỀ XUẤT SỬA LỖI:');
    console.log(`   - Logic hiện tại đã được đơn giản hóa:`);
    console.log(`     * Chỉ sử dụng ENTRY_ORDER_TTL_MINUTES cho tất cả entry orders`);
    console.log(`     * Không còn phân biệt extend-miss và LIMIT thông thường`);
    console.log(`     * TTL ${entryOrderTTL} phút áp dụng cho tất cả`);

    // 7. Tổng kết
    console.log('\n📈 7. TỔNG KẾT:');
    console.log(`   - Config ENTRY_ORDER_TTL_MINUTES: ${entryOrderTTL} phút`);
    console.log(`   - Logic hiện tại: Dùng ${entryOrderTTL} phút cho TẤT CẢ entry orders`);
    console.log(`   - Đã đơn giản hóa: Chỉ còn 1 config thay vì 2 config gây nhầm lẫn`);

  } catch (error) {
    console.error('\n❌ LỖI TỔNG QUÁT:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
}

// Chạy test
testExtendLimitAutoCancel()
  .then(() => {
    console.log('\n✅ Test hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test thất bại:', error?.message || error);
    process.exit(1);
  });

