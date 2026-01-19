#!/usr/bin/env node

/**
 * Deep analysis of position issues - find root causes
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

async function getDbConnection() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_oc',
    waitForConnections: true,
    connectionLimit: 10
  });
}

async function analyzePositionIssues() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(80));
    console.log('🔍 DEEP POSITION ISSUE ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Generated at: ${new Date().toISOString()}\n`);
    
    // 1. Analyze positions without SL - WHY?
    console.log('1️⃣  Analyzing WHY positions don\'t have SL...');
    const [noSlAnalysis] = await pool.execute(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN s.stoploss IS NULL OR s.stoploss = 0 THEN 1 END) as no_strategy_sl,
        COUNT(CASE WHEN s.stoploss > 0 AND (p.stop_loss_price IS NULL OR p.stop_loss_price = 0) THEN 1 END) as sl_not_placed,
        COUNT(CASE WHEN p.sl_order_id IS NOT NULL AND p.sl_order_id != '' AND (p.stop_loss_price IS NULL OR p.stop_loss_price = 0) THEN 1 END) as sl_order_exists_but_no_price
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'open' AND (p.stop_loss_price IS NULL OR p.stop_loss_price = 0)
    `);
    
    const analysis = noSlAnalysis[0];
    console.log(`   Total positions without SL: ${analysis.total}`);
    console.log(`   - Strategy has no SL configured: ${analysis.no_strategy_sl}`);
    console.log(`   - Strategy has SL but not placed: ${analysis.sl_not_placed}`);
    console.log(`   - SL order exists but no price in DB: ${analysis.sl_order_exists_but_no_price}`);
    console.log();
    
    // 2. Analyze strategies without stoploss
    console.log('2️⃣  Analyzing strategies without stoploss...');
    const [strategiesNoSl] = await pool.execute(`
      SELECT DISTINCT
        s.id,
        s.symbol,
        s.stoploss,
        COUNT(p.id) as position_count,
        SUM(CASE WHEN p.pnl < 0 THEN 1 ELSE 0 END) as losing_count,
        SUM(CASE WHEN p.pnl > 0 THEN 1 ELSE 0 END) as winning_count,
        SUM(p.pnl) as total_pnl
      FROM strategies s
      INNER JOIN positions p ON s.id = p.strategy_id
      WHERE p.status = 'open' AND (s.stoploss IS NULL OR s.stoploss = 0)
      GROUP BY s.id, s.symbol, s.stoploss
      ORDER BY position_count DESC
      LIMIT 20
    `);
    
    console.log(`   Found ${strategiesNoSl.length} strategies without SL config`);
    if (strategiesNoSl.length > 0) {
      console.log('   Top strategies without SL:');
      strategiesNoSl.forEach((s, i) => {
        console.log(`   ${i + 1}. Strategy ${s.id} (${s.symbol}) | ` +
                   `Positions: ${s.position_count} | ` +
                   `Losing: ${s.losing_count} | ` +
                   `Total PnL: ${Number(s.total_pnl || 0).toFixed(2)} USDT`);
      });
    }
    console.log();
    
    // 3. Analyze positions with SL order but no price
    console.log('3️⃣  Analyzing positions with SL order but no price...');
    const [slOrderNoPrice] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.sl_order_id,
        p.stop_loss_price,
        s.stoploss as strategy_stoploss
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'open' 
        AND p.sl_order_id IS NOT NULL 
        AND p.sl_order_id != ''
        AND (p.stop_loss_price IS NULL OR p.stop_loss_price = 0)
      LIMIT 20
    `);
    
    console.log(`   Found ${slOrderNoPrice.length} positions with SL order but no price`);
    if (slOrderNoPrice.length > 0) {
      console.log('   ⚠️  These positions have SL orders but price not stored in DB:');
      slOrderNoPrice.forEach((pos, i) => {
        console.log(`   ${i + 1}. Position ${pos.id} (${pos.symbol} ${pos.side}) | ` +
                   `SL Order: ${pos.sl_order_id} | ` +
                   `Strategy SL: ${pos.strategy_stoploss || 'N/A'}`);
      });
    }
    console.log();
    
    // 4. Analyze losing positions by entry time
    console.log('4️⃣  Analyzing losing positions by entry time...');
    const [losingByTime] = await pool.execute(`
      SELECT 
        DATE_FORMAT(p.opened_at, '%Y-%m-%d %H:00:00') as hour,
        COUNT(*) as total,
        SUM(CASE WHEN p.pnl < 0 THEN 1 ELSE 0 END) as losing,
        SUM(CASE WHEN p.pnl > 0 THEN 1 ELSE 0 END) as winning,
        SUM(p.pnl) as total_pnl
      FROM positions p
      WHERE p.status = 'open' AND p.opened_at IS NOT NULL
      GROUP BY hour
      ORDER BY hour DESC
      LIMIT 24
    `);
    
    console.log('   Positions by hour (last 24h):');
    losingByTime.forEach(row => {
      const winRate = row.total > 0 ? (row.winning / row.total * 100) : 0;
      console.log(`   ${row.hour}: Total=${row.total} | Losing=${row.losing} | Winning=${row.winning} | ` +
                 `WinRate=${winRate.toFixed(1)}% | PnL=${Number(row.total_pnl || 0).toFixed(2)} USDT`);
    });
    console.log();
    
    // 5. Analyze positions by PnL range
    console.log('5️⃣  Analyzing positions by PnL range...');
    const [pnlRanges] = await pool.execute(`
      SELECT 
        CASE 
          WHEN p.pnl < -50 THEN '< -50 USDT'
          WHEN p.pnl < -20 THEN '-50 to -20 USDT'
          WHEN p.pnl < -10 THEN '-20 to -10 USDT'
          WHEN p.pnl < -5 THEN '-10 to -5 USDT'
          WHEN p.pnl < 0 THEN '-5 to 0 USDT'
          WHEN p.pnl = 0 THEN '0 USDT'
          WHEN p.pnl <= 5 THEN '0 to 5 USDT'
          WHEN p.pnl <= 10 THEN '5 to 10 USDT'
          WHEN p.pnl <= 20 THEN '10 to 20 USDT'
          ELSE '> 20 USDT'
        END as pnl_range,
        COUNT(*) as count
      FROM positions p
      WHERE p.status = 'open'
      GROUP BY pnl_range
      ORDER BY 
        CASE pnl_range
          WHEN '< -50 USDT' THEN 1
          WHEN '-50 to -20 USDT' THEN 2
          WHEN '-20 to -10 USDT' THEN 3
          WHEN '-10 to -5 USDT' THEN 4
          WHEN '-5 to 0 USDT' THEN 5
          WHEN '0 USDT' THEN 6
          WHEN '0 to 5 USDT' THEN 7
          WHEN '5 to 10 USDT' THEN 8
          WHEN '10 to 20 USDT' THEN 9
          ELSE 10
        END
    `);
    
    console.log('   Positions by PnL range:');
    pnlRanges.forEach(row => {
      console.log(`   ${row.pnl_range}: ${row.count} positions`);
    });
    console.log();
    
    // 6. Analyze positions with TP but no SL
    console.log('6️⃣  Analyzing positions with TP but no SL...');
    const [tpNoSl] = await pool.execute(`
      SELECT 
        COUNT(*) as total,
        AVG(p.pnl) as avg_pnl,
        SUM(CASE WHEN p.pnl < 0 THEN 1 ELSE 0 END) as losing,
        SUM(CASE WHEN p.pnl > 0 THEN 1 ELSE 0 END) as winning
      FROM positions p
      WHERE p.status = 'open'
        AND p.take_profit_price IS NOT NULL 
        AND p.take_profit_price > 0
        AND (p.stop_loss_price IS NULL OR p.stop_loss_price = 0)
    `);
    
    const tpNoSlData = tpNoSl[0];
    console.log(`   Positions with TP but no SL: ${tpNoSlData.total}`);
    if (tpNoSlData.total > 0) {
      console.log(`   - Average PnL: ${Number(tpNoSlData.avg_pnl || 0).toFixed(2)} USDT`);
      console.log(`   - Losing: ${tpNoSlData.losing} | Winning: ${tpNoSlData.winning}`);
    }
    console.log();
    
    // 7. Root cause analysis
    console.log('='.repeat(80));
    console.log('🔍 ROOT CAUSE ANALYSIS');
    console.log('='.repeat(80));
    
    if (analysis.no_strategy_sl > 0) {
      console.log('❌ ROOT CAUSE 1: Strategies không có stoploss configured');
      console.log(`   - ${analysis.no_strategy_sl} positions từ strategies không có SL`);
      console.log('   → FIX: Update strategies table, set stoploss > 0 cho tất cả strategies');
      console.log();
    }
    
    if (analysis.sl_not_placed > 0) {
      console.log('❌ ROOT CAUSE 2: SL không được place mặc dù strategy có stoploss');
      console.log(`   - ${analysis.sl_not_placed} positions có strategy.stoploss > 0 nhưng không có SL`);
      console.log('   → FIX: Check PositionMonitor.placeExitOrder() logs');
      console.log('   → FIX: Check ExitOrderManager errors');
      console.log('   → FIX: Verify exchange API calls for SL placement');
      console.log();
    }
    
    if (analysis.sl_order_exists_but_no_price > 0) {
      console.log('❌ ROOT CAUSE 3: SL order tồn tại nhưng price không được lưu vào DB');
      console.log(`   - ${analysis.sl_order_exists_but_no_price} positions có sl_order_id nhưng stop_loss_price = NULL`);
      console.log('   → FIX: Check PositionMonitor update logic after SL placement');
      console.log('   → FIX: Verify Position.update() is called after SL order creation');
      console.log();
    }
    
    // 8. Recommendations
    console.log('='.repeat(80));
    console.log('💡 IMMEDIATE ACTIONS REQUIRED');
    console.log('='.repeat(80));
    
    console.log('1. ⚠️  CRITICAL: 986 positions không có SL - Cần fix ngay!');
    console.log('   → Check strategy.stoploss configuration');
    console.log('   → Review PositionMonitor logs for SL placement failures');
    console.log('   → Verify ExitOrderManager is working correctly');
    console.log();
    
    console.log('2. ⚠️  Win rate quá thấp (2.35%)');
    console.log('   → Review entry conditions');
    console.log('   → Check trend filter effectiveness');
    console.log('   → Consider adjusting strategy parameters');
    console.log();
    
    console.log('3. ⚠️  Nhiều positions đang lỗ');
    console.log('   → Review top losing positions');
    console.log('   → Check if SL is being hit correctly');
    console.log('   → Verify position monitoring is working');
    console.log();
    
    console.log('='.repeat(80));
    
  } finally {
    await pool.end();
  }
}

analyzePositionIssues().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});


