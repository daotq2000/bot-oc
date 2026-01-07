import { TelegramService } from '../src/services/TelegramService.js';
import { Bot } from '../src/models/Bot.js';
import logger from '../src/utils/logger.js';

/**
 * Script to directly test the Telegram close notification logic.
 *
 * This script does NOT interact with the exchange. It simulates a closed position
 * and calls the notification function directly to isolate and debug the alert mechanism.
 */

const TEST_BOT_ID = 2;

async function runTest() {
  try {
    logger.info('\n============================================================');
    logger.info('Direct Telegram Notification Test');
    logger.info('============================================================\n');

    // 1. Initialize Telegram Service
    const telegramService = new TelegramService();
    await telegramService.initialize();
    if (!telegramService.isReady()) {
        logger.warn('Telegram Service is not configured (missing token or chat ID). The script will log the message content instead of sending it.');
    }
    logger.info('[Test] TelegramService initialized.');

    // 2. Mock Bot and Stats data
    const bot = await Bot.findById(TEST_BOT_ID) || { id: TEST_BOT_ID, bot_name: 'Test Bot' };
    const stats = { total_wins: 10, total_losses: 5, total_pnl: 123.45 };

    // 3. Simulate a WINNING position
    logger.info('\n--- Testing WINNING Position Notification ---');
    const winningPosition = {
        id: 1001,
        bot_id: TEST_BOT_ID,
        symbol: 'RIVER_USDT',
        side: 'long',
        pnl: 0.151,
        pnl_percent: 1.51,
        entry_price: 1.799,
        close_price: 1.811,
        amount: 10.14,
        closed_at: new Date().toISOString(),
        strategy: { // Mock strategy data
            interval: '1m',
            oc: 3.565,
            extend: 80,
            take_profit: 40,
        },
        bot: bot
    };

    logger.info('[Test] Simulating winning position data:', winningPosition);
    await telegramService.sendCloseSummaryAlert(winningPosition, stats);
    logger.info('[Test] ✅ Winning position notification test complete.');

    // 4. Simulate a LOSING position
    logger.info('\n--- Testing LOSING Position Notification ---');
    const losingPosition = {
        id: 1002,
        bot_id: TEST_BOT_ID,
        symbol: 'FRANKLIN_USDT',
        side: 'short',
        pnl: -0.081,
        pnl_percent: -7.56,
        entry_price: 0.00299,
        close_price: 0.00277,
        amount: 2.49,
        closed_at: new Date().toISOString(),
        strategy: { // Mock strategy data
            interval: '1m',
            oc: 3.4,
            extend: 80,
            take_profit: 30,
        },
        bot: bot
    };
    logger.info('[Test] Simulating losing position data:', losingPosition);
    await telegramService.sendCloseSummaryAlert(losingPosition, stats);
    logger.info('[Test] ✅ Losing position notification test complete.');


    logger.info('\n============================================================');
    logger.info('✅ Test script finished successfully.');
    logger.info('Please check the console output above for the generated message content.');
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

