import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionWebSocketClient } from '../src/services/PositionWebSocketClient.js';
import { PositionService } from '../src/services/PositionService.js';
import { TelegramService } from '../src/services/TelegramService.js';
import { BinanceDirectClient } from '../src/services/BinanceDirectClient.js';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';

const BOT_ID = 2; // Bot ID to test
const DEFAULT_SYMBOL_TO_CLOSE = 'BASUSDT';
const SIDE_TO_CLOSE = 'long';
const TEST_TIMEOUT_MS = 60_000; // Max waiting time for WebSocket confirmation

async function main() {
  logger.info('--- Starting Position Closing Test Script ---');

  // 1. Initialize Services
  logger.info(`Loading bot config for bot_id=${BOT_ID}...`);
  const bot = await Bot.findById(BOT_ID);
  if (!bot) {
    logger.error(`Bot with id=${BOT_ID} not found.`);
    return;
  }

  const telegramService = new TelegramService();
  await telegramService.initialize(bot.telegram_chat_id);

  const exchangeService = new ExchangeService(bot);
  await exchangeService.initialize();

  const positionService = new PositionService(exchangeService, telegramService);

  logger.info('Services initialized successfully.');

  // 2. Find the position to close
  let timeoutId = null;
  let symbolToClose = DEFAULT_SYMBOL_TO_CLOSE;

  logger.info(`Searching for open '${SIDE_TO_CLOSE}' position for ${symbolToClose}...`);
  let [positions] = await pool.execute(
    `SELECT * FROM positions WHERE bot_id = ? AND symbol LIKE ? AND side = ? AND status = 'open' LIMIT 1`,
    [BOT_ID, `%${symbolToClose}%`, SIDE_TO_CLOSE]
  );

  let positionToClose = positions[0];

  if (!positionToClose) {
    logger.warn(`No open '${SIDE_TO_CLOSE}' position found for ${symbolToClose} and bot_id=${BOT_ID} in DB. Checking exchange for active positions...`);

    try {
      const openExchangePositions = await exchangeService.getOpenPositions();

      if (!Array.isArray(openExchangePositions) || openExchangePositions.length === 0) {
        logger.error(`No active positions found on exchange for bot_id=${BOT_ID}. Cannot run close-position test.`);
        return;
      }

      const desiredSideLabel = SIDE_TO_CLOSE === 'long' ? 'LONG' : 'SHORT';

      // Try to find a position on exchange that matches desired side, otherwise fallback to first
      let exchangePos = openExchangePositions.find(p => {
        const amt = parseFloat(p.positionAmt || p.contracts || 0);
        if (!amt) return false;
        const isLong = amt > 0;
        const sideLabel = p.positionSide || (isLong ? 'LONG' : 'SHORT');
        return sideLabel === desiredSideLabel;
      }) || openExchangePositions[0];

      const exchangeSymbol = exchangePos.symbol;
      symbolToClose = exchangeSymbol;

      logger.info(`Using active exchange position for test: Symbol=${exchangeSymbol}, Side=${desiredSideLabel}, Amt=${exchangePos.positionAmt || exchangePos.contracts}`);

      // Map back to DB position with same symbol & side
      const [dbPositions] = await pool.execute(
        `SELECT * FROM positions WHERE bot_id = ? AND symbol LIKE ? AND side = ? AND status = 'open' LIMIT 1`,
        [BOT_ID, `%${exchangeSymbol}%`, SIDE_TO_CLOSE]
      );

      positionToClose = dbPositions[0];
      if (!positionToClose) {
        logger.error(`No matching open DB position found for symbol=${exchangeSymbol}, side=${SIDE_TO_CLOSE}, bot_id=${BOT_ID}.`);
        return;
      }
    } catch (err) {
      logger.error('Error while fetching active positions from exchange:', err);
      return;
    }
  }

  logger.info(`Found position to close: ID=${positionToClose.id}, Symbol=${positionToClose.symbol}, Amount=${positionToClose.amount}`);

  // 3. Setup WebSocket Listener (Binance user-data stream)
  logger.info('Setting up Binance WebSocket listener for user data...');
  const binanceDirectClient = exchangeService.binanceDirectClient;
  if (!binanceDirectClient) {
    logger.error('BinanceDirectClient not available.');
    return;
  }

  // Reuse the same PositionWebSocketClient logic as production EntryOrderMonitor
  const restMakeRequest = binanceDirectClient.makeRequest.bind(binanceDirectClient);
  const isTestnet = !!binanceDirectClient.isTestnet;
  const wsClient = new PositionWebSocketClient(restMakeRequest, isTestnet);

  wsClient.on('ORDER_TRADE_UPDATE', async (evt) => {
    try {
      const order = evt.o || evt.order || {};

      // We are looking for the market close order, which is a SELL for a LONG position
      if (order.s === symbolToClose && order.S === 'SELL' && order.ot === 'MARKET') {
        logger.info(`Received ORDER_TRADE_UPDATE for ${order.s}: Status=${order.X}, OrderID=${order.i}`);

        if (order.X === 'FILLED') {
          // Clear timeout when we get a successful fill
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          logger.info('✅ Close order has been filled!');
          
          // 5. Verification steps
          logger.info('--- Verifying post-close state ---');
          
          // Give a small delay for DB update to complete
          await new Promise(resolve => setTimeout(resolve, 2000));

          const finalPosition = await Position.findById(positionToClose.id);

          if (finalPosition && finalPosition.status === 'closed') {
            logger.info(`✅ Position status in DB is now 'closed'.`);
            logger.info(`   - Close Reason: ${finalPosition.close_reason}`);
            logger.info(`   - PNL: ${finalPosition.pnl}`);
            logger.info(`   - Close Price: ${finalPosition.close_price}`);
          } else {
            logger.error(`❌ Position status in DB is NOT 'closed'. Current status: ${finalPosition ? finalPosition.status : 'not found'}`);
          }

          logger.info('Verification complete. Closing script.');
          wsClient.stop();
          process.exit(0);
        }
      }
    } catch (err) {
      logger.error('Error handling ORDER_TRADE_UPDATE in test script:', err);
    }
  });

  wsClient.on('listenKeyExpired', () => {
    logger.warn('[TestClosePosition] listenKeyExpired received, WS client will reconnect automatically.');
  });

  await wsClient.connect();
  logger.info('WebSocket listener is active (user-data stream).');

  // 4. Close the position
  logger.info(`Attempting to close position ID=${positionToClose.id} with a market order...`);
  try {
    await positionService.closePosition(positionToClose, await exchangeService.getTickerPrice(positionToClose.symbol), 0, 'manual_test');
    logger.info('Close command sent successfully. Waiting for WebSocket confirmation...');

    // Global timeout to avoid hanging forever if WS event never arrives
    timeoutId = setTimeout(() => {
      logger.error(`❌ Test timeout reached (${TEST_TIMEOUT_MS} ms) without receiving ORDER_TRADE_UPDATE FILLED event. Exiting.`);
      try {
        wsClient.stop();
      } catch (_) {}
      process.exit(1);
    }, TEST_TIMEOUT_MS);
  } catch (error) {
    logger.error('Error sending close command:', error);
    try {
      wsClient.stop();
    } catch (_) {}
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('An unexpected error occurred:', error);
  process.exit(1);
});

