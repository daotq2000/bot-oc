import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import logger from './src/utils/logger.js';

dotenv.config();

/**
 * Test script to diagnose and fix the -1111 precision error.
 */
async function testPrecision() {
  const strategyId = process.argv[2] ? parseInt(process.argv[2], 10) : 743; // Allow overriding via CLI
  if (Number.isNaN(strategyId)) {
    logger.error('Invalid strategy id passed to test_precision.js');
    process.exit(1);
  }

  try {
    logger.info(`=== Testing Precision for Strategy ${strategyId} ===\n`);

    // 1. Get strategy and bot
    const strategy = await Strategy.findById(strategyId);
    if (!strategy) {
      logger.error(`Strategy ${strategyId} not found.`);
      return;
    }
    const bot = await Bot.findById(strategy.bot_id);
    if (!bot) {
      logger.error(`Bot ${strategy.bot_id} not found.`);
      return;
    }

    logger.info(`Strategy Symbol: ${strategy.symbol}`);
    logger.info(`Order Amount: ${strategy.amount} USDT\n`);

    // 2. Initialize services
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    const binanceClient = exchangeService.binanceDirectClient;

    // 3. Get symbol precision info from Binance
    const stepSize = await binanceClient.getStepSize(strategy.symbol);
    logger.info(`Step Size for ${strategy.symbol}: "${stepSize}"\n`);

    // 4. Simulate quantity calculation
    let currentPrice = await binanceClient.getPrice(strategy.symbol);
    if (currentPrice === null) {
      logger.warn(`Price for ${strategy.symbol} not found in WebSocket cache. Falling back to REST ticker once for diagnostics.`);
      try {
        const ticker = await binanceClient.getTicker(strategy.symbol);
        currentPrice = parseFloat(ticker?.lastPrice || ticker?.price || '0');
      } catch (restError) {
        logger.error(`REST price fallback failed for ${strategy.symbol}:`, restError);
        return;
      }
      if (!currentPrice || Number.isNaN(currentPrice)) {
        logger.error(`Could not get price for ${strategy.symbol} from REST fallback either.`);
        return;
      }
    }
    const calculatedQuantity = strategy.amount / currentPrice;
    logger.info(`Calculated (raw) quantity: ${calculatedQuantity}`);

    // 5. Format the quantity using the function that is failing
    const formattedQuantity = binanceClient.formatQuantity(calculatedQuantity, stepSize);
    logger.info(`Formatted quantity: "${formattedQuantity}" (Type: ${typeof formattedQuantity})\n`);

    // 6. Analyze the result
    logger.info('=== Analysis ===');
    const precision = stepSize.includes('.') ? (stepSize.split('.')[1] || '').length : 0;
    logger.info(`Required precision (decimal places): ${precision}`);
    logger.info(`Is formatted quantity a whole number? ${!formattedQuantity.includes('.')}`);
    logger.info(`Does formatted quantity match required precision? ${precision === 0 ? !formattedQuantity.includes('.') : (formattedQuantity.split('.')[1] || '').length === precision}\n`);

    logger.info('This test reveals the exact value being sent to Binance. Based on this, I will correct the formatting logic.');

  } catch (error) {
    logger.error('Test failed:', error);
  } finally {
    process.exit(0);
  }
}

testPrecision();


