#!/usr/bin/env node
/**
 * Ghost Position Cleanup Script
 * 
 * This script cleans up "ghost positions" - positions that exist in the database
 * but not on the exchange. These can occur due to:
 * - Network issues during position close
 * - Exchange closing positions via liquidation without notification
 * - TP/SL orders filled but DB not updated
 * 
 * Usage:
 *   node scripts/cleanupGhostPositions.js [--dry-run] [--max-age-hours=N]
 * 
 * Options:
 *   --dry-run: Only report ghost positions, don't close them
 *   --max-age-hours=N: Only check positions older than N hours (default: 1)
 */

import dotenv from 'dotenv';
dotenv.config();

import pool from '../src/config/database.js';
import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { calculatePnL } from '../src/utils/calculator.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX_AGE_HOURS = (() => {
  const ageArg = args.find(a => a.startsWith('--max-age-hours='));
  return ageArg ? parseInt(ageArg.split('=')[1], 10) : 1;
})();

console.log('='.repeat(60));
console.log('Ghost Position Cleanup Script');
console.log('='.repeat(60));
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (will close ghost positions)'}`);
console.log(`Max Age: ${MAX_AGE_HOURS} hours`);
console.log('='.repeat(60));

async function main() {
  const exchangeServices = new Map();
  let totalGhost = 0;
  let totalClosed = 0;
  let totalErrors = 0;

  try {
    // Get all active bots
    const bots = await Bot.findAll(true);
    console.log(`\nFound ${bots.length} active bot(s)\n`);

    // Initialize exchange services
    for (const bot of bots) {
      try {
        const exchangeService = new ExchangeService(bot);
        await exchangeService.initialize();
        exchangeServices.set(bot.id, exchangeService);
        console.log(`✅ Initialized ExchangeService for bot ${bot.id} (${bot.bot_name || 'unnamed'})`);
      } catch (e) {
        console.error(`❌ Failed to initialize ExchangeService for bot ${bot.id}: ${e.message}`);
      }
    }

    // Get all open positions from DB that are older than MAX_AGE_HOURS
    const cutoffTime = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000);
    const [dbPositions] = await pool.execute(
      `SELECT p.*, s.bot_id, s.symbol as strategy_symbol
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE p.status = 'open' AND p.opened_at < ?
       ORDER BY p.opened_at ASC`,
      [cutoffTime]
    );

    console.log(`\nFound ${dbPositions.length} open position(s) older than ${MAX_AGE_HOURS} hour(s)\n`);

    // Group by bot
    const positionsByBot = new Map();
    for (const pos of dbPositions) {
      const botId = pos.bot_id;
      if (!positionsByBot.has(botId)) {
        positionsByBot.set(botId, []);
      }
      positionsByBot.get(botId).push(pos);
    }

    // Check each bot's positions against exchange
    for (const [botId, positions] of positionsByBot) {
      const exchangeService = exchangeServices.get(botId);
      if (!exchangeService) {
        console.log(`\n⚠️ Skipping bot ${botId} (no ExchangeService)\n`);
        continue;
      }

      console.log(`\n--- Bot ${botId} (${positions.length} positions) ---`);

      // Fetch all positions from exchange once
      let exchangePositions = [];
      try {
        exchangePositions = await exchangeService.getOpenPositions();
        if (!Array.isArray(exchangePositions)) exchangePositions = [];
      } catch (e) {
        console.error(`❌ Failed to fetch exchange positions for bot ${botId}: ${e.message}`);
        continue;
      }

      // Create map of exchange positions
      const exchangeMap = new Map();
      for (const exPos of exchangePositions) {
        const symbol = exPos.symbol || exPos.info?.symbol;
        const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? 0);
        if (!symbol || rawAmt === 0) continue;
        
        const side = rawAmt > 0 ? 'long' : 'short';
        const key = `${symbol}_${side}`;
        exchangeMap.set(key, exPos);
      }

      console.log(`Exchange has ${exchangeMap.size} active position(s)`);

      // Check each DB position
      for (const dbPos of positions) {
        const symbol = dbPos.symbol;
        const side = dbPos.side;
        const key = `${symbol}_${side}`;
        
        const exPos = exchangeMap.get(key);
        const ageHours = ((Date.now() - new Date(dbPos.opened_at).getTime()) / (60 * 60 * 1000)).toFixed(1);

        if (!exPos) {
          totalGhost++;
          console.log(`\n🔴 GHOST FOUND: Position ${dbPos.id}`);
          console.log(`   Symbol: ${symbol} | Side: ${side}`);
          console.log(`   Age: ${ageHours} hours`);
          console.log(`   Entry: ${dbPos.entry_price} | Amount: ${dbPos.amount}`);
          console.log(`   exit_order_id: ${dbPos.exit_order_id || 'NULL'}`);
          console.log(`   sl_order_id: ${dbPos.sl_order_id || 'NULL'}`);

          if (!DRY_RUN) {
            try {
              // Get current price for PnL calculation
              let closePrice = Number(dbPos.entry_price);
              try {
                closePrice = await exchangeService.getTickerPrice(symbol) || closePrice;
              } catch (e) {
                console.log(`   ⚠️ Could not get current price, using entry price`);
              }

              const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, side);

              // Close in DB
              await Position.update(dbPos.id, {
                status: 'closed',
                close_reason: 'ghost_cleanup_script',
                close_price: closePrice,
                realized_pnl: pnl,
                closed_at: new Date()
              });

              totalClosed++;
              console.log(`   ✅ CLOSED in DB | closePrice=${closePrice} | pnl=${pnl.toFixed(2)}`);
            } catch (e) {
              totalErrors++;
              console.error(`   ❌ Failed to close: ${e.message}`);
            }
          }
        } else {
          // Position exists on exchange - verify amount match
          const exQty = Math.abs(parseFloat(exPos.positionAmt || 0));
          const exNotional = exQty * parseFloat(exPos.entryPrice || dbPos.entry_price || 0);
          const dbNotional = Number(dbPos.amount || 0);
          const diffPct = dbNotional > 0 ? Math.abs(exNotional - dbNotional) / dbNotional * 100 : 0;

          if (diffPct > 10) {
            console.log(`\n🟡 AMOUNT MISMATCH: Position ${dbPos.id}`);
            console.log(`   Symbol: ${symbol} | Side: ${side}`);
            console.log(`   DB Amount: ${dbNotional.toFixed(4)} | Exchange: ${exNotional.toFixed(4)} (${diffPct.toFixed(1)}% diff)`);
            
            if (!DRY_RUN) {
              await Position.update(dbPos.id, { amount: exNotional });
              console.log(`   ✅ Reconciled amount to ${exNotional.toFixed(4)}`);
            }
          }
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total positions checked: ${dbPositions.length}`);
    console.log(`Ghost positions found: ${totalGhost}`);
    if (!DRY_RUN) {
      console.log(`Ghost positions closed: ${totalClosed}`);
      console.log(`Errors: ${totalErrors}`);
    }
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    // Cleanup
    await pool.end();
    process.exit(0);
  }
}

main();
