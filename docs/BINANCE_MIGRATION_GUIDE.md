mi# Hướng Dẫn Migration: Thêm Hỗ Trợ Binance Exchange

## 📋 Tổng Quan

Migration này thêm hỗ trợ Binance exchange và phân biệt symbol theo exchange trong database. Điều này cho phép:
- Hỗ trợ Binance như một exchange mới
- Phân biệt candles theo exchange (vì giá có thể khác nhau giữa các sàn)
- Mỗi exchange có dữ liệu candles riêng biệt

## 🔄 Thay Đổi Database

### 1. Thêm 'binance' vào ENUM exchange
- Bảng `bots`: Thêm `'binance'` vào ENUM `exchange`

### 2. Thêm cột `exchange` vào bảng `candles`
- Thêm cột `exchange VARCHAR(20) NOT NULL` sau cột `symbol`
- Cập nhật UNIQUE KEY từ `(symbol, interval, open_time)` thành `(exchange, symbol, interval, open_time)`
- Thêm indexes: `idx_exchange`, `idx_exchange_symbol_interval`

## 📝 Các Bước Migration

### Bước 1: Backup Database
```bash
mysqldump -u root -p bot_oc > backup_before_binance.sql
```

### Bước 2: Chạy Migration Script
```bash
mysql -u root -p bot_oc < database/migration_add_binance.sql
```

Hoặc chạy từng lệnh SQL trong file `database/migration_add_binance.sql`:

```sql
-- 1. Thêm 'binance' vào enum
ALTER TABLE bots MODIFY COLUMN exchange ENUM('mexc', 'gate', 'binance') NOT NULL;

-- 2. Thêm cột exchange vào candles
ALTER TABLE candles ADD COLUMN exchange VARCHAR(20) NOT NULL DEFAULT 'mexc' AFTER symbol;

-- 3. Update existing candles với exchange từ bot
UPDATE candles c
INNER JOIN strategies s ON c.symbol = s.symbol AND c.`interval` = s.`interval`
INNER JOIN bots b ON s.bot_id = b.id
SET c.exchange = b.exchange;

-- 4. Drop old unique constraint
ALTER TABLE candles DROP INDEX unique_candle;

-- 5. Add new unique constraint với exchange
ALTER TABLE candles ADD UNIQUE KEY unique_candle (exchange, symbol, `interval`, open_time);

-- 6. Add indexes
ALTER TABLE candles ADD INDEX idx_exchange (exchange);
ALTER TABLE candles ADD INDEX idx_exchange_symbol_interval (exchange, symbol, `interval`);

-- 7. Remove default (optional)
ALTER TABLE candles MODIFY COLUMN exchange VARCHAR(20) NOT NULL;
```

### Bước 3: Verify Migration
```sql
-- Kiểm tra exchange enum
SHOW COLUMNS FROM bots LIKE 'exchange';

-- Kiểm tra cột exchange trong candles
SHOW COLUMNS FROM candles LIKE 'exchange';

-- Kiểm tra unique constraint
SHOW INDEX FROM candles WHERE Key_name = 'unique_candle';

-- Kiểm tra dữ liệu
SELECT exchange, COUNT(*) as count FROM candles GROUP BY exchange;
```

## 🔧 Thay Đổi Code

### Backend

#### 1. ExchangeService.js
- ✅ Thêm hỗ trợ `ccxt.binance`
- ✅ Xử lý transfer cho Binance (spot ↔ future)
- ✅ Format symbol cho Binance swap markets

#### 2. Candle Model (Candle.js)
- ✅ Tất cả methods bây giờ yêu cầu `exchange` parameter:
  - `getLatest(exchange, symbol, interval)`
  - `getPrevious(exchange, symbol, interval)`
  - `getCandles(exchange, symbol, interval, limit)`
  - `upsert(candle)` - candle object phải có `exchange`

#### 3. CandleService.js
- ✅ Tự động lấy `exchange` từ `exchangeService.bot.exchange`
- ✅ Thêm `exchange` vào candles trước khi insert
- ✅ Tất cả queries sử dụng `exchange`

### Frontend

