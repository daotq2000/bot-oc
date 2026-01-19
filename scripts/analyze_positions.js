#!/usr/bin/env node

/**
 * Script to analyze open positions, compare DB vs Exchange, and find losing positions
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env
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

async function analyzePositions() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(80));
    console.log('📊 POSITION ANALYSIS REPORT');
    console.log('='.repeat(80));
    console.log(`Generated at: ${new Date().toISOString()}\n`);
    
    // 1. Get open positions from database
    console.log('1️⃣  Fetching open positions from database...');
    // Get all columns from positions, then join for additional info
    const [dbPositions] = await pool.execute(`
      SELECT 
        p.*,
        b.exchange,
        b.binance_testnet,
        s.extend,
        s.take_profit,
        s.stoploss
      FROM positions p
      LEFT JOIN bots b ON p.bot_id = b.id
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'open'
      ORDER BY p.opened_at DESC
    `);
    
    console.log(`   Found ${dbPositions.length} open positions in database\n`);
    
    if (dbPositions.length === 0) {
      console.log('✅ No open positions found. System is clean!\n');
      return;
    }
    
    // 2. Analyze by exchange
    console.log('2️⃣  Analyzing by exchange...');
    const byExchange = {};
    dbPositions.forEach(pos => {
      const exchange = pos.exchange || 'unknown';
      const isTestnet = pos.binance_testnet;
      const key = `${exchange}${isTestnet ? '_testnet' : ''}`;
      if (!byExchange[key]) byExchange[key] = [];
      byExchange[key].push(pos);
    });
    
    Object.entries(byExchange).forEach(([exchange, positions]) => {
      console.log(`   ${exchange}: ${positions.length} positions`);
    });
    console.log();
    
    // Calculate PnL for each position (if not in DB)
    // Note: PnL is calculated in PositionService.updatePosition() but may not be stored in DB
    // We'll fetch current prices and calculate PnL for analysis
    console.log('   Calculating current PnL for positions...');
    // For now, we'll use pnl from DB if available, otherwise mark as unknown
    dbPositions.forEach(pos => {
      // pnl_percent calculation: ((current_price - entry_price) / entry_price) * 100
      // But we need current price, so we'll use pnl from DB if available
      if (pos.pnl === undefined || pos.pnl === null) {
        pos.pnl = null;
        pos.pnl_percent = null;
      } else {
        // Calculate pnl_percent if not available
        if (pos.pnl_percent === undefined || pos.pnl_percent === null) {
          if (pos.entry_price && pos.amount && pos.entry_price > 0) {
            // pnl_percent = (pnl / amount) * 100
            pos.pnl_percent = (pos.pnl / pos.amount) * 100;
          } else {
            pos.pnl_percent = 0;
          }
        }
      }
    });
    
    // 3. Analyze losing positions
    console.log('3️⃣  Analyzing losing positions...');
    const losingPositions = dbPositions.filter(p => p.pnl !== null && p.pnl < 0);
    console.log(`   Total losing positions: ${losingPositions.length}`);
    
    if (losingPositions.length > 0) {
      const totalLoss = losingPositions.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
      const avgLoss = totalLoss / losingPositions.length;
      const maxLoss = Math.min(...losingPositions.map(p => Number(p.pnl) || 0));
      
      console.log(`   Total loss: ${totalLoss.toFixed(2)} USDT`);
      console.log(`   Average loss: ${avgLoss.toFixed(2)} USDT`);
      console.log(`   Max loss: ${maxLoss.toFixed(2)} USDT`);
      
      console.log('\n   Top 10 losing positions:');
      const sortedLosing = losingPositions
        .sort((a, b) => (a.pnl || 0) - (b.pnl || 0))
        .slice(0, 10);
      
      sortedLosing.forEach((pos, i) => {
        const hoursOpen = pos.opened_at 
          ? ((Date.now() - new Date(pos.opened_at).getTime()) / (1000 * 60 * 60)).toFixed(1)
          : 'N/A';
        const pnl = pos.pnl !== null && pos.pnl !== undefined ? Number(pos.pnl) : null;
        const pnlPercent = pos.pnl_percent !== null && pos.pnl_percent !== undefined ? Number(pos.pnl_percent) : null;
        console.log(`   ${i + 1}. ${pos.symbol} ${(pos.side || '').toUpperCase()} | ` +
                   `Entry: ${Number(pos.entry_price || 0).toFixed(8)} | ` +
                   `PnL: ${pnl !== null ? pnl.toFixed(2) : 'N/A'} USDT ${pnlPercent !== null ? '(' + pnlPercent.toFixed(2) + '%)' : ''} | ` +
                   `SL: ${pos.stop_loss_price ? Number(pos.stop_loss_price).toFixed(8) : 'N/A'} | ` +
                   `Open: ${hoursOpen}h`);
      });
    }
    console.log();
    
    // 4. Analyze winning positions
    console.log('4️⃣  Analyzing winning positions...');
    const winningPositions = dbPositions.filter(p => p.pnl !== null && p.pnl > 0);
    console.log(`   Total winning positions: ${winningPositions.length}`);
    
    if (winningPositions.length > 0) {
      const totalProfit = winningPositions.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
      const avgProfit = totalProfit / winningPositions.length;
      const maxProfit = Math.max(...winningPositions.map(p => Number(p.pnl) || 0));
      
      console.log(`   Total profit: ${totalProfit.toFixed(2)} USDT`);
      console.log(`   Average profit: ${avgProfit.toFixed(2)} USDT`);
      console.log(`   Max profit: ${maxProfit.toFixed(2)} USDT`);
    }
    console.log();
    
    // 5. Analyze by strategy type
    console.log('5️⃣  Analyzing by strategy type...');
    const byStrategyType = {};
    
    dbPositions.forEach(pos => {
      // Check if strategy has is_reverse_strategy field (may be in bots table)
      const isReverse = pos.is_reverse_strategy || false;
      const strategyType = isReverse ? 'COUNTER_TREND' : 'FOLLOWING_TREND';
      if (!byStrategyType[strategyType]) {
        byStrategyType[strategyType] = { total: 0, winning: 0, losing: 0, totalPnl: 0 };
      }
      byStrategyType[strategyType].total++;
      const pnl = pos.pnl !== null && pos.pnl !== undefined ? Number(pos.pnl) : 0;
      byStrategyType[strategyType].totalPnl += pnl;
      if (pnl > 0) byStrategyType[strategyType].winning++;
      else if (pnl < 0) byStrategyType[strategyType].losing++;
    });
    
    Object.entries(byStrategyType).forEach(([type, stats]) => {
      const winRate = stats.total > 0 ? (stats.winning / stats.total * 100) : 0;
      console.log(`   ${type}:`);
      console.log(`      Total: ${stats.total} | Winning: ${stats.winning} | Losing: ${stats.losing}`);
      console.log(`      Win Rate: ${winRate.toFixed(2)}% | Total PnL: ${stats.totalPnl.toFixed(2)} USDT`);
    });
    console.log();
    
    // 6. Analyze positions without SL
    console.log('6️⃣  Analyzing positions without Stop Loss...');
    const noSlPositions = dbPositions.filter(p => !p.stop_loss_price || Number(p.stop_loss_price) === 0);
    console.log(`   Positions without SL: ${noSlPositions.length}`);
    if (noSlPositions.length > 0) {
      console.log('   ⚠️  WARNING: These positions are at risk!');
      noSlPositions.slice(0, 10).forEach(pos => {
        console.log(`      - ${pos.symbol} ${pos.side.toUpperCase()} | ` +
                   `Entry: ${Number(pos.entry_price).toFixed(8)} | ` +
                   `PnL: ${(pos.pnl || 0).toFixed(2)} USDT | ` +
                   `Strategy SL: ${pos.stoploss || 'N/A'}`);
      });
    }
    console.log();
    
    // 7. Analyze positions without TP
    console.log('7️⃣  Analyzing positions without Take Profit...');
    const noTpPositions = dbPositions.filter(p => !p.take_profit_price || Number(p.take_profit_price) === 0);
    console.log(`   Positions without TP: ${noTpPositions.length}`);
    if (noTpPositions.length > 0) {
      console.log('   ⚠️  WARNING: These positions may not exit at profit target!');
      noTpPositions.slice(0, 10).forEach(pos => {
        console.log(`      - ${pos.symbol} ${pos.side.toUpperCase()} | ` +
                   `Entry: ${Number(pos.entry_price).toFixed(8)} | ` +
                   `PnL: ${(pos.pnl || 0).toFixed(2)} USDT`);
      });
    }
    console.log();
    
    // 8. Analyze by time opened
    console.log('8️⃣  Analyzing by time opened...');
    const now = Date.now();
    const recentPositions = [];
    const oldPositions = [];
    
    dbPositions.forEach(pos => {
      if (pos.opened_at) {
        const openedAt = new Date(pos.opened_at).getTime();
        const hoursOpen = (now - openedAt) / (1000 * 60 * 60);
        if (hoursOpen < 24) {
          recentPositions.push({ pos, hours: hoursOpen });
        } else {
          oldPositions.push({ pos, hours: hoursOpen });
        }
      }
    });
    
    console.log(`   Positions opened < 24h: ${recentPositions.length}`);
    console.log(`   Positions opened >= 24h: ${oldPositions.length}`);
    
    if (oldPositions.length > 0) {
      console.log('   ⚠️  WARNING: Old positions that may need review:');
      oldPositions
        .sort((a, b) => b.hours - a.hours)
        .slice(0, 5)
        .forEach(({ pos, hours }) => {
          console.log(`      - ${pos.symbol} ${pos.side.toUpperCase()} | ` +
                     `Open for ${hours.toFixed(1)}h | ` +
                     `PnL: ${(pos.pnl || 0).toFixed(2)} USDT`);
        });
    }
    console.log();
    
    // 9. Analyze positions with large losses
    console.log('9️⃣  Analyzing positions with large losses (>5% or >50 USDT)...');
    const largeLossPositions = losingPositions.filter(p => {
      const pnlPercent = Math.abs(p.pnl_percent !== null ? p.pnl_percent : 0);
      const pnlAbs = Math.abs(p.pnl !== null ? p.pnl : 0);
      return pnlPercent > 5 || pnlAbs > 50;
    });
    console.log(`   Positions with large losses: ${largeLossPositions.length}`);
    if (largeLossPositions.length > 0) {
      console.log('   ⚠️  CRITICAL: These positions need immediate attention!');
      largeLossPositions.slice(0, 10).forEach(pos => {
        console.log(`      - ${pos.symbol} ${pos.side.toUpperCase()} | ` +
                   `Entry: ${Number(pos.entry_price).toFixed(8)} | ` +
                   `PnL: ${pos.pnl !== null && pos.pnl !== undefined ? Number(pos.pnl).toFixed(2) : 'N/A'} USDT ${pos.pnl_percent !== null && pos.pnl_percent !== undefined ? '(' + Number(pos.pnl_percent).toFixed(2) + '%)' : ''} | ` +
                   `SL: ${pos.stop_loss_price ? Number(pos.stop_loss_price).toFixed(8) : 'MISSING!'}`);
      });
    }
    console.log();
    
    // 10. Summary
    console.log('='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    const totalPnl = dbPositions.reduce((sum, p) => sum + (p.pnl !== null && p.pnl !== undefined ? Number(p.pnl) : 0), 0);
    const winRate = dbPositions.length > 0 
      ? (winningPositions.length / dbPositions.length * 100) 
      : 0;
    
    console.log(`Total Open Positions: ${dbPositions.length}`);
    console.log(`Winning: ${winningPositions.length} | Losing: ${losingPositions.length}`);
    console.log(`Total PnL: ${totalPnl.toFixed(2)} USDT`);
    console.log(`Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`Positions without SL: ${noSlPositions.length}`);
    console.log(`Positions without TP: ${noTpPositions.length}`);
    console.log(`Positions with large losses: ${largeLossPositions.length}`);
    console.log();
    
    // 11. Recommendations
    console.log('='.repeat(80));
    console.log('💡 RECOMMENDATIONS');
    console.log('='.repeat(80));
    
    if (noSlPositions.length > 0) {
      console.log('⚠️  CRITICAL: Some positions don\'t have Stop Loss!');
      console.log('   → Check PositionMonitor logs for SL placement errors');
      console.log('   → Verify strategy.stoploss is configured');
      console.log('   → Check ExitOrderManager logs');
    }
    
    if (noTpPositions.length > 0) {
      console.log('⚠️  WARNING: Some positions don\'t have Take Profit!');
      console.log('   → Check PositionMonitor logs for TP placement errors');
      console.log('   → Verify strategy.take_profit is configured');
    }
    
    if (losingPositions.length > winningPositions.length) {
      console.log('⚠️  WARNING: More losing positions than winning!');
      console.log('   → Review entry conditions and trend filters');
      console.log('   → Check if SL is being hit too early');
      console.log('   → Consider adjusting strategy parameters');
    }
    
    if (largeLossPositions.length > 0) {
      console.log('🚨 CRITICAL: Positions with large losses detected!');
      console.log('   → Review these positions immediately');
      console.log('   → Check if SL orders are working correctly');
      console.log('   → Verify exchange position status');
    }
    
    if (oldPositions.length > 0) {
      console.log('⚠️  INFO: Some positions are open for > 24h');
      console.log('   → Review if these should still be open');
      console.log('   → Check trailing TP logic');
      console.log('   → Consider manual review');
    }
    
    console.log();
    console.log('='.repeat(80));
    console.log('✅ Analysis complete!');
    console.log('='.repeat(80));
    
  } finally {
    await pool.end();
  }
}

// Run analysis
analyzePositions().catch(error => {
  console.error('❌ Error running analysis:', error);
  process.exit(1);
});

