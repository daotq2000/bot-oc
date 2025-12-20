/*
 * Force close ALL positions from Binance API directly (not from database).
 * This ensures we catch all positions, even if database is out of sync.
 * 
 * Strategy:
 * 1. Get all open positions from Binance API for each bot
 * 2. Force close each position with fallback:
 *    - Try MARKET reduceOnly first
 *    - If fails (price out of range), use LIMIT IOC with aggressive price
 *    - If still fails, use LIMIT GTC with very aggressive price (will fill eventually)
 * 3. Update database to mark positions as closed
 * 
 * Run: node src/scripts/forceCloseAllPositionsFromAPI.js [--bot-id=6] [--dry-run]
 */

import logger from '../utils/logger.js';
import { Position } from '../models/Position.js';
import { Bot } from '../models/Bot.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { calculatePnL } from '../utils/calculator.js';
import { configService } from '../services/ConfigService.js';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isOutOfRangeMarketError(msg = '') {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('best market price') ||
    m.includes('out of range') ||
    m.includes('would immediately trigger') ||
    m.includes('-2021') ||
    m.includes('market not available') ||
    m.includes('no market depth') ||
    m.includes('price precision') ||
    m.includes('quantity precision')
  );
}

/**
 * Force close a Binance position using multiple fallback strategies
 */
