import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionService } from '../src/services/PositionService.js';
import { OrderService } from '../src/services/OrderService.js';
import { TelegramService } from '../src/services/TelegramService.js';
import logger from '../src/utils/logger.js';

/**
 * Script to test the position close notification flow.
 *
 * 1. Finds/creates a test bot and strategy.
 * 2. Creates a REAL small test position on the exchange via OrderService.
 * 3. Immediately closes the position via PositionService.
 * 4. Verifies that the notification logic is triggered.
 */

const TEST_BOT_ID = 2;
const TEST_SYMBOL = 'DOGEUSDT'; // Symbol for the test position (lower minimum notional)
const TEST_AMOUNT = 100; // USDT amount for the test position

async function runTest() {
  let createdPosition;
  try {
    logger.info('\n============================================================');
    logger.info('Position Close Notification Test');
    logger.info(`Testing with Bot ID: ${TEST_BOT_ID}, Symbol: ${TEST_SYMBOL}`);
    logger.info('============================================================\n');

    // 1. Find/create the bot
    let bot = await Bot.findById(TEST_BOT_ID);
    if (!bot || !bot.is_active) {
      throw new Error(`Bot with ID ${TEST_BOT_ID} is not active or not found.`);
    }
    logger.info(`[Test] Found bot: ${bot.name} (ID: ${bot.id})`);

    // 2. Find/create a strategy
    const strategies = await Strategy.findAll();
    let strategy = strategies.find(s => s.bot_id === TEST_BOT_ID && s.symbol === TEST_SYMBOL);
    if (!strategy) {
      logger.info(`[Test] No existing strategy found, creating a temporary one...`);
      strategy = await Strategy.create({
        bot_id: TEST_BOT_ID, symbol: TEST_SYMBOL, trade_type: 'both', interval: '1m',
        oc: 5, extend: 0, amount: TEST_AMOUNT, take_profit: 50, reduce: 10, up_reduce: 0, ignore: 0, is_active: true,
      });
    }
    logger.info(`[Test] Using strategy ID: ${strategy.id}`);

    // 3. Initialize services
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    logger.info('[Test] ExchangeService initialized.');

    const telegramService = new TelegramService();
    await telegramService.initialize();
    logger.info('[Test] TelegramService initialized.');

    const orderService = new OrderService(exchangeService, telegramService);
    const positionService = new PositionService(exchangeService, telegramService);
    logger.info('[Test] OrderService and PositionService created.');

    // 4. Create a REAL test position by executing a signal
    logger.info(`[Test] Creating a small ${TEST_SYMBOL} LONG position of ${TEST_AMOUNT} USDT...`);
    const entryPrice = await exchangeService.getTickerPrice(TEST_SYMBOL);
    const { calculateTakeProfit, calculateInitialStopLoss } = await import('../src/utils/calculator.js');
    const tpPrice = calculateTakeProfit(entryPrice, strategy.oc, strategy.take_profit, 'long');
    const slPrice = calculateInitialStopLoss(tpPrice, strategy.oc, strategy.reduce, 'long');

    const signal = { strategy, side: 'long', entryPrice, amount: TEST_AMOUNT, tpPrice, slPrice };
    createdPosition = await orderService.executeSignal(signal);

    if (!createdPosition) {
      throw new Error('Failed to create test position on the exchange.');
    }
    logger.info(`[Test] ✅ Successfully created position on exchange. DB Position ID: ${createdPosition.id}`);

    // 5. Wait for the position to be confirmed on the exchange, then close it
    logger.info('[Test] Waiting up to 30 seconds for position to appear on the exchange...');
    let positionOnExchange = null;
    for (let i = 0; i < 15; i++) { // Poll for up to 30 seconds
        const positions = await exchangeService.getOpenPositions(TEST_SYMBOL);
        const openPosition = positions.find(p => p.symbol === TEST_SYMBOL && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (openPosition) {
            positionOnExchange = openPosition;
            logger.info(`[Test] ✅ Position confirmed on exchange:`, positionOnExchange);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before next poll
    }

    if (!positionOnExchange) {
        throw new Error(`Position for ${TEST_SYMBOL} did not appear on the exchange after 30 seconds.`);
    }

    const currentPrice = await exchangeService.getTickerPrice(TEST_SYMBOL);
    if (!currentPrice) {
      throw new Error(`Could not fetch current price for ${TEST_SYMBOL} to close position.`);
    }

    logger.info(`[Test] Calling closePosition for position ${createdPosition.id} at price ${currentPrice}...`);
    await positionService.closePosition(createdPosition, currentPrice, 0, 'manual_test');

    logger.info('\n============================================================');
    logger.info('✅ Test script finished.');
    logger.info('Please check the logs for `[Notification]` messages to verify success.');
    logger.info('============================================================\n');

    process.exit(0);
  } catch (error) {
    logger.error('\n============================================================');
    logger.error('❌ Test script failed!');
    logger.error('============================================================');
    logger.error('Error:', error?.message || error);
    logger.error('Stack:', error?.stack);
    // Clean up if position was created but failed later
    if (createdPosition) {
      logger.info(`[Cleanup] Attempting to close dangling test position ${createdPosition.id}`);
      try {
        const exchangeService = new ExchangeService(await Bot.findById(TEST_BOT_ID));
        await exchangeService.initialize();
        await exchangeService.closePosition(TEST_SYMBOL, 'long', TEST_AMOUNT);
        logger.info(`[Cleanup] ✅ Dangling position closed.`);
      } catch (cleanupError) {
        logger.error(`[Cleanup] ❌ Failed to clean up dangling position:`, cleanupError?.message || cleanupError);
      }
    }
    process.exit(1);
  }
}

runTest();
