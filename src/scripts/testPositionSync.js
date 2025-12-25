#!/usr/bin/env node
/*
Test Position Sync Script

Test và verify việc sync positions từ exchange vào bảng positions cho các bots có is_active = true.

Usage:
  node src/scripts/testPositionSync.js [--execute] [--bot-id <id>] [--verbose]

Options:
  --execute     : Thực sự tạo positions missing (default: dry-run)
  --bot-id <id> : Chỉ test cho bot cụ thể
  --verbose     : Hiển thị chi tiết từng position
  --fix         : Tự động tạo positions missing (tương tự --execute)

Notes:
- Script sẽ fetch positions từ exchange và so sánh với database
- Hiển thị các positions missing (có trên exchange nhưng không có trong DB)
- Có thể tạo positions missing nếu có matching strategy hoặc entry_order
*/

import dotenv from 'dotenv';
dotenv.config();

import pool from '../config/database.js';
import { Bot } from '../models/Bot.js';
import { Position } from '../models/Position.js';
import { EntryOrder } from '../models/EntryOrder.js';
import { ExchangeService } from '../services/ExchangeService.js';
import logger from '../utils/logger.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { 
    execute: false, 
    botId: null, 
    verbose: false,
    fix: false
  };
  
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--execute' || a === '--fix') {
      opts.execute = true;
      opts.fix = true;
    } else if (a === '--bot-id' && i + 1 < args.length) {
      opts.botId = parseInt(args[++i], 10);
    } else if (a === '--verbose') {
      opts.verbose = true;
    }
  }
  
  return opts;
}

/**
 * Normalize symbol format
 */