async function forceCloseBinancePosition(client, positionData, attempt = 1) {
  const symbol = positionData.symbol;
  const positionAmt = parseFloat(positionData.positionAmt || 0);
  const absAmt = Math.abs(positionAmt);
  
  if (absAmt <= 0) {
    return { success: true, reason: 'no_position' };
  }

  const positionSide = positionData.positionSide || 'BOTH';
  const isLong = positionAmt > 0;
  const orderSide = isLong ? 'SELL' : 'BUY';
  const sideStr = isLong ? 'LONG' : 'SHORT';

  // Get precision info
  const [stepSize, tickSize, currentPrice, dualSide] = await Promise.all([
    client.getStepSize(symbol),
    client.getTickSize(symbol),
    client.getPrice(symbol).catch(() => null),
    client.getDualSidePosition()
  ]);

  logger.info(`[ForceClose] Position mode for ${symbol}: dualSide=${dualSide}, positionSide=${positionSide}`);

  if (!currentPrice || currentPrice <= 0) {
    logger.error(`[ForceClose] Cannot get current price for ${symbol}`);
    return { success: false, error: 'no_price' };
  }

  const tick = parseFloat(tickSize);
  const qtyStr = client.formatQuantity(absAmt, stepSize);
  const qty = parseFloat(qtyStr);
  
  if (qty <= 0) {
    return { success: true, reason: 'qty_too_small' };
  }

  // Strategy 1: Try MARKET reduceOnly
  if (attempt === 1) {
    try {
      logger.info(`[ForceClose] Attempt ${attempt}: MARKET ${dualSide ? 'reduceOnly' : ''} ${orderSide} ${qtyStr} ${symbol}`);
      let order;
      try {
        order = await client.placeMarketOrder(
          symbol,
          orderSide,
          qty,
          dualSide && positionSide !== 'BOTH' ? positionSide : undefined,
          dualSide // reduceOnly only in hedge mode
        );
      } catch (e) {
        // If reduceOnly error, retry without reduceOnly
        if (e?.message?.includes('-1106') && e?.message?.includes('reduceonly')) {
          logger.warn(`[ForceClose] MARKET reduceOnly error, retrying without reduceOnly...`);
          order = await client.placeMarketOrder(
            symbol,
            orderSide,
            qty,
            undefined,
            false // No reduceOnly
          );
        } else {
          throw e;
        }
      }
      
      // Wait a bit and check fill
      await sleep(2000);
      const avgPrice = await client.getOrderAverageFillPrice(symbol, order.orderId).catch(() => null);
      logger.info(`[ForceClose] ✅ MARKET order placed: id=${order.orderId}, avgPrice=${avgPrice || 'n/a'}`);
      return { success: true, orderId: order.orderId, avgPrice };
    } catch (e) {
      const msg = e?.message || '';
      if (isOutOfRangeMarketError(msg)) {
        logger.warn(`[ForceClose] MARKET failed (${msg}), trying LIMIT IOC...`);
      } else {
        logger.warn(`[ForceClose] MARKET failed: ${msg}, trying LIMIT IOC...`);
      }
    }
  }

  // Strategy 2: LIMIT IOC with aggressive price (attempts 2-3)
  if (attempt <= 3) {
    const offsetPct = attempt === 2 ? 2 : 5; // 2% then 5% (reduced to avoid price limit errors)
    const factor = 1 + (offsetPct / 100);
    let limitPrice;
    
    if (isLong) {
      // Close LONG: SELL at price BELOW current (aggressive)
      limitPrice = currentPrice / factor;
    } else {
      // Close SHORT: BUY at price ABOVE current (aggressive)
      // But don't exceed Binance's max price limit (usually current * 1.1 for short close)
      limitPrice = Math.min(currentPrice * factor, currentPrice * 1.1);
    }

    // Round to tick
    const pricePrecision = client.getPrecisionFromIncrement(tickSize);
    const rounded = Math.max(tick, Math.round(limitPrice / tick) * tick);
    const priceStr = Number(rounded.toFixed(pricePrecision));

  const params = {
    symbol: client.normalizeSymbol(symbol),
    side: orderSide,
    type: 'LIMIT',
    price: priceStr.toString(),
    quantity: qtyStr,
    timeInForce: 'IOC'
  };
  // Only add reduceOnly if in hedge mode (dual-side)
  // In one-way mode, closing is done by placing opposite order, reduceOnly not needed
  if (dualSide === true) {
    params.reduceOnly = 'true';
    if (positionSide !== 'BOTH') {
      params.positionSide = positionSide;
    }
    logger.debug(`[ForceClose] Using reduceOnly=true (hedge mode) for ${symbol}`);
  } else {
    logger.debug(`[ForceClose] NOT using reduceOnly (one-way mode) for ${symbol}`);
  }

    try {
      logger.info(`[ForceClose] Attempt ${attempt}: LIMIT IOC ${orderSide} ${qtyStr} ${symbol} @ ${priceStr} (${offsetPct}% ${isLong ? 'below' : 'above'} market)`);
      const order = await client.makeRequest('/fapi/v1/order', 'POST', params, true);
      logger.info(`[ForceClose] ✅ LIMIT IOC order placed: id=${order.orderId}`);
      
      // Wait and check if filled
      await sleep(2000);
      const orderStatus = await client.getOrder(symbol, order.orderId).catch(() => null);
      if (orderStatus?.status === 'FILLED') {
        return { success: true, orderId: order.orderId };
      }
      
      // If not filled, cancel and try next strategy
      try {
        await client.cancelOrder(symbol, order.orderId);
        logger.info(`[ForceClose] Cancelled unfilled IOC order ${order.orderId}`);
      } catch (_) {}
      
    } catch (e) {
      const msg = e?.message || '';
      // If reduceOnly error, retry without reduceOnly
      if (msg.includes('-1106') && msg.includes('reduceonly')) {
        logger.warn(`[ForceClose] reduceOnly error detected, retrying without reduceOnly...`);
        delete params.reduceOnly;
        try {
          const order = await client.makeRequest('/fapi/v1/order', 'POST', params, true);
          logger.info(`[ForceClose] ✅ LIMIT IOC order placed (without reduceOnly): id=${order.orderId}`);
          await sleep(2000);
          const orderStatus = await client.getOrder(symbol, order.orderId).catch(() => null);
          if (orderStatus?.status === 'FILLED') {
            return { success: true, orderId: order.orderId };
          }
        } catch (e2) {
          logger.warn(`[ForceClose] LIMIT IOC retry without reduceOnly also failed: ${e2?.message || e2}`);
        }
      } else if (msg.includes('-4016') && msg.includes('Limit price')) {
        // Price too high/low - try with current market price
        logger.warn(`[ForceClose] Price limit error, trying with market price...`);
        const marketPriceParams = {
          symbol: client.normalizeSymbol(symbol),
          side: orderSide,
          type: 'LIMIT',
          price: currentPrice.toFixed(pricePrecision),
          quantity: qtyStr,
          timeInForce: 'IOC'
        };
        try {
          const order = await client.makeRequest('/fapi/v1/order', 'POST', marketPriceParams, true);
          logger.info(`[ForceClose] ✅ LIMIT IOC order placed (at market price): id=${order.orderId}`);
          await sleep(2000);
          const orderStatus = await client.getOrder(symbol, order.orderId).catch(() => null);
          if (orderStatus?.status === 'FILLED') {
            return { success: true, orderId: order.orderId };
          }
        } catch (e3) {
          logger.warn(`[ForceClose] LIMIT IOC at market price also failed: ${e3?.message || e3}`);
        }
      } else {
        logger.warn(`[ForceClose] LIMIT IOC attempt ${attempt} failed: ${msg}`);
      }
    }
  }

  // Strategy 3: LIMIT GTC with VERY aggressive price (attempts 4+)
  // This will sit on order book and fill eventually
  const offsetPct = Math.min(20, 5 * attempt); // up to 20%
  const factor = 1 + (offsetPct / 100);
  let limitPrice;
  
  if (isLong) {
    limitPrice = currentPrice / factor; // Much lower
  } else {
    limitPrice = currentPrice * factor; // Much higher
  }

  const pricePrecision = client.getPrecisionFromIncrement(tickSize);
  const rounded = Math.max(tick, Math.round(limitPrice / tick) * tick);
  const priceStr = Number(rounded.toFixed(pricePrecision));

  const params = {
    symbol: client.normalizeSymbol(symbol),
    side: orderSide,
    type: 'LIMIT',
    price: priceStr.toString(),
    quantity: qtyStr,
    timeInForce: 'GTC'
  };
  // Only add reduceOnly if in hedge mode (dual-side)
  // In one-way mode, closing is done by placing opposite order, reduceOnly not needed
  if (dualSide === true) {
    params.reduceOnly = 'true';
    if (positionSide !== 'BOTH') {
      params.positionSide = positionSide;
    }
    logger.debug(`[ForceClose] Using reduceOnly=true (hedge mode) for ${symbol}`);
  } else {
    logger.debug(`[ForceClose] NOT using reduceOnly (one-way mode) for ${symbol}`);
  }

  try {
    logger.info(`[ForceClose] Attempt ${attempt}: LIMIT GTC ${orderSide} ${qtyStr} ${symbol} @ ${priceStr} (${offsetPct}% ${isLong ? 'below' : 'above'} market) - will fill eventually`);
    const order = await client.makeRequest('/fapi/v1/order', 'POST', params, true);
    logger.info(`[ForceClose] ✅ LIMIT GTC order placed: id=${order.orderId} (will fill when price reaches)`);
    return { success: true, orderId: order.orderId, pending: true };
  } catch (e) {
    const msg = e?.message || '';
    // If reduceOnly error, retry without reduceOnly
    if (msg.includes('-1106') && msg.includes('reduceonly')) {
      logger.warn(`[ForceClose] reduceOnly error detected, retrying without reduceOnly...`);
      delete params.reduceOnly;
      try {
        const order = await client.makeRequest('/fapi/v1/order', 'POST', params, true);
        logger.info(`[ForceClose] ✅ LIMIT GTC order placed (without reduceOnly): id=${order.orderId} (will fill when price reaches)`);
        return { success: true, orderId: order.orderId, pending: true };
      } catch (e2) {
        logger.error(`[ForceClose] ❌ LIMIT GTC retry without reduceOnly also failed: ${e2?.message || e2}`);
        return { success: false, error: e2 };
      }
      } else if (msg.includes('-4016') && msg.includes('Limit price')) {
        // Price too high/low - try with current market price
        logger.warn(`[ForceClose] Price limit error, trying with market price...`);
        delete params.reduceOnly;
        params.price = currentPrice.toFixed(pricePrecision);
        try {
          const order = await client.makeRequest('/fapi/v1/order', 'POST', params, true);
          logger.info(`[ForceClose] ✅ LIMIT GTC order placed (at market price): id=${order.orderId} (will fill when price reaches)`);
          return { success: true, orderId: order.orderId, pending: true };
        } catch (e3) {
          logger.error(`[ForceClose] ❌ LIMIT GTC at market price also failed: ${e3?.message || e3}`);
          return { success: false, error: e3 };
        }
      } else {
        logger.error(`[ForceClose] ❌ LIMIT GTC failed: ${msg}`);
        return { success: false, error: e };
      }
    }
  }

