#!/usr/bin/env node
/**
 * Script kiểm tra và sửa vấn đề gây thua lỗ
 * Chạy: node scripts/fix_profit_issues.js
 */

import pool from '../src/config/database.js';
import { configService } from '../src/services/ConfigService.js';

async function main() {
  console.log('\n🔍 KIỂM TRA VẤN ĐỀ GÂY THUA LỖ\n');
  console.log('='.repeat(60));

  try {
    // 1. Kiểm tra strategies có stoploss
    console.log('\n📊 1. KIỂM TRA STOPLOSS TRONG STRATEGIES');
    console.log('-'.repeat(40));
    
    const [strategiesWithoutSL] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM strategies 
      WHERE is_active = 1 AND (stoploss IS NULL OR stoploss <= 0)
    `);
    
    const [strategiesWithSL] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM strategies 
      WHERE is_active = 1 AND stoploss > 0
    `);
    
    console.log(`✅ Strategies có SL: ${strategiesWithSL[0].count}`);
    console.log(`❌ Strategies KHÔNG có SL: ${strategiesWithoutSL[0].count}`);
    
    if (strategiesWithoutSL[0].count > 0) {
      console.log('\n⚠️  CẢNH BÁO: Có strategies không có stoploss!');
      console.log('   Chạy lệnh sau để fix:');
      console.log('   UPDATE strategies SET stoploss = 25 WHERE stoploss IS NULL OR stoploss <= 0;');
    }

    // 2. Kiểm tra positions có SL orders
    console.log('\n📊 2. KIỂM TRA SL ORDERS TRÊN POSITIONS');
    console.log('-'.repeat(40));
    
    const [positionsWithSL] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM positions 
      WHERE status = 'open' AND sl_order_id IS NOT NULL
    `);
    
    const [positionsWithoutSL] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM positions 
      WHERE status = 'open' AND sl_order_id IS NULL
    `);
    
    const [totalOpen] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM positions 
      WHERE status = 'open'
    `);
    
    const slCoverage = totalOpen[0].count > 0 
      ? ((positionsWithSL[0].count / totalOpen[0].count) * 100).toFixed(1)
      : 0;
    
    console.log(`📈 Total open positions: ${totalOpen[0].count}`);
    console.log(`✅ Positions có SL order: ${positionsWithSL[0].count}`);
    console.log(`❌ Positions KHÔNG có SL order: ${positionsWithoutSL[0].count}`);
    console.log(`📊 SL Coverage: ${slCoverage}%`);
    
    if (slCoverage < 100) {
      console.log('\n⚠️  CẢNH BÁO: SL coverage < 100%!');
      console.log('   Đây là nguyên nhân chính gây lỗ sâu!');
    }

    // 3. Kiểm tra TP coverage
    console.log('\n📊 3. KIỂM TRA TP ORDERS');
    console.log('-'.repeat(40));
    
    const [positionsWithTP] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM positions 
      WHERE status = 'open' AND exit_order_id IS NOT NULL
    `);
    
    const tpCoverage = totalOpen[0].count > 0 
      ? ((positionsWithTP[0].count / totalOpen[0].count) * 100).toFixed(1)
      : 0;
    
    console.log(`✅ Positions có TP order: ${positionsWithTP[0].count}`);
    console.log(`📊 TP Coverage: ${tpCoverage}%`);

    // 4. Kiểm tra PnL gần đây
    console.log('\n📊 4. PNL SUMMARY (30 ngày gần đây)');
    console.log('-'.repeat(40));
    
    const [pnlStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_closed,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        SUM(pnl) as total_pnl,
        AVG(CASE WHEN pnl > 0 THEN pnl ELSE NULL END) as avg_win,
        AVG(CASE WHEN pnl < 0 THEN pnl ELSE NULL END) as avg_loss,
        MIN(pnl) as max_loss,
        MAX(pnl) as max_win
      FROM positions 
      WHERE status = 'closed' 
        AND closed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);
    
    const stats = pnlStats[0];
    const winRate = stats.total_closed > 0 
      ? ((stats.wins / stats.total_closed) * 100).toFixed(1)
      : 0;
    
    console.log(`📈 Total closed: ${stats.total_closed}`);
    console.log(`✅ Wins: ${stats.wins} | ❌ Losses: ${stats.losses}`);
    console.log(`📊 Win Rate: ${winRate}%`);
    console.log(`💰 Total PnL: ${Number(stats.total_pnl || 0).toFixed(2)} USDT`);
    console.log(`📈 Avg Win: ${Number(stats.avg_win || 0).toFixed(2)} USDT`);
    console.log(`📉 Avg Loss: ${Number(stats.avg_loss || 0).toFixed(2)} USDT`);
    console.log(`🔴 Max Loss: ${Number(stats.max_loss || 0).toFixed(2)} USDT`);
    console.log(`🟢 Max Win: ${Number(stats.max_win || 0).toFixed(2)} USDT`);

    // 5. Kiểm tra close reasons
    console.log('\n📊 5. CLOSE REASONS ANALYSIS');
    console.log('-'.repeat(40));
    
    const [closeReasons] = await pool.execute(`
      SELECT 
        close_reason,
        COUNT(*) as count,
        SUM(pnl) as total_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
      FROM positions 
      WHERE status = 'closed' 
        AND closed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY close_reason
      ORDER BY count DESC
      LIMIT 10
    `);
    
    for (const reason of closeReasons) {
      const reasonWinRate = reason.count > 0 
        ? ((reason.wins / reason.count) * 100).toFixed(1)
        : 0;
      const status = Number(reason.total_pnl) >= 0 ? '✅' : '❌';
      console.log(
        `${status} ${reason.close_reason}: ${reason.count} trades, ` +
        `WR=${reasonWinRate}%, PnL=${Number(reason.total_pnl || 0).toFixed(2)}`
      );
    }

    // 6. Config check
    console.log('\n📊 6. CONFIG CHECK');
    console.log('-'.repeat(40));
    
    const configChecks = [
      { key: 'SOFTWARE_SL_ENABLED', expected: true, critical: true },
      { key: 'IMMEDIATE_TPSL_ENABLED', expected: true, critical: true },
      { key: 'ADV_TPSL_TRAILING_ENABLED', expected: true, critical: false },
      { key: 'ADV_TPSL_BREAK_EVEN_ENABLED', expected: true, critical: false },
      { key: 'VOLATILITY_FILTER_ENABLED', expected: true, critical: false },
      { key: 'VOLUME_VMA_GATE_ENABLED', expected: true, critical: false },
      { key: 'PULLBACK_CONFIRMATION_ENABLED', expected: true, critical: false },
      { key: 'MARKET_REGIME_FILTER_ENABLED', expected: true, critical: false },
      { key: 'FUNDING_RATE_FILTER_ENABLED', expected: true, critical: false },
    ];
    
    for (const check of configChecks) {
      const value = configService.getBoolean(check.key, false);
      const status = value === check.expected ? '✅' : (check.critical ? '🔴' : '⚠️');
      const label = check.critical ? '[CRITICAL]' : '[OPTIONAL]';
      console.log(`${status} ${label} ${check.key}: ${value} (expected: ${check.expected})`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📋 SUMMARY & RECOMMENDATIONS');
    console.log('='.repeat(60));
    
    const issues = [];
    
    if (strategiesWithoutSL[0].count > 0) {
      issues.push('❌ Strategies không có stoploss - FIX NGAY!');
    }
    
    if (Number(slCoverage) < 100) {
      issues.push(`❌ SL Coverage chỉ ${slCoverage}% - Đây là nguyên nhân chính gây lỗ sâu!`);
    }
    
    if (Number(tpCoverage) < 100) {
      issues.push(`⚠️ TP Coverage chỉ ${tpCoverage}%`);
    }
    
    if (Number(winRate) < 50) {
      issues.push(`⚠️ Win Rate thấp (${winRate}%) - Cần cải thiện entry filters`);
    }
    
    if (issues.length === 0) {
      console.log('\n✅ Không phát hiện vấn đề nghiêm trọng!');
    } else {
      console.log('\n🔴 CÁC VẤN ĐỀ CẦN FIX:');
      issues.forEach((issue, i) => console.log(`   ${i + 1}. ${issue}`));
    }
    
    console.log('\n📖 Xem chi tiết hướng dẫn tại: PROFIT_IMPROVEMENT_GUIDE.md');
    console.log('\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