#### 1. Types (bot.types.ts)
- ✅ `exchange: 'mexc' | 'gate' | 'binance'`

#### 2. BotForm.tsx
- ✅ Thêm `'binance'` vào Zod enum
- ✅ Thêm option "Binance" vào Select dropdown

## 🧪 Testing

### Test Tạo Bot Binance
1. Tạo bot mới với exchange = 'binance'
2. Verify bot được lưu vào database
3. Verify ExchangeService khởi tạo thành công với Binance

### Test Candle Updates
1. Tạo strategy cho bot Binance
2. Verify CandleUpdater job fetch candles với exchange = 'binance'
3. Verify candles được lưu với `exchange = 'binance'`
4. Verify không có conflict với candles từ MEXC/Gate cùng symbol

### Test Signal Detection
1. Tạo strategy cho bot Binance với symbol BTC/USDT
2. Verify SignalScanner sử dụng candles đúng exchange
3. Verify signals được phát hiện từ candles của Binance

## ⚠️ Lưu Ý

1. **Dữ liệu cũ**: Nếu có dữ liệu candles cũ, migration sẽ cập nhật `exchange` dựa trên strategy's bot. Nếu strategy không có bot hoặc bot không có exchange, sẽ dùng default 'mexc'.

2. **Symbol Format**: Binance sử dụng format tương tự MEXC/Gate (BTC/USDT), nhưng CCXT sẽ tự động format thành `BTC/USDT:USDT` cho swap markets.

3. **Transfer**: Binance sử dụng `'spot'` và `'future'` (không phải `'swap'` như MEXC).

4. **API Keys**: Cần có Binance API keys với quyền:
   - Read (để fetch candles, balance)
   - Trade (để place orders)
   - Transfer (để transfer spot ↔ future)

## 🚀 Sau Migration

Sau khi migration thành công:

1. **Tạo Bot Binance mới**:
   - Vào Frontend → Bots → Add New Bot
   - Chọn Exchange: Binance
   - Nhập API keys
   - Cấu hình balance settings

2. **Tạo Strategy cho Bot Binance**:
   - Chọn bot Binance
   - Tạo strategy với symbol (ví dụ: BTC/USDT)
   - Strategy sẽ tự động sử dụng candles từ Binance

3. **Verify hoạt động**:
   - Kiểm tra CandleUpdater fetch candles từ Binance
   - Kiểm tra SignalScanner phát hiện signals từ Binance candles
   - Kiểm tra orders được place trên Binance

## 📊 Database Schema Sau Migration

```sql
-- Bảng bots
exchange ENUM('mexc', 'gate', 'binance') NOT NULL

-- Bảng candles
exchange VARCHAR(20) NOT NULL,  -- mexc, gate, binance
symbol VARCHAR(20) NOT NULL,
`interval` VARCHAR(5) NOT NULL,
...
UNIQUE KEY unique_candle (exchange, symbol, `interval`, open_time)
```

## 🔍 Troubleshooting

### Lỗi: "Column 'exchange' cannot be null"
- Đảm bảo đã chạy migration script đầy đủ
- Kiểm tra existing candles đã được update với exchange

### Lỗi: "Duplicate entry for key 'unique_candle'"
- Có thể có candles trùng lặp từ migration
- Chạy query để tìm duplicates:
  ```sql
  SELECT exchange, symbol, `interval`, open_time, COUNT(*) 
  FROM candles 
  GROUP BY exchange, symbol, `interval`, open_time 
  HAVING COUNT(*) > 1;
  ```

### Binance API Errors
- Kiểm tra API keys có đúng quyền
- Kiểm tra IP whitelist (nếu có)
- Kiểm tra rate limits

## ✅ Checklist

- [ ] Backup database
- [ ] Chạy migration script
- [ ] Verify database schema
- [ ] Test tạo bot Binance
- [ ] Test candle updates
- [ ] Test signal detection
- [ ] Test order placement
- [ ] Verify frontend hiển thị Binance option
- [ ] Update documentation

---

**Migration hoàn tất!** Bây giờ hệ thống đã hỗ trợ Binance và phân biệt candles theo exchange. 🎉

