#!/usr/bin/env node
/*
Reconcile Positions Script

A) Cancel open phantom positions (in DB but no exposure on exchange)
B) Mark past false-closed positions as sync_invalid_close and set pnl=0 (optional)

Usage:
  node src/scripts/reconcilePositions.js [--execute] [--since-hours 24] [--fix-closed]

Notes:
- Requires valid DB connection (.env) and exchange API keys in bots table.
- --execute applies changes; without it, the script runs in dry-run mode.
- --fix-closed enables step B; otherwise only A is performed.
*/

import dotenv from 'dotenv';
dotenv.config();

import pool from '../config/database.js';
import { Bot } from '../models/Bot.js';
import { Position } from '../models/Position.js';
import { ExchangeService } from '../services/ExchangeService.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { execute: false, sinceHours: 24, fixClosed: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--execute') opts.execute = true;
    else if (a === '--fix-closed') opts.fixClosed = true;
    else if (a === '--since-hours') opts.sinceHours = parseInt(args[++i] || '24', 10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  console.log(`Reconcile Positions - execute=${opts.execute} sinceHours=${opts.sinceHours} fixClosed=${opts.fixClosed}`);

  // Load active bots
  const bots = await Bot.findAll(true);
  if (!bots.length) {
    console.log('No active bots found.');
    process.exit(0);
  }

  // Initialize ExchangeService per bot
  const exMap = new Map();
  for (const bot of bots) {
    try {
      const ex = new ExchangeService(bot);
      await ex.initialize();
      exMap.set(bot.id, ex);
    } catch (e) {
      console.warn(`WARN: Failed to init exchange for bot ${bot.id} (${bot.bot_name}): ${e?.message || e}`);
    }
  }

  // A) Cancel open phantom positions
  const openPositions = await Position.findOpen();
  let cancelCandidates = [];
  for (const p of openPositions) {
    try {
      const ex = exMap.get(p.bot_id);
      if (!ex) { console.warn(`No exchange for bot ${p.bot_id}, skip position ${p.id}`); continue; }
      const qty = await ex.getClosableQuantity(p.symbol, p.side);
      if (!qty || qty <= 0) {
        cancelCandidates.push(p);
      }
    } catch (e) {
      console.warn(`WARN: getClosableQuantity failed for pos ${p.id} ${p.symbol}: ${e?.message || e}`);
    }
  }

  console.log(`A) Open phantom positions: ${cancelCandidates.length}`);
  if (cancelCandidates.length) {
    const ids = cancelCandidates.map(p => p.id);
    console.log(`IDs: ${ids.join(', ')}`);
    if (opts.execute) {
      const sql = `UPDATE positions SET status='cancelled', close_reason='no_exchange_position', closed_at=NOW() WHERE id IN (${ids.map(() => '?').join(',')})`;
      await pool.execute(sql, ids);
      console.log(`Cancelled ${ids.length} open positions marked as phantom.`);
    }
  }

  // B) Mark past false-closed (heuristic: recent closed TP/SL)
  if (opts.fixClosed) {
    const [rows] = await pool.execute(
      `SELECT id, bot_id, symbol, side, close_reason, pnl, closed_at
       FROM positions
       WHERE status='closed'
         AND close_reason IN ('tp_hit','sl_hit')
         AND closed_at >= (NOW() - INTERVAL ? HOUR)
       ORDER BY closed_at DESC`,
      [opts.sinceHours]
    );

    console.log(`B) Recently closed TP/SL within ${opts.sinceHours}h: ${rows.length}`);
    const ids = rows.map(r => r.id);
    if (ids.length) {
      console.log(`IDs (candidates): ${ids.join(', ')}`);
      if (opts.execute) {
        const sql = `UPDATE positions SET pnl=0, close_reason='sync_invalid_close' WHERE id IN (${ids.map(() => '?').join(',')})`;
        await pool.execute(sql, ids);
        console.log(`Relabeled ${ids.length} positions to sync_invalid_close with pnl=0.`);
      } else {
        console.log('Dry-run: add --execute to apply B.');
      }
    }
  }

  console.log('Done.');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });

