# Concurrency Testing Guide for PositionLimitService

## Tổng quan

`PositionLimitService` sử dụng **MySQL Advisory Lock (GET_LOCK)** để tránh race condition khi nhiều luồng cùng check limit và tạo order.

## Lock Mechanism

### Implementation

```javascript
// 1. Acquire advisory lock
const lockKey = `pos_limit_${botId}_${symbol}`;
const [lockResult] = await connection.execute('SELECT GET_LOCK(?, ?)', [lockKey, timeout]);

// 2. Check limit (within lock)
const canOpen = checkLimit();

// 3. Release lock
await connection.execute('SELECT RELEASE_LOCK(?)', [lockKey]);
```

### Lock Key Format

- Format: `pos_limit_{botId}_{symbol}`
- Example: `pos_limit_1_BTCUSDT`
- Symbol được normalize: uppercase, remove `/`, `:`, `_`

### Lock Timeout

- Default: 5 seconds
- Nếu không acquire được lock sau 5s → reject (fail-safe)

## Race Condition Scenario

### Without Lock (Vấn đề)

```
Thread A: Check limit → current = 20, new = 10, max = 30 → PASS (projected = 30)
Thread B: Check limit → current = 20, new = 10, max = 30 → PASS (projected = 30)
Thread A: Create order → total = 30 ✅
Thread B: Create order → total = 40 ❌ (vượt limit!)
```

### With Lock (Giải pháp)

```
Thread A: Acquire lock → Check limit → current = 20, new = 10 → PASS → Create order → Release lock
Thread B: Wait for lock → Acquire lock → Check limit → current = 30, new = 10 → REJECT → Release lock
```

## Testing Concurrency

### Unit Tests

**File:** `tests/unit/services/PositionLimitService.concurrency.test.js`

Tests verify:
- Lock acquisition và release
- Limit check logic
- Error handling

### Integration Tests (Runtime)

Để test concurrency thực tế, chạy script sau:

```bash
# Test script: test_concurrency.js
node scripts/test_position_limit_concurrency.js
```

### Manual Test Script

Tạo file `scripts/test_position_limit_concurrency.js`:

```javascript
import { positionLimitService } from '../src/services/PositionLimitService.js';

async function testConcurrency() {
  const botId = 1;
  const symbol = 'BTC/USDT';
  const maxAmount = 30;
  const amountPerRequest = 10;
  const numConcurrentRequests = 5;

  console.log(`Testing concurrency: ${numConcurrentRequests} requests, each ${amountPerRequest} USDT, max = ${maxAmount}`);

  // Simulate concurrent requests
  const promises = Array.from({ length: numConcurrentRequests }, (_, i) => 
    positionLimitService.canOpenNewPosition({
      botId,
      symbol,
      newOrderAmount: amountPerRequest
    }).then(result => {
      console.log(`Request ${i + 1}: ${result ? 'ALLOWED' : 'REJECTED'}`);
      return result;
    })
  );

  const results = await Promise.all(promises);
  const allowedCount = results.filter(r => r === true).length;
  const rejectedCount = results.filter(r => r === false).length;

  console.log(`\nResults:`);
  console.log(`  Allowed: ${allowedCount}`);
  console.log(`  Rejected: ${rejectedCount}`);
  console.log(`  Expected: 3 allowed, 2 rejected (max = ${maxAmount}, each = ${amountPerRequest})`);

  // Verify
  if (allowedCount === 3 && rejectedCount === 2) {
    console.log('✅ Test PASSED: Lock prevented race condition');
  } else {
    console.log('❌ Test FAILED: Race condition detected!');
    process.exit(1);
  }
}

testConcurrency().catch(console.error);
```

## Performance Considerations

### Lock Overhead

- **Advisory lock** là lightweight, không lock database rows
- Lock timeout = 5s đủ cho hầu hết cases
- Nếu timeout thường xuyên → có thể tăng timeout hoặc optimize query

### Connection Pool

- Mỗi check sử dụng 1 connection từ pool
- Connection được release ngay sau khi check xong
- Pool size nên đủ lớn để handle concurrent requests

## Monitoring

### Logs

Khi lock timeout:
```
[PositionLimitService] Failed to acquire lock for bot=1 symbol=BTC/USDT after 5s timeout
```

Khi limit reached:
```
[PositionLimitService] [POSITION_LIMIT_REACHED] bot=1 symbol=BTC/USDT current=30.00 new=10.00 projected=40.00 max=30.00
```

### Metrics to Monitor

1. Lock acquisition time
2. Lock timeout frequency
3. Limit rejection rate
4. Concurrent request count

## Best Practices

1. **Always release lock**: Sử dụng try-finally để đảm bảo lock được release
2. **Fail-safe**: Nếu lock timeout → reject (safer than allow)
3. **Connection management**: Luôn release connection về pool
4. **Error handling**: Log errors nhưng không block system

## Troubleshooting

### Lock timeout thường xuyên

- Kiểm tra query performance
- Tăng lock timeout
- Kiểm tra connection pool size

### Race condition vẫn xảy ra

- Verify lock key format đúng
- Check connection pool không bị exhausted
- Verify lock được release đúng cách

