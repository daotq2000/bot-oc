# Testing Guide

## Test Structure

```
tests/
├── setup.js                 # Jest setup configuration
├── utils/
│   ├── mocks.js             # Mock objects and fixtures
│   └── testHelpers.js       # Helper functions
├── unit/                    # Unit tests
│   ├── utils/
│   │   ├── calculator.test.js
│   │   └── validator.test.js
│   └── services/
│       ├── CandleService.test.js
│       └── StrategyService.test.js
└── integration/             # Integration tests
    ├── tradingFlow.test.js
    └── balanceManagement.test.js
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run tests with coverage
```bash
npm run test:coverage
```

### Run specific test file
```bash
npm test -- calculator.test.js
```

## Test Categories

### Unit Tests
- **Calculator**: Test all calculation functions (OC, TP, SL, PnL)
- **Validator**: Test input validation functions
- **Services**: Test individual service methods in isolation

### Integration Tests
- **Trading Flow**: Test complete flow from signal to position
- **Balance Management**: Test transfer and withdraw flows

### API Tests
- **Endpoints**: Test REST API endpoints
- **Controllers**: Test request/response handling

## Mocking

All external dependencies are mocked:
- Database models
- Exchange services
- Telegram service
- External APIs

## Test Data

Test fixtures are defined in `tests/utils/mocks.js`:
- `mockBot`: Sample bot configuration
- `mockStrategy`: Sample strategy
- `mockCandle`: Sample candle data
- `mockPosition`: Sample position

## Writing New Tests

1. Create test file in appropriate directory
2. Import necessary modules and mocks
3. Use `describe` and `it` blocks
4. Mock external dependencies
5. Test both success and error cases

Example:
```javascript
import { describe, it, expect, beforeEach } from '@jest/globals';

describe('MyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should do something', async () => {
    // Test implementation
    expect(result).toBe(expected);
  });
});
```

