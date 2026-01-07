// Usage: node test_websocket.js [bot_id]
// Example: node test_websocket.js 2

import { Bot } from './src/models/Bot.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { PositionWebSocketClient } from './src/services/PositionWebSocketClient.js';
import dbPool from './src/config/database.js';
import { configService } from './src/services/ConfigService.js';

const botId = process.argv[2] ? parseInt(process.argv[2], 10) : 2;

if (!botId || isNaN(botId)) {
  console.error('Please provide a valid bot_id.');
  process.exit(1);
}

async function main() {
  console.log(`Attempting to connect to WebSocket for bot_id: ${botId}...`);

  try {
    // 1. Load app configs
    await configService.loadAll();

    // 2. Fetch bot credentials from the database
    const bot = await Bot.findById(botId);
    if (!bot) {
      console.error(`Bot with id=${botId} not found.`);
      return;
    }
    if ((bot.exchange || '').toLowerCase() !== 'binance') {
      console.error(`This script only works for Binance bots. Bot ${botId} is configured for '${bot.exchange}'.`);
      return;
    }

    console.log(`Found bot: ${bot.bot_name} (Exchange: ${bot.exchange})`);

    // 3. Initialize ExchangeService to get the BinanceDirectClient
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();

    if (!exchangeService.binanceDirectClient) {
      console.error('Failed to initialize BinanceDirectClient within ExchangeService.');
      return;
    }

    // 4. Create and configure the WebSocket client
    const restMakeRequest = exchangeService.binanceDirectClient.makeRequest.bind(exchangeService.binanceDirectClient);
    const isTestnet = !!exchangeService.binanceDirectClient.isTestnet;
    const wsClient = new PositionWebSocketClient(restMakeRequest, isTestnet);

    console.log(`Connecting to ${isTestnet ? 'Testnet' : 'Production'} WebSocket...`);

    // 5. Set up event listeners to log data
    wsClient.on('connected', () => {
      console.log('✅ WebSocket Connected! Listening for events...');
    });

    wsClient.on('disconnected', () => {
      console.warn('⚠️ WebSocket Disconnected. It will attempt to reconnect.');
    });

    wsClient.on('error', (error) => {
      console.error('❌ WebSocket Error:', error.message || error);
    });

    wsClient.on('listenKeyExpired', () => {
        console.warn('🔑 Listen Key Expired. Reconnecting with a new key...');
    });

    wsClient.on('ACCOUNT_UPDATE', (data) => {
      console.log('\n---------- [ACCOUNT_UPDATE] ----------');
      console.log('Timestamp:', new Date().toISOString());
      console.log(JSON.stringify(data, null, 2));
      console.log('------------------------------------\n');
    });

    wsClient.on('ORDER_TRADE_UPDATE', (data) => {
      console.log('\n---------- [ORDER_TRADE_UPDATE] ----------');
      console.log('Timestamp:', new Date().toISOString());
      console.log(JSON.stringify(data, null, 2));
      console.log('--------------------------------------\n');
    });

    // 6. Connect
    await wsClient.connect();

    // Keep the script running and handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down WebSocket client...');
      await wsClient.stop();
      await dbPool.end();
      console.log('Client stopped. Exiting.');
      process.exit(0);
    });

  } catch (error) {
    console.error('An error occurred during initialization:', error);
    await dbPool.end();
    process.exit(1);
  }
}

main();

