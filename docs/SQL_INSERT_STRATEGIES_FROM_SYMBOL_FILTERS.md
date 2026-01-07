# SQL: Insert Strategies từ Symbol Filters

## Câu lệnh SQL Sample

### 1. Insert tất cả symbols từ symbol_filters cho một bot cụ thể

```sql
INSERT INTO strategies (
  bot_id, 
  symbol, 
  trade_type, 
  `interval`, 
  oc, 
  extend, 
  amount, 
  take_profit, 
  reduce, 
  up_reduce, 
  `ignore`, 
  is_active,
  created_at,
  updated_at
)
SELECT 
  ? AS bot_id,                    -- Thay ? bằng bot_id cụ thể, ví dụ: 1
  sf.symbol,                      -- Lấy symbol từ symbol_filters
  'both' AS trade_type,           -- Mặc định: both (long + short)
  '5m' AS `interval`,             -- Mặc định: 5m (có thể thay đổi)
  2.00 AS oc,                     -- Mặc định: 2% OC threshold
  50.00 AS extend,                 -- Mặc định: 50% extend
  1000.00 AS amount,              -- Mặc định: 1000 USDT
  50.00 AS take_profit,           -- Mặc định: 50% TP
  5.00 AS reduce,                 -- Mặc định: 5% reduce
  5.00 AS up_reduce,              -- Mặc định: 5% up_reduce
  50.00 AS `ignore`,              -- Mặc định: 50% ignore threshold
  TRUE AS is_active,              -- Mặc định: active
  NOW() AS created_at,
  NOW() AS updated_at
FROM symbol_filters sf
WHERE sf.exchange = ?              -- Thay ? bằng exchange, ví dụ: 'binance'
  AND NOT EXISTS (                -- Tránh duplicate: chỉ insert nếu chưa tồn tại
    SELECT 1 
    FROM strategies s 
    WHERE s.bot_id = ?            -- Thay ? bằng bot_id (giống trên)
      AND s.symbol = sf.symbol
      AND s.`interval` = '5m'     -- Cùng interval
      AND s.trade_type = 'both'
      AND s.oc = 2.00
  );
```

### 2. Insert với giá trị động (ví dụ)

```sql
-- Thay các giá trị này theo nhu cầu
SET @bot_id = 1;
SET @exchange = 'binance';
SET @interval = '5m';
SET @oc = 2.00;
SET @extend = 50.00;
SET @amount = 1000.00;
SET @take_profit = 50.00;
SET @reduce = 5.00;
SET @up_reduce = 5.00;
SET @ignore = 50.00;

INSERT INTO strategies (
  bot_id, symbol, trade_type, `interval`, oc, extend, 
  amount, take_profit, reduce, up_reduce, `ignore`, is_active,
  created_at, updated_at
)
SELECT 
  @bot_id,
  sf.symbol,
  'both',
  @interval,
  @oc,
  @extend,
  @amount,
  @take_profit,
  @reduce,
  @up_reduce,
  @ignore,
  TRUE,
  NOW(),
  NOW()
FROM symbol_filters sf
WHERE sf.exchange = @exchange
  AND NOT EXISTS (
    SELECT 1 
    FROM strategies s 
    WHERE s.bot_id = @bot_id
      AND s.symbol = sf.symbol
      AND s.`interval` = @interval
      AND s.trade_type = 'both'
      AND s.oc = @oc
  );
```

### 3. Insert chỉ USDT pairs

```sql
INSERT INTO strategies (
  bot_id, symbol, trade_type, `interval`, oc, extend, 
  amount, take_profit, reduce, up_reduce, `ignore`, is_active,
  created_at, updated_at
)
SELECT 
  1 AS bot_id,                    -- Thay bằng bot_id của bạn
  sf.symbol,
  'both',
  '5m',
  2.00,
  50.00,
  1000.00,
  50.00,
  5.00,
  5.00,
  50.00,
  TRUE,
  NOW(),
  NOW()
FROM symbol_filters sf
WHERE sf.exchange = 'binance'     -- Thay bằng exchange của bạn
  AND REPLACE(REPLACE(sf.symbol, '/', ''), ':', '') LIKE '%USDT'  -- Chỉ USDT pairs
  AND NOT EXISTS (
    SELECT 1 
    FROM strategies s 
    WHERE s.bot_id = 1
      AND s.symbol = sf.symbol
      AND s.`interval` = '5m'
      AND s.trade_type = 'both'
      AND s.oc = 2.00
  );
```