/**
 * Close all positions for a bot from Binance API
 */
async function closeAllPositionsForBot(bot, dryRun = false) {
  const exSvc = new ExchangeService(bot);
  
  try {
    await exSvc.initialize();
  } catch (e) {
    logger.error(`[ForceClose] Failed to initialize exchange for bot ${bot.id}: ${e?.message || e}`);
    return { success: false, error: e };
  }

  if (!exSvc.binanceDirectClient) {
    logger.warn(`[ForceClose] Bot ${bot.id} is not Binance, skipping`);
    return { success: false, error: 'not_binance' };
  }

  const client = exSvc.binanceDirectClient;
  const baseURL = client.baseURL;
  const isTestnet = client.isTestnet;
  
  logger.info(`[ForceClose] Bot ${bot.id} (${bot.bot_name}): ${isTestnet ? 'TESTNET' : 'PRODUCTION'} - ${baseURL}`);

  // Get all open positions from Binance API
  // Try multiple endpoints in case of permission issues
  let apiPositions = [];
  let fetchError = null;
  
  // Method 1: Try /fapi/v2/positionRisk (standard)
  try {
    apiPositions = await client.getOpenPositions();
    logger.info(`[ForceClose] Found ${apiPositions.length} open positions via positionRisk for bot ${bot.id}`);
  } catch (e) {
    fetchError = e;
    logger.warn(`[ForceClose] positionRisk endpoint failed for bot ${bot.id}: ${e?.message || e}`);
    
      // Method 2: Try /fapi/v2/account to get positions from account info
      try {
        logger.info(`[ForceClose] Trying alternative method: /fapi/v2/account for bot ${bot.id}`);
        const accountData = await client.makeRequest('/fapi/v2/account', 'GET', {}, true);
        if (accountData && accountData.positions && Array.isArray(accountData.positions)) {
          apiPositions = accountData.positions.filter(p => {
            const amt = parseFloat(p.positionAmt || 0);
            return amt !== 0 && !isNaN(amt);
          });
          logger.info(`[ForceClose] Found ${apiPositions.length} open positions via account endpoint for bot ${bot.id}`);
        } else {
          logger.warn(`[ForceClose] Account endpoint returned no positions data`);
        }
      } catch (e2) {
      logger.warn(`[ForceClose] Account endpoint also failed: ${e2?.message || e2}`);
      
      // Method 3: Fallback to database positions if API fails
      logger.warn(`[ForceClose] API endpoints failed, falling back to database positions for bot ${bot.id}`);
      try {
        const dbPositions = await Position.findOpen();
        const botDbPositions = dbPositions.filter(p => p.bot_id === bot.id);
        logger.info(`[ForceClose] Found ${botDbPositions.length} open positions in database for bot ${bot.id}`);
        
        // Convert DB positions to API-like format
        // Note: We'll use getClosableQuantity to get actual qty from exchange
        apiPositions = botDbPositions.map(p => ({
          symbol: p.symbol,
          positionAmt: p.side === 'long' ? p.amount.toString() : `-${p.amount}`,
          positionSide: 'BOTH', // Default, will be determined from account
          _fromDb: true // Flag to indicate this came from DB
        }));
      } catch (e3) {
        logger.error(`[ForceClose] Database fallback also failed: ${e3?.message || e3}`);
        return { success: false, error: fetchError || e3 };
      }
    }
  }
  
  // If no positions found but we have DB positions, use them
  if (apiPositions.length === 0) {
    try {
      const dbPositions = await Position.findOpen();
      const botDbPositions = dbPositions.filter(p => p.bot_id === bot.id);
      if (botDbPositions.length > 0) {
        logger.info(`[ForceClose] Using ${botDbPositions.length} positions from database for bot ${bot.id}`);
        // Convert to API format and get actual qty from exchange
        for (const dbPos of botDbPositions) {
          try {
            const actualQty = await exSvc.getClosableQuantity(dbPos.symbol, dbPos.side);
            if (actualQty && actualQty > 0) {
              apiPositions.push({
                symbol: dbPos.symbol,
                positionAmt: dbPos.side === 'long' ? actualQty.toString() : `-${actualQty}`,
                positionSide: 'BOTH',
                _fromDb: true
              });
            }
          } catch (e) {
            logger.warn(`[ForceClose] Could not get closable qty for ${dbPos.symbol}: ${e?.message || e}`);
          }
        }
      }
    } catch (e) {
      logger.warn(`[ForceClose] Failed to get DB positions: ${e?.message || e}`);
    }
  }
  
  if (apiPositions.length === 0) {
    if (fetchError) {
      logger.error(`[ForceClose] Could not fetch positions from any source for bot ${bot.id}. Last error: ${fetchError?.message || fetchError}`);
      logger.error(`[ForceClose] Please check: 1) API key has 'Enable Reading' permission, 2) IP whitelist includes your server IP, 3) API key is not expired`);
    } else {
      logger.info(`[ForceClose] No open positions found for bot ${bot.id}`);
    }
    return { success: true, closed: 0, total: 0 };
  }

  if (apiPositions.length === 0) {
    logger.info(`[ForceClose] No open positions for bot ${bot.id}`);
    return { success: true, closed: 0 };
  }

  const results = {
    total: apiPositions.length,
    closed: 0,
    failed: 0,
    skipped: 0
  };

  for (const apiPos of apiPositions) {
    const symbol = apiPos.symbol;
    let positionAmt = parseFloat(apiPos.positionAmt || 0);
    
    // If position came from DB, get actual qty from exchange
    if (apiPos._fromDb) {
      try {
        const isLong = positionAmt > 0;
        const side = isLong ? 'long' : 'short';
        const actualQty = await exSvc.getClosableQuantity(symbol, side);
        if (actualQty && actualQty > 0) {
          positionAmt = isLong ? actualQty : -actualQty;
          logger.info(`[ForceClose] Updated qty from exchange: ${symbol} ${side} qty=${actualQty}`);
        } else {
          logger.warn(`[ForceClose] No closable qty found for ${symbol} ${side}, skipping`);
          results.skipped++;
          continue;
        }
      } catch (e) {
        logger.warn(`[ForceClose] Failed to get closable qty for ${symbol}: ${e?.message || e}, using DB value`);
      }
    }
    
    const absAmt = Math.abs(positionAmt);
    
    if (absAmt <= 0) {
      results.skipped++;
      continue;
    }

    const isLong = positionAmt > 0;
    const side = isLong ? 'long' : 'short';
    
    logger.info(`[ForceClose] Processing: ${symbol} ${side} qty=${absAmt} (bot ${bot.id})`);

    if (dryRun) {
      logger.info(`[ForceClose] [DRY-RUN] Would close ${symbol} ${side} qty=${absAmt}`);
      results.closed++;
      continue;
    }

    // Try to close with multiple attempts
    let closed = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await forceCloseBinancePosition(client, apiPos, attempt);
      
      if (result.success) {
        closed = true;
        results.closed++;
        
        // Wait a bit and verify position is closed
        await sleep(2000);
        const remaining = await client.getOpenPositions(symbol).catch(() => []);
        const stillOpen = remaining.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt || 0)) > 0);
        
        if (stillOpen) {
          const remainingQty = Math.abs(parseFloat(stillOpen.positionAmt || 0));
          logger.warn(`[ForceClose] Position ${symbol} still has ${remainingQty} remaining, will retry...`);
          closed = false;
          await sleep(3000);
          continue;
        }
        
        logger.info(`[ForceClose] ✅ Successfully closed ${symbol} ${side} (attempt ${attempt})`);
        break;
      }
      
      if (attempt < 5) {
        await sleep(2000 * attempt);
      }
    }

    if (!closed) {
      results.failed++;
      logger.error(`[ForceClose] ❌ Failed to close ${symbol} ${side} after 5 attempts`);
    }

    // Update database if we have matching position
    try {
      const dbPositions = await Position.findOpenBySymbol(symbol);
      for (const dbPos of dbPositions) {
        if (dbPos.bot_id === bot.id && dbPos.side === side) {
          const closePrice = await exSvc.getTickerPrice(symbol).catch(() => dbPos.entry_price);
          const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, side);
          await Position.close(dbPos.id, closePrice, pnl, 'force_close_from_api');
          logger.info(`[ForceClose] Updated DB position ${dbPos.id} (${symbol} ${side})`);
        }
      }
    } catch (e) {
      logger.warn(`[ForceClose] Failed to update DB for ${symbol}: ${e?.message || e}`);
    }

    await sleep(1000); // Rate limit
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const botIdArg = args.find(a => a.startsWith('--bot-id='));
  const botId = botIdArg ? parseInt(botIdArg.split('=')[1]) : null;
  const dryRun = args.includes('--dry-run');

  try {
    logger.info(`[ForceClose] Starting force close from Binance API${dryRun ? ' (DRY-RUN)' : ''}...`);

    // Load config
    await configService.loadAll();

    // Get bots
    let bots = [];
    if (botId) {
      const bot = await Bot.findById(botId);
      if (bot) bots.push(bot);
      else {
        logger.error(`[ForceClose] Bot ${botId} not found`);
        process.exit(1);
      }
    } else {
      bots = await Bot.findAll(true); // Only active bots
      // Filter to Binance only
      bots = bots.filter(b => b.exchange === 'binance');
    }

    if (bots.length === 0) {
      logger.info('[ForceClose] No Binance bots found');
      return;
    }

    logger.info(`[ForceClose] Processing ${bots.length} bot(s)`);

    const summary = {
      bots: 0,
      totalPositions: 0,
      closed: 0,
      failed: 0,
      skipped: 0
    };

    for (const bot of bots) {
      logger.info(`[ForceClose] ===== Processing bot ${bot.id} (${bot.bot_name}) =====`);
      const result = await closeAllPositionsForBot(bot, dryRun);
      
      if (result.success !== false) {
        summary.bots++;
        summary.totalPositions += result.total || 0;
        summary.closed += result.closed || 0;
        summary.failed += result.failed || 0;
        summary.skipped += result.skipped || 0;
      }
      
      await sleep(2000); // Between bots
    }

    logger.info(`[ForceClose] ===== SUMMARY =====`);
    logger.info(`[ForceClose] Bots processed: ${summary.bots}`);
    logger.info(`[ForceClose] Total positions found: ${summary.totalPositions}`);
    logger.info(`[ForceClose] Closed: ${summary.closed}`);
    logger.info(`[ForceClose] Failed: ${summary.failed}`);
    logger.info(`[ForceClose] Skipped: ${summary.skipped}`);

  } catch (e) {
    logger.error(`[ForceClose] Fatal error: ${e?.message || e}`, e.stack);
  } finally {
    await sleep(1000);
    process.exit(0);
  }
}

main();

