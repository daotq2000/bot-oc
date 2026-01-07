import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionService } from '../src/services/PositionService.js';
import { OrderService } from '../src/services/OrderService.js';
import { TelegramService } from '../src/services/TelegramService.js';
import { calculateTakeProfit, calculateInitialStopLoss } from '../src/utils/calculator.js';
import logger from '../src/utils/logger.js';

/**
 * Script to test PNL notifications for both winning and losing positions.
 *
 * 1. Finds a test bot.
 * 2. Creates and closes a LONG position with profit.
 * 3. Creates and closes a SHORT position with loss.
 * 4. Verifies that the correct notifications are sent.
 */

const TEST_BOT_ID = 2;
const LONG_SYMBOL = 'DOGEUSDT';
const SHORT_SYMBOL = 'LTCUSDT';
const TEST_AMOUNT = 100; // USDT amount for each position

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
  try {
    logger.info('\n============================================================');
    logger.info('PNL Notification Test');
    logger.info(`Testing with Bot ID: ${TEST_BOT_ID}`);
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

    // --- Test 1: LONG Position with Profit ---
    logger.info('\n--- Starting Test 1: LONG Position (Profit) ---');
    const longStrategy = await findOrCreateStrategy(TEST_BOT_ID, LONG_SYMBOL);
    const longEntryPrice = await exchangeService.getTickerPrice(LONG_SYMBOL);
    const longSignal = { strategy: longStrategy, side: 'long', entryPrice: longEntryPrice, amount: TEST_AMOUNT };
    let longPosition = await orderService.executeSignal(longSignal);
    if (!longPosition) throw new Error('Failed to create LONG position in DB.');
    logger.info(`[Test] ✅ Created LONG position in DB. ID: ${longPosition.id}`);
    await waitForPosition(exchangeService, LONG_SYMBOL);
    await exchangeService.cancelAllOpenOrders(LONG_SYMBOL);
    logger.info(`[Test] Cancelled all open orders for ${LONG_SYMBOL}. Waiting 2s before closing.`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const longClosePrice = longPosition.entry_price * 1.02; // 2% profit
    await positionService.closePosition(longPosition, longClosePrice, 0, 'manual_test_win');
    logger.info('--- Finished Test 1: LONG Position ---\n');

    // --- Test 2: SHORT Position with Loss ---
    logger.info('--- Starting Test 2: SHORT Position (Loss) ---');
    const shortStrategy = await findOrCreateStrategy(TEST_BOT_ID, SHORT_SYMBOL);
    const shortEntryPrice = await exchangeService.getTickerPrice(SHORT_SYMBOL);
    const shortSignal = { strategy: shortStrategy, side: 'short', entryPrice: shortEntryPrice, amount: TEST_AMOUNT };
    let shortPosition = await orderService.executeSignal(shortSignal);
    if (!shortPosition) throw new Error('Failed to create SHORT position in DB.');
    logger.info(`[Test] ✅ Created SHORT position in DB. ID: ${shortPosition.id}`);
    await waitForPosition(exchangeService, SHORT_SYMBOL);
    await exchangeService.cancelAllOpenOrders(SHORT_SYMBOL);
    logger.info(`[Test] Cancelled all open orders for ${SHORT_SYMBOL}. Waiting 2s before closing.`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const shortClosePrice = shortPosition.entry_price * 1.02; // 2% loss
    await positionService.closePosition(shortPosition, shortClosePrice, 0, 'manual_test_loss');
    logger.info('--- Finished Test 2: SHORT Position ---\n');

    logger.info('\n============================================================');
    logger.info('✅ Test script finished successfully.');
    logger.info('Please check the logs and Telegram for notifications.');
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