### 4. Insert với nhiều intervals

```sql
-- Insert cho nhiều intervals cùng lúc (5m, 15m, 1h)
INSERT INTO strategies (
  bot_id, symbol, trade_type, `interval`, oc, extend, 
  amount, take_profit, reduce, up_reduce, `ignore`, is_active,
  created_at, updated_at
)
SELECT 
  1 AS bot_id,
  sf.symbol,
  'both',
  intervals.interval_name,
  2.00,
  50.00,
  1000.00,
  50.00,
  5.00,
  5.00,
  50.00,
  TRUE,
  NOW(),
  NOW()
FROM symbol_filters sf
CROSS JOIN (
  SELECT '5m' AS interval_name
  UNION ALL SELECT '15m'
  UNION ALL SELECT '1h'
) AS intervals
WHERE sf.exchange = 'binance'
  AND REPLACE(REPLACE(sf.symbol, '/', ''), ':', '') LIKE '%USDT'
  AND NOT EXISTS (
    SELECT 1 
    FROM strategies s 
    WHERE s.bot_id = 1
      AND s.symbol = sf.symbol
      AND s.`interval` = intervals.interval_name
      AND s.trade_type = 'both'
      AND s.oc = 2.00
  );
```

## Lưu ý

1. **Thay đổi giá trị mặc định** theo nhu cầu:
   - `bot_id`: ID của bot
   - `exchange`: 'binance', 'mexc', 'gate'
   - `interval`: '1m', '3m', '5m', '15m', '30m', '1h'
   - `oc`, `extend`, `amount`, `take_profit`, `reduce`, `up_reduce`, `ignore`

2. **Tránh duplicate**: Câu lệnh sử dụng `NOT EXISTS` để tránh insert duplicate strategies

3. **UNIQUE constraint**: Bảng `strategies` có UNIQUE constraint trên `(symbol, trade_type, interval, oc)`, nên nếu insert duplicate sẽ bị lỗi

4. **Kiểm tra trước khi insert**:
```sql
-- Xem có bao nhiêu symbols sẽ được insert
SELECT COUNT(*) 
FROM symbol_filters sf
WHERE sf.exchange = 'binance'
  AND REPLACE(REPLACE(sf.symbol, '/', ''), ':', '') LIKE '%USDT'
  AND NOT EXISTS (
    SELECT 1 
    FROM strategies s 
    WHERE s.bot_id = 1
      AND s.symbol = sf.symbol
      AND s.`interval` = '5m'
      AND s.trade_type = 'both'
      AND s.oc = 2.00
  );
```

## Ví dụ thực tế

```sql
-- Insert strategies cho bot_id = 1, exchange = binance, interval = 5m
INSERT INTO strategies (
  bot_id, symbol, trade_type, `interval`, oc, extend, 
  amount, take_profit, reduce, up_reduce, `ignore`, is_active,
  created_at, updated_at
)
SELECT 
  1,
  sf.symbol,
  'both',
  '5m',
  2.00,
  50.00,
  1000.00,
  50.00,
  5.00,
  5.00,
  50.00,
  TRUE,
  NOW(),
  NOW()
FROM symbol_filters sf
WHERE sf.exchange = 'binance'
  AND REPLACE(REPLACE(sf.symbol, '/', ''), ':', '') LIKE '%USDT'
  AND NOT EXISTS (
    SELECT 1 
    FROM strategies s 
    WHERE s.bot_id = 1
      AND s.symbol = sf.symbol
      AND s.`interval` = '5m'
      AND s.trade_type = 'both'
      AND s.oc = 2.00
  );
```

