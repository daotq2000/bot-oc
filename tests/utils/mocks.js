import { jest } from "@jest/globals";

/**
 * Test mocks and fixtures
 */

export const mockBot = {
  id: 1,
  bot_name: 'Test Bot',
  exchange: 'mexc',
  uid: 'test_uid',
  access_key: 'test_access_key',
  secret_key: 'test_secret_key',
  proxy: '127.0.0.1:8080:user:pass',
  telegram_chat_id: '123456789',
  future_balance_target: 20.00,
  spot_transfer_threshold: 10.00,
  transfer_frequency: 15,
  withdraw_enabled: false,
  withdraw_address: null,
  withdraw_network: 'BEP20',
  spot_balance_threshold: 10.00,
  is_active: true,
};

export const mockStrategy = {
  id: 1,
  bot_id: 1,
  symbol: 'BTC/USDT',
  trade_type: 'both',
  interval: '1m',
  oc: 2.00,
  extend: 10.00,
  amount: 10.00,
  take_profit: 50.00,
  reduce: 5.00,
  up_reduce: 5.00,
  ignore: 50.00,
  is_active: true,
};

export const mockCandle = {
  id: 1,
  exchange: 'mexc',
  symbol: 'BTC/USDT',
  interval: '1m',
  open_time: Date.now() - 60000,
  open: 50000.00,
  high: 51000.00,
  low: 49000.00,
  close: 51000.00,
  volume: 100.5,
  close_time: Date.now() - 1000,
};

export const mockPosition = {
  id: 1,
  strategy_id: 1,
  order_id: 'test_order_123',
  symbol: 'BTC/USDT',
  side: 'long',
  entry_price: 50000.00,
  amount: 10.00,
  take_profit_price: 52500.00,
  stop_loss_price: 47500.00,
  current_reduce: 5.00,
  minutes_elapsed: 0,
  status: 'open',
  pnl: null,
  close_price: null,
  close_reason: null,
};

export const mockExchangeService = {
  bot: mockBot, // Add bot reference for exchange
  initialize: jest.fn().mockResolvedValue(true),
  getBalance: jest.fn().mockResolvedValue({ free: 100, used: 0, total: 100 }),
  createOrder: jest.fn().mockResolvedValue({ id: 'order_123', status: 'open' }),
  closePosition: jest.fn().mockResolvedValue({ id: 'close_123' }),
  transferSpotToFuture: jest.fn().mockResolvedValue({ id: 'transfer_123' }),
  transferFutureToSpot: jest.fn().mockResolvedValue({ id: 'transfer_123' }),
  withdraw: jest.fn().mockResolvedValue({ id: 'withdraw_123' }),
  getOpenPositions: jest.fn().mockResolvedValue([]),
  fetchOHLCV: jest.fn().mockResolvedValue([mockCandle]),
  getTickerPrice: jest.fn().mockResolvedValue(50000.00),
  cancelOrder: jest.fn().mockResolvedValue({ id: 'cancel_123' }),
};

export const mockTelegramService = {
  initialize: jest.fn().mockResolvedValue(true),
  sendMessage: jest.fn().mockResolvedValue(true),
  sendOrderNotification: jest.fn().mockResolvedValue(true),
  sendCloseNotification: jest.fn().mockResolvedValue(true),
  sendErrorNotification: jest.fn().mockResolvedValue(true),
  sendBalanceUpdate: jest.fn().mockResolvedValue(true),
};

