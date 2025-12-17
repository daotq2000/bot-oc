import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import { configService } from '../src/services/ConfigService.js';
import { exchangeInfoService } from '../src/services/ExchangeInfoService.js';
import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import pool, { testConnection } from '../src/config/database.js';

dotenv.config();

function sortSymbols(arr) {
  return Array.from(new Set(arr.map(s => String(s).toUpperCase()))).sort();
}

async function ensureSingleActiveRowPerExchange(exchange) {
  const rows = await PriceAlertConfig.findAllAny(exchange);
  if (!rows || rows.length === 0) return null;
  // Prefer the newest active row; else the newest row
  const active = rows.filter(r => !!r.is_active);
  if (active.length > 0) {
    // Keep the most recent active row
    const keep = active[0];
    const toDeactivate = rows.filter(r => r.id !== keep.id && r.is_active);
    for (const r of toDeactivate) {
      await PriceAlertConfig.update(r.id, { is_active: false });
    }
    return keep;
  }
  // No active row - activate the newest row
  const newest = rows[0];
  await PriceAlertConfig.update(newest.id, { is_active: true });
  // Deactivate the rest just in case
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].is_active) await PriceAlertConfig.update(rows[i].id, { is_active: false });
  }
  return await PriceAlertConfig.findById(newest.id);
}

async function createDefaultRow(exchange, symbols) {
  // Reasonable defaults; keep minimal so user can adjust later
  const data = {
    exchange,
    symbols: symbols || [],
    intervals: ['1m', '5m'],
    threshold: 4.0,
    telegram_chat_id: null,
    is_active: true
  };
  return await PriceAlertConfig.create(data);
}

async function updateExchangeSymbols(exchange, symbolsSet) {
  const symbols = sortSymbols(Array.from(symbolsSet));
  logger.info(`[Update] ${exchange}: fetched ${symbols.length} tradable USDT-M futures symbols`);

  // Try to find an active row to update; ensure only one active
  let row = await ensureSingleActiveRowPerExchange(exchange);
  if (!row) {
    logger.info(`[Update] ${exchange}: No rows exist. Creating a new config row.`);
    row = await createDefaultRow(exchange, symbols);
  } else {
    // Update symbols only, keep user threshold/intervals/chat
    await PriceAlertConfig.update(row.id, { symbols });
  }

  // Deactivate any other rows strictly (redundant safeguard)
  const all = await PriceAlertConfig.findAllAny(exchange);
  for (const r of all) {
    if (r.id !== row.id && r.is_active) await PriceAlertConfig.update(r.id, { is_active: false });
  }

  logger.info(`[Update] ${exchange}: row ${row.id} updated with ${symbols.length} symbols (one active row enforced)`);
  return { id: row.id, count: symbols.length };
}

async function main() {
  try {
    logger.info('[UpdateSymbols] Starting');
    const ok = await testConnection();
    if (!ok) throw new Error('Database connection failed');

    // Load configs to allow service defaults
    await configService.loadAll();

    // Refresh symbol filters first (optional but helpful)
    try { await exchangeInfoService.updateFiltersFromExchange(); } catch (_) {}
    try { await exchangeInfoService.updateMexcFiltersFromExchange(); } catch (_) {}

    // Fetch latest tradable symbols per exchange
    const [binanceSet, mexcSet] = await Promise.all([
      exchangeInfoService.getTradableSymbolsFromBinance(),
      exchangeInfoService.getTradableSymbolsFromMexc()
    ]);

    const results = {};
    results.binance = await updateExchangeSymbols('binance', binanceSet);
    results.mexc = await updateExchangeSymbols('mexc', mexcSet);

    logger.info('[UpdateSymbols] Done:', results);
    // End the pool so script can exit
    await pool.end();
    process.exit(0);
  } catch (e) {
    logger.error('[UpdateSymbols] Failed:', e?.message || e);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  }
}

// Execute when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default main;

