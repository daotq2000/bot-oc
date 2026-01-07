import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionService } from '../src/services/PositionService.js';
import { OrderService } from '../src/services/OrderService.js';
import { TelegramService } from '../src/services/TelegramService.js';
import logger from '../src/utils/logger.js';

/**
 * Script to force close a position on the testnet and verify notifications.
 *
 * 1. Cleans up any existing positions for the symbol.
 * 2. Creates a new position.
 * 3. Confirms the position is open on the exchange.
 * 4. Cancels all open orders for that symbol.
 * 5. Force closes the position with a market order.
 * 6. Verifies the notification logic is triggered.
 */

const TEST_BOT_ID = 2;
const TEST_SYMBOL = 'DOGEUSDT';
const TEST_AMOUNT = 100; // USDT amount for creating a new position

async function findOrCreateStrategy(botId, symbol) {
    const strategies = await Strategy.findAll();
    let strategy = strategies.find(s => s.bot_id === botId && s.symbol === symbol);
  
    if (!strategy) {
      logger.info(`[Test] No existing strategy found for ${symbol}, creating a temporary one...`);
      strategy = await Strategy.create({
        bot_id: botId,
        symbol: symbol,
        trade_type: 'both',
        interval: '1m',
        oc: 5,
        extend: 0,
        amount: TEST_AMOUNT,
        take_profit: 50,
        reduce: 10,
        up_reduce: 0,
        ignore: 0,
        is_active: true,
      });
      logger.info(`[Test] Created temporary strategy with ID: ${strategy.id}`);
    }
    return strategy;
}

async function waitForPosition(exchangeService, symbol) {
    logger.info(`[Test] Waiting up to 30 seconds for ${symbol} position to appear on the exchange...`);
    for (let i = 0; i < 15; i++) { // Poll for up to 30 seconds
        const positions = await exchangeService.getOpenPositions(symbol);
        const openPosition = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (openPosition) {
            logger.info(`[Test] ✅ Position for ${symbol} confirmed on exchange: Amount=${openPosition.positionAmt}`);
            return openPosition;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`Position for ${symbol} did not appear on the exchange.`);
}

async function runTest() {
  let positionToClose;
  try {
    logger.info('\n============================================================');
    logger.info('Force Close Position & Notification Test');
    logger.info(`Testing with Bot ID: ${TEST_BOT_ID}, Symbol: ${TEST_SYMBOL}`);
    logger.info('============================================================\n');

    const bot = await Bot.findById(TEST_BOT_ID);
    if (!bot || !bot.is_active) {
      throw new Error(`Bot with ID ${TEST_BOT_ID} is not active or not found.`);
    }
    logger.info(`[Test] Found bot: ${bot.name} (ID: ${bot.id})`);

    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    logger.info('[Test] ExchangeService initialized.');

    const telegramService = new TelegramService();
    await telegramService.initialize();
    logger.info('[Test] TelegramService initialized.');

    const orderService = new OrderService(exchangeService, telegramService);
    const positionService = new PositionService(exchangeService, telegramService);
    logger.info('[Test] OrderService and PositionService created.');

    // 1. Clean up any existing positions on the exchange
    try {
        logger.info(`[Test] Cleaning up any existing ${TEST_SYMBOL} positions...`);
        await exchangeService.closePosition(TEST_SYMBOL, 'long', 0, true); // Close long
        await exchangeService.closePosition(TEST_SYMBOL, 'short', 0, true); // Close short
        logger.info(`[Test] ✅ Cleanup complete.`);
    } catch (e) {
        if (!e.message.includes('-1106')) { // Ignore "no position" errors
            logger.warn(`[Test] Cleanup warning: ${e.message}`);
        }
    }

    // 2. Create a new position
    logger.info(`[Test] Creating a new LONG position for ${TEST_SYMBOL}...`);
    const strategy = await findOrCreateStrategy(TEST_BOT_ID, TEST_SYMBOL);
    const entryPrice = await exchangeService.getTickerPrice(TEST_SYMBOL);
    const signal = { strategy, side: 'long', entryPrice, amount: TEST_AMOUNT };
    positionToClose = await orderService.executeSignal(signal);
    if (!positionToClose) throw new Error('Failed to create test position in DB.');
    logger.info(`[Test] ✅ Created new position in DB. ID: ${positionToClose.id}`);

    // 3. Wait for the position to be confirmed on the exchange
    await waitForPosition(exchangeService, TEST_SYMBOL);

    // 4. Cancel all open orders for the symbol
    logger.info(`[Test] Cancelling all open orders for ${TEST_SYMBOL}...`);
    await exchangeService.cancelAllOpenOrders(TEST_SYMBOL);
    logger.info(`[Test] ✅ Open orders cancelled. Waiting 2s before closing.`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 5. Force close the position
    logger.info(`[Test] Force closing position ${positionToClose.id} with a market order...`);
    const currentPrice = await exchangeService.getTickerPrice(TEST_SYMBOL);
    await positionService.closePosition(positionToClose, currentPrice, 0, 'manual_force_close');

    logger.info('\n============================================================');
    logger.info('✅ Test script finished successfully.');
    logger.info('Please check the logs for `[Notification]` messages to verify success.');
    logger.info('============================================================\n');

    process.exit(0);
  } catch (error) {
    logger.error('\n============================================================');
    logger.error('❌ Test script failed!');
    logger.error('============================================================');
    logger.error('Error:', error?.message || error);
    logger.error('Stack:', error?.stack);
    process.exit(1);
  }
}

runTest();
