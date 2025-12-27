#!/usr/bin/env node
/**
 * Verify trailing TP runtime behavior.
 *
 * Dry-run by default: only computes time gating exactly like PositionService.
 * Optional: --run to actually call PositionService.updatePosition once.
 *
 * Usage:
 *   node scripts/verify_trailing_tp_runtime.js --pos 123
 *   node scripts/verify_trailing_tp_runtime.js --symbol BTCUSDT
 *   node scripts/verify_trailing_tp_runtime.js --symbol BTCUSDT --run
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import pool from '../src/config/database.js';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const posId = Number(argValue('--pos') || 0) || null;
const symbolArg = argValue('--symbol');
const doRun = process.argv.includes('--run');

async function fetchAnyOpenPosition() {
  const [rows] = await pool.execute(
    `SELECT p.*
     FROM positions p
     WHERE p.status = 'open'
     ORDER BY p.opened_at DESC
     LIMIT 1`
  );
  return rows?.[0] || null;
}

async function fetchOpenPositionBySymbol(symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
  // positions.symbol is stored normalized in many places (BTCUSDT). We'll try multiple matching patterns.
  const [rows] = await pool.execute(
    `SELECT p.*
     FROM positions p
     WHERE p.status = 'open'
       AND (REPLACE(REPLACE(REPLACE(UPPER(p.symbol), '/', ''), ':', ''), '_', '') = ?
            OR UPPER(p.symbol) = ?
            OR UPPER(p.symbol) = ?)
     ORDER BY p.opened_at DESC
     LIMIT 1`,
    [sym, sym, `${sym}/USDT`]
  );
  return rows?.[0] || null;
}

async function main() {
  console.log('='.repeat(90));
  console.log('VERIFY TRAILING TP RUNTIME');
  console.log('='.repeat(90));

  let position;
  if (posId) {
    position = await Position.findById(posId);
  } else if (symbolArg) {
    position = await fetchOpenPositionBySymbol(symbolArg);
  } else {
    position = await fetchAnyOpenPosition();
  }

  if (!position) {
    console.log('No open position found for the given selector.');
    process.exit(1);
  }

  const strategy = await Strategy.findById(position.strategy_id);
  if (!strategy) {
    console.log(`Strategy ${position.strategy_id} not found.`);
    process.exit(1);
  }

  console.log('\n[DB Position]');
  console.log({
    id: position.id,
    bot_id: position.bot_id,
    symbol: position.symbol,
    side: position.side,
    entry_price: position.entry_price,
    take_profit_price: position.take_profit_price,
    initial_tp_price: position.initial_tp_price,
    minutes_elapsed: position.minutes_elapsed,
    opened_at: position.opened_at,
    exit_order_id: position.exit_order_id,
    status: position.status,
  });

  console.log('\n[Strategy]');
  console.log({
    id: strategy.id,
    interval: strategy.interval,
    take_profit: strategy.take_profit,
    reduce: strategy.reduce,
    up_reduce: strategy.up_reduce,
    stoploss: strategy.stoploss,
  });

  // Replicate time-gating logic
  const prevMinutes = Number(position.minutes_elapsed || 0);
  let openedAtMs = null;
  let useTimeBased = true;

  if (position.opened_at) {
    openedAtMs = new Date(position.opened_at).getTime();
    if (Number.isNaN(openedAtMs)) {
      useTimeBased = false;
    }
  } else {
    useTimeBased = false;
  }

  const now = Date.now();
  let actualMinutesElapsed;
  let willSkip = false;
  let reason = '';

  if (useTimeBased) {
    const actualRaw = Math.floor((now - openedAtMs) / 60000);
    actualMinutesElapsed = actualRaw;

    if (actualMinutesElapsed <= prevMinutes) {
      willSkip = true;
      reason = `SKIP: actualMinutesElapsed(${actualMinutesElapsed}) <= prevMinutes(${prevMinutes})`;
    } else {
      const minutesToProcess = Math.min(actualMinutesElapsed - prevMinutes, 1);
      actualMinutesElapsed = prevMinutes + minutesToProcess;
      reason = `MOVE: actualMinutesElapsedRaw=${actualRaw} prevMinutes=${prevMinutes} -> processing 1 step => targetMinutes=${actualMinutesElapsed}`;
    }
  } else {
    actualMinutesElapsed = prevMinutes + 1;
    reason = `MOVE (fallback): opened_at invalid => prevMinutes=${prevMinutes} -> targetMinutes=${actualMinutesElapsed}`;
  }

  console.log('\n[Time gating]');
  console.log({
    now,
    openedAtMs,
    useTimeBased,
    prevMinutes,
    actualMinutesElapsed,
    willSkip,
    reason,
    diffMs: openedAtMs ? now - openedAtMs : null,
    diffSec: openedAtMs ? Math.floor((now - openedAtMs) / 1000) : null,
  });

  if (!doRun) {
    console.log('\nDry-run only. Add --run to execute PositionService.updatePosition once.');
    return;
  }

  console.log('\n[RUN] Executing PositionService.updatePosition(position) once...');
  const { Bot } = await import('../src/models/Bot.js');
  const { ExchangeService } = await import('../src/services/ExchangeService.js');
  const { PositionService } = await import('../src/services/PositionService.js');

  const bot = await Bot.findById(position.bot_id);
  if (!bot) {
    console.log(`Bot ${position.bot_id} not found.`);
    process.exit(1);
  }

  const exchangeService = new ExchangeService(bot);
  await exchangeService.initialize();
  const positionService = new PositionService(exchangeService, null);

  const currentPrice = await exchangeService.getTickerPrice(position.symbol);
  console.log(`Current price: ${currentPrice}`);

  const updated = await positionService.updatePosition(position);
  console.log('\n[UPDATED POSITION RESULT]');
  console.log({
    id: updated?.id,
    take_profit_price: updated?.take_profit_price,
    minutes_elapsed: updated?.minutes_elapsed,
    exit_order_id: updated?.exit_order_id,
    pnl: updated?.pnl,
    status: updated?.status,
  });
}

main().catch(err => {
  console.error('ERROR:', err?.message || err);
  console.error(err?.stack || err);
  process.exit(1);
});
