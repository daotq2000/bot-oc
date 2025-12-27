#!/usr/bin/env node
/**
 * Debug script for HMSTRUSDT TP order cancellation issue
 * 
 * Usage:
 *   node scripts/debug_hmstrusdt_tp.js [--watch] [--symbol SYMBOL]
 * 
 * --watch: Monitor in real-time (poll every 5s)
 * --symbol: Symbol to debug (default: HMSTRUSDT)
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import logger from '../src/utils/logger.js';
import { configService } from '../src/services/ConfigService.js';

const SYMBOL = process.argv.includes('--symbol') 
  ? process.argv[process.argv.indexOf('--symbol') + 1]?.toUpperCase()
  : 'HMSTRUSDT';

const WATCH_MODE = process.argv.includes('--watch');

async function getExchangeService(botId) {
  try {
    const { ExchangeService } = await import('../src/services/ExchangeService.js');
    const bot = await Bot.findById(botId);
    if (!bot) return null;
    
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    return exchangeService;
  } catch (e) {
    logger.error(`Failed to get ExchangeService for bot ${botId}: ${e?.message || e}`);
    return null;
  }
}

async function checkPosition() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log(`🔍 DEBUG HMSTRUSDT TP ORDER | ${new Date().toISOString()}`);
    console.log('='.repeat(80));

    // 1. Find position
    const positions = await Position.findAll({
      where: {
        symbol: SYMBOL,
        status: 'open'
      },
      order: [['opened_at', 'DESC']],
      limit: 5
    });

    if (positions.length === 0) {
      console.log(`❌ No open positions found for ${SYMBOL}`);
      
      // Check closed positions too
      const closedPositions = await Position.findAll({
        where: {
          symbol: SYMBOL,
          status: 'closed'
        },
        order: [['opened_at', 'DESC']],
        limit: 5
      });
      
      if (closedPositions.length > 0) {
        console.log(`\n📋 Found ${closedPositions.length} recently closed position(s) for ${SYMBOL}\n`);
        for (const pos of closedPositions.slice(0, 3)) {
          console.log(`  Position ${pos.id}: ${pos.side} | Entry: ${pos.entry_price} | TP: ${pos.take_profit_price} | Exit Order ID: ${pos.exit_order_id || 'NULL'}`);
        }
      }
      
      return;
    }

    console.log(`\n📊 Found ${positions.length} open position(s) for ${SYMBOL}\n`);

    for (const pos of positions) {
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`Position ID: ${pos.id}`);
      console.log(`Symbol: ${pos.symbol}`);
      console.log(`Side: ${pos.side}`);
      console.log(`Status: ${pos.status}`);
      console.log(`Entry Price: ${pos.entry_price}`);
      console.log(`Take Profit Price: ${pos.take_profit_price}`);
      console.log(`Initial TP Price: ${pos.initial_tp_price || 'N/A'}`);
      console.log(`Exit Order ID: ${pos.exit_order_id || 'NULL'}`);
      console.log(`SL Order ID: ${pos.sl_order_id || 'NULL'}`);
      console.log(`Opened At: ${pos.opened_at}`);
      console.log(`Minutes Elapsed: ${pos.minutes_elapsed || 0}`);
      console.log(`TP/SL Pending: ${pos.tp_sl_pending || false}`);
      console.log(`Is Processing: ${pos.is_processing || false}`);

      // 2. Get strategy
      if (pos.strategy_id) {
        const strategy = await Strategy.findById(pos.strategy_id);
        if (strategy) {
          console.log(`\n📈 Strategy:`);
          console.log(`  Take Profit: ${strategy.take_profit}%`);
          console.log(`  Reduce: ${strategy.reduce}%`);
          console.log(`  Up Reduce: ${strategy.up_reduce}%`);
          console.log(`  Stop Loss: ${strategy.stoploss || 'N/A'}`);
          console.log(`  Interval: ${strategy.interval}`);
        }
      }

      // 3. Check exchange orders
      if (pos.bot_id && pos.exit_order_id) {
        console.log(`\n🔍 Checking exchange order status...`);
        try {
          const exchangeService = await getExchangeService(pos.bot_id);
          if (exchangeService) {
            // Check exit order status
            try {
              const orderStatus = await exchangeService.getOrderStatus(pos.symbol, pos.exit_order_id);
              console.log(`\n✅ Exit Order Status:`);
              console.log(`  Order ID: ${pos.exit_order_id}`);
              console.log(`  Status: ${orderStatus?.status || 'UNKNOWN'}`);
              console.log(`  Type: ${orderStatus?.type || 'N/A'}`);
              console.log(`  Side: ${orderStatus?.side || 'N/A'}`);
              console.log(`  Stop Price: ${orderStatus?.stopPrice || orderStatus?.price || 'N/A'}`);
              console.log(`  Quantity: ${orderStatus?.origQty || orderStatus?.executedQty || 'N/A'}`);
              console.log(`  Time: ${orderStatus?.time || orderStatus?.updateTime || 'N/A'}`);
            } catch (e) {
              console.log(`\n❌ Failed to get exit order status: ${e?.message || e}`);
              console.log(`  Order ID: ${pos.exit_order_id}`);
              console.log(`  Error: ${e?.stack || 'N/A'}`);
            }

            // Get all open orders for this symbol
            try {
              const openOrders = await exchangeService.getOpenOrders(pos.symbol);
              const exitOrders = openOrders.filter(o => 
                (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET') &&
                o.reduceOnly === true
              );
              
              console.log(`\n📋 Open Exit Orders on Exchange (${exitOrders.length}):`);
              if (exitOrders.length === 0) {
                console.log(`  ⚠️ NO EXIT ORDERS FOUND ON EXCHANGE!`);
                console.log(`  DB has exit_order_id=${pos.exit_order_id}, but exchange has none.`);
                console.log(`  This indicates the order was cancelled or filled.`);
              } else {
                exitOrders.forEach((order, idx) => {
                  console.log(`\n  Order ${idx + 1}:`);
                  console.log(`    Order ID: ${order.orderId}`);
                  console.log(`    Type: ${order.type}`);
                  console.log(`    Side: ${order.side}`);
                  console.log(`    Stop Price: ${order.stopPrice || order.price || 'N/A'}`);
                  console.log(`    Quantity: ${order.origQty || 'N/A'}`);
                  console.log(`    Status: ${order.status || 'N/A'}`);
                  console.log(`    Time: ${order.time || order.updateTime || 'N/A'}`);
                  console.log(`    Matches DB: ${order.orderId === pos.exit_order_id ? '✅ YES' : '❌ NO'}`);
                });
              }
            } catch (e) {
              console.log(`\n⚠️ Failed to get open orders: ${e?.message || e}`);
            }

            // Get current market price
            try {
              const currentPrice = await exchangeService.getTickerPrice(pos.symbol);
              console.log(`\n💹 Current Market Price: ${currentPrice}`);
              if (pos.take_profit_price) {
                const tpDistance = pos.side === 'long' 
                  ? ((pos.take_profit_price - currentPrice) / currentPrice * 100)
                  : ((currentPrice - pos.take_profit_price) / currentPrice * 100);
                console.log(`  Distance to TP: ${tpDistance.toFixed(3)}%`);
              }
            } catch (e) {
              console.log(`\n⚠️ Failed to get current price: ${e?.message || e}`);
            }
          }
        } catch (e) {
          console.log(`\n❌ Failed to initialize ExchangeService: ${e?.message || e}`);
        }
      } else {
        if (!pos.exit_order_id) {
          console.log(`\n⚠️ No exit_order_id in DB - order may not have been placed yet`);
        }
        if (!pos.bot_id) {
          console.log(`\n⚠️ No bot_id - cannot check exchange`);
        }
      }

      // 4. Check recent logs (if available)
      console.log(`\n📝 Recent Activity:`);
      console.log(`  Last updated: ${pos.updated_at || 'N/A'}`);
      console.log(`  Minutes elapsed: ${pos.minutes_elapsed || 0}`);
      
      // Calculate time since opened
      if (pos.opened_at) {
        const openedAt = new Date(pos.opened_at);
        const now = new Date();
        const minutesSinceOpened = Math.floor((now - openedAt) / 1000 / 60);
        console.log(`  Time since opened: ${minutesSinceOpened} minutes`);
      }
    }

    console.log(`\n${'='.repeat(80)}\n`);

  } catch (error) {
    console.error(`\n❌ Error: ${error?.message || error}`);
    console.error(error?.stack || '');
  }
}

async function main() {
  await checkPosition();

  if (WATCH_MODE) {
    console.log(`\n👀 Watch mode enabled - polling every 5 seconds...\n`);
    setInterval(async () => {
      await checkPosition();
    }, 5000);
  } else {
    process.exit(0);
  }
}

main().catch(console.error);

