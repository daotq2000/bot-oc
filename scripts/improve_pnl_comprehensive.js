#!/usr/bin/env node

/**
 * Comprehensive PNL Improvement Script
 * 
 * This script:
 * 1. Analyzes why software_sl is causing losses
 * 2. Reviews positions with high negative PNL
 * 3. Suggests optimal SL levels based on historical data
 * 4. Fixes positions without proper SL
 * 5. Identifies and disables underperforming strategies
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

async function improvePNL() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(100));
    console.log('🔧 COMPREHENSIVE PNL IMPROVEMENT SCRIPT');
    console.log('='.repeat(100));
    console.log(`Generated at: ${new Date().toISOString()}\n`);

    // ============================================
    // ANALYSIS 1: Why is software_sl causing losses?
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🔍 ANALYSIS 1: SOFTWARE SL PERFORMANCE');
    console.log('━'.repeat(80));

    const [softwareSLAnalysis] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.close_price,
        p.stop_loss_price,
        p.pnl,
        p.amount,
        s.stoploss as strategy_sl_percent,
        s.take_profit as strategy_tp_percent,
        CASE WHEN p.stop_loss_price > 0 AND p.entry_price > 0 
             THEN ABS(p.entry_price - p.stop_loss_price) / p.entry_price * 100 
             ELSE 0 END as actual_sl_percent,
        CASE WHEN p.close_price > 0 AND p.entry_price > 0 
             THEN ABS(p.entry_price - p.close_price) / p.entry_price * 100 
             ELSE 0 END as actual_exit_percent,
        TIMESTAMPDIFF(MINUTE, p.opened_at, p.closed_at) as duration_minutes
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.close_reason = 'software_sl' AND p.status = 'closed'
      ORDER BY p.pnl ASC
      LIMIT 30
    `);

    console.log('\n📊 Top 30 Software SL Losses Analysis:\n');
    
    let totalSLLoss = 0;
    let avgSLPercent = 0;
    let avgDuration = 0;
    let slTooTight = 0;
    
    if (softwareSLAnalysis.length > 0) {
      console.log('┌──────┬────────────────────┬──────┬────────────────┬────────────────┬──────────┬──────────┬──────────┐');
      console.log('│ ID   │ Symbol             │ Side │ Entry Price    │ PNL            │ SL %     │ Exit %   │ Duration │');
      console.log('├──────┼────────────────────┼──────┼────────────────┼────────────────┼──────────┼──────────┼──────────┤');
      
      for (const pos of softwareSLAnalysis) {
        const slPercent = Number(pos.actual_sl_percent || 0).toFixed(2);
        const exitPercent = Number(pos.actual_exit_percent || 0).toFixed(2);
        const duration = pos.duration_minutes || 0;
        
        totalSLLoss += Number(pos.pnl || 0);
        avgSLPercent += Number(pos.actual_sl_percent || 0);
        avgDuration += duration;
        
        // SL too tight if < 1%
        if (Number(slPercent) < 1) slTooTight++;
        
        console.log(
          `│ ${String(pos.id).padEnd(4)} │ ${String(pos.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(pos.side).slice(0, 4).padEnd(4)} │ ${String(Number(pos.entry_price || 0).toFixed(6)).padStart(14)} │ ` +
          `${String(Number(pos.pnl || 0).toFixed(2)).padStart(14)} │ ${String(slPercent + '%').padStart(8)} │ ` +
          `${String(exitPercent + '%').padStart(8)} │ ${String(duration + 'm').padStart(8)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────┴────────────────┴────────────────┴──────────┴──────────┴──────────┘');
      
      avgSLPercent = avgSLPercent / softwareSLAnalysis.length;
      avgDuration = avgDuration / softwareSLAnalysis.length;
      
      console.log(`
📈 Software SL Statistics:
   • Total Loss from SL hits: ${totalSLLoss.toFixed(2)} USDT
   • Average SL %: ${avgSLPercent.toFixed(2)}%
   • Average Duration: ${avgDuration.toFixed(0)} minutes
   • SL Too Tight (<1%): ${slTooTight} positions (${(slTooTight/softwareSLAnalysis.length*100).toFixed(1)}%)
`);
    }

    // ============================================
    // ANALYSIS 2: Optimal SL levels based on winners
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📊 ANALYSIS 2: OPTIMAL SL LEVELS (Based on Winners)');
    console.log('━'.repeat(80));

    const [winnerAnalysis] = await pool.execute(`
      SELECT 
        p.symbol,
        COUNT(*) as total,
        SUM(CASE WHEN p.pnl > 0 THEN 1 ELSE 0 END) as wins,
        AVG(CASE WHEN p.pnl > 0 AND p.close_price > 0 AND p.entry_price > 0 
            THEN ABS(p.entry_price - p.close_price) / p.entry_price * 100 END) as avg_winner_move_pct,
        AVG(CASE WHEN p.pnl < 0 AND p.close_price > 0 AND p.entry_price > 0 
            THEN ABS(p.entry_price - p.close_price) / p.entry_price * 100 END) as avg_loser_move_pct,
        MAX(CASE WHEN p.pnl > 0 AND p.close_price > 0 AND p.entry_price > 0 
            THEN ABS(p.entry_price - p.close_price) / p.entry_price * 100 END) as max_winner_move_pct,
        AVG(p.pnl) as avg_pnl,
        s.stoploss as current_sl
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'closed'
      GROUP BY p.symbol, s.stoploss
      HAVING total >= 3
      ORDER BY wins/total DESC
      LIMIT 20
    `);

    console.log('\n🏆 Symbol Performance & Recommended SL:\n');
    console.log('┌────────────────────┬──────────┬──────────┬────────────────┬────────────────┬────────────────┬────────────────┐');
    console.log('│ Symbol             │ Trades   │ Win Rate │ Avg Win Move   │ Avg Loss Move  │ Current SL     │ Recommended SL │');
    console.log('├────────────────────┼──────────┼──────────┼────────────────┼────────────────┼────────────────┼────────────────┤');

    for (const sym of winnerAnalysis) {
      const winRate = (sym.wins / sym.total * 100).toFixed(1);
      const avgWinMove = Number(sym.avg_winner_move_pct || 0).toFixed(2);
      const avgLossMove = Number(sym.avg_loser_move_pct || 0).toFixed(2);
      const currentSL = Number(sym.current_sl || 0).toFixed(2);
      
      // Recommended SL = slightly more than avg loss move to avoid being stopped out
      const recommendedSL = Math.max(Number(avgLossMove) * 1.2, 2).toFixed(2);
      
      console.log(
        `│ ${String(sym.symbol).slice(0, 18).padEnd(18)} │ ${String(sym.total).padStart(8)} │ ` +
        `${String(winRate + '%').padStart(8)} │ ${String(avgWinMove + '%').padStart(14)} │ ` +
        `${String(avgLossMove + '%').padStart(14)} │ ${String(currentSL + '%').padStart(14)} │ ` +
        `${String(recommendedSL + '%').padStart(14)} │`
      );
    }
    console.log('└────────────────────┴──────────┴──────────┴────────────────┴────────────────┴────────────────┴────────────────┘');

    // ============================================
    // ANALYSIS 3: Underperforming strategies to disable
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🚫 ANALYSIS 3: UNDERPERFORMING STRATEGIES (Consider Disabling)');
    console.log('━'.repeat(80));

    const [badStrategies] = await pool.execute(`
      SELECT 
        s.id,
        s.symbol,
        s.bot_id,
        s.is_active as enabled,
        s.stoploss,
        s.take_profit,
        s.oc,
        COUNT(p.id) as total_positions,
        SUM(CASE WHEN p.status = 'closed' AND p.pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN p.status = 'closed' AND p.pnl <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE 0 END) as total_pnl
      FROM strategies s
      LEFT JOIN positions p ON s.id = p.strategy_id
      GROUP BY s.id, s.symbol, s.bot_id, s.is_active, s.stoploss, s.take_profit, s.oc
      HAVING total_positions >= 3 AND total_pnl < -10
      ORDER BY total_pnl ASC
      LIMIT 20
    `);

    console.log('\n⚠️  Strategies with PNL < -10 USDT (consider disabling):\n');
    
    if (badStrategies.length > 0) {
      console.log('┌──────┬────────────────────┬──────────┬──────────┬──────────┬────────────────┬──────────┐');
      console.log('│ ID   │ Symbol             │ Enabled  │ Trades   │ Win Rate │ Total PNL      │ SL/TP    │');
      console.log('├──────┼────────────────────┼──────────┼──────────┼──────────┼────────────────┼──────────┤');
      
      for (const s of badStrategies) {
        const winRate = s.total_positions > 0 ? (s.wins / s.total_positions * 100).toFixed(1) : '0.0';
        const sltp = `${s.stoploss || 0}/${s.take_profit || 0}`;
        
        console.log(
          `│ ${String(s.id).padEnd(4)} │ ${String(s.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(s.enabled ? 'YES' : 'NO').padEnd(8)} │ ${String(s.total_positions).padStart(8)} │ ` +
          `${String(winRate + '%').padStart(8)} │ ${String(Number(s.total_pnl || 0).toFixed(2)).padStart(14)} │ ` +
          `${String(sltp).slice(0, 8).padEnd(8)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────────┴──────────┴──────────┴────────────────┴──────────┘');
    } else {
      console.log('   ✅ No significantly underperforming strategies found!');
    }

    // ============================================
    // ANALYSIS 4: Open positions needing attention
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🔥 ANALYSIS 4: OPEN POSITIONS NEEDING IMMEDIATE ATTENTION');
    console.log('━'.repeat(80));

    const [criticalPositions] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.amount,
        p.pnl,
        p.stop_loss_price,
        p.take_profit_price,
        p.sl_order_id,
        p.tp_order_id,
        p.use_software_sl,
        s.stoploss as strategy_sl,
        s.take_profit as strategy_tp,
        TIMESTAMPDIFF(HOUR, p.opened_at, NOW()) as hours_open
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'open'
      ORDER BY COALESCE(p.pnl, 0) ASC
      LIMIT 30
    `);

    console.log(`\n🔥 Top 30 Open Positions by PNL (worst first):\n`);
    
    let totalUnrealizedLoss = 0;
    let positionsNeedingSL = [];
    
    if (criticalPositions.length > 0) {
      console.log('┌──────┬────────────────────┬──────┬────────────────┬────────────────┬────────────────┬──────────┬──────────────┐');
      console.log('│ ID   │ Symbol             │ Side │ Entry          │ Unrealized PNL │ SL Price       │ Hours    │ SL Status    │');
      console.log('├──────┼────────────────────┼──────┼────────────────┼────────────────┼────────────────┼──────────┼──────────────┤');
      
      for (const pos of criticalPositions) {
        let slStatus = '';
        if (pos.sl_order_id) {
          slStatus = '✅ Exchange';
        } else if (pos.use_software_sl && pos.stop_loss_price) {
          slStatus = '⚡ Software';
        } else if (pos.stop_loss_price) {
          slStatus = '⚠️  Price Only';
        } else {
          slStatus = '❌ NONE';
          positionsNeedingSL.push(pos);
        }
        
        if (Number(pos.pnl) < 0) {
          totalUnrealizedLoss += Math.abs(Number(pos.pnl));
        }
        
        console.log(
          `│ ${String(pos.id).padEnd(4)} │ ${String(pos.symbol).slice(0, 18).padEnd(18)} │ ` +
          `${String(pos.side).slice(0, 4).padEnd(4)} │ ${String(Number(pos.entry_price || 0).toFixed(6)).padStart(14)} │ ` +
          `${String(Number(pos.pnl || 0).toFixed(2)).padStart(14)} │ ` +
          `${String(Number(pos.stop_loss_price || 0).toFixed(6)).padStart(14)} │ ` +
          `${String(pos.hours_open || 0).padStart(8)} │ ${String(slStatus).slice(0, 12).padEnd(12)} │`
        );
      }
      console.log('└──────┴────────────────────┴──────┴────────────────┴────────────────┴────────────────┴──────────┴──────────────┘');
      
      console.log(`
📊 Summary:
   • Total Unrealized Loss: ${totalUnrealizedLoss.toFixed(2)} USDT
   • Positions without ANY SL: ${positionsNeedingSL.length}
`);
    }

    // ============================================
    // FIX ACTIONS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🛠️  RECOMMENDED FIX ACTIONS');
    console.log('━'.repeat(80));

    const fixes = [];

    // 1. Fix positions without SL
    if (positionsNeedingSL.length > 0) {
      fixes.push({
        priority: 'CRITICAL',
        action: `Add SL to ${positionsNeedingSL.length} positions without any SL`,
        sql: positionsNeedingSL.map(p => {
          // Calculate SL based on strategy or default 5%
          const slPercent = Number(p.strategy_sl) || 5;
          let slPrice;
          if (p.side === 'long') {
            slPrice = Number(p.entry_price) * (1 - slPercent / 100);
          } else {
            slPrice = Number(p.entry_price) * (1 + slPercent / 100);
          }
          return `UPDATE positions SET stop_loss_price = ${slPrice.toFixed(8)}, use_software_sl = 1 WHERE id = ${p.id};`;
        }).join('\n')
      });
    }

    // 2. Disable worst performing strategies
    if (badStrategies.length > 0) {
      const worstStrategies = badStrategies.filter(s => Number(s.total_pnl) < -50 && s.enabled);
      if (worstStrategies.length > 0) {
        fixes.push({
          priority: 'HIGH',
          action: `Disable ${worstStrategies.length} strategies with PNL < -50 USDT`,
          sql: worstStrategies.map(s => `UPDATE strategies SET is_active = 0 WHERE id = ${s.id}; -- ${s.symbol}: ${s.total_pnl} USDT`).join('\n')
        });
      }
    }

    // 3. Increase SL for strategies with tight SL
    if (slTooTight > softwareSLAnalysis.length * 0.3) {
      fixes.push({
        priority: 'MEDIUM',
        action: 'Increase SL % for strategies with SL < 2%',
        sql: `UPDATE strategies SET stoploss = 3 WHERE stoploss > 0 AND stoploss < 2;`
      });
    }

    // Print fixes
    console.log('\n📋 RECOMMENDED FIXES:\n');
    
    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i];
      const priorityIcon = fix.priority === 'CRITICAL' ? '🔴' : fix.priority === 'HIGH' ? '🟠' : '🟡';
      
      console.log(`${i + 1}. ${priorityIcon} [${fix.priority}] ${fix.action}`);
      console.log(`   SQL Commands:`);
      console.log(`   ${fix.sql.split('\n').slice(0, 5).join('\n   ')}`);
      if (fix.sql.split('\n').length > 5) {
        console.log(`   ... and ${fix.sql.split('\n').length - 5} more commands`);
      }
      console.log();
    }

    // ============================================
    // AUTO-FIX (Optional)
    // ============================================
    const autoFix = process.argv.includes('--fix');
    
    if (autoFix) {
      console.log('\n' + '━'.repeat(80));
      console.log('⚡ APPLYING AUTO-FIXES...');
      console.log('━'.repeat(80));

      // Fix positions without SL
      if (positionsNeedingSL.length > 0) {
        console.log(`\n🔧 Adding SL to ${positionsNeedingSL.length} positions...`);
        
        let fixed = 0;
        for (const pos of positionsNeedingSL) {
          const slPercent = Number(pos.strategy_sl) || 5;
          let slPrice;
          if (pos.side === 'long') {
            slPrice = Number(pos.entry_price) * (1 - slPercent / 100);
          } else {
            slPrice = Number(pos.entry_price) * (1 + slPercent / 100);
          }
          
          try {
            await pool.execute(
              `UPDATE positions SET stop_loss_price = ?, use_software_sl = 1 WHERE id = ?`,
              [slPrice, pos.id]
            );
            fixed++;
            console.log(`   ✅ Position ${pos.id} (${pos.symbol}): SL = ${slPrice.toFixed(6)}`);
          } catch (e) {
            console.log(`   ❌ Position ${pos.id}: ${e.message}`);
          }
        }
        console.log(`   Fixed ${fixed}/${positionsNeedingSL.length} positions`);
      }

      console.log('\n✅ Auto-fix complete!');
    } else {
      console.log('\n💡 To apply fixes automatically, run: node scripts/improve_pnl_comprehensive.js --fix');
    }

    console.log('\n' + '='.repeat(100));
    console.log('🔧 IMPROVEMENT ANALYSIS COMPLETE');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await pool.end();
  }
}

// Run the script
improvePNL().catch(console.error);
