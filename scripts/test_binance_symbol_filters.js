#!/usr/bin/env node

/**
 * Script test để verify việc update symbol_filters cho Binance
 * Kiểm tra số lượng symbols và so sánh với API
 */

import { exchangeInfoService } from '../src/services/ExchangeInfoService.js';
import { SymbolFilter } from '../src/models/SymbolFilter.js';
import { BinanceDirectClient } from '../src/services/BinanceDirectClient.js';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';

async function testBinanceSymbolFilters() {
  console.log('\n=== TEST BINANCE SYMBOL_FILTERS UPDATE ===\n');

  try {
    // 1. Kiểm tra số lượng record hiện tại trong database
    console.log('📊 1. KIỂM TRA DATABASE HIỆN TẠI:');
    const [dbRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM symbol_filters WHERE exchange = ?',
      ['binance']
    );
    const currentCount = dbRows[0]?.count || 0;
    console.log(`   - Số record Binance trong database: ${currentCount}`);

    const [allRows] = await pool.execute(
      'SELECT symbol, tick_size, step_size, min_notional, max_leverage FROM symbol_filters WHERE exchange = ? ORDER BY symbol LIMIT 50',
      ['binance']
    );
    console.log(`   - Hiển thị ${Math.min(allRows.length, 50)} record đầu tiên:`);
    if (allRows.length > 0) {
      allRows.forEach((row, idx) => {
        console.log(`     ${idx + 1}. ${row.symbol} - tick:${row.tick_size}, step:${row.step_size}, min:${row.min_notional}, leverage:${row.max_leverage}`);
      });
    } else {
      console.log('     (Không có record nào)');
    }

    // 2. Test fetch exchange info từ Binance API
    console.log('\n📡 2. TEST FETCH EXCHANGE INFO TỪ BINANCE API:');
    try {
      const binanceClient = new BinanceDirectClient('', '', false, exchangeInfoService);
      console.log('   - Đang fetch exchange info từ Binance...');
      const exchangeInfo = await binanceClient.getExchangeInfo();

      if (!exchangeInfo || !exchangeInfo.symbols) {
        console.error('   ❌ Không lấy được exchange info từ Binance');
      } else {
        console.log(`   - Tổng số symbols từ API: ${exchangeInfo.symbols.length}`);

        // Lọc futures USDT perpetual
        const futuresSymbols = [];
        for (const symbolInfo of exchangeInfo.symbols) {
          if (symbolInfo.status !== 'TRADING') continue;
          const quote = (symbolInfo.quoteAsset || '').toUpperCase();
          const contractType = (symbolInfo.contractType || '').toUpperCase();
          if (quote === 'USDT' && (contractType === 'PERPETUAL' || contractType === '')) {
            futuresSymbols.push(symbolInfo);
          }
        }

        console.log(`   - Số USDT perpetual futures TRADING: ${futuresSymbols.length}`);
        console.log(`   - Hiển thị 20 symbols đầu tiên:`);
        futuresSymbols.slice(0, 20).forEach((s, idx) => {
          console.log(`     ${idx + 1}. ${s.symbol} - status:${s.status}, quote:${s.quoteAsset}, contractType:${s.contractType}`);
        });

        // Kiểm tra phân bố status
        const statusCounts = {};
        exchangeInfo.symbols.forEach(s => {
          const status = (s.status || 'UNKNOWN').toUpperCase();
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        });
        console.log(`\n   - Phân bố status:`);
        Object.entries(statusCounts).forEach(([status, count]) => {
          console.log(`     - ${status}: ${count}`);
        });

        // Kiểm tra phân bố quote assets
        const quoteCounts = {};
        exchangeInfo.symbols.forEach(s => {
          const quote = (s.quoteAsset || 'UNKNOWN').toUpperCase();
          quoteCounts[quote] = (quoteCounts[quote] || 0) + 1;
        });
        console.log(`\n   - Top 10 quote assets:`);
        Object.entries(quoteCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .forEach(([quote, count]) => {
            console.log(`     - ${quote}: ${count}`);
          });

        // Kiểm tra phân bố contract types
        const contractTypeCounts = {};
        exchangeInfo.symbols.forEach(s => {
          const ct = (s.contractType || 'NONE').toUpperCase();
          contractTypeCounts[ct] = (contractTypeCounts[ct] || 0) + 1;
        });
        console.log(`\n   - Phân bố contract types:`);
        Object.entries(contractTypeCounts)
          .sort((a, b) => b[1] - a[1])
          .forEach(([ct, count]) => {
            console.log(`     - ${ct}: ${count}`);
          });

        // Kiểm tra leverage brackets
        let symbolsWithLeverage = 0;
        let maxLeverageCounts = {};
        futuresSymbols.forEach(s => {
          if (s.leverageBrackets && s.leverageBrackets.length > 0) {
            symbolsWithLeverage++;
            const maxBracket = s.leverageBrackets.reduce((max, bracket) => {
              const leverage = parseInt(bracket.initialLeverage || 0);
              return leverage > parseInt(max.initialLeverage || 0) ? bracket : max;
            });
            const maxLev = parseInt(maxBracket.initialLeverage || 125);
            maxLeverageCounts[maxLev] = (maxLeverageCounts[maxLev] || 0) + 1;
          }
        });
        console.log(`\n   - Symbols có leverage brackets: ${symbolsWithLeverage}/${futuresSymbols.length}`);
        console.log(`   - Phân bố max leverage:`);
        Object.entries(maxLeverageCounts)
          .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
          .slice(0, 10)
          .forEach(([lev, count]) => {
            console.log(`     - ${lev}x: ${count} symbols`);
          });
      }
    } catch (e) {
      console.error(`   ❌ Lỗi khi fetch exchange info: ${e?.message || e}`);
      console.error(`   Stack: ${e?.stack}`);
    }

    // 3. Test hàm updateFiltersFromExchange
    console.log('\n🔄 3. TEST HÀM updateFiltersFromExchange:');
    try {
      console.log('   - Đang gọi updateFiltersFromExchange...');
      await exchangeInfoService.updateFiltersFromExchange();
      console.log('   ✅ Update thành công!');
    } catch (e) {
      console.error(`   ❌ Lỗi khi update: ${e?.message || e}`);
      console.error(`   Stack: ${e?.stack}`);
    }

    // 4. Kiểm tra lại database sau khi update
    console.log('\n📊 4. KIỂM TRA DATABASE SAU KHI UPDATE:');
    const [dbRowsAfter] = await pool.execute(
      'SELECT COUNT(*) as count FROM symbol_filters WHERE exchange = ?',
      ['binance']
    );
    const afterCount = dbRowsAfter[0]?.count || 0;
    console.log(`   - Số record Binance sau update: ${afterCount}`);
    console.log(`   - Thay đổi: ${afterCount - currentCount > 0 ? '+' : ''}${afterCount - currentCount}`);

    // Kiểm tra một số symbols cụ thể
    const testSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'DOGEUSDT'];
    console.log(`\n   - Kiểm tra một số symbols phổ biến:`);
    for (const symbol of testSymbols) {
      const [rows] = await pool.execute(
        'SELECT * FROM symbol_filters WHERE exchange = ? AND symbol = ?',
        ['binance', symbol]
      );
      if (rows.length > 0) {
        const r = rows[0];
        console.log(`     ✅ ${symbol}: tick=${r.tick_size}, step=${r.step_size}, min=${r.min_notional}, leverage=${r.max_leverage}`);
      } else {
        console.log(`     ❌ ${symbol}: Không tìm thấy trong database`);
      }
    }

    // Kiểm tra symbols có vấn đề (giá trị mặc định)
    const [defaultRows] = await pool.execute(
      `SELECT COUNT(*) as count FROM symbol_filters 
       WHERE exchange = 'binance' 
       AND tick_size = '0.01' 
       AND step_size = '0.001' 
       AND min_notional = 5 
       AND max_leverage = 125`
    );
    const defaultCount = defaultRows[0]?.count || 0;
    console.log(`\n   - Số symbols có giá trị mặc định (có thể có vấn đề): ${defaultCount}`);

    // 5. So sánh với MEXC
    console.log('\n📊 5. SO SÁNH VỚI MEXC (THAM KHẢO):');
    const [mexcRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM symbol_filters WHERE exchange = ?',
      ['mexc']
    );
    const mexcCount = mexcRows[0]?.count || 0;
    console.log(`   - Số record MEXC: ${mexcCount}`);
    console.log(`   - Tỷ lệ Binance/MEXC: ${mexcCount > 0 ? ((afterCount / mexcCount) * 100).toFixed(2) : 'N/A'}%`);

    // 6. Kiểm tra symbols bị thiếu hoặc thừa
    console.log('\n📊 6. PHÂN TÍCH CHI TIẾT:');
    
    // Lấy danh sách symbols từ database
    const [dbSymbols] = await pool.execute(
      'SELECT symbol FROM symbol_filters WHERE exchange = ? ORDER BY symbol',
      ['binance']
    );
    const dbSymbolSet = new Set(dbSymbols.map(r => r.symbol.toUpperCase()));
    
    // Lấy danh sách từ API (nếu có)
    try {
      const binanceClient = new BinanceDirectClient('', '', false, exchangeInfoService);
      const exchangeInfo = await binanceClient.getExchangeInfo();
      const apiSymbols = [];
      if (exchangeInfo && exchangeInfo.symbols) {
        for (const s of exchangeInfo.symbols) {
          if (s.status !== 'TRADING') continue;
          const quote = (s.quoteAsset || '').toUpperCase();
          const contractType = (s.contractType || '').toUpperCase();
          if (quote === 'USDT' && (contractType === 'PERPETUAL' || contractType === '')) {
            apiSymbols.push(s.symbol.toUpperCase());
          }
        }
      }
      const apiSymbolSet = new Set(apiSymbols);
      
      // Tìm symbols có trong DB nhưng không có trong API (có thể đã delist)
      const inDbNotInApi = Array.from(dbSymbolSet).filter(s => !apiSymbolSet.has(s));
      if (inDbNotInApi.length > 0) {
        console.log(`   - Symbols trong DB nhưng không có trong API (${inDbNotInApi.length}):`);
        inDbNotInApi.slice(0, 20).forEach((s, idx) => {
          console.log(`     ${idx + 1}. ${s}`);
        });
        if (inDbNotInApi.length > 20) {
          console.log(`     ... và ${inDbNotInApi.length - 20} symbols khác`);
        }
      }
      
      // Tìm symbols có trong API nhưng không có trong DB (có thể bị thiếu)
      const inApiNotInDb = Array.from(apiSymbolSet).filter(s => !dbSymbolSet.has(s));
      if (inApiNotInDb.length > 0) {
        console.log(`   - Symbols trong API nhưng không có trong DB (${inApiNotInDb.length}):`);
        inApiNotInDb.slice(0, 20).forEach((s, idx) => {
          console.log(`     ${idx + 1}. ${s}`);
        });
        if (inApiNotInDb.length > 20) {
          console.log(`     ... và ${inApiNotInDb.length - 20} symbols khác`);
        }
      }
      
      if (inDbNotInApi.length === 0 && inApiNotInDb.length === 0) {
        console.log(`   ✅ Database và API đồng bộ hoàn toàn!`);
      }
    } catch (e) {
      console.log(`   ⚠️  Không thể so sánh với API: ${e?.message || e}`);
    }

    // 7. Tổng kết
    console.log('\n📈 7. TỔNG KẾT:');
    console.log(`   - Record Binance trước update: ${currentCount}`);
    console.log(`   - Record Binance sau update: ${afterCount}`);
    if (afterCount < 100) {
      console.log(`   ⚠️  CẢNH BÁO: Chỉ có ${afterCount} record, có thể có vấn đề!`);
    } else if (afterCount > 1000) {
      console.log(`   ⚠️  CẢNH BÁO: Có ${afterCount} record, có thể có symbols không phải futures!`);
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
testBinanceSymbolFilters()
  .then(() => {
    console.log('\n✅ Test hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test thất bại:', error?.message || error);
    process.exit(1);
  });

