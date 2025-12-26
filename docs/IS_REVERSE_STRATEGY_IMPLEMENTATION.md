# Implementation: is_reverse_strategy Feature

## Tổng quan

Feature này cho phép bot chọn chiến lược giao dịch:
- **Reverse Strategy** (`is_reverse_strategy = true`, default): Đánh ngược sóng
  - Thị trường tăng (bullish) → SHORT
  - Thị trường giảm (bearish) → LONG
  
- **Trend-following Strategy** (`is_reverse_strategy = false`): Đánh xuôi sóng
  - Thị trường tăng (bullish) → LONG
  - Thị trường giảm (bearish) → SHORT

## Các thay đổi

### 1. Database Migration

**File:** `migrations/20251226000000-add-is-reverse-strategy-to-bots.cjs`

- Thêm cột `is_reverse_strategy TINYINT(1) DEFAULT 1 NOT NULL` vào bảng `bots`
- Default value = `1` (true) - Reverse strategy
- Comment: "Trading strategy: 1 = reverse (bullish→SHORT, bearish→LONG), 0 = trend-following (bullish→LONG, bearish→SHORT)"

### 2. Bot Model

**File:** `src/models/Bot.js`

- Cập nhật `create()` method để hỗ trợ `is_reverse_strategy` với default = `true`
- Thêm `is_reverse_strategy` vào INSERT statement

### 3. Strategy Model

**File:** `src/models/Strategy.js`

- Cập nhật `findAll()` để JOIN và lấy `is_reverse_strategy` từ bảng `bots`
- Cập nhật `findById()` để JOIN và lấy `is_reverse_strategy` từ bảng `bots`
- Strategy object giờ có property `is_reverse_strategy` từ bot

### 4. WebSocketOCConsumer

**File:** `src/consumers/WebSocketOCConsumer.js`

- Cập nhật `processMatch()` để đọc `is_reverse_strategy` từ strategy object
- Logic quyết định side:
  ```javascript
  const isReverseStrategy = strategy.is_reverse_strategy !== undefined 
    ? (strategy.is_reverse_strategy === true || strategy.is_reverse_strategy === 1 || strategy.is_reverse_strategy === '1')
    : true; // Default to reverse strategy if not specified
  
  const side = isReverseStrategy
    ? (direction === 'bullish' ? 'short' : 'long')  // Reverse: bullish → SHORT, bearish → LONG
    : (direction === 'bullish' ? 'long' : 'short');  // Trend-following: bullish → LONG, bearish → SHORT
  ```
- Hỗ trợ nhiều format: boolean, number (0/1), string ("0"/"1")
- Default to reverse strategy nếu không có giá trị

## Logic Mapping

| is_reverse_strategy | Direction | Side | Mô tả |
|---------------------|-----------|------|-------|
| `true` (default) | bullish | SHORT | Đánh ngược - thị trường tăng → SHORT |
| `true` (default) | bearish | LONG | Đánh ngược - thị trường giảm → LONG |
| `false` | bullish | LONG | Đánh xuôi - thị trường tăng → LONG |
| `false` | bearish | SHORT | Đánh xuôi - thị trường giảm → SHORT |

## Unit Tests

### Bot Model Tests
**File:** `tests/unit/models/Bot.test.js`

- Test tạo bot với `is_reverse_strategy` default = true
- Test tạo bot với `is_reverse_strategy` = false

### WebSocketOCConsumer Tests
**File:** `tests/unit/consumers/WebSocketOCConsumer.test.js`

- Test reverse strategy với bullish → SHORT
- Test reverse strategy với bearish → LONG
- Test trend-following strategy với bullish → LONG
- Test trend-following strategy với bearish → SHORT
- Test default behavior khi `is_reverse_strategy` undefined
- Test với các format khác nhau (boolean, number, string)

## Cách sử dụng

### 1. Chạy Migration

```bash
# Migration sẽ tự động chạy khi deploy hoặc có thể chạy thủ công
node migrations/20251226000000-add-is-reverse-strategy-to-bots.cjs
```

### 2. Cấu hình Bot

**Reverse Strategy (default):**
```sql
UPDATE bots SET is_reverse_strategy = 1 WHERE id = 1;
-- hoặc
UPDATE bots SET is_reverse_strategy = TRUE WHERE id = 1;
```

**Trend-following Strategy:**
```sql
UPDATE bots SET is_reverse_strategy = 0 WHERE id = 1;
-- hoặc
UPDATE bots SET is_reverse_strategy = FALSE WHERE id = 1;
```

### 3. Tạo Bot mới

```javascript
const bot = await Bot.create({
  bot_name: 'My Bot',
  exchange: 'binance',
  // is_reverse_strategy sẽ default = true
});

// Hoặc chỉ định rõ
const bot = await Bot.create({
  bot_name: 'My Bot',
  exchange: 'binance',
  is_reverse_strategy: false // Trend-following
});
```

## Testing

Chạy unit tests:

```bash
# Test Bot model
npm test -- tests/unit/models/Bot.test.js --testNamePattern="is_reverse_strategy"

# Test WebSocketOCConsumer
npm test -- tests/unit/consumers/WebSocketOCConsumer.test.js
```

## Lưu ý

1. **Backward Compatibility**: 
   - Các bot cũ không có `is_reverse_strategy` sẽ được set default = `true` (reverse strategy)
   - Migration tự động set default = `1` cho tất cả bots hiện có

2. **Strategy Cache**: 
   - StrategyCache sẽ tự động refresh và load `is_reverse_strategy` từ bots
   - Không cần thay đổi StrategyCache logic

3. **RealtimeOCDetector**: 
   - Không cần thay đổi vì nó gọi `webSocketOCConsumer.processMatch()` 
   - Logic quyết định side đã được xử lý trong `processMatch()`

## Files Changed

1. `migrations/20251226000000-add-is-reverse-strategy-to-bots.cjs` - Migration
2. `src/models/Bot.js` - Bot model
3. `src/models/Strategy.js` - Strategy model (JOIN bots)
4. `src/consumers/WebSocketOCConsumer.js` - Logic quyết định side
5. `tests/unit/models/Bot.test.js` - Bot model tests
6. `tests/unit/consumers/WebSocketOCConsumer.test.js` - WebSocketOCConsumer tests

## Verification

Sau khi deploy, verify bằng cách:

1. Kiểm tra database:
```sql
SELECT id, bot_name, is_reverse_strategy FROM bots;
```

2. Kiểm tra logs khi có signal:
```
[WebSocketOCConsumer] Strategy 1 (bot_id=1): is_reverse_strategy=true, direction=bullish, side=short
```

3. Kiểm tra order được tạo với side đúng:
- Reverse strategy + bullish → SHORT order
- Reverse strategy + bearish → LONG order
- Trend-following + bullish → LONG order
- Trend-following + bearish → SHORT order

