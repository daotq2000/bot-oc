# Implementation: Position Limit Service

## Tổng quan

Feature này implement **hard limit** cho tổng USDT vào lệnh cho mỗi coin dựa trên `bots.max_amount_per_coin`.

### Business Rules

1. `bots.max_amount_per_coin` giới hạn tổng position size (USDT) cho mỗi symbol
2. Tổng tiền = **sum(amount của tất cả order đã mở + đang pending cho cùng symbol)**
3. Khi **reach hoặc vượt threshold** → **reject toàn bộ lệnh mới**, kể cả DCA
4. Áp dụng cho **cả LONG & SHORT**
5. Không phụ thuộc vào biến động giá hay tín hiệu strategy

## Implementation

### 1. PositionLimitService

**File:** `src/services/PositionLimitService.js`

Service mới để kiểm tra giới hạn position:

#### Methods

- `canOpenNewPosition({ botId, symbol, newOrderAmount })`: Kiểm tra có thể mở position mới không
  - Returns: `true` nếu có thể mở, `false` nếu đã chạm/vượt limit
  - Logic: `projectedAmount >= maxAmountPerCoin` → reject

- `getCurrentTotalAmount(botId, symbol)`: Lấy tổng amount hiện tại cho một symbol

#### Logic Details

- Tính tổng từ:
  - Open positions (`p.status = 'open'`)
  - Pending entry orders (`eo.status = 'open'`)
- Reject khi: `currentAmount + newOrderAmount >= maxAmountPerCoin`
- Special cases:
  - `max_amount_per_coin = 0` → reject toàn bộ
  - `max_amount_per_coin = null/undefined` → không có limit (allow)
  - Bot not found → allow (tránh block system)
  - Database error → allow (tránh block system)

### 2. OrderService Integration

**File:** `src/services/OrderService.js`

Cập nhật `executeSignal()` để sử dụng `PositionLimitService`:

```javascript
// Check using PositionLimitService before creating any new order
const canOpen = await positionLimitService.canOpenNewPosition({
  botId: strategy.bot_id,
  symbol: strategy.symbol,
  newOrderAmount: amount
});

if (!canOpen) {
  // Log và reject
  return null;
}
```

### 3. Changes from Previous Implementation

**Before:**
- Logic check nằm trong `OrderService.executeSignal()`
- Check `projectedAmount > maxAmountPerCoin` (chỉ reject khi vượt quá)

**After:**
- Logic tách riêng vào `PositionLimitService`
- Check `projectedAmount >= maxAmountPerCoin` (reject khi chạm hoặc vượt)
- Cleaner code, dễ test và maintain

## Unit Tests

**File:** `tests/unit/services/PositionLimitService.test.js`

### Test Coverage: 17 tests

#### canOpenNewPosition (14 tests)

1. ✅ Cho phép mở khi tổng < max
   - `current = 20, new = 5, max = 30` → `true`

2. ✅ Reject khi vừa chạm ngưỡng
   - `current = 20, new = 10, max = 30` → `projected = 30 >= 30` → `false`

3. ✅ Reject khi vượt ngưỡng
   - `current = 25, new = 10, max = 30` → `projected = 35 >= 30` → `false`

4. ✅ Edge case: current = 0, new = max
   - `current = 0, new = 30, max = 30` → `projected = 30 >= 30` → `false`

5. ✅ Edge case: current = 0, new < max
   - `current = 0, new = 20, max = 30` → `true`

6. ✅ max_amount_per_coin = 0 → reject toàn bộ
   - `max = 0` → `false`

7. ✅ max_amount_per_coin = null/undefined → allow
   - `max = null` → `true`

8. ✅ max_amount_per_coin = negative → allow (invalid)
   - `max = -10` → `true`

9. ✅ Include cả open positions và pending orders
   - `positions = 15, pending = 10, new = 5, max = 30` → `projected = 30 >= 30` → `false`

10. ✅ Allow khi include pending orders vẫn dưới max
    - `positions = 10, pending = 5, new = 10, max = 30` → `projected = 25 < 30` → `true`

11. ✅ Handle bot not found gracefully
    - `bot = null` → `true` (tránh block system)

12. ✅ Handle database errors gracefully
    - `DB error` → `true` (tránh block system)

13. ✅ Handle empty query result
    - `no rows` → `true`

14. ✅ Handle null/undefined amounts
    - `amounts = null` → `true`

#### getCurrentTotalAmount (3 tests)

1. ✅ Return sum of positions and pending orders
2. ✅ Return 0 when no positions or orders
3. ✅ Handle database errors and return 0

## Usage Example

```javascript
import { positionLimitService } from './services/PositionLimitService.js';

// Check before creating order
const canOpen = await positionLimitService.canOpenNewPosition({
  botId: 1,
  symbol: 'BTC/USDT',
  newOrderAmount: 10
});

if (!canOpen) {
  logger.warn('[POSITION_LIMIT_REACHED] Cannot open new position');
  return null;
}

// Proceed with order creation
```

## Logging

Khi reject, log format:
```
[PositionLimitService] [POSITION_LIMIT_REACHED] bot=1 symbol=BTC/USDT current=30.00 new=10.00 projected=40.00 max=30.00
```

## Database Query

Query tính tổng amount:
```sql
SELECT 
  COALESCE(SUM(CASE WHEN p.status = 'open' THEN p.amount ELSE 0 END), 0) AS positions_amount,
  COALESCE(SUM(CASE WHEN eo.status = 'open' THEN eo.amount ELSE 0 END), 0) AS pending_orders_amount
FROM strategies s
LEFT JOIN positions p ON p.strategy_id = s.id AND p.status = 'open' AND p.symbol = ?
LEFT JOIN entry_orders eo ON eo.strategy_id = s.id AND eo.status = 'open' AND eo.symbol = ?
WHERE s.bot_id = ? AND s.symbol = ?
GROUP BY s.bot_id, s.symbol
```

## Files Changed

1. `src/services/PositionLimitService.js` - New service
2. `src/services/OrderService.js` - Updated to use PositionLimitService
3. `tests/unit/services/PositionLimitService.test.js` - New unit tests
4. `tests/unit/services/OrderService.test.js` - Updated to mock PositionLimitService

## Verification

Sau khi deploy, verify bằng cách:

1. Set `max_amount_per_coin` cho một bot:
```sql
UPDATE bots SET max_amount_per_coin = 30 WHERE id = 1;
```

2. Kiểm tra logs khi tạo order:
- Nếu tổng < max → order được tạo
- Nếu tổng >= max → order bị reject với log `[POSITION_LIMIT_REACHED]`

3. Test với các scenarios:
- Mở position đầu tiên
- Mở position thứ 2, 3...
- Khi chạm limit
- Khi vượt limit

## Notes

- **Hard limit**: Không được vượt trong mọi trường hợp
- **Includes pending orders**: Tính cả entry orders đang pending
- **Applies to both LONG & SHORT**: Không phân biệt side
- **Error handling**: Cho phép khi có lỗi để tránh block toàn bộ system (nhưng log để debug)

