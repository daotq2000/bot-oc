#!/usr/bin/env node

/**
 * Script test để verify việc update symbol_filters cho MEXC
 * Kiểm tra tại sao chỉ có 35 record trong database
 */

import { exchangeInfoService } from '../src/services/ExchangeInfoService.js';
import { SymbolFilter } from '../src/models/SymbolFilter.js';
import ccxt from 'ccxt';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';

async function testMexcSymbolFilters() {
  console.log('\n=== TEST MEXC SYMBOL_FILTERS UPDATE ===\n');

  try {
    // 1. Kiểm tra số lượng record hiện tại trong database
    console.log('📊 1. KIỂM TRA DATABASE HIỆN TẠI:');
    const [dbRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM symbol_filters WHERE exchange = ?',
      ['mexc']
    );
    const currentCount = dbRows[0]?.count || 0;
    console.log(`   - Số record MEXC trong database: ${currentCount}`);

    const [allRows] = await pool.execute(
      'SELECT symbol, tick_size, step_size, min_notional, max_leverage FROM symbol_filters WHERE exchange = ? ORDER BY symbol LIMIT 50',
      ['mexc']
    );
    console.log(`   - Hiển thị ${Math.min(allRows.length, 50)} record đầu tiên:`);
    if (allRows.length > 0) {
      allRows.forEach((row, idx) => {
        console.log(`     ${idx + 1}. ${row.symbol} - tick:${row.tick_size}, step:${row.step_size}, min:${row.min_notional}, leverage:${row.max_leverage}`);
      });
    } else {
      console.log('     (Không có record nào)');
    }

    // 2. Test fetch markets từ MEXC qua CCXT
    console.log('\n📡 2. TEST FETCH MARKETS TỪ MEXC (CCXT):');
    try {
      const mexc = new ccxt.mexc({ 
        enableRateLimit: true, 
        options: { defaultType: 'swap' } 
      });

      // Force .co domain
      const co = 'https://api.mexc.co';
      const coContract = 'https://contract.mexc.co';
      if ('hostname' in mexc) mexc.hostname = 'mexc.co';
      mexc.urls = mexc.urls || {};
      mexc.urls.api = mexc.urls.api || {};
      Object.assign(mexc.urls.api, {
        public: co,
        private: co,
        spot: co,
        spotPublic: co,
        spotPrivate: co,
        contract: coContract,
        contractPublic: coContract,
        contractPrivate: coContract
      });
      mexc.urls.www = 'https://www.mexc.co';

      console.log('   - Đang fetch markets từ MEXC...');
      await mexc.loadMarkets({ 'type': 'swap' });

      const markets = mexc.markets || {};
      console.log(`   - Tổng số markets từ CCXT: ${Object.keys(markets).length}`);

      // Lọc swap markets USDT
      const swapMarkets = [];
      for (const marketId in markets) {
        const m = markets[marketId];
        if (!m) continue;
        if ((m.type !== 'swap' && m.contract !== true) || (m.quote && m.quote.toUpperCase() !== 'USDT')) continue;
        if (m.active === false) continue;
        swapMarkets.push(m);
      }

      console.log(`   - Số swap markets USDT active: ${swapMarkets.length}`);
      console.log(`   - Hiển thị 20 markets đầu tiên:`);
      swapMarkets.slice(0, 20).forEach((m, idx) => {
        const symbol = `${(m.base || '').toUpperCase()}${(m.quote || '').toUpperCase()}`;
        console.log(`     ${idx + 1}. ${symbol} - type:${m.type}, contract:${m.contract}, active:${m.active}, quote:${m.quote}`);
      });

      // Kiểm tra precision và limits
      console.log('\n   - Kiểm tra precision và limits của một số markets:');
      swapMarkets.slice(0, 5).forEach((m, idx) => {
        const symbol = `${(m.base || '').toUpperCase()}${(m.quote || '').toUpperCase()}`;
        console.log(`     ${symbol}:`);
        console.log(`       - precision: ${JSON.stringify(m.precision)}`);
        console.log(`       - limits: ${JSON.stringify(m.limits)}`);
        console.log(`       - info: ${JSON.stringify(m.info ? Object.keys(m.info) : 'N/A')}`);
      });

    } catch (e) {
      console.error(`   ❌ Lỗi khi fetch markets từ CCXT: ${e?.message || e}`);
      console.error(`   Stack: ${e?.stack}`);
    }

    // 3. Test hàm updateMexcFiltersFromExchange
    console.log('\n🔄 3. TEST HÀM updateMexcFiltersFromExchange:');
    try {
      console.log('   - Đang gọi updateMexcFiltersFromExchange...');
      await exchangeInfoService.updateMexcFiltersFromExchange();
      console.log('   ✅ Update thành công!');
    } catch (e) {
      console.error(`   ❌ Lỗi khi update: ${e?.message || e}`);
      console.error(`   Stack: ${e?.stack}`);
    }

    // 4. Kiểm tra lại database sau khi update
    console.log('\n📊 4. KIỂM TRA DATABASE SAU KHI UPDATE:');
    const [dbRowsAfter] = await pool.execute(
      'SELECT COUNT(*) as count FROM symbol_filters WHERE exchange = ?',
      ['mexc']
    );
    const afterCount = dbRowsAfter[0]?.count || 0;
    console.log(`   - Số record MEXC sau update: ${afterCount}`);
    console.log(`   - Thay đổi: ${afterCount - currentCount > 0 ? '+' : ''}${afterCount - currentCount}`);

    const [allRowsAfter] = await pool.execute(
      'SELECT symbol, tick_size, step_size, min_notional, max_leverage FROM symbol_filters WHERE exchange = ? ORDER BY symbol',
      ['mexc']
    );
    console.log(`   - Tổng số symbols: ${allRowsAfter.length}`);
    if (allRowsAfter.length > 0) {
      console.log(`   - Danh sách tất cả symbols:`);
      allRowsAfter.forEach((row, idx) => {
        console.log(`     ${idx + 1}. ${row.symbol}`);
      });
    }

    // 5. So sánh với Binance để tham khảo
    console.log('\n📊 5. SO SÁNH VỚI BINANCE (THAM KHẢO):');
    const [binanceRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM symbol_filters WHERE exchange = ?',
      ['binance']
    );
    const binanceCount = binanceRows[0]?.count || 0;
    console.log(`   - Số record Binance: ${binanceCount}`);
    console.log(`   - Tỷ lệ MEXC/Binance: ${binanceCount > 0 ? ((afterCount / binanceCount) * 100).toFixed(2) : 'N/A'}%`);

    // 6. Test fallback REST API
    console.log('\n📡 6. TEST FALLBACK REST API (MEXC Spot ExchangeInfo):');
    try {
      const url = 'https://api.mexc.co/api/v3/exchangeInfo';
      console.log(`   - Đang fetch từ: ${url}`);
      const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      const symbols = data?.symbols || [];
      console.log(`   - Tổng số symbols từ REST API: ${symbols.length}`);
      
      // Kiểm tra format của symbols
      if (symbols.length > 0) {
        console.log(`   - Sample symbol structure (first 3):`);
        symbols.slice(0, 3).forEach((s, idx) => {
          console.log(`     ${idx + 1}. Symbol: ${s.symbol || 'N/A'}`);
          console.log(`        - status: ${s.status || 'N/A'}`);
          console.log(`        - quoteAsset: ${s.quoteAsset || 'N/A'}`);
          console.log(`        - baseAsset: ${s.baseAsset || 'N/A'}`);
          console.log(`        - quotePrecision: ${s.quotePrecision || 'N/A'}`);
          console.log(`        - baseAssetPrecision: ${s.baseAssetPrecision || 'N/A'}`);
          console.log(`        - filters: ${s.filters ? JSON.stringify(s.filters).substring(0, 200) : 'N/A'}`);
        });
      }
      
      // Thử các filter khác nhau
      const usdtSymbols1 = symbols.filter(s => {
        const status = (s.status || '').toUpperCase();
        const quote = (s.quoteAsset || '').toUpperCase();
        return status === 'TRADING' && quote === 'USDT';
      });
      console.log(`   - Filter 1 (status='TRADING' && quote='USDT'): ${usdtSymbols1.length} symbols`);
      
      const usdtSymbols2 = symbols.filter(s => {
        const quote = (s.quoteAsset || '').toUpperCase();
        return quote === 'USDT';
      });
      console.log(`   - Filter 2 (chỉ quote='USDT'): ${usdtSymbols2.length} symbols`);
      
      const usdtSymbols3 = symbols.filter(s => {
        const status = (s.status || '').toUpperCase();
        return status === 'TRADING';
      });
      console.log(`   - Filter 3 (chỉ status='TRADING'): ${usdtSymbols3.length} symbols`);
      
      // Kiểm tra các status khác nhau
      const statusCounts = {};
      symbols.forEach(s => {
        const status = (s.status || 'UNKNOWN').toUpperCase();
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });
      console.log(`   - Phân bố status:`);
      Object.entries(statusCounts).forEach(([status, count]) => {
        console.log(`     - ${status}: ${count}`);
      });
      
      // Kiểm tra các quote assets
      const quoteCounts = {};
      symbols.forEach(s => {
        const quote = (s.quoteAsset || 'UNKNOWN').toUpperCase();
        quoteCounts[quote] = (quoteCounts[quote] || 0) + 1;
      });
      console.log(`   - Top 10 quote assets:`);
      Object.entries(quoteCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .forEach(([quote, count]) => {
          console.log(`     - ${quote}: ${count}`);
        });
      
      // Hiển thị một số USDT symbols
      const usdtSymbols = symbols.filter(s => {
        const quote = (s.quoteAsset || '').toUpperCase();
        return quote === 'USDT';
      });
      console.log(`   - Hiển thị 20 USDT symbols đầu tiên (không filter status):`);
      usdtSymbols.slice(0, 20).forEach((s, idx) => {
        console.log(`     ${idx + 1}. ${s.symbol} - status:${s.status}, quote:${s.quoteAsset}`);
      });
    } catch (e) {
      console.error(`   ❌ Lỗi khi fetch REST API: ${e?.message || e}`);
    }

    // 6b. Test MEXC Futures Contract API
    console.log('\n📡 6b. TEST MEXC FUTURES CONTRACT API:');
    try {
      const futuresUrl = 'https://contract.mexc.co/api/v1/contract/detail';
      console.log(`   - Đang fetch từ: ${futuresUrl}`);
      const res = await fetch(futuresUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        const text = await res.text();
        console.log(`   - Response status: ${res.status}`);
        console.log(`   - Response text: ${text.substring(0, 500)}`);
      } else {
        const data = await res.json();
        console.log(`   - Response keys: ${Object.keys(data).join(', ')}`);
        if (data.data && Array.isArray(data.data)) {
          console.log(`   - Số contracts: ${data.data.length}`);
          console.log(`   - Sample contract (first 3):`);
          data.data.slice(0, 3).forEach((c, idx) => {
            console.log(`     ${idx + 1}. ${JSON.stringify(c).substring(0, 300)}`);
          });
        }
      }
    } catch (e) {
      console.error(`   ❌ Lỗi khi fetch Futures API: ${e?.message || e}`);
    }

    // 6c. Test MEXC Contract Symbol List
    console.log('\n📡 6c. TEST MEXC CONTRACT SYMBOL LIST:');
    try {
      const symbolListUrl = 'https://contract.mexc.co/api/v1/contract/symbols';
      console.log(`   - Đang fetch từ: ${symbolListUrl}`);
      const res = await fetch(symbolListUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        const text = await res.text();
        console.log(`   - Response status: ${res.status}`);
        console.log(`   - Response text: ${text.substring(0, 500)}`);
      } else {
        const data = await res.json();
        console.log(`   - Response structure: ${JSON.stringify(Object.keys(data)).substring(0, 200)}`);
        if (data.data && Array.isArray(data.data)) {
          console.log(`   - Số symbols: ${data.data.length}`);
          const usdtSymbols = data.data.filter(s => (s.symbol || '').includes('USDT'));
          console.log(`   - Số USDT symbols: ${usdtSymbols.length}`);
          console.log(`   - Sample symbols (first 10):`);
          usdtSymbols.slice(0, 10).forEach((s, idx) => {
            console.log(`     ${idx + 1}. ${s.symbol || JSON.stringify(s).substring(0, 100)}`);
          });
        } else {
          console.log(`   - Full response: ${JSON.stringify(data).substring(0, 1000)}`);
        }
      }
    } catch (e) {
      console.error(`   ❌ Lỗi khi fetch Symbol List: ${e?.message || e}`);
    }

    // 7. Tổng kết
    console.log('\n📈 7. TỔNG KẾT:');
    console.log(`   - Record MEXC trước update: ${currentCount}`);
    console.log(`   - Record MEXC sau update: ${afterCount}`);
    if (afterCount < 50) {
      console.log(`   ⚠️  CẢNH BÁO: Chỉ có ${afterCount} record, có thể có vấn đề!`);
      console.log(`   - Kiểm tra:`);
      console.log(`     1. MEXC API có trả về đủ markets không?`);
      console.log(`     2. Filter logic có quá strict không?`);
      console.log(`     3. Có lỗi trong quá trình parse markets không?`);
    } else {
      console.log(`   ✅ Số lượng record hợp lý (${afterCount})`);
    }

  } catch (error) {
    console.error('\n❌ LỖI TỔNG QUÁT:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
}

// Chạy test
testMexcSymbolFilters()
  .then(() => {
    console.log('\n✅ Test hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test thất bại:', error?.message || error);
    process.exit(1);
  });

