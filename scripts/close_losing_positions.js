#!/usr/bin/env node

/**
 * Close Losing Positions Script
 * 
 * This script:
 * 1. Identifies positions with high unrealized losses
 * 2. Closes them via exchange API (market order)
 * 3. Updates database accordingly
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

// Dynamic imports
const { Bot } = await import('../src/models/Bot.js');
const { ExchangeService } = await import('../src/services/ExchangeService.js');
const { Position } = await import('../src/models/Position.js');

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

async function closeLosingPositions() {
  const pool = await getDbConnection();
  const dryRun = !process.argv.includes('--execute');
  const lossThreshold = Number(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || -20);
  
  try {
    console.log('='.repeat(100));
    console.log('🔴 CLOSE LOSING POSITIONS SCRIPT');
    console.log('='.repeat(100));
    console.log(`Generated at: ${new Date().toISOString()}`);
    console.log(`Mode: ${dryRun ? '🔍 DRY RUN (use --execute to actually close)' : '⚡ EXECUTE MODE'}`);
    console.log(`Loss Threshold: ${lossThreshold} USDT (use --threshold=-30 to change)\n`);

    // Get positions with high losses
    const [losingPositions] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.amount,
        p.quantity,
        p.pnl,
        p.stop_loss_price,
        p.tp_order_id,
        p.sl_order_id,
        p.use_software_sl,
        s.id as strategy_id,
        s.bot_id,
        b.bot_name,
        b.exchange
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      LEFT JOIN bots b ON s.bot_id = b.id
      WHERE p.status = 'open' AND COALESCE(p.pnl, 0) < ?
      ORDER BY p.pnl ASC
    `, [lossThreshold]);

    if (losingPositions.length === 0) {
      console.log(`✅ No positions with unrealized loss < ${lossThreshold} USDT found!`);
      await pool.end();
      return;
    }

    console.log(`\n🔥 Found ${losingPositions.length} positions with loss < ${lossThreshold} USDT:\n`);
    
    let totalLoss = 0;
    console.log('┌──────┬────────────────────┬──────┬────────────────┬────────────────┬────────────────┬──────────────┐');
    console.log('│ ID   │ Symbol             │ Side │ Entry Price    │ Unrealized PNL │ Quantity       │ Bot          │');
    console.log('├──────┼────────────────────┼──────┼────────────────┼────────────────┼────────────────┼──────────────┤');
    
    for (const pos of losingPositions) {
      totalLoss += Math.abs(Number(pos.pnl));
      console.log(
        `│ ${String(pos.id).padEnd(4)} │ ${String(pos.symbol).slice(0, 18).padEnd(18)} │ ` +
        `${String(pos.side).slice(0, 4).padEnd(4)} │ ${String(Number(pos.entry_price || 0).toFixed(6)).padStart(14)} │ ` +
        `${String(Number(pos.pnl || 0).toFixed(2)).padStart(14)} │ ` +
        `${String(Number(pos.quantity || pos.amount || 0).toFixed(4)).padStart(14)} │ ` +
        `${String(pos.bot_name || pos.bot_id).slice(0, 12).padEnd(12)} │`
      );
    }
    console.log('└──────┴────────────────────┴──────┴────────────────┴────────────────┴────────────────┴──────────────┘');
    console.log(`\n📊 Total Unrealized Loss to be locked: ${totalLoss.toFixed(2)} USDT`);

    if (dryRun) {
      console.log('\n⚠️  DRY RUN MODE - No actual changes will be made.');
      console.log('   To execute, run: node scripts/close_losing_positions.js --execute');
      console.log(`   To change threshold, run: node scripts/close_losing_positions.js --execute --threshold=-30\n`);
      await pool.end();
      return;
    }

    // Execute mode - close positions
    console.log('\n⚡ EXECUTING - Closing positions...\n');

    // Group positions by bot
    const positionsByBot = new Map();
    for (const pos of losingPositions) {
      if (!positionsByBot.has(pos.bot_id)) {
        positionsByBot.set(pos.bot_id, []);
      }
      positionsByBot.get(pos.bot_id).push(pos);
    }

    let closedCount = 0;
    let failedCount = 0;
    const results = [];

    for (const [botId, positions] of positionsByBot) {
      console.log(`\n🤖 Processing Bot ${botId} (${positions[0]?.bot_name || 'unknown'})...`);
      
      try {
        // Get bot and initialize exchange service
        const bot = await Bot.findById(botId);
        if (!bot) {
          console.log(`   ❌ Bot ${botId} not found, skipping ${positions.length} positions`);
          failedCount += positions.length;
          continue;
        }

        const exchangeService = new ExchangeService(bot);
        await exchangeService.initialize();

        for (const pos of positions) {
          try {
            console.log(`   📍 Closing position ${pos.id} (${pos.symbol} ${pos.side})...`);
            
            // Determine close side (opposite of position side)
            const closeSide = pos.side === 'long' ? 'sell' : 'buy';
            const quantity = Number(pos.quantity) || Number(pos.amount);
            
            // Cancel existing TP/SL orders first
            if (pos.tp_order_id) {
              try {
                await exchangeService.cancelOrder(pos.symbol, pos.tp_order_id);
                console.log(`      ✅ Cancelled TP order ${pos.tp_order_id}`);
              } catch (e) {
                console.log(`      ⚠️  Failed to cancel TP order: ${e.message}`);
              }
            }
            
            if (pos.sl_order_id) {
              try {
                await exchangeService.cancelOrder(pos.symbol, pos.sl_order_id);
                console.log(`      ✅ Cancelled SL order ${pos.sl_order_id}`);
              } catch (e) {
                console.log(`      ⚠️  Failed to cancel SL order: ${e.message}`);
              }
            }

            // Place market close order
            const closeOrder = await exchangeService.createMarketOrder(
              pos.symbol,
              closeSide,
              quantity,
              { reduceOnly: true }
            );

            if (closeOrder) {
              // Update position in database
              const closePrice = closeOrder.average || closeOrder.price || pos.entry_price;
              const realizedPnl = pos.pnl; // Use current PNL as realized
              
              await pool.execute(`
                UPDATE positions 
                SET status = 'closed', 
                    close_reason = 'manual_close_high_loss',
                    close_price = ?,
                    pnl = ?,
                    closed_at = NOW()
                WHERE id = ?
              `, [closePrice, realizedPnl, pos.id]);

              console.log(`      ✅ Position ${pos.id} closed. PNL: ${realizedPnl} USDT`);
              closedCount++;
              results.push({
                id: pos.id,
                symbol: pos.symbol,
                pnl: realizedPnl,
                status: 'closed'
              });
            } else {
              console.log(`      ❌ Failed to close position ${pos.id}: No order returned`);
              failedCount++;
              results.push({
                id: pos.id,
                symbol: pos.symbol,
                pnl: pos.pnl,
                status: 'failed',
                error: 'No order returned'
              });
            }

          } catch (posError) {
            console.log(`      ❌ Failed to close position ${pos.id}: ${posError.message}`);
            failedCount++;
            results.push({
              id: pos.id,
              symbol: pos.symbol,
              pnl: pos.pnl,
              status: 'failed',
              error: posError.message
            });
          }
        }

      } catch (botError) {
        console.log(`   ❌ Failed to process bot ${botId}: ${botError.message}`);
        failedCount += positions.length;
      }
    }

    // Summary
    console.log('\n' + '━'.repeat(80));
    console.log('📊 EXECUTION SUMMARY');
    console.log('━'.repeat(80));
    console.log(`   ✅ Successfully closed: ${closedCount} positions`);
    console.log(`   ❌ Failed: ${failedCount} positions`);
    
    const totalRealized = results
      .filter(r => r.status === 'closed')
      .reduce((sum, r) => sum + Number(r.pnl), 0);
    console.log(`   💰 Total Realized Loss: ${totalRealized.toFixed(2)} USDT`);
    console.log('\n');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

// Run
closeLosingPositions().catch(console.error);
