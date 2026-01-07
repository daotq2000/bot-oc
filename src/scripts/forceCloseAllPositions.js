/*
 * Force close all open positions across all bots.
 * - Tries market reduce-only closes first via ExchangeService.closePosition
 * - If market fails (e.g., "best market price out of range"), falls back to
 *   aggressive reduce-only LIMIT orders that should execute immediately.
 *
 * Run: node src/scripts/forceCloseAllPositions.js
 */

import logger from '../utils/logger.js';
import { Position } from '../models/Position.js';
import { Bot } from '../models/Bot.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { calculatePnL } from '../utils/calculator.js';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isOutOfRangeMarketError(msg = '') {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('best market price') ||
    m.includes('out of range') ||
    m.includes('would immediately trigger') ||
    m.includes('-2021') || // Binance: Order would trigger immediately
    m.includes('market not available') ||
    m.includes('no market depth')
  );
}

async function fallbackCloseOnBinance(exchangeService, position, attempt = 1) {
  const client = exchangeService.binanceDirectClient;
  const symbol = position.symbol;
  const side = position.side; // 'long' | 'short'

  // Determine qty we can close
  const qty = await exchangeService.getClosableQuantity(symbol, side);
  if (!qty || qty <= 0) {
    logger.info(`[ForceClose][Binance] No closable qty for ${symbol} ${side}`);
    return { success: true, qtyClosed: 0 };
  }

  // Compute aggressive price
  const current = await client.getPrice(symbol);
  const tickSize = await client.getTickSize(symbol);
  const tick = parseFloat(tickSize);
  const offsetPct = Math.min(10, 2 * attempt); // up to 10%
  const factor = 1 + (offsetPct / 100);
  let limitPrice;
  if (side === 'long') {
    // close with SELL at price below current to make it marketable
    limitPrice = current / factor; // lower
  } else {
    // short -> close with BUY at price above current to make it marketable
    limitPrice = current * factor; // higher
  }

  // Round per tick
  const pricePrecision = client.getPrecisionFromIncrement(tickSize);
  const rounded = Math.max(tick, Math.round(limitPrice / tick) * tick);
  const priceStr = Number(rounded.toFixed(pricePrecision));

  // Build params for LIMIT reduceOnly
  const positionSide = side === 'long' ? 'LONG' : 'SHORT';
  const orderSide = side === 'long' ? 'SELL' : 'BUY';
  const stepSize = await client.getStepSize(symbol);
  const qtyStr = client.formatQuantity(qty, stepSize);

  const dualSide = await client.getDualSidePosition();

  const params = {
    symbol: client.normalizeSymbol(symbol),
    side: orderSide,
    type: 'LIMIT',
    price: priceStr.toString(),
    quantity: qtyStr,
    timeInForce: 'IOC',
    reduceOnly: 'true'
  };
  if (dualSide) params.positionSide = positionSide;

  logger.info(`[ForceClose][Binance] Place LIMIT reduceOnly ${orderSide} ${qtyStr} ${symbol} @ ${priceStr} (attempt=${attempt})`);
  try {
    const data = await client.makeRequest('/fapi/v1/order', 'POST', params, true);
    logger.info(`[ForceClose][Binance] ✅ LIMIT reduceOnly order placed: id=${data?.orderId}`);
    return { success: true, orderId: data?.orderId };
  } catch (e) {
    logger.error(`[ForceClose][Binance] ❌ LIMIT reduceOnly failed: ${e?.message || e}`);
    return { success: false, error: e };
  }
}

async function fallbackCloseOnCcxt(exchangeService, position, attempt = 1) {
  const symbol = position.symbol;
  const side = position.side; // 'long' | 'short'
  const exchange = exchangeService.exchange;
  if (!exchange) {
    return { success: false, error: new Error('No CCXT exchange instance') };
  }

  // Fetch closable qty via positions
  const marketSymbol = exchangeService.formatSymbolForExchange(symbol, 'swap');
  let positions = [];
  try {
    positions = await exchange.fetchPositions(marketSymbol);
  } catch (_) {}
  let pos = Array.isArray(positions) && positions.length > 0 ? positions[0] : null;
  let qty = 0;
  if (pos) {
    qty = (pos.contracts ?? Math.abs(parseFloat(pos.positionAmt || 0))) || 0;
  }
  if (!qty || qty <= 0) {
    logger.info(`[ForceClose][CCXT] No closable qty for ${marketSymbol} ${side}`);
    return { success: true, qtyClosed: 0 };
  }

  const orderSide = side === 'long' ? 'sell' : 'buy';
  // Aggressive price
  const ticker = await exchange.fetchTicker(marketSymbol).catch(() => null);
  const current = Number(ticker?.last || 0);
  const offsetPct = Math.min(10, 2 * attempt);
  const factor = 1 + (offsetPct / 100);
  let price = current;
  if (current > 0) {
    price = side === 'long' ? (current / factor) : (current * factor);
  }
  // Respect precision
  const qtyStr = exchange.amountToPrecision(marketSymbol, qty);
  const priceStr = price && price > 0 ? exchange.priceToPrecision(marketSymbol, price) : undefined;

  const params = { reduceOnly: true, timeInForce: 'IOC' };
  logger.info(`[ForceClose][CCXT] Place LIMIT IOC reduceOnly ${orderSide} ${qtyStr} ${marketSymbol} @ ${priceStr} (attempt=${attempt})`);
  try {
    const data = await exchange.createOrder(marketSymbol, 'limit', orderSide, parseFloat(qtyStr), parseFloat(priceStr), params);
    logger.info(`[ForceClose][CCXT] ✅ LIMIT IOC reduceOnly order placed: id=${data?.id || 'n/a'}`);
    return { success: true, orderId: data?.id };
  } catch (e) {
    logger.error(`[ForceClose][CCXT] ❌ LIMIT IOC reduceOnly failed: ${e?.message || e}`);
    return { success: false, error: e };
  }
}

