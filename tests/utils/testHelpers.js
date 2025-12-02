/**
 * Test helper functions
 */

/**
 * Create a test database connection
 */
export async function createTestDB() {
  // In real tests, you might want to use a test database
  // For now, we'll use mocks
  return {
    execute: jest.fn(),
    query: jest.fn(),
  };
}

/**
 * Reset all mocks
 */
export function resetMocks(...mocks) {
  mocks.forEach(mock => {
    if (mock && typeof mock.mockReset === 'function') {
      mock.mockReset();
    }
  });
}

/**
 * Wait for async operations
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create mock candle data
 */
export function createMockCandle(overrides = {}) {
  const now = Date.now();
  return {
    symbol: 'BTC/USDT',
    interval: '1m',
    open_time: now - 60000,
    open: 50000.00,
    high: 51000.00,
    low: 49000.00,
    close: 51000.00,
    volume: 100.5,
    close_time: now - 1000,
    ...overrides,
  };
}

/**
 * Create mock strategy
 */
export function createMockStrategy(overrides = {}) {
  return {
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
    ...overrides,
  };
}

