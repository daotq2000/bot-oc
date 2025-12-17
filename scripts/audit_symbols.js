import { Strategy } from '../src/models/Strategy.js';
import { exchangeInfoService } from '../src/services/ExchangeInfoService.js';
import { SymbolFilter } from '../src/models/SymbolFilter.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

function normalize(symbol) {
  if (!symbol) return symbol;
  let s = symbol.toString().toUpperCase().replace(/[\/:_\s]/g, '');
  if (s.endsWith('USD') && !s.endsWith('USDT')) s = s.replace(/USD$/, 'USDT');
  if (!s.endsWith('USDT')) s = s + 'USDT';
  return s;
}

async function getSymbolSetsFromFilters() {
  const rows = await SymbolFilter.findAll();
  const binance = new Set();
  const mexc = new Set();
  for (const r of rows) {
    const ex = (r.exchange || '').toLowerCase();
    const sym = normalize(r.symbol);
    if (!sym) continue;
    if (ex === 'binance') binance.add(sym);
    else if (ex === 'mexc') mexc.add(sym);
  }
  return { binance, mexc };
}

async function main() {
  try {
    await configService.loadAll();

    // Load filters cache (best-effort; if empty, still use DB rows directly)
    await exchangeInfoService.loadFiltersFromDB();

    const { binance, mexc } = await getSymbolSetsFromFilters();

    const strategies = await Strategy.findAll(null, true);

    const report = {
      totalStrategies: strategies.length,
      ok: [],
      invalid: [],
      byExchange: { binance: { total: 0, ok: 0, invalid: 0 }, mexc: { total: 0, ok: 0, invalid: 0 } }
    };

    for (const s of strategies) {
      const ex = (s.exchange || '').toLowerCase();
      const symRaw = s.symbol;
      const sym = normalize(symRaw);
      if (ex !== 'binance' && ex !== 'mexc') continue; // skip others

      report.byExchange[ex].total++;

      const tradable = ex === 'binance' ? binance.has(sym) : mexc.has(sym);
      if (tradable) {
        report.ok.push({ id: s.id, bot_id: s.bot_id, exchange: ex, symbol: symRaw, normalized: sym });
        report.byExchange[ex].ok++;
      } else {
        report.invalid.push({ id: s.id, bot_id: s.bot_id, exchange: ex, symbol: symRaw, normalized: sym });
        report.byExchange[ex].invalid++;
      }
    }

    // Output summary
    console.log('--- Symbol Audit (Active strategies) ---');
    console.log(`Total strategies: ${report.totalStrategies}`);
    console.log(`Binance: total=${report.byExchange.binance.total}, ok=${report.byExchange.binance.ok}, invalid=${report.byExchange.binance.invalid}`);
    console.log(`MEXC: total=${report.byExchange.mexc.total}, ok=${report.byExchange.mexc.ok}, invalid=${report.byExchange.mexc.invalid}`);

    if (report.invalid.length > 0) {
      console.log('\nInvalid (not tradable on assigned exchange):');
      for (const r of report.invalid.slice(0, 200)) {
        console.log(`- id=${r.id} bot=${r.bot_id} ex=${r.exchange} symbol='${r.symbol}' -> ${r.normalized}`);
      }
      if (report.invalid.length > 200) console.log(`... and ${report.invalid.length - 200} more`);
    } else {
      console.log('\nNo invalid symbols found.');
    }

    // Optional hints: symbols that exist on the other exchange
    const suggestions = [];
    for (const r of report.invalid) {
      if (r.exchange === 'binance' && mexc.has(r.normalized)) {
        suggestions.push({ id: r.id, symbol: r.symbol, suggest: 'mexc' });
      }
      if (r.exchange === 'mexc' && binance.has(r.normalized)) {
        suggestions.push({ id: r.id, symbol: r.symbol, suggest: 'binance' });
      }
    }
    if (suggestions.length) {
      console.log('\nSuggestions (symbol exists on the other exchange):');
      for (const s of suggestions.slice(0, 200)) {
        console.log(`- strategy ${s.id}: '${s.symbol}' -> consider switching to ${s.suggest}`);
      }
      if (suggestions.length > 200) console.log(`... and ${suggestions.length - 200} more`);
    }

    process.exit(0);
  } catch (e) {
    logger.error('Audit failed:', e?.message || e);
    process.exit(1);
  }
}

main();

