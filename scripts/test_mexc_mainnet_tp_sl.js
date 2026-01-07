#!/usr/bin/env node
/**
 * Test MEXC mainnet order flow: entry + TP + SL (reduce-only)
 * 
 * Usage:
 *  node scripts/test_mexc_mainnet_tp_sl.js \
 *    --symbol BTCUSDT \
 *    --side long \
 *    --amount 5 \
 *    --oc 2 \
 *    --take_profit 50 \
 *    --reduce 5 \
 *    --confirm
 * 
 * Required env:
 *  - MEXC_API_KEY, MEXC_SECRET_KEY, MEXC_UID
 * Notes:
 *  - This WILL place real orders on MEXC mainnet if --confirm provided.
 *  - Without --confirm, script runs in dry-run mode and prints the plan only.
 */

import dotenv from 'dotenv';
// simple argv parser (no external deps)
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true; // flag
      } else {
        out[key] = next;
        i++;
      }
    } else if (a.startsWith('-')) {
      const key = a.replace(/^-+/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        out[key] = true; // flag
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

import logger from '../src/utils/logger.js';
import { ExchangeService } from '../src/services/ExchangeService.js';

dotenv.config();

const args = parseArgs(process.argv.slice(2));

function usage(msg = null) {
  if (msg) console.error(`Error: ${msg}`);
  console.log(`\nUsage: node scripts/test_mexc_mainnet_tp_sl.js --symbol BTCUSDT --side long|short --amount 5 --oc 2 --take_profit 50 --reduce 5 [--confirm]\n`);
  process.exit(msg ? 1 : 0);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeSymbol(sym) {
  if (!sym) return null;
  const s = String(sym).toUpperCase().replace(/[\/:_]/g, '').replace(/USD$/, 'USDT');
  return s;
}

async function main() {
  const symbolArg = normalizeSymbol(args.symbol || args.s);
  const side = String(args.side || args.d || '').toLowerCase();
  const amount = Number(args.amount || args.a);
  const oc = Number(args.oc || 2);
  const take_profit = Number(args.take_profit || args.tp || 50);
  const reduce = Number(args.reduce || args.r || 5);
  const confirm = !!args.confirm;

  if (!symbolArg) usage('Missing --symbol');
  if (!['long', 'short'].includes(side)) usage('Missing/invalid --side');
  if (!Number.isFinite(amount) || amount <= 0) usage('Missing/invalid --amount (USDT)');

  // Resolve bot credentials: prefer --bot_id from DB, else use ENV
  const botIdArg = Number(args.bot_id || args.botId || args.b);
  let bot = null;
  if (Number.isFinite(botIdArg) && botIdArg > 0) {
    const { Bot } = await import('../src/models/Bot.js');
    bot = await Bot.findById(botIdArg);
    if (!bot) {
      console.error(`Bot id ${botIdArg} not found in database`);
      process.exit(1);
    }
    if ((bot.exchange || '').toLowerCase() !== 'mexc') {
      console.error(`Bot id ${botIdArg} is not a MEXC bot (exchange=${bot.exchange})`);
      process.exit(1);
    }
    console.log(`[INFO] Using bot from DB: id=${bot.id}, name=${bot.bot_name || 'N/A'}`);
  } else {
    const apiKey = process.env.MEXC_API_KEY;
    const secret = process.env.MEXC_SECRET_KEY;
    const uid = process.env.MEXC_UID;
    if (!apiKey || !secret || !uid) {
      console.error('Missing MEXC_API_KEY / MEXC_SECRET_KEY / MEXC_UID in environment');
      process.exit(1);
    }
    // Build bot object (mainnet)
    bot = {
      id: 9001,
      exchange: 'mexc',
      access_key: apiKey,
      secret_key: secret,
      uid: uid,
      is_active: 1
    };
    console.log(`[INFO] Using bot from ENV (id=${bot.id})`);
  }

  const exSvc = new ExchangeService(bot);
  await exSvc.initialize();

  // Path info & verbose toggle
  const directOn = !!(exSvc?.mexcFuturesClient?.enableDirect);
  const verbose = !!(args.verbose || args.v);
  if (directOn && exSvc?.mexcFuturesClient) {
    exSvc.mexcFuturesClient.verbose = verbose;
  }
  console.log(`[Path] MEXC Futures: ${directOn ? 'Direct REST (signed)' : 'CCXT'}`);
  if (verbose) console.log('[Verbose] REST request/response logging enabled (masked)');

  // Preflight (catch 1002 Contract not activated) before placing any order
  try {
    if (exSvc?.mexcFuturesClient?.preflight) {
      const pf = await exSvc.mexcFuturesClient.preflight(symbolArg);
      if (!pf.ok) {
        const code = pf.code;
        const msg = pf.message || 'Unknown error';
        if (String(code) === '1002') {
          console.error(`\n[Preflight] Contract not activated (code=1002).`);
          console.error(`- Kích hoạt Futures/Contract trong tài khoản MEXC (Open/Activate + Risk Agreement).`);
          console.error(`- Tạo API key có quyền Futures Order Placing (không chỉ View).`);
          console.error(`- Nếu dùng IP whitelist: thêm IP máy chủ.`);
          process.exit(1);
        } else {
          console.warn(`[Preflight] Warning: code=${code}, msg=${msg}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[Preflight] Skipped due to error: ${e?.message || e}`);
  }

  // --- Balance check (Futures first) ---
  console.log('\n[0] Checking balances (Futures and Spot)...');
  let futBal = await exSvc.getBalance('future').catch(() => ({ free: 0, used: 0, total: 0 }));
  let spotBal = await exSvc.getBalance('spot').catch(() => ({ free: 0, used: 0, total: 0 }));
  const futFree = Number(futBal?.free || 0);
  const spotFree = Number(spotBal?.free || 0);
  console.log(`Futures free: ${futFree} USDT | Spot free: ${spotFree} USDT`);

  if (!Number.isFinite(futFree)) {
    throw new Error('Failed to fetch Futures balance');
  }

  // If insufficient futures balance, optionally auto-transfer from spot when --auto_transfer
  const shortfall = Math.max(0, amount - futFree);
  const autoTransfer = !!args.auto_transfer || !!args.autotransfer || !!args.at;
  if (shortfall > 0) {
    if (autoTransfer) {
      if (spotFree >= shortfall) {
        console.log(`[0] Auto-transfer ${shortfall} USDT from Spot -> Futures...`);
        try {
          await exSvc.transferSpotToFuture(shortfall);
          // re-fetch balances
          futBal = await exSvc.getBalance('future');
          console.log(`[0] New Futures free: ${Number(futBal?.free || 0)} USDT`);
        } catch (e) {
          console.error(`[0] Auto-transfer failed: ${e?.message || e}`);
          throw e;
        }
      } else {
        throw new Error(`Insufficient futures balance (${futFree}) and spot balance (${spotFree}) < shortfall (${shortfall}).`);
      }
    } else {
      throw new Error(`Insufficient futures balance: need ${amount} USDT, have ${futFree} USDT. Add --auto_transfer to move from spot if available.`);
    }
  }

  // Helper to fetch current price with robust fallbacks (WS -> REST swap -> REST spot)
  async function getCurrentPriceOrThrow(exSvc, symbol) {
    // 1) Try service helper (WS-first)
    try {
      const p = await exSvc.getTickerPrice(symbol);
      if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
    } catch (_) {}

    // 2) Try REST swap via CCXT
    try {
      const swapSym = exSvc.formatSymbolForExchange(symbol, 'swap');
      const t = await exSvc.exchange.fetchTicker(swapSym);
      const p = t?.last;
      if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
    } catch (_) {}

    // 3) Try REST spot via CCXT (public)
    try {
      const spot = new (await import('ccxt')).default.mexc({ enableRateLimit: true });
      // Force .co domain to bypass regional blocks
      try {
        if ('hostname' in spot) spot.hostname = 'mexc.co';
        const deepReplace = (obj) => {
          if (!obj) return obj;
          if (typeof obj === 'string') return obj.replace(/mexc\.com/g, 'mexc.co');
          if (Array.isArray(obj)) return obj.map(deepReplace);
          if (typeof obj === 'object') { for (const k of Object.keys(obj)) obj[k] = deepReplace(obj[k]); return obj; }
          return obj;
        };
        spot.urls = deepReplace(spot.urls || {});
      } catch (_) {}
      try { await spot.loadMarkets(); } catch (_) {}
      const base = String(symbol).toUpperCase().replace(/[\/:_]/g, '').replace(/USDT$/, '');
      const spotSym = `${base}/USDT`;
      const t = await spot.fetchTicker(spotSym);
      const p = t?.last;
      if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
    } catch (_) {}

    throw new Error(`Cannot fetch current price for ${symbol}`);
  }

  // Fetch current price for reference
  const current = await getCurrentPriceOrThrow(exSvc, symbolArg);
  if (!Number.isFinite(Number(current)) || Number(current) <= 0) {
    throw new Error(`Cannot fetch current price for ${symbolArg}`);
  }

  // Import strategy calculator helpers
  const { calculateTakeProfit, calculateInitialStopLoss } = await import('../src/utils/calculator.js');

  console.log('\n=== Test Plan (MEXC mainnet) ===');
  console.log(`Symbol      : ${symbolArg}`);
  console.log(`Side        : ${side.toUpperCase()}`);
  console.log(`Amount (USDT): ${amount}`);
  console.log(`Current     : ${current}`);
  console.log(`Strategy    : OC=${oc}%, TP=${take_profit}, Reduce=${reduce}`);
  console.log(`Mode        : ${confirm ? 'CONFIRMED - WILL PLACE REAL ORDERS' : 'DRY-RUN'}`);

  if (!confirm) {
    console.log('\nPass --confirm to place real orders.');
    process.exit(0);
  }

  // 1) Place entry MARKET order
  console.log('\n[1] Placing ENTRY MARKET order...');
  // Re-fetch current price right before order to avoid null from WS cache
  const liveCurrent = await getCurrentPriceOrThrow(exSvc, symbolArg);

  // Pre-validate against exchange limits and auto-scale amount if necessary
  try {
    const marketSymbol = exSvc.formatSymbolForExchange(symbolArg, 'swap');
    const market = exSvc.exchange.market(marketSymbol);
    const plannedQtyRaw = Number(amount) / Number(liveCurrent);
    const plannedQtyStr = exSvc.exchange.amountToPrecision(marketSymbol, plannedQtyRaw);
    const plannedQty = parseFloat(plannedQtyStr);

    const maxQty = Number(market?.limits?.amount?.max);
    let minQty = Number(market?.limits?.amount?.min);
    const minCost = Number(market?.limits?.cost?.min);

    // Fallback for MEXC futures when minQty is missing but CCXT enforces min contracts=1
    if (!Number.isFinite(minQty) && (bot.exchange || '').toLowerCase() === 'mexc') {
      if (plannedQty < 1) {
        minQty = 1;
        console.log(`[1] CCXT minQty not provided; assume min contracts=1 for MEXC futures`);
      }
    }

    let scaledAmount = amount;

    if (Number.isFinite(maxQty) && plannedQty > maxQty) {
      const autoScale = !!args.auto_scale || !!args.autoscale || !!args.as;
      const suggestedAmount = maxQty * Number(liveCurrent);
      if (!autoScale) {
        throw new Error(`Planned qty ${plannedQty} > maxQty ${maxQty}. Suggest --auto_scale or lower amount to ~= ${suggestedAmount.toFixed(8)} USDT`);
      }
      scaledAmount = suggestedAmount;
      console.log(`[1] Auto-scale amount to ${scaledAmount.toFixed(8)} USDT to respect maxQty=${maxQty}`);
    }

    if (Number.isFinite(minQty) && plannedQty < minQty) {
      const requiredAmount = minQty * Number(liveCurrent);
      console.log(`[1] Planned qty ${plannedQty} < minQty ${minQty}. Bumping amount to ${requiredAmount.toFixed(8)} USDT`);
      scaledAmount = Math.max(scaledAmount, requiredAmount);
    }

    if (Number.isFinite(minCost)) {
      const minAmount = Math.max(Number(minCost), 0);
      if (scaledAmount < minAmount) {
        console.log(`[1] Amount ${scaledAmount} < minCost ${minCost}. Bumping amount to ${minAmount}`);
        scaledAmount = minAmount;
      }
    }

    // Place order with scaledAmount
    const order = await exSvc.createOrder({
      symbol: symbolArg,
      side: side === 'long' ? 'buy' : 'sell',
      amount: scaledAmount,
      type: 'market',
      price: liveCurrent
    });

    // Continue with order flow using 'order' below
    const entryFill = Number(order?.avgFillPrice || order?.price || liveCurrent);
    if (!Number.isFinite(entryFill) || entryFill <= 0) {
      throw new Error(`Invalid entry fill price from order: ${JSON.stringify(order)}`);
    }
    console.log(`[OK] Entry placed. OrderId=${order?.id || 'N/A'} Entry=${entryFill}`);

    // 2) Determine open contracts (position size)
    console.log('[2] Fetching open positions to get contracts...');
    const positions = await exSvc.getOpenPositions();
    const sym = exSvc.formatSymbolForExchange(symbolArg, 'swap');
    let pos = null;
    if (Array.isArray(positions)) {
      pos = positions.find(p => p.symbol === sym || p.symbol === symbolArg || p.info?.symbol === sym || p.info?.symbol === symbolArg);
      if (!pos) pos = positions.find(p => String(p.symbol || '').includes(symbolArg.replace('USDT', '')));
    }
    if (!pos) {
      throw new Error(`Cannot locate open position after entry for ${symbolArg}. Positions: ${JSON.stringify(positions || [])}`);
    }
    const contracts = Number(pos.contracts || Math.abs(parseFloat(pos.positionAmt || 0)) || 0);
    if (!Number.isFinite(contracts) || contracts <= 0) {
      throw new Error(`Invalid contracts for open position: ${JSON.stringify(pos)}`);
    }
    console.log(`[OK] Open contracts: ${contracts}`);

    // 3) Compute TP & SL from strategy formulae (using entry fill as base)
    const tpPrice = calculateTakeProfit(entryFill, oc, take_profit, side);
    const slPrice = calculateInitialStopLoss(tpPrice, oc, reduce, side);

    const closeSide = side === 'long' ? 'sell' : 'buy';
    const reduceParams = { reduceOnly: true };

    // 4) Place TP reduce-only LIMIT
    console.log(`[3] Placing TP LIMIT reduce-only at ${tpPrice} ...`);
    try {
      const tpOrder = await exSvc.exchange.createOrder(
        exSvc.formatSymbolForExchange(symbolArg, 'swap'),
        'limit',
        closeSide,
        contracts,
        tpPrice,
        reduceParams
      );
      console.log(`[OK] TP order created: ${tpOrder?.id || 'N/A'}`);
    } catch (e) {
      console.error(`[WARN] Failed to create TP LIMIT reduce-only: ${e?.message || e}`);
    }

    // 5) Place SL reduce-only (try conditional/stop; fallback to LIMIT)
    console.log(`[4] Placing SL (reduce-only) near ${slPrice} ...`);
    let slPlaced = false;
    try {
      const params = { reduceOnly: true, stopLossPrice: slPrice };
      const slOrder = await exSvc.exchange.createOrder(
        exSvc.formatSymbolForExchange(symbolArg, 'swap'),
        'market',
        closeSide,
        contracts,
        undefined,
        params
      );
      console.log(`[OK] SL STOP-MARKET created (if supported): ${slOrder?.id || 'N/A'}`);
      slPlaced = true;
    } catch (e) {
      console.warn(`[WARN] STOP-MARKET SL not supported or failed: ${e?.message || e}`);
    }

    if (!slPlaced) {
      try {
        const slOrder2 = await exSvc.exchange.createOrder(
          exSvc.formatSymbolForExchange(symbolArg, 'swap'),
          'limit',
          closeSide,
          contracts,
          slPrice,
          reduceParams
        );
        console.log(`[OK] Fallback SL LIMIT created: ${slOrder2?.id || 'N/A'}`);
      } catch (e2) {
        console.error(`[ERR] Failed to place any SL order: ${e2?.message || e2}`);
      }
    }

    console.log('\n=== Done. Verify on MEXC Futures mainnet UI. ===');

    return; // done
  } catch (e) {
    // Forward to outer catch
    throw e;
  }

  const entryFill = Number(order?.avgFillPrice || order?.price || current);
  if (!Number.isFinite(entryFill) || entryFill <= 0) {
    throw new Error(`Invalid entry fill price from order: ${JSON.stringify(order)}`);
  }
  console.log(`[OK] Entry placed. OrderId=${order?.id || 'N/A'} Entry=${entryFill}`);

  // 2) Determine open contracts (position size)
  console.log('[2] Fetching open positions to get contracts...');
  const positions = await exSvc.getOpenPositions();
  const sym = exSvc.formatSymbolForExchange(symbolArg, 'swap');
  let pos = null;
  if (Array.isArray(positions)) {
    // Normalize matches by symbol (MEXC may differ), fallback by endsWith
    pos = positions.find(p => p.symbol === sym || p.symbol === symbolArg || p.info?.symbol === sym || p.info?.symbol === symbolArg);
    if (!pos) pos = positions.find(p => String(p.symbol || '').includes(symbolArg.replace('USDT', '')));
  }
  if (!pos) {
    throw new Error(`Cannot locate open position after entry for ${symbolArg}. Positions: ${JSON.stringify(positions || [])}`);
  }
  const contracts = Number(pos.contracts || Math.abs(parseFloat(pos.positionAmt || 0)) || 0);
  if (!Number.isFinite(contracts) || contracts <= 0) {
    throw new Error(`Invalid contracts for open position: ${JSON.stringify(pos)}`);
  }
  console.log(`[OK] Open contracts: ${contracts}`);

  // 3) Compute TP & SL from strategy formulae (using entry fill as base)
  const tpPrice = calculateTakeProfit(entryFill, oc, take_profit, side);
  const slPrice = calculateInitialStopLoss(tpPrice, oc, reduce, side);

  const closeSide = side === 'long' ? 'sell' : 'buy';
  const reduceParams = { reduceOnly: true };

  // 4) Place TP reduce-only LIMIT
  console.log(`[3] Placing TP LIMIT reduce-only at ${tpPrice} ...`);
  try {
    const tpOrder = await exSvc.exchange.createOrder(
      exSvc.formatSymbolForExchange(symbolArg, 'swap'),
      'limit',
      closeSide,
      contracts,
      tpPrice,
      reduceParams
    );
    console.log(`[OK] TP order created: ${tpOrder?.id || 'N/A'}`);
  } catch (e) {
    console.error(`[WARN] Failed to create TP LIMIT reduce-only: ${e?.message || e}`);
  }

  // 5) Place SL reduce-only (try conditional/stop; fallback to LIMIT)
  console.log(`[4] Placing SL (reduce-only) near ${slPrice} ...`);
  let slPlaced = false;
  try {
    // Attempt conditional STOP-MARKET if supported by CCXT params
    const params = { reduceOnly: true, stopLossPrice: slPrice };
    const slOrder = await exSvc.exchange.createOrder(
      exSvc.formatSymbolForExchange(symbolArg, 'swap'),
      'market',
      closeSide,
      contracts,
      undefined,
      params
    );
    console.log(`[OK] SL STOP-MARKET created (if supported): ${slOrder?.id || 'N/A'}`);
    slPlaced = true;
  } catch (e) {
    console.warn(`[WARN] STOP-MARKET SL not supported or failed: ${e?.message || e}`);
  }

  if (!slPlaced) {
    try {
      // Fallback to reduce-only LIMIT at SL price (may not behave as true stop)
      const slOrder2 = await exSvc.exchange.createOrder(
        exSvc.formatSymbolForExchange(symbolArg, 'swap'),
        'limit',
        closeSide,
        contracts,
        slPrice,
        reduceParams
      );
      console.log(`[OK] Fallback SL LIMIT created: ${slOrder2?.id || 'N/A'}`);
    } catch (e2) {
      console.error(`[ERR] Failed to place any SL order: ${e2?.message || e2}`);
    }
  }

  console.log('\n=== Done. Verify on MEXC Futures mainnet UI. ===');
}

main().catch(err => {
  console.error('Fatal error:', err?.message || err);
  process.exit(1);
});

