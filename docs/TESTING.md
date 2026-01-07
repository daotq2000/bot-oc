# Testing Documentation

## Tổng Quan

Hệ thống testing đã được implement với đầy đủ unit tests, integration tests và API tests cho toàn bộ features.

## Cấu Trúc Tests

```
tests/
├── setup.js                      # Jest configuration setup
├── utils/
│   ├── mocks.js                  # Mock objects và fixtures
│   └── testHelpers.js            # Helper functions
├── unit/                          # Unit tests
│   ├── utils/
│   │   ├── calculator.test.js    # Test calculation functions
│   │   └── validator.test.js     # Test validation functions
│   ├── services/
│   │   ├── CandleService.test.js
│   │   ├── StrategyService.test.js
│   │   ├── PositionService.test.js
│   │   └── OrderService.test.js
│   └── models/
│       └── Bot.test.js
├── integration/                   # Integration tests
│   ├── tradingFlow.test.js       # Test complete trading flow
│   └── balanceManagement.test.js # Test balance management
└── api/                           # API tests
    └── bot.test.js
```

## Chạy Tests

### Tất cả tests
```bash
npm test
```

### Watch mode (tự động chạy khi file thay đổi)
```bash
npm run test:watch
```

### Với coverage report
```bash
npm run test:coverage
```

### Chạy test file cụ thể
```bash
npm test -- calculator.test.js
```

## Test Coverage

### Unit Tests

#### 1. Calculator Tests (`calculator.test.js`)
- ✅ `calculateOC()` - Tính OC percentage
- ✅ `getCandleDirection()` - Xác định hướng nến
- ✅ `calculateLongEntryPrice()` - Tính entry cho long
- ✅ `calculateShortEntryPrice()` - Tính entry cho short
- ✅ `calculateTakeProfit()` - Tính TP
- ✅ `calculateInitialStopLoss()` - Tính SL ban đầu
- ✅ `calculateDynamicStopLoss()` - Tính SL động
- ✅ `calculatePnL()` - Tính PnL
- ✅ `calculatePnLPercent()` - Tính PnL %

#### 2. Validator Tests (`validator.test.js`)
- ✅ `validateProxy()` - Validate proxy format
- ✅ `validateExchange()` - Validate exchange name
- ✅ `validateSymbol()` - Validate trading symbol
- ✅ `validateInterval()` - Validate timeframe
- ✅ `validateTradeType()` - Validate trade type
- ✅ `validateAmount()` - Validate amount
- ✅ `validatePercentage()` - Validate percentage
- ✅ `validateWalletAddress()` - Validate wallet address
- ✅ `validateNetwork()` - Validate network

#### 3. Service Tests

**CandleService** (`CandleService.test.js`)
- ✅ `updateCandles()` - Update candles from exchange
- ✅ `getLatestCandle()` - Get latest candle
- ✅ `getPreviousCandle()` - Get previous candle
- ✅ `calculateCandleMetrics()` - Calculate OC and direction
- ✅ `isCandleClosed()` - Check if candle is closed

**StrategyService** (`StrategyService.test.js`)
- ✅ `checkSignal()` - Check for trading signal
- ✅ `checkExtendCondition()` - Check extend condition
- ✅ `calculateEntryPrice()` - Calculate entry price

**PositionService** (`PositionService.test.js`)
- ✅ `isTakeProfitHit()` - Check if TP hit
- ✅ `isStopLossHit()` - Check if SL hit
- ✅ `calculateUpdatedStopLoss()` - Calculate dynamic SL

**OrderService** (`OrderService.test.js`)
- ✅ `shouldUseMarketOrder()` - Decide order type
- ✅ `executeSignal()` - Execute trading signal

#### 4. Model Tests

**Bot Model** (`Bot.test.js`)
- ✅ `findAll()` - Find all bots
- ✅ `findById()` - Find bot by ID
- ✅ `create()` - Create new bot

### Integration Tests

#### 1. Trading Flow (`tradingFlow.test.js`)
- ✅ Complete flow từ signal đến position
- ✅ Monitor position và close on TP hit
- ✅ Test với các scenarios khác nhau

#### 2. Balance Management (`balanceManagement.test.js`)
- ✅ Transfer spot to future
- ✅ Transfer future to spot
- ✅ Auto manage balances
- ✅ Auto withdraw
- ✅ Error handling

### API Tests

#### Bot API (`bot.test.js`)
- ✅ GET /api/bots - List bots
- ✅ POST /api/bots - Create bot
- ✅ Validation và error handling

## Mock Objects

Tất cả external dependencies được mock trong `tests/utils/mocks.js`:

- `mockBot` - Sample bot configuration
- `mockStrategy` - Sample strategy
- `mockCandle` - Sample candle data
- `mockPosition` - Sample position
- `mockExchangeService` - Mocked exchange service
- `mockTelegramService` - Mocked telegram service

## Test Utilities

### Helpers (`testHelpers.js`)
- `createTestDB()` - Create test database connection
- `resetMocks()` - Reset all mocks
- `sleep()` - Wait for async operations
- `createMockCandle()` - Create mock candle
- `createMockStrategy()` - Create mock strategy

## Best Practices

1. **Isolation**: Mỗi test độc lập, không phụ thuộc vào test khác
2. **Mocking**: Mock tất cả external dependencies
3. **Clear Names**: Test names mô tả rõ ràng behavior
4. **Arrange-Act-Assert**: Structure tests theo pattern AAA
5. **Coverage**: Aim for >80% code coverage

## Example Test

```javascript
import { describe, it, expect, beforeEach } from '@jest/globals';

describe('MyService', () => {
  beforeEach(() => {
    // Setup before each test
    jest.clearAllMocks();
  });

  it('should do something correctly', async () => {
    // Arrange
    const input = { value: 100 };
    
    // Act
    const result = await myService.process(input);
    
    // Assert
    expect(result).toBe(expected);
  });
});
```

## Continuous Integration

Tests có thể được chạy trong CI/CD pipeline:

```yaml
# Example GitHub Actions
- name: Run tests
  run: npm test

- name: Generate coverage
  run: npm run test:coverage
```

## Troubleshooting

### Tests fail với import errors
- Đảm bảo `package.json` có `"type": "module"`
- Kiểm tra Jest config đúng

### Mock không hoạt động
- Đảm bảo mock được setup trong `beforeEach`
- Kiểm tra mock được import đúng

### Database connection errors
- Tests sử dụng mocks, không cần real database
- Nếu cần test database, setup test database riêng

## Coverage Goals

- **Unit Tests**: >90% coverage
- **Integration Tests**: >70% coverage
- **API Tests**: >80% coverage
- **Overall**: >80% coverage

## Next Steps

1. Thêm tests cho các services còn lại
2. Thêm tests cho cron jobs
3. Thêm E2E tests
4. Setup CI/CD với test automation

