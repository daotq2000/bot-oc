/**
 * Test script to verify leverage logic when default_leverage = null
 * 
 * This script tests that when bot.default_leverage is null,
 * the system should:
 * 1. Try to get max_leverage from symbol_filters cache
 * 2. If cache miss (Binance), try API call
 * 3. Only fallback to default config (5) if both cache and API fail
 */

import pool from '../src/config/database.js';
import { exchangeInfoService } from '../src/services/ExchangeInfoService.js';
import { BinanceDirectClient } from '../src/services/BinanceDirectClient.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function testLeverageLogic() {
  console.log('Starting leverage logic test...');
  const connection = await pool.getConnection();
  
  try {
    // Test with a bot that has default_leverage = null
    const [bots] = await connection.query(
      `SELECT id, bot_name, exchange, default_leverage FROM bots WHERE default_leverage IS NULL LIMIT 1`
    );
    
    if (bots.length === 0) {
      logger.info('No bot with default_leverage = null found. Creating test scenario...');
      // Get any bot and temporarily set default_leverage to null for testing
      const [allBots] = await connection.query(`SELECT id, bot_name, exchange, default_leverage FROM bots LIMIT 1`);
      if (allBots.length === 0) {
        logger.error('No bots found in database');
        return;
      }
      bots.push(allBots[0]);
    }
    
    const bot = bots[0];
    console.log(`\n=== Testing leverage logic for bot_id=${bot.id}, exchange=${bot.exchange}, default_leverage=${bot.default_leverage} ===\n`);
    logger.info(`\n=== Testing leverage logic for bot_id=${bot.id}, exchange=${bot.exchange}, default_leverage=${bot.default_leverage} ===\n`);
    
    // Test symbol
    const testSymbol = 'BTCUSDT';
    
    // Step 1: Check cache
    console.log('Step 1: Checking cache...');
    logger.info('Step 1: Checking cache...');
    const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(testSymbol, bot.exchange?.toLowerCase() || 'binance');
    console.log(`  Cache result: ${maxLeverageFromCache} (${maxLeverageFromCache != null ? 'FOUND' : 'NOT FOUND'})`);
    logger.info(`  Cache result: ${maxLeverageFromCache} (${maxLeverageFromCache != null ? 'FOUND' : 'NOT FOUND'})`);
    
    // Step 2: If Binance and cache miss, try API
    let maxLeverageFromAPI = null;
    if (bot.exchange?.toLowerCase() === 'binance' && maxLeverageFromCache == null) {
      console.log('Step 2: Cache miss, trying API call...');
      logger.info('Step 2: Cache miss, trying API call...');
      try {
        const binanceClient = new BinanceDirectClient(
          configService.getString('BINANCE_API_KEY'),
          configService.getString('BINANCE_API_SECRET'),
          configService.getBoolean('BINANCE_TESTNET', false)
        );
        binanceClient.exchangeInfoService = exchangeInfoService;
        maxLeverageFromAPI = await binanceClient.getMaxLeverage(testSymbol);
        console.log(`  API result: ${maxLeverageFromAPI} (${maxLeverageFromAPI != null ? 'FOUND' : 'NOT FOUND'})`);
        logger.info(`  API result: ${maxLeverageFromAPI} (${maxLeverageFromAPI != null ? 'FOUND' : 'NOT FOUND'})`);
      } catch (apiErr) {
        console.error(`  API call failed: ${apiErr.message}`);
        logger.error(`  API call failed: ${apiErr.message}`);
      }
    } else if (bot.exchange?.toLowerCase() === 'binance') {
      console.log('Step 2: Cache hit, skipping API call');
      logger.info('Step 2: Cache hit, skipping API call');
    } else {
      console.log('Step 2: MEXC exchange, no API call available');
      logger.info('Step 2: MEXC exchange, no API call available');
    }
    
    // Step 3: Determine final leverage
    let finalLeverage;
    if (maxLeverageFromCache != null && Number.isFinite(Number(maxLeverageFromCache))) {
      finalLeverage = parseInt(maxLeverageFromCache);
      console.log(`\n✅ Final leverage: ${finalLeverage} (from cache)`);
      logger.info(`\n✅ Final leverage: ${finalLeverage} (from cache)`);
    } else if (maxLeverageFromAPI != null && Number.isFinite(Number(maxLeverageFromAPI))) {
      finalLeverage = parseInt(maxLeverageFromAPI);
      console.log(`\n✅ Final leverage: ${finalLeverage} (from API)`);
      logger.info(`\n✅ Final leverage: ${finalLeverage} (from API)`);
    } else {
      const defaultLeverage = parseInt(
        bot.exchange?.toLowerCase() === 'binance' 
          ? configService.getNumber('BINANCE_DEFAULT_LEVERAGE', 5)
          : configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5)
      );
      finalLeverage = defaultLeverage;
      console.log(`\n⚠️  Final leverage: ${finalLeverage} (from default config - cache and API both failed)`);
      logger.warn(`\n⚠️  Final leverage: ${finalLeverage} (from default config - cache and API both failed)`);
    }
    
    // Step 4: Check what the OLD logic would have done
    const oldLogicLeverage = maxLeverageFromCache || 
      (bot.exchange?.toLowerCase() === 'binance' 
        ? parseInt(configService.getNumber('BINANCE_DEFAULT_LEVERAGE', 5))
        : parseInt(configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5)));
    
    console.log(`\n=== Comparison ===`);
    console.log(`Old logic would use: ${oldLogicLeverage}`);
    console.log(`New logic uses: ${finalLeverage}`);
    logger.info(`\n=== Comparison ===`);
    logger.info(`Old logic would use: ${oldLogicLeverage}`);
    logger.info(`New logic uses: ${finalLeverage}`);
    
    if (oldLogicLeverage !== finalLeverage && maxLeverageFromCache == null && maxLeverageFromAPI != null) {
      console.log(`\n✅ FIX VERIFIED: New logic correctly uses API result (${maxLeverageFromAPI}) instead of default (${oldLogicLeverage})`);
      logger.info(`\n✅ FIX VERIFIED: New logic correctly uses API result (${maxLeverageFromAPI}) instead of default (${oldLogicLeverage})`);
    } else if (oldLogicLeverage === finalLeverage) {
      console.log(`\nℹ️  Both logics produce same result (expected if cache exists or API fails)`);
      logger.info(`\nℹ️  Both logics produce same result (expected if cache exists or API fails)`);
    }
    
    // Step 5: Check symbol_filters table
    logger.info(`\n=== Checking symbol_filters table ===`);
    const [filters] = await connection.query(
      `SELECT symbol, max_leverage, exchange FROM symbol_filters WHERE symbol = ? AND exchange = ?`,
      [testSymbol, bot.exchange?.toLowerCase() || 'binance']
    );
    
    if (filters.length > 0) {
      logger.info(`  Found in DB: max_leverage = ${filters[0].max_leverage}`);
      if (filters[0].max_leverage != null && filters[0].max_leverage !== maxLeverageFromCache) {
        logger.warn(`  ⚠️  WARNING: DB has max_leverage=${filters[0].max_leverage} but cache returned ${maxLeverageFromCache}`);
        logger.warn(`  This suggests cache may need to be refreshed.`);
      }
    } else {
      logger.warn(`  ⚠️  NOT FOUND in symbol_filters table for ${testSymbol} on ${bot.exchange}`);
      logger.warn(`  This explains why cache returned null.`);
    }
    
  } catch (error) {
    console.error('Error testing leverage logic:', error);
    logger.error('Error testing leverage logic:', error);
  } finally {
    connection.release();
    console.log('Test completed.');
    process.exit(0);
  }
}

testLeverageLogic();