function normalizeSymbol(symbol) {
  if (!symbol) return null;
  let normalized = symbol;
  normalized = normalized.replace(/\/USDT:USDT$/, 'USDT'); // MEXC: BTC/USDT:USDT
  normalized = normalized.replace(/\/USDT$/, 'USDT'); // Standard: BTC/USDT
  normalized = normalized.replace(/_USDT$/, 'USDT'); // Gate: BTC_USDT
  normalized = normalized.replace(/\//g, ''); // Remove any remaining slashes
  return normalized;
}

/**
 * Get position key for matching
 */
function getPositionKey(symbol, side) {
  return `${normalizeSymbol(symbol)}_${side}`;
}

/**
 * Test sync positions for a specific bot
 */
async function testBotPositionSync(botId, exchangeService, opts) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing Position Sync for Bot ${botId} (${exchangeService.bot.bot_name || 'N/A'})`);
  console.log(`${'='.repeat(80)}`);

  try {
    // 1. Fetch positions from exchange
    console.log('\n[1] Fetching positions from exchange...');
    let exchangePositions;
    try {
      exchangePositions = await exchangeService.exchange.fetchPositions();
      if (!Array.isArray(exchangePositions)) {
        console.log(`⚠️  Exchange returned non-array: ${typeof exchangePositions}`);
        exchangePositions = [];
      }
      console.log(`✅ Fetched ${exchangePositions.length} positions from exchange`);
    } catch (error) {
      console.error(`❌ Failed to fetch positions from exchange:`, error?.message || error);
      return { success: false, error: error?.message || error };
    }

    if (exchangePositions.length === 0) {
      console.log('ℹ️  No positions on exchange for this bot');
      return { success: true, exchangeCount: 0, dbCount: 0, missing: 0, created: 0 };
    }

    // 2. Get open positions from database
    console.log('\n[2] Fetching open positions from database...');
    const [dbPositions] = await pool.execute(
      `SELECT p.*, s.symbol as strategy_symbol, s.bot_id
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE s.bot_id = ? AND p.status = 'open'`,
      [botId]
    );
    console.log(`✅ Found ${dbPositions.length} open positions in database`);

    // 3. Create map of DB positions
    const dbPositionsMap = new Map();
    for (const pos of dbPositions) {
      const key = getPositionKey(pos.symbol, pos.side);
      dbPositionsMap.set(key, pos);
      
      // Also add by original symbol
      const key2 = `${pos.symbol}_${pos.side}`;
      if (key2 !== key) {
        dbPositionsMap.set(key2, pos);
      }
    }

    // 4. Process exchange positions
    console.log('\n[3] Comparing exchange positions with database...');
    const missingPositions = [];
    const matchedPositions = [];
    
    for (const exPos of exchangePositions) {
      try {
        const symbol = exPos.symbol || exPos.info?.symbol || exPos.market;
        const contracts = exPos.contracts ?? Math.abs(parseFloat(exPos.positionAmt || exPos.size || 0));
        const side = contracts > 0 ? 'long' : (contracts < 0 ? 'short' : null);
        
        if (!symbol || !side || Math.abs(contracts) <= 0) {
          if (opts.verbose) {
            console.log(`  ⚠️  Skipping invalid position: symbol=${symbol}, side=${side}, contracts=${contracts}`);
          }
          continue;
        }

        const normalizedSymbol = normalizeSymbol(symbol);
        const key = getPositionKey(normalizedSymbol, side);
        
        // Try to find in database
        let dbPos = dbPositionsMap.get(key);
        if (!dbPos) {
          // Try with original symbol
          const key2 = `${symbol}_${side}`;
          dbPos = dbPositionsMap.get(key2);
        }
        
        // Also try direct symbol match
        if (!dbPos) {
          for (const [k, pos] of dbPositionsMap.entries()) {
            if (pos.symbol === normalizedSymbol || pos.symbol === symbol) {
              dbPos = pos;
              break;
            }
          }
        }

        if (dbPos) {
          matchedPositions.push({ exchange: exPos, database: dbPos, symbol, side, contracts });
          if (opts.verbose) {
            console.log(`  ✅ Matched: ${symbol} ${side} (${contracts} contracts) -> DB Position ${dbPos.id}`);
          }
        } else {
          missingPositions.push({ exchange: exPos, symbol, normalizedSymbol, side, contracts });
          if (opts.verbose) {
            console.log(`  ❌ Missing: ${symbol} ${side} (${contracts} contracts) - NOT in database`);
          }
        }
      } catch (error) {
        console.warn(`  ⚠️  Error processing position ${exPos.symbol || 'unknown'}:`, error?.message || error);
      }
    }

    // 5. Display results
    console.log(`\n[4] Results:`);
    console.log(`  Exchange positions: ${exchangePositions.length}`);
    console.log(`  Database positions: ${dbPositions.length}`);
    console.log(`  Matched: ${matchedPositions.length}`);
    console.log(`  Missing: ${missingPositions.length}`);

    if (missingPositions.length > 0) {
      console.log(`\n[5] Missing Positions (on exchange but not in database):`);
      for (const missing of missingPositions) {
        console.log(`  - ${missing.symbol} ${missing.side} (${missing.contracts} contracts)`);
        console.log(`    Normalized: ${missing.normalizedSymbol}`);
        console.log(`    Entry Price: ${missing.exchange.entryPrice || missing.exchange.info?.entryPrice || 'N/A'}`);
        console.log(`    Mark Price: ${missing.exchange.markPrice || missing.exchange.info?.markPrice || 'N/A'}`);
      }
    }

    // 6. Try to create missing positions if --execute
    let createdCount = 0;
    if (opts.execute && missingPositions.length > 0) {
      console.log(`\n[6] Attempting to create ${missingPositions.length} missing positions...`);
      
      for (const missing of missingPositions) {
        try {
          const created = await createMissingPosition(botId, missing, exchangeService);
          if (created) {
            createdCount++;
            console.log(`  ✅ Created position for ${missing.symbol} ${missing.side}`);
          } else {
            console.log(`  ⚠️  Could not create position for ${missing.symbol} ${missing.side} (no matching strategy/entry_order)`);
          }
        } catch (error) {
          console.error(`  ❌ Error creating position for ${missing.symbol} ${missing.side}:`, error?.message || error);
        }
      }
      
      console.log(`\n✅ Created ${createdCount} positions`);
    } else if (missingPositions.length > 0) {
      console.log(`\n[6] Dry-run mode: Use --execute to create missing positions`);
    }

    return {
      success: true,
      exchangeCount: exchangePositions.length,
      dbCount: dbPositions.length,
      matched: matchedPositions.length,
      missing: missingPositions.length,
      created: createdCount
    };
  } catch (error) {
    console.error(`❌ Error testing bot ${botId}:`, error?.message || error);
    return { success: false, error: error?.message || error };
  }
}

/**
 * Create missing position (similar to PositionSync.createMissingPosition)
 */
async function createMissingPosition(botId, missing, exchangeService) {
  try {
    const { symbol, normalizedSymbol, side, exchange: exPos } = missing;

    // Try to find matching entry_order first
    const [entryOrders] = await pool.execute(
      `SELECT * FROM entry_orders 
       WHERE bot_id = ? AND symbol = ? AND side = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [botId, normalizedSymbol, side]
    );

    if (entryOrders.length > 0) {
      const entry = entryOrders[0];
      console.log(`    Found matching entry_order ${entry.id}`);
      
      const { Strategy } = await import('../models/Strategy.js');
      const strategy = await Strategy.findById(entry.strategy_id);
      if (!strategy) {
        console.log(`    Strategy ${entry.strategy_id} not found`);
        return false;
      }
      
      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const entryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || exPos.markPrice || entry.entry_price || 0);
      const tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit, side);
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice, rawStoploss, side) : null;
      
      // ConcurrencyManager removed - reservation logic disabled
      // const { concurrencyManager } = await import('../services/ConcurrencyManager.js');
      const reservationToken = entry.reservation_token || null; // Reservation disabled
      
      // Skip reservation check (ConcurrencyManager removed)
      // if (!reservationToken) {
      //   const status = await concurrencyManager.getStatus(botId);
      //   console.log(`    Concurrency limit reached: ${status.currentCount}/${status.maxConcurrent}`);
      //   return false;
      // }
      
      try {
        const position = await Position.create({
          strategy_id: entry.strategy_id,
          bot_id: botId,
          order_id: entry.order_id,
          symbol: entry.symbol,
          side: side,
          entry_price: entryPrice,
          amount: entry.amount,
          take_profit_price: tpPrice,
          stop_loss_price: slPrice,
          current_reduce: strategy.reduce
        });
        
        await EntryOrder.markFilled(entry.id);
        // ConcurrencyManager removed - reservation disabled
        // await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');
        
        console.log(`    ✅ Created Position ${position.id} from entry_order ${entry.id}`);
        return true;
      } catch (posError) {
        // ConcurrencyManager removed - reservation disabled
        // await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
        throw posError;
      }
    }

    // Try to find matching strategy
    const [strategies] = await pool.execute(
      `SELECT * FROM strategies 
       WHERE bot_id = ? AND symbol = ? AND is_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [botId, normalizedSymbol]
    );

    if (strategies.length === 0) {
      console.log(`    No matching strategy found for ${normalizedSymbol}`);
      return false;
    }

    const strategy = strategies[0];
    console.log(`    Found matching strategy ${strategy.id}`);

    const entryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || exPos.markPrice || 0);
    const contracts = exPos.contracts ?? Math.abs(parseFloat(exPos.positionAmt || 0));
    const markPrice = parseFloat(exPos.markPrice || exPos.info?.markPrice || entryPrice || 0);
    const amount = Math.abs(contracts * markPrice);

    const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
    const tpPrice = calculateTakeProfit(entryPrice || markPrice, strategy.take_profit, side);
    const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
    const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
    const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice || markPrice, rawStoploss, side) : null;

    // ConcurrencyManager removed - reservation logic disabled
    // const { concurrencyManager } = await import('../services/ConcurrencyManager.js');
    // const canAccept = await concurrencyManager.canAcceptNewPosition(botId);
    // if (!canAccept) {
    //   const status = await concurrencyManager.getStatus(botId);
    //   console.log(`    Concurrency limit reached: ${status.currentCount}/${status.maxConcurrent}`);
    //   return false;
    // }
    // const reservationToken = await concurrencyManager.reserveSlot(botId);
    // if (!reservationToken) {
    //   const status = await concurrencyManager.getStatus(botId);
    //   console.log(`    Failed to reserve slot: ${status.currentCount}/${status.maxConcurrent}`);
    //   return false;
    // }
    const reservationToken = null; // Reservation disabled

    try {
      const position = await Position.create({
        strategy_id: strategy.id,
        bot_id: botId,
        order_id: `sync_${Date.now()}`,
        symbol: normalizedSymbol,
        side: side,
        entry_price: entryPrice || markPrice,
        amount: amount,
        take_profit_price: tpPrice,
        stop_loss_price: slPrice,
        current_reduce: strategy.reduce
      });

      // ConcurrencyManager removed - reservation disabled
      // await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');
      console.log(`    ✅ Created Position ${position.id} from strategy ${strategy.id}`);
      return true;
    } catch (error) {
      // ConcurrencyManager removed - reservation disabled
      // await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
      throw error;
    }
  } catch (error) {
    console.error(`    Error creating position:`, error?.message || error);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  const opts = parseArgs();
  
  console.log('='.repeat(80));
  console.log('Position Sync Test Script');
  console.log('='.repeat(80));
  console.log(`Mode: ${opts.execute ? 'EXECUTE (will create positions)' : 'DRY-RUN (read-only)'}`);
  console.log(`Bot ID filter: ${opts.botId || 'All active bots'}`);
  console.log(`Verbose: ${opts.verbose}`);
  console.log('='.repeat(80));

  // Load bots
  let bots;
  if (opts.botId) {
    const bot = await Bot.findById(opts.botId);
    bots = bot ? [bot] : [];
  } else {
    bots = await Bot.findAll(true); // Active bots only
  }

  if (bots.length === 0) {
    console.log('No bots found.');
    process.exit(0);
  }

  console.log(`\nFound ${bots.length} bot(s) to test\n`);

  // Initialize ExchangeService for each bot
  const exchangeServices = new Map();
  for (const bot of bots) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      exchangeServices.set(bot.id, exchangeService);
    } catch (error) {
      console.error(`Failed to initialize exchange for bot ${bot.id}:`, error?.message || error);
    }
  }

  // Test each bot
  const results = [];
  for (const bot of bots) {
    const exchangeService = exchangeServices.get(bot.id);
    if (!exchangeService) {
      console.log(`\n⚠️  Skipping bot ${bot.id} (exchange initialization failed)`);
      continue;
    }

    const result = await testBotPositionSync(bot.id, exchangeService, opts);
    results.push({ botId: bot.id, botName: bot.bot_name, ...result });
  }

  // Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('Summary');
  console.log(`${'='.repeat(80)}`);
  
  let totalExchange = 0;
  let totalDB = 0;
  let totalMatched = 0;
  let totalMissing = 0;
  let totalCreated = 0;

  for (const result of results) {
    if (result.success) {
      totalExchange += result.exchangeCount || 0;
      totalDB += result.dbCount || 0;
      totalMatched += result.matched || 0;
      totalMissing += result.missing || 0;
      totalCreated += result.created || 0;
      
      console.log(`\nBot ${result.botId} (${result.botName || 'N/A'}):`);
      console.log(`  Exchange: ${result.exchangeCount || 0}`);
      console.log(`  Database: ${result.dbCount || 0}`);
      console.log(`  Matched: ${result.matched || 0}`);
      console.log(`  Missing: ${result.missing || 0}`);
      if (opts.execute) {
        console.log(`  Created: ${result.created || 0}`);
      }
    } else {
      console.log(`\nBot ${result.botId}: ❌ Error - ${result.error}`);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('Total:');
  console.log(`  Exchange positions: ${totalExchange}`);
  console.log(`  Database positions: ${totalDB}`);
  console.log(`  Matched: ${totalMatched}`);
  console.log(`  Missing: ${totalMissing}`);
  if (opts.execute) {
    console.log(`  Created: ${totalCreated}`);
  }
  console.log(`${'='.repeat(80)}\n`);

  // Cleanup
  for (const exchangeService of exchangeServices.values()) {
    try {
      // ExchangeService cleanup if needed
    } catch (_) {}
  }
}

main()
  .then(() => {
    console.log('Test completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });

