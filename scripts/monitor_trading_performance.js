#!/usr/bin/env node

/**
 * Trading Performance Monitor
 * Real-time monitoring of bot trading activity and filter effectiveness
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'rootpassword',
  database: process.env.DB_NAME || 'bot_oc_xuoi'
};

async function getOpenPositions(pool) {
  const [rows] = await pool.execute(`
    SELECT 
      p.id, p.symbol, p.side, p.amount, p.entry_price,
      p.exit_order_id, p.sl_order_id, p.take_profit_price, p.stop_loss_price,
      p.opened_at, p.bot_id,
      TIMESTAMPDIFF(SECOND, p.opened_at, NOW()) as age_seconds,
      b.bot_name
    FROM positions p
    LEFT JOIN bots b ON p.bot_id = b.id
    WHERE p.status = 'open'
    ORDER BY p.opened_at DESC
    LIMIT 50
  `);
  return rows;
}

async function getPositionStats(pool) {
  const [rows] = await pool.execute(`
    SELECT 
      COUNT(*) as total_open,
      COUNT(CASE WHEN exit_order_id IS NOT NULL THEN 1 END) as has_tp,
      COUNT(CASE WHEN sl_order_id IS NOT NULL THEN 1 END) as has_sl,
      COUNT(CASE WHEN exit_order_id IS NOT NULL AND sl_order_id IS NOT NULL THEN 1 END) as has_both,
      COUNT(CASE WHEN exit_order_id IS NULL THEN 1 END) as missing_tp,
      COUNT(CASE WHEN TIMESTAMPDIFF(SECOND, opened_at, NOW()) > 10 AND exit_order_id IS NULL THEN 1 END) as emergency_no_tp,
      ROUND(SUM(amount), 2) as total_notional,
      COUNT(CASE WHEN side = 'long' THEN 1 END) as longs,
      COUNT(CASE WHEN side = 'short' THEN 1 END) as shorts
    FROM positions WHERE status = 'open'
  `);
  return rows[0];
}

async function getTodayPnL(pool) {
  const [rows] = await pool.execute(`
    SELECT 
      COUNT(*) as total_closed,
      COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins,
      COUNT(CASE WHEN pnl <= 0 THEN 1 END) as losses,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(AVG(pnl), 2) as avg_pnl,
      ROUND(AVG(CASE WHEN pnl > 0 THEN pnl END), 2) as avg_win,
      ROUND(AVG(CASE WHEN pnl <= 0 THEN pnl END), 2) as avg_loss,
      GROUP_CONCAT(DISTINCT close_reason) as close_reasons
    FROM positions 
    WHERE status = 'closed' AND closed_at >= CURDATE()
  `);
  return rows[0];
}

async function getRecentSignals(pool, minutes = 30) {
  const [rows] = await pool.execute(`
    SELECT 
      DATE_FORMAT(opened_at, '%Y-%m-%d %H:%i') as minute,
      COUNT(*) as signals,
      COUNT(CASE WHEN side = 'long' THEN 1 END) as longs,
      COUNT(CASE WHEN side = 'short' THEN 1 END) as shorts
    FROM positions 
    WHERE opened_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
    GROUP BY minute
    ORDER BY minute DESC
    LIMIT 10
  `, [minutes]);
  return rows;
}

async function getPositionsByBot(pool) {
  const [rows] = await pool.execute(`
    SELECT 
      b.bot_name,
      p.bot_id,
      COUNT(*) as open_positions,
      COUNT(CASE WHEN p.exit_order_id IS NOT NULL THEN 1 END) as has_tp,
      COUNT(CASE WHEN p.exit_order_id IS NULL THEN 1 END) as no_tp,
      ROUND(SUM(p.amount), 2) as total_notional
    FROM positions p
    LEFT JOIN bots b ON p.bot_id = b.id
    WHERE p.status = 'open'
    GROUP BY p.bot_id, b.bot_name
  `);
  return rows;
}

async function getCloseReasonBreakdown(pool) {
  const [rows] = await pool.execute(`
    SELECT 
      close_reason,
      COUNT(*) as count,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(AVG(pnl), 2) as avg_pnl
    FROM positions 
    WHERE status = 'closed' AND closed_at >= CURDATE()
    GROUP BY close_reason
    ORDER BY count DESC
  `);
  return rows;
}

function clearScreen() {
  process.stdout.write('\x1B[2J\x1B[0f');
}

function printSection(title, content) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(content);
}

async function runMonitor() {
  const pool = mysql.createPool(dbConfig);
  
  console.log('🚀 Starting Trading Performance Monitor...');
  console.log(`   Database: ${dbConfig.database}@${dbConfig.host}`);
  console.log('   Press Ctrl+C to exit\n');
  
  const interval = Number(process.argv[2]) || 10; // Default 10 seconds
  
  while (true) {
    try {
      clearScreen();
      
      const now = new Date().toISOString().replace('T', ' ').split('.')[0];
      console.log(`\n📊 TRADING PERFORMANCE MONITOR - ${now}`);
      console.log(`   Refresh: ${interval}s`);

      // Position Stats
      const stats = await getPositionStats(pool);
      printSection('📈 OPEN POSITIONS OVERVIEW', `
  Total Open:      ${stats.total_open}
  With TP Order:   ${stats.has_tp} (${((stats.has_tp/stats.total_open)*100 || 0).toFixed(1)}%)
  With SL Order:   ${stats.has_sl} (${((stats.has_sl/stats.total_open)*100 || 0).toFixed(1)}%)
  Missing TP:      ${stats.missing_tp} ⚠️
  Emergency (>10s): ${stats.emergency_no_tp} 🚨
  Total Notional:  $${stats.total_notional || 0}
  Long/Short:      ${stats.longs}/${stats.shorts}
`);

      // By Bot
      const byBot = await getPositionsByBot(pool);
      let botTable = '  Bot Name              | Open | TP | No TP | Notional\n';
      botTable += '  ' + '-'.repeat(55) + '\n';
      for (const bot of byBot) {
        botTable += `  ${(bot.bot_name || 'N/A').padEnd(20)} | ${String(bot.open_positions).padStart(4)} | ${String(bot.has_tp).padStart(2)} | ${String(bot.no_tp).padStart(5)} | $${bot.total_notional}\n`;
      }
      printSection('🤖 POSITIONS BY BOT', botTable);

      // Today's PnL
      const pnl = await getTodayPnL(pool);
      const winRate = pnl.total_closed > 0 ? ((pnl.wins / pnl.total_closed) * 100).toFixed(1) : 0;
      printSection('💰 TODAY\'S PERFORMANCE', `
  Total Closed:    ${pnl.total_closed || 0}
  Wins/Losses:     ${pnl.wins || 0}/${pnl.losses || 0}
  Win Rate:        ${winRate}%
  Total PnL:       $${pnl.total_pnl || 0} ${pnl.total_pnl > 0 ? '✅' : pnl.total_pnl < 0 ? '❌' : ''}
  Avg PnL/Trade:   $${pnl.avg_pnl || 0}
  Avg Win:         $${pnl.avg_win || 0}
  Avg Loss:        $${pnl.avg_loss || 0}
`);

      // Close Reasons
      const reasons = await getCloseReasonBreakdown(pool);
      if (reasons.length > 0) {
        let reasonTable = '  Reason                        | Count | Total PnL | Avg PnL\n';
        reasonTable += '  ' + '-'.repeat(60) + '\n';
        for (const r of reasons) {
          reasonTable += `  ${(r.close_reason || 'N/A').padEnd(30)} | ${String(r.count).padStart(5)} | $${String(r.total_pnl).padStart(8)} | $${r.avg_pnl}\n`;
        }
        printSection('📋 CLOSE REASONS TODAY', reasonTable);
      }

      // Recent Signals
      const signals = await getRecentSignals(pool, 30);
      if (signals.length > 0) {
        let signalTable = '  Time            | Signals | Long | Short\n';
        signalTable += '  ' + '-'.repeat(45) + '\n';
        for (const s of signals) {
          signalTable += `  ${s.minute}   | ${String(s.signals).padStart(7)} | ${String(s.longs).padStart(4)} | ${String(s.shorts).padStart(5)}\n`;
        }
        printSection('📡 RECENT SIGNALS (30 min)', signalTable);
      }

      // Sample of open positions
      const openPositions = await getOpenPositions(pool);
      if (openPositions.length > 0) {
        let posTable = '  ID  | Symbol      | Side  | Age(s) | TP Order   | Notional\n';
        posTable += '  ' + '-'.repeat(60) + '\n';
        for (const p of openPositions.slice(0, 10)) {
          const tpStatus = p.exit_order_id ? '✅' : (p.age_seconds > 10 ? '🚨' : '⏳');
          posTable += `  ${String(p.id).padStart(3)} | ${p.symbol.padEnd(11)} | ${p.side.padEnd(5)} | ${String(p.age_seconds).padStart(6)} | ${tpStatus} ${p.exit_order_id ? String(p.exit_order_id).slice(-6) : 'NULL'.padEnd(6)} | $${Number(p.amount).toFixed(2)}\n`;
        }
        printSection('📋 RECENT POSITIONS (newest 10)', posTable);
      }

      // Wait before next refresh
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
      
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

runMonitor().catch(console.error);
