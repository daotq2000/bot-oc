#!/usr/bin/env node

/**
 * PNL Analysis and Improvement Script
 * 
 * This script analyzes:
 * 1. Current PNL of all bots
 * 2. Open and closed positions
 * 3. Sync issues that cause losses
 * 4. Strategies without proper SL
 * 5. Win rate by close reason
 * 
 * And provides recommendations for improvement
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

async function analyzePNL() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(100));
    console.log('📊 COMPREHENSIVE PNL ANALYSIS AND IMPROVEMENT RECOMMENDATIONS');
    console.log('='.repeat(100));
    console.log(`Generated at: ${new Date().toISOString()}\n`);

    // ============================================
    // SECTION 1: OVERALL PNL SUMMARY
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📈 SECTION 1: OVERALL PNL SUMMARY');
    console.log('━'.repeat(80));

    const [overallStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_positions,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_positions,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_positions,
        SUM(CASE WHEN status = 'closed' THEN COALESCE(pnl, 0) ELSE 0 END) as realized_pnl,
        SUM(CASE WHEN status = 'open' THEN COALESCE(pnl, 0) ELSE 0 END) as unrealized_pnl,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) > 0 THEN 1 ELSE 0 END) as winning_closed,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) <= 0 THEN 1 ELSE 0 END) as losing_closed,
        AVG(CASE WHEN status = 'closed' THEN COALESCE(pnl, 0) END) as avg_pnl_closed,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) > 0 THEN COALESCE(pnl, 0) ELSE 0 END) as total_profit,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) < 0 THEN ABS(COALESCE(pnl, 0)) ELSE 0 END) as total_loss
      FROM positions
    `);

    const stats = overallStats[0];
    const winRate = stats.closed_positions > 0 
      ? (stats.winning_closed / stats.closed_positions * 100).toFixed(2) 
      : 0;
    const profitFactor = stats.total_loss > 0 
      ? (stats.total_profit / stats.total_loss).toFixed(2) 
      : 'N/A';

    console.log(`
📊 OVERALL STATISTICS:
┌────────────────────────────────────────────────────────────┐
│ Total Positions:     ${String(stats.total_positions).padStart(10)}                           │
│ Open Positions:      ${String(stats.open_positions).padStart(10)}                           │
│ Closed Positions:    ${String(stats.closed_positions).padStart(10)}                           │
├────────────────────────────────────────────────────────────┤
│ Realized PNL:        ${String(Number(stats.realized_pnl || 0).toFixed(2) + ' USDT').padStart(15)}                      │
│ Unrealized PNL:      ${String(Number(stats.unrealized_pnl || 0).toFixed(2) + ' USDT').padStart(15)}                      │
├────────────────────────────────────────────────────────────┤
│ Winning Positions:   ${String(stats.winning_closed).padStart(10)}                           │
│ Losing Positions:    ${String(stats.losing_closed).padStart(10)}                           │
│ Win Rate:            ${String(winRate + '%').padStart(10)}                           │
│ Profit Factor:       ${String(profitFactor).padStart(10)}                           │
│ Avg PNL per Trade:   ${String(Number(stats.avg_pnl_closed || 0).toFixed(2) + ' USDT').padStart(15)}                      │
└────────────────────────────────────────────────────────────┘
`);

    // ============================================
    // SECTION 2: PNL BY BOT
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🤖 SECTION 2: PNL BY BOT');
    console.log('━'.repeat(80));

    const [pnlByBot] = await pool.execute(`
      SELECT 
        b.id as bot_id,
        b.bot_name,
        b.exchange,
        COUNT(p.id) as total_positions,
        SUM(CASE WHEN p.status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN p.status = 'closed' THEN 1 ELSE 0 END) as closed_count,
        SUM(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE 0 END) as realized_pnl,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) <= 0 THEN 1 ELSE 0 END) as losses
      FROM bots b
      LEFT JOIN strategies s ON b.id = s.bot_id
      LEFT JOIN positions p ON s.id = p.strategy_id
      GROUP BY b.id, b.bot_name, b.exchange
      ORDER BY realized_pnl DESC
    `);

    console.log('\n📊 PNL by Bot:\n');
    console.log('┌──────┬─────────────────────┬──────────┬──────────┬──────────┬────────────────┬──────────┐');
    console.log('│ ID   │ Bot Name            │ Exchange │ Open     │ Closed   │ Realized PNL   │ Win Rate │');
    console.log('├──────┼─────────────────────┼──────────┼──────────┼──────────┼────────────────┼──────────┤');
    
    for (const bot of pnlByBot) {
      const winRate = bot.closed_count > 0 ? (bot.wins / bot.closed_count * 100).toFixed(1) : 'N/A';
      console.log(
        `│ ${String(bot.bot_id).padEnd(4)} │ ${String(bot.bot_name || 'N/A').slice(0, 19).padEnd(19)} │ ${String(bot.exchange || 'N/A').slice(0, 8).padEnd(8)} │ ` +
        `${String(bot.open_count).padStart(8)} │ ${String(bot.closed_count).padStart(8)} │ ` +
        `${String(Number(bot.realized_pnl || 0).toFixed(2)).padStart(12)} │ ${String(winRate + '%').padStart(8)} │`
      );
    }
    console.log('└──────┴─────────────────────┴──────────┴──────────┴──────────┴────────────────┴──────────┘');

    // ============================================
    // SECTION 3: PNL BY CLOSE REASON (Critical!)
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🔴 SECTION 3: PNL BY CLOSE REASON (CRITICAL FOR IMPROVEMENT)');
    console.log('━'.repeat(80));

    const [pnlByCloseReason] = await pool.execute(`
      SELECT 
        COALESCE(close_reason, 'unknown') as close_reason,
        COUNT(*) as count,
        SUM(COALESCE(pnl, 0)) as total_pnl,
        AVG(COALESCE(pnl, 0)) as avg_pnl,
        SUM(CASE WHEN COALESCE(pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN COALESCE(pnl, 0) <= 0 THEN 1 ELSE 0 END) as losses
      FROM positions
      WHERE status = 'closed'
      GROUP BY close_reason
      ORDER BY count DESC
    `);

    console.log('\n⚠️  CLOSE REASON ANALYSIS (Key to improving PNL):\n');
    console.log('┌───────────────────────────────┬──────────┬────────────────┬────────────────┬──────────┐');
    console.log('│ Close Reason                  │ Count    │ Total PNL      │ Avg PNL        │ Win Rate │');
    console.log('├───────────────────────────────┼──────────┼────────────────┼────────────────┼──────────┤');
    
    let syncIssuesCount = 0;
    let syncIssuesPnl = 0;
    let goodCloseCount = 0;
    let goodClosePnl = 0;
    
    for (const reason of pnlByCloseReason) {
      const winRate = reason.count > 0 ? (reason.wins / reason.count * 100).toFixed(1) : 'N/A';
      const reasonName = reason.close_reason || 'unknown';
      
      // Track sync issues vs good closes
      if (reasonName.includes('sync') || reasonName.includes('exchange_empty') || reasonName.includes('unknown')) {
        syncIssuesCount += Number(reason.count);
        syncIssuesPnl += Number(reason.total_pnl || 0);
      } else if (reasonName.includes('tp_hit') || reasonName.includes('sl_hit') || reasonName.includes('target_pnl')) {
        goodCloseCount += Number(reason.count);
        goodClosePnl += Number(reason.total_pnl || 0);
      }
      
      console.log(
        `│ ${String(reasonName).slice(0, 29).padEnd(29)} │ ${String(reason.count).padStart(8)} │ ` +
        `${String(Number(reason.total_pnl || 0).toFixed(2)).padStart(14)} │ ` +
        `${String(Number(reason.avg_pnl || 0).toFixed(2)).padStart(14)} │ ${String(winRate + '%').padStart(8)} │`
      );
    }
    console.log('└───────────────────────────────┴──────────┴────────────────┴────────────────┴──────────┘');

    const totalClosed = stats.closed_positions || 1;
    const syncIssuesPct = ((syncIssuesCount / totalClosed) * 100).toFixed(1);
    const goodClosePct = ((goodCloseCount / totalClosed) * 100).toFixed(1);

    console.log(`
🚨 SYNC ISSUES IMPACT:
   • Positions closed due to sync issues: ${syncIssuesCount} (${syncIssuesPct}% of all closed)
   • PNL from sync issues: ${syncIssuesPnl.toFixed(2)} USDT
   
✅ GOOD CLOSES (TP/SL hit):
   • Positions closed properly (TP/SL): ${goodCloseCount} (${goodClosePct}% of all closed)
   • PNL from good closes: ${goodClosePnl.toFixed(2)} USDT
`);

    // ============================================
    // SECTION 4: STRATEGIES WITHOUT SL
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('⚠️  SECTION 4: STRATEGIES WITHOUT PROPER SL (HIGH RISK)');
    console.log('━'.repeat(80));

    const [strategiesWithoutSL] = await pool.execute(`
      SELECT 
        s.id,
        s.symbol,
        s.bot_id,
        b.bot_name,
        s.stoploss,
        s.take_profit,
        COUNT(p.id) as position_count,
        SUM(CASE WHEN p.status = 'open' THEN 1 ELSE 0 END) as open_positions,
        SUM(CASE WHEN p.pnl < 0 THEN COALESCE(p.pnl, 0) ELSE 0 END) as total_loss
      FROM strategies s
      LEFT JOIN bots b ON s.bot_id = b.id
      LEFT JOIN positions p ON s.id = p.strategy_id
      WHERE (s.stoploss IS NULL OR s.stoploss = 0 OR s.stoploss = '')
      GROUP BY s.id, s.symbol, s.bot_id, b.bot_name, s.stoploss, s.take_profit
      HAVING position_count > 0
      ORDER BY open_positions DESC, total_loss ASC
      LIMIT 30
    `);

    console.log(`\n⚠️  Found ${strategiesWithoutSL.length} strategies WITHOUT SL that have positions:\n`);
    
    if (strategiesWithoutSL.length > 0) {
      console.log('┌──────┬────────────────────┬──────────┬──────────┬──────────┬────────────────┐');
      console.log('│ ID   │ Symbol             │ Bot      │ Open Pos │ SL Value │ Total Loss     │');
      console.log('├──────┼────────────────────┼──────────┼──────────┼──────────┼────────────────┤');
      
      for (const s of strategiesWithoutSL) {
        console.log(
          `│ ${String(s.id).padEnd(4)} │ ${String(s.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(s.bot_name || s.bot_id).slice(0, 8).padEnd(8)} │ ${String(s.open_positions).padStart(8)} │ ` +
          `${String(s.stoploss || 'NULL').slice(0, 8).padEnd(8)} │ ${String(Number(s.total_loss || 0).toFixed(2)).padStart(14)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────────┴──────────┴──────────┴────────────────┘');
    }

    // ============================================
    // SECTION 5: OPEN POSITIONS AT RISK
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🔥 SECTION 5: OPEN POSITIONS AT RISK (NEED IMMEDIATE ATTENTION)');
    console.log('━'.repeat(80));

    const [positionsAtRisk] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.amount,
        p.pnl,
        p.stop_loss_price,
        p.sl_order_id,
        p.exit_order_id,
        s.stoploss as strategy_sl,
        s.take_profit as strategy_tp,
        TIMESTAMPDIFF(HOUR, p.opened_at, NOW()) as hours_open
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'open'
        AND (
          (p.stop_loss_price IS NULL OR p.stop_loss_price = 0)
          OR (p.sl_order_id IS NULL OR p.sl_order_id = '')
          OR COALESCE(p.pnl, 0) < -20
        )
      ORDER BY COALESCE(p.pnl, 0) ASC
      LIMIT 30
    `);

    console.log(`\n🔥 Found ${positionsAtRisk.length} positions at risk:\n`);
    
    if (positionsAtRisk.length > 0) {
      console.log('┌──────┬────────────────────┬──────┬────────────────┬────────────────┬────────┬──────────────┐');
      console.log('│ ID   │ Symbol             │ Side │ Entry Price    │ PNL            │ Hours  │ Risk Issue   │');
      console.log('├──────┼────────────────────┼──────┼────────────────┼────────────────┼────────┼──────────────┤');
      
      for (const pos of positionsAtRisk) {
        let riskIssue = '';
        if (!pos.sl_order_id) riskIssue = 'NO SL ORDER';
        else if (!pos.stop_loss_price) riskIssue = 'NO SL PRICE';
        else if (pos.pnl < -20) riskIssue = 'HIGH LOSS';
        
        console.log(
          `│ ${String(pos.id).padEnd(4)} │ ${String(pos.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(pos.side).slice(0, 4).padEnd(4)} │ ${String(Number(pos.entry_price || 0).toFixed(6)).padStart(14)} │ ` +
          `${String(Number(pos.pnl || 0).toFixed(2)).padStart(14)} │ ${String(pos.hours_open || 0).padStart(6)} │ ` +
          `${String(riskIssue).slice(0, 12).padEnd(12)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────┴────────────────┴────────────────┴────────┴──────────────┘');
    }

    // ============================================
    // SECTION 6: TOP WINNING & LOSING SYMBOLS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📊 SECTION 6: TOP WINNING & LOSING SYMBOLS');
    console.log('━'.repeat(80));

    const [topSymbols] = await pool.execute(`
      SELECT 
        p.symbol,
        COUNT(*) as total_trades,
        SUM(CASE WHEN COALESCE(p.pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN COALESCE(p.pnl, 0) <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(p.pnl, 0)) as total_pnl,
        AVG(COALESCE(p.pnl, 0)) as avg_pnl
      FROM positions p
      WHERE p.status = 'closed'
      GROUP BY p.symbol
      HAVING total_trades >= 3
      ORDER BY total_pnl DESC
      LIMIT 20
    `);

    console.log('\n🏆 TOP 20 SYMBOLS BY PNL (min 3 trades):\n');
    console.log('┌────────────────────┬──────────┬──────────┬──────────┬────────────────┬────────────────┐');
    console.log('│ Symbol             │ Trades   │ Wins     │ Losses   │ Total PNL      │ Win Rate       │');
    console.log('├────────────────────┼──────────┼──────────┼──────────┼────────────────┼────────────────┤');
    
    for (const sym of topSymbols) {
      const winRate = sym.total_trades > 0 ? (sym.wins / sym.total_trades * 100).toFixed(1) : 'N/A';
      const pnlColor = Number(sym.total_pnl) >= 0 ? '🟢' : '🔴';
      console.log(
        `│ ${String(sym.symbol).slice(0, 18).padEnd(18)} │ ${String(sym.total_trades).padStart(8)} │ ` +
        `${String(sym.wins).padStart(8)} │ ${String(sym.losses).padStart(8)} │ ` +
        `${pnlColor} ${String(Number(sym.total_pnl || 0).toFixed(2)).padStart(12)} │ ${String(winRate + '%').padStart(14)} │`
      );
    }
    console.log('└────────────────────┴──────────┴──────────┴──────────┴────────────────┴────────────────┘');

    // ============================================
    // SECTION 7: RECOMMENDATIONS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('💡 SECTION 7: IMPROVEMENT RECOMMENDATIONS');
    console.log('━'.repeat(80));

    const recommendations = [];
    
    // Sync issues
    if (Number(syncIssuesPct) > 20) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: `${syncIssuesPct}% positions closed due to sync issues`,
        action: 'Fix PositionSync to verify TP/SL orders before closing. Enable retry logic.',
        expectedImpact: 'Could recover significant PNL currently lost to sync errors'
      });
    }

    // Win rate
    if (Number(winRate) < 45) {
      recommendations.push({
        priority: 'HIGH',
        issue: `Low win rate: ${winRate}%`,
        action: 'Improve entry filters (RSI, volume, trend confirmation). Review TP/SL levels.',
        expectedImpact: 'Target win rate: 50%+'
      });
    }

    // Strategies without SL
    if (strategiesWithoutSL.length > 0) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: `${strategiesWithoutSL.length} strategies without SL have open positions`,
        action: 'Add SL to all strategies. Run fix_strategies_stoploss.js script.',
        expectedImpact: 'Reduce max drawdown and protect against large losses'
      });
    }

    // Positions at risk
    if (positionsAtRisk.length > 0) {
      recommendations.push({
        priority: 'HIGH',
        issue: `${positionsAtRisk.length} positions at risk (no SL or high loss)`,
        action: 'Immediately add SL orders or manually close high-loss positions.',
        expectedImpact: 'Prevent further losses on unprotected positions'
      });
    }

    // Profit factor
    if (profitFactor !== 'N/A' && Number(profitFactor) < 1.5) {
      recommendations.push({
        priority: 'MEDIUM',
        issue: `Low profit factor: ${profitFactor}`,
        action: 'Improve risk/reward ratio. Use ATR-based TP/SL. Implement trailing stop.',
        expectedImpact: 'Target profit factor: 2.0+'
      });
    }

    console.log('\n📋 PRIORITIZED RECOMMENDATIONS:\n');
    
    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const priorityIcon = rec.priority === 'CRITICAL' ? '🔴' : rec.priority === 'HIGH' ? '🟠' : '🟡';
      
      console.log(`${i + 1}. ${priorityIcon} [${rec.priority}] ${rec.issue}`);
      console.log(`   ➤ Action: ${rec.action}`);
      console.log(`   ➤ Expected Impact: ${rec.expectedImpact}`);
      console.log();
    }

    // ============================================
    // SECTION 8: QUICK FIX COMMANDS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🛠️  SECTION 8: QUICK FIX COMMANDS');
    console.log('━'.repeat(80));

    console.log(`
📝 SQL commands to fix common issues:

1. Add default SL to strategies without SL (5% loss limit):
   UPDATE strategies SET stoploss = 5 WHERE (stoploss IS NULL OR stoploss = 0);

2. Find positions older than 24h without movement:
   SELECT id, symbol, side, pnl, TIMESTAMPDIFF(HOUR, opened_at, NOW()) as hours
   FROM positions WHERE status = 'open' AND TIMESTAMPDIFF(HOUR, opened_at, NOW()) > 24
   ORDER BY hours DESC;

3. Close stale positions (use with caution):
   UPDATE positions SET status = 'closed', close_reason = 'stale_position', closed_at = NOW()
   WHERE status = 'open' AND TIMESTAMPDIFF(HOUR, opened_at, NOW()) > 72;

📝 Script commands:
   node scripts/fix_strategies_stoploss.js     # Add SL to all strategies
   node scripts/analyze_position_issues.js     # Deep analysis of position issues
   node scripts/check_missing_tp_orders.js     # Check missing TP orders
`);

    console.log('\n' + '='.repeat(100));
    console.log('📊 ANALYSIS COMPLETE');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await pool.end();
  }
}

// Run the analysis
analyzePNL().catch(console.error);
