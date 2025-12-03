/**
 * Script to populate symbol_filters table with precision data from Binance API
 * Usage: node src/scripts/populateSymbolFilters.js
 */

import { BinanceDirectClient } from '../services/BinanceDirectClient.js';
import { SymbolFilter } from '../models/SymbolFilter.js';
import logger from '../utils/logger.js';

async function populateSymbolFilters() {
  try {
    logger.info('🚀 Starting to populate symbol_filters table...');
    
    // Create a Binance client (no auth needed for public data)
    const binanceClient = new BinanceDirectClient('', '', false);
    
    // Fetch exchange info
    logger.info('📡 Fetching exchange info from Binance API...');
    const exchangeInfo = await binanceClient.getExchangeInfo();
    
    if (!exchangeInfo || !exchangeInfo.symbols) {
      logger.error('❌ Failed to fetch exchange info from Binance.');
      process.exit(1);
    }
    
    logger.info(`📊 Found ${exchangeInfo.symbols.length} symbols on Binance`);
    
    // Extract filter information for each symbol
    const filtersToSave = [];
    let processedCount = 0;
    let skippedCount = 0;
    
    for (const symbolInfo of exchangeInfo.symbols) {
      // Only process trading symbols
      if (symbolInfo.status !== 'TRADING') {
        skippedCount++;
        continue;
      }
      
      // Find the required filters
      const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
      const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
      
      // Only save if all required filters are present
      if (priceFilter && lotSizeFilter && minNotionalFilter) {
        filtersToSave.push({
          exchange: 'binance',
          symbol: symbolInfo.symbol,
          tick_size: priceFilter.tickSize,
          step_size: lotSizeFilter.stepSize,
          min_notional: minNotionalFilter.notional
        });
        processedCount++;
      } else {
        skippedCount++;
      }
    }
    
    logger.info(`✅ Extracted filters for ${processedCount} symbols (skipped ${skippedCount})`);
    
    // Bulk insert/update into database
    if (filtersToSave.length > 0) {
      logger.info(`💾 Saving ${filtersToSave.length} symbol filters to database...`);
      await SymbolFilter.bulkUpsert(filtersToSave);
      logger.info(`✅ Successfully saved ${filtersToSave.length} symbol filters to database!`);
    } else {
      logger.warn('⚠️ No filters to save');
    }
    
    logger.info('✨ Symbol filters population completed successfully!');
    process.exit(0);
    
  } catch (error) {
    logger.error('❌ Error populating symbol filters:', error);
    process.exit(1);
  }
}

// Run the script
populateSymbolFilters();