async function ensureClosed(exchangeService, position, maxAttempts = 5) {
  const symbol = position.symbol;
  const side = position.side;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check remaining qty
    let remaining = 0;
    try {
      remaining = await exchangeService.getClosableQuantity(symbol, side);
    } catch (_) {}
    if (!remaining || remaining <= 0) {
      return true;
    }

    // Fallback attempt depending on exchange
    if (exchangeService.binanceDirectClient) {
      const r = await fallbackCloseOnBinance(exchangeService, position, attempt);
      if (!r.success && attempt === maxAttempts) return false;
    } else if (exchangeService.exchange) {
      const r = await fallbackCloseOnCcxt(exchangeService, position, attempt);
      if (!r.success && attempt === maxAttempts) return false;
    } else {
      return false;
    }

    await sleep(1000 * attempt);
  }
  return false;
}

async function main() {
  try {
    const openPositions = await Position.findOpen();
    if (!openPositions || openPositions.length === 0) {
      logger.info('[ForceClose] No open positions found.');
      return;
    }

    // Group positions by bot_id
    const byBot = new Map();
    for (const p of openPositions) {
      if (!byBot.has(p.bot_id)) byBot.set(p.bot_id, []);
      byBot.get(p.bot_id).push(p);
    }

    logger.info(`[ForceClose] Found ${openPositions.length} open positions across ${byBot.size} bots.`);

    for (const [botId, positions] of byBot.entries()) {
      const bot = await Bot.findById(botId);
      if (!bot) {
        logger.warn(`[ForceClose] Bot ${botId} not found, skipping ${positions.length} positions.`);
        continue;
      }

      // Init exchange service for this bot
      const exSvc = new ExchangeService(bot);
      try {
        await exSvc.initialize();
      } catch (e) {
        logger.error(`[ForceClose] Failed to initialize exchange for bot ${botId}: ${e?.message || e}`);
        continue;
      }

      for (const pos of positions) {
        try {
          logger.info(`[ForceClose] Closing position ${pos.id} ${pos.symbol} ${pos.side} amount=${pos.amount}`);

          // First try built-in market reduce-only close
          try {
            await exSvc.closePosition(pos.symbol, pos.side, pos.amount);
          } catch (e) {
            const msg = e?.message || '';
            if (isOutOfRangeMarketError(msg)) {
              logger.warn(`[ForceClose] Market close failed due to price constraints, applying fallback for ${pos.symbol}`);
              const ok = await ensureClosed(exSvc, pos, 5);
              if (!ok) throw e;
            } else {
              // Try fallback anyway once
              logger.warn(`[ForceClose] Market close failed (${msg}), trying fallback once for ${pos.symbol}`);
              const ok = await ensureClosed(exSvc, pos, 3);
              if (!ok) throw e;
            }
          }

          // Verify closed
          let remaining = 0;
          try { remaining = await exSvc.getClosableQuantity(pos.symbol, pos.side); } catch (_) {}
          if (remaining && remaining > 0) {
            logger.warn(`[ForceClose] Position ${pos.id} may still have remaining qty: ${remaining}.`);
          }

          // Update DB as closed
          const closePrice = await exSvc.getTickerPrice(pos.symbol);
          const pnl = calculatePnL(pos.entry_price, closePrice, pos.amount, pos.side);
          await Position.close(pos.id, closePrice, pnl, 'force_close_script');
          logger.info(`[ForceClose] ✅ Closed position ${pos.id} at ${closePrice} with PnL=${pnl.toFixed(6)} USDT`);
        } catch (e) {
          logger.error(`[ForceClose] ❌ Failed to close position ${pos.id} ${pos.symbol}: ${e?.message || e}`);
        }
      }
    }

    logger.info('[ForceClose] Completed processing all open positions.');
  } catch (e) {
    logger.error(`[ForceClose] Fatal error: ${e?.message || e}`);
  } finally {
    // Allow logs to flush
    await sleep(500);
    process.exit(0);
  }
}

main();

