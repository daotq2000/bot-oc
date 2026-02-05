#!/usr/bin/env node

/**
 * Strategy Optimization Script
 * 
 * This script analyzes strategies and provides recommendations:
 * 1. Identifies strategies with low win rate
 * 2. Identifies strategies without proper SL/TP
 * 3. Recommends optimal SL/TP levels based on historical data
 * 4. Can automatically update strategies with recommended settings
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

// Default optimal settings based on analysis
const OPTIMAL_SETTINGS = {
  DEFAULT_SL_PERCENTAGE: 5,      // 5% SL
  DEFAULT_TP_PERCENTAGE: 3,      // 3% TP (risk/reward 1.67:1)
  MIN_WIN_RATE: 40,              // Minimum acceptable win rate
  MIN_TRADES: 5,                 // Minimum trades to evaluate
  RECOMMENDED_REDUCE: 0.5,       // Trail TP by 0.5%
  RECOMMENDED_UP_REDUCE: 0.3,    // Move TP up by 0.3% when profitable
};

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

async function analyzeStrategies() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(100));
    console.log('📊 STRATEGY ANALYSIS AND OPTIMIZATION');
    console.log('='.repeat(100));
    console.log(`Generated at: ${new Date().toISOString()}\n`);

    // ============================================
    // SECTION 1: STRATEGY PERFORMANCE OVERVIEW
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📈 SECTION 1: STRATEGY PERFORMANCE OVERVIEW');
    console.log('━'.repeat(80));

    const [strategyPerformance] = await pool.execute(`
      SELECT 
        s.id,
        s.symbol,
        s.bot_id,
        b.bot_name,
        s.trade_type,
        s.stoploss,
        s.take_profit,
        s.reduce,
        s.up_reduce,
        s.\`interval\`,
        s.oc,
        s.is_active,
        COUNT(p.id) as total_trades,
        SUM(CASE WHEN p.status = 'closed' THEN 1 ELSE 0 END) as closed_trades,
        SUM(CASE WHEN p.status = 'open' THEN 1 ELSE 0 END) as open_trades,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE 0 END) as total_pnl,
        AVG(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) END) as avg_pnl,
        AVG(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) > 0 THEN COALESCE(p.pnl, 0) END) as avg_win,
        AVG(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) < 0 THEN ABS(COALESCE(p.pnl, 0)) END) as avg_loss
      FROM strategies s
      LEFT JOIN bots b ON s.bot_id = b.id
      LEFT JOIN positions p ON s.id = p.strategy_id
      WHERE s.is_active = 1
      GROUP BY s.id, s.symbol, s.bot_id, b.bot_name, s.trade_type, s.stoploss, s.take_profit, 
               s.reduce, s.up_reduce, s.\`interval\`, s.oc, s.is_active
      HAVING total_trades > 0
      ORDER BY total_pnl DESC
    `);

    console.log(`\n📊 Found ${strategyPerformance.length} active strategies with trades\n`);

    // Categorize strategies
    const highPerformers = [];
    const lowPerformers = [];
    const needsSL = [];
    const needsTP = [];

    for (const s of strategyPerformance) {
      const winRate = s.closed_trades > 0 ? (s.wins / s.closed_trades * 100) : 0;
      const profitFactor = s.avg_loss > 0 ? (s.avg_win / s.avg_loss) : 0;
      
      s.winRate = winRate;
      s.profitFactor = profitFactor;

      // Categorize
      if (s.closed_trades >= OPTIMAL_SETTINGS.MIN_TRADES) {
        if (winRate >= 50 && s.total_pnl > 0) {
          highPerformers.push(s);
        } else if (winRate < OPTIMAL_SETTINGS.MIN_WIN_RATE || s.total_pnl < -10) {
          lowPerformers.push(s);
        }
      }

      if (!s.stoploss || Number(s.stoploss) === 0) {
        needsSL.push(s);
      }
      if (!s.take_profit || Number(s.take_profit) === 0) {
        needsTP.push(s);
      }
    }

    // ============================================
    // SECTION 2: HIGH PERFORMERS (Keep these!)
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🏆 SECTION 2: HIGH PERFORMING STRATEGIES (Win Rate >= 50%, Profitable)');
    console.log('━'.repeat(80));

    if (highPerformers.length > 0) {
      console.log('\n┌──────┬────────────────────┬──────────┬──────────┬────────────────┬──────────┬────────────────┐');
      console.log('│ ID   │ Symbol             │ Trades   │ Wins     │ Win Rate       │ PnL      │ SL/TP Config   │');
      console.log('├──────┼────────────────────┼──────────┼──────────┼────────────────┼──────────┼────────────────┤');
      
      for (const s of highPerformers.slice(0, 15)) {
        const slTpConfig = `${s.stoploss || 'N/A'}/${s.take_profit || 'N/A'}`;
        console.log(
          `│ ${String(s.id).padEnd(4)} │ ${String(s.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(s.closed_trades).padStart(8)} │ ${String(s.wins).padStart(8)} │ ` +
          `${String(s.winRate.toFixed(1) + '%').padStart(14)} │ ` +
          `${String(Number(s.total_pnl || 0).toFixed(2)).padStart(8)} │ ${String(slTpConfig).padStart(14)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────────┴──────────┴────────────────┴──────────┴────────────────┘');
      console.log(`\n✅ ${highPerformers.length} high performing strategies - KEEP THESE!`);
    } else {
      console.log('\n⚠️  No high performing strategies found with minimum criteria');
    }

    // ============================================
    // SECTION 3: LOW PERFORMERS (Consider disabling)
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log(`🔴 SECTION 3: LOW PERFORMING STRATEGIES (Win Rate < ${OPTIMAL_SETTINGS.MIN_WIN_RATE}% or Losing)`);
    console.log('━'.repeat(80));

    if (lowPerformers.length > 0) {
      console.log('\n┌──────┬────────────────────┬──────────┬──────────┬────────────────┬────────────────┬────────────────┐');
      console.log('│ ID   │ Symbol             │ Trades   │ Losses   │ Win Rate       │ Total Loss     │ Recommendation │');
      console.log('├──────┼────────────────────┼──────────┼──────────┼────────────────┼────────────────┼────────────────┤');
      
      for (const s of lowPerformers.slice(0, 20)) {
        let recommendation = '';
        if (s.winRate < 30) recommendation = 'DISABLE';
        else if (s.total_pnl < -50) recommendation = 'DISABLE';
        else recommendation = 'REVIEW';
        
        console.log(
          `│ ${String(s.id).padEnd(4)} │ ${String(s.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(s.closed_trades).padStart(8)} │ ${String(s.losses).padStart(8)} │ ` +
          `${String(s.winRate.toFixed(1) + '%').padStart(14)} │ ` +
          `${String(Number(s.total_pnl || 0).toFixed(2)).padStart(14)} │ ${String(recommendation).padStart(14)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────────┴──────────┴────────────────┴────────────────┴────────────────┘');
      console.log(`\n⚠️  ${lowPerformers.length} low performing strategies - CONSIDER DISABLING OR OPTIMIZING`);
    } else {
      console.log('\n✅ No critically low performing strategies found');
    }

    // ============================================
    // SECTION 4: STRATEGIES WITHOUT SL (HIGH RISK!)
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('⚠️  SECTION 4: STRATEGIES WITHOUT STOPLOSS (HIGH RISK!)');
    console.log('━'.repeat(80));

    if (needsSL.length > 0) {
      console.log(`\n🚨 Found ${needsSL.length} strategies without proper SL configuration:\n`);
      
      console.log('┌──────┬────────────────────┬──────────┬────────────────┬────────────────┬────────────────┐');
      console.log('│ ID   │ Symbol             │ Open Pos │ Total Loss     │ Current SL     │ Recommended SL │');
      console.log('├──────┼────────────────────┼──────────┼────────────────┼────────────────┼────────────────┤');
      
      const totalLossWithoutSL = needsSL.reduce((sum, s) => 
        sum + Math.min(0, Number(s.total_pnl || 0)), 0
      );

      for (const s of needsSL.slice(0, 20)) {
        const currentSL = s.stoploss || 'NONE';
        const recommendedSL = OPTIMAL_SETTINGS.DEFAULT_SL_PERCENTAGE;
        
        console.log(
          `│ ${String(s.id).padEnd(4)} │ ${String(s.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(s.open_trades).padStart(8)} │ ` +
          `${String(Number(Math.min(0, s.total_pnl || 0)).toFixed(2)).padStart(14)} │ ` +
          `${String(currentSL).padStart(14)} │ ${String(recommendedSL + '%').padStart(14)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────────┴────────────────┴────────────────┴────────────────┘');
      
      console.log(`\n🚨 Total potential loss from strategies without SL: ${totalLossWithoutSL.toFixed(2)} USDT`);
      console.log(`\n💡 To fix, run: node scripts/optimize_strategies.js --fix-sl`);
    } else {
      console.log('\n✅ All strategies have SL configured');
    }

    // ============================================
    // SECTION 5: RECOMMENDATIONS SUMMARY
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('💡 SECTION 5: OPTIMIZATION RECOMMENDATIONS');
    console.log('━'.repeat(80));

    const disableIds = lowPerformers
      .filter(s => s.winRate < 30 || s.total_pnl < -50)
      .map(s => s.id);

    const fixSLIds = needsSL.map(s => s.id);
    const fixTPIds = needsTP.map(s => s.id);

    console.log(`
📋 RECOMMENDED ACTIONS:

1. 🏆 HIGH PERFORMERS: ${highPerformers.length} strategies
   → Keep and consider increasing position size

2. 🔴 LOW PERFORMERS: ${lowPerformers.length} strategies
   → ${disableIds.length} recommended to DISABLE
   → SQL to disable:
   ${disableIds.length > 0 ? `UPDATE strategies SET is_active = 0 WHERE id IN (${disableIds.join(',')});` : '   (none)'}

3. ⚠️  MISSING SL: ${needsSL.length} strategies
   → Add default ${OPTIMAL_SETTINGS.DEFAULT_SL_PERCENTAGE}% SL
   → SQL to fix:
   ${fixSLIds.length > 0 ? `UPDATE strategies SET stoploss = ${OPTIMAL_SETTINGS.DEFAULT_SL_PERCENTAGE} WHERE id IN (${fixSLIds.join(',')});` : '   (none)'}

4. ⚠️  MISSING TP: ${needsTP.length} strategies
   → Consider adding TP for better risk management
   → SQL to add ${OPTIMAL_SETTINGS.DEFAULT_TP_PERCENTAGE}% TP:
   ${fixTPIds.length > 0 ? `UPDATE strategies SET take_profit = ${OPTIMAL_SETTINGS.DEFAULT_TP_PERCENTAGE} WHERE id IN (${fixTPIds.join(',')});` : '   (none)'}

5. 📊 TRAILING SETTINGS (for strategies without reduce/up_reduce):
   → Recommended: reduce=${OPTIMAL_SETTINGS.RECOMMENDED_REDUCE}, up_reduce=${OPTIMAL_SETTINGS.RECOMMENDED_UP_REDUCE}
`);

    // ============================================
    // SECTION 6: AUTO-FIX OPTIONS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🔧 SECTION 6: AUTO-FIX OPTIONS');
    console.log('━'.repeat(80));

    const args = process.argv.slice(2);
    
    if (args.includes('--fix-sl')) {
      console.log('\n🔧 Applying SL fix to strategies without SL...\n');
      
      for (const s of needsSL) {
        try {
          await pool.execute(
            `UPDATE strategies SET stoploss = ? WHERE id = ?`,
            [OPTIMAL_SETTINGS.DEFAULT_SL_PERCENTAGE, s.id]
          );
          console.log(`   ✅ Strategy ${s.id} (${s.symbol}): SL set to ${OPTIMAL_SETTINGS.DEFAULT_SL_PERCENTAGE}%`);
        } catch (error) {
          console.log(`   ❌ Strategy ${s.id} (${s.symbol}): Failed - ${error.message}`);
        }
      }
      
      console.log(`\n✅ Applied SL to ${needsSL.length} strategies`);
    }

    if (args.includes('--disable-losers')) {
      console.log('\n🔧 Disabling low performing strategies...\n');
      
      for (const id of disableIds) {
        try {
          await pool.execute(
            `UPDATE strategies SET is_active = 0 WHERE id = ?`,
            [id]
          );
          console.log(`   ✅ Strategy ${id}: Disabled`);
        } catch (error) {
          console.log(`   ❌ Strategy ${id}: Failed - ${error.message}`);
        }
      }
      
      console.log(`\n✅ Disabled ${disableIds.length} low performing strategies`);
    }

    if (!args.includes('--fix-sl') && !args.includes('--disable-losers')) {
      console.log(`
💡 Available auto-fix options:

   node scripts/optimize_strategies.js --fix-sl           # Add SL to strategies without SL
   node scripts/optimize_strategies.js --disable-losers   # Disable consistently losing strategies
   node scripts/optimize_strategies.js --fix-sl --disable-losers  # Both
`);
    }

    console.log('\n' + '='.repeat(100));
    console.log('📊 ANALYSIS COMPLETE');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await pool.end();
  }
}

// Run
analyzeStrategies().catch(console.error);
