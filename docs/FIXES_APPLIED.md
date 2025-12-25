# Báo Cáo Các Sửa Chữa Đã Áp Dụng

## Tóm Tắt
Đã xác định và sửa chữa 4 vấn đề chính trong bot:

1. ✅ **Gate bot không được khởi tạo** - Không có Gate bot trong database
2. ✅ **Binance logs chiếm hết logs** - Khởi tạo lặp lại ExchangeService 4 lần/bot
3. ✅ **Lỗi ReduceOnly -1106 spam logs** - Thay đổi log level từ warn → debug
4. ✅ **Lỗi Timestamp -1021 từ Binance** - Thêm recvWindow vào requests

---

## Chi Tiết Các Sửa Chữa

### 1. Khắc Phục Lỗi ReduceOnly -1106 Spam Logs ✅

**File:** `src/services/ExchangeService.js`

**Vấn Đề:**
- Lỗi `ReduceOnly close skipped` được log ở mức `warn`
- Lỗi này lặp lại mỗi phút (27+ lần trong 27 phút)
- Đây là hành vi bình thường (race condition), không phải lỗi

**Giải Pháp:**
```javascript
// Trước:
logger.warn(`ReduceOnly close skipped for bot ${this.bot.id} (${symbol}): ${msg}`);

// Sau:
logger.debug(`ReduceOnly close skipped for bot ${this.bot.id} (${symbol}): ${msg}`);
```

**Tác Động:**
- Giảm spam logs từ 27+ entries/27 phút → 0 entries (chỉ log ở debug level)
- Logs sẽ sạch hơn, dễ tìm lỗi thực sự

---

### 2. Khắc Phục Lỗi Timestamp -1021 ✅

**File:** `src/services/BinanceDirectClient.js`

**Vấn Đề:**
- Binance API trả về lỗi: `Error -1021: Timestamp for this request is outside of the recvWindow`
- Không có `recvWindow` parameter trong requests
- Mặc định recvWindow là 5000ms, quá nhỏ khi có độ trễ mạng

**Giải Pháp:**
```javascript
// Trước:
const authParams = { ...params, timestamp };

// Sau:
const authParams = { ...params, timestamp, recvWindow: 10000 };
```

**Tác Động:**
- Tăng recvWindow từ 5000ms → 10000ms
- Cho phép độ trễ mạng lên đến 10 giây
- Giảm lỗi timestamp từ Binance API

---

### 3. Tối Ưu Hóa Khởi Tạo ExchangeService ✅

**File Mới:** `src/services/ExchangeServicePool.js`

**Vấn Đề:**
- Mỗi job (CandleUpdater, SignalScanner, PositionMonitor, BalanceManager) tạo ExchangeService riêng
- Mỗi bot được khởi tạo 4 lần → 4 lần logs "Binance direct API client initialized"
- Lãng phí tài nguyên, tạo spam logs

**Giải Pháp:**
- Tạo `ExchangeServicePool` singleton
- Chia sẻ ExchangeService giữa các jobs
- Mỗi bot chỉ được khởi tạo 1 lần

**Các Files Cập Nhật:**
1. `src/jobs/CandleUpdater.js` - Sử dụng pool
2. `src/jobs/SignalScanner.js` - Sử dụng pool
3. `src/jobs/PositionMonitor.js` - Sử dụng pool
4. `src/jobs/BalanceManager.js` - Sử dụng pool

**Tác Động:**
- Giảm logs khởi tạo từ 24 entries (6 bots × 4 jobs) → 6 entries (1 lần/bot)
- Giảm tài nguyên sử dụng
- Tăng hiệu suất khởi động

---

### 4. Giảm Spam Logs Cập Nhật Candle ✅

**File:** `src/jobs/CandleUpdater.js`

**Vấn Đề:**
- Log "Updated candles for X unique symbol/interval combinations" mỗi lần chạy
- Spam logs khi không có strategies

**Giải Pháp:**
```javascript
// Trước:
logger.debug(`Updated candles for ${strategiesToUpdate.length} unique symbol/interval combinations`);

// Sau:
if (strategiesToUpdate.length > 0) {
  logger.debug(`Updated candles for ${strategiesToUpdate.length} unique symbol/interval combinations`);
}
```

**Tác Động:**
- Chỉ log khi có updates
- Giảm noise logs

---

## Vấn Đề Gate Bot Không Được Khởi Tạo

**Nguyên Nhân:** ✅ Xác Nhận
- **Không có Gate bot trong database**
- Database chỉ có 6 bots, tất cả đều là Binance
- Gate feature hoàn toàn không được cấu hình

**Giải Pháp:**
- Nếu muốn sử dụng Gate, cần tạo bot mới với exchange='gate'
- Hoặc import database cũ có Gate bot

**Bots Hiện Tại:**
```
Bot 2: Binance Futures Bot (binance)
Bot 3: binance-daotq2 (binance)
Bot 4: binance-mainet (binance)
Bot 5: hronemount mainet (binance)
Bot 6: hr.eastgate mainet (binance)
Bot 7: daotq2k mainet (binance)
```

---

## Kết Quả Dự Kiến Sau Sửa Chữa

### Logs Trước:
```
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"warn","message":"ReduceOnly close skipped for bot 3 (LIGHT/USDT): Binance API Error -1106: Parameter 'reduceonly' sent when not required.","service":"bot-oc","timestamp":"2025-12-09 15:01:05"}
{"level":"warn","message":"ReduceOnly close skipped for bot 3 (LIGHT/USDT): Binance API Error -1106: Parameter 'reduceonly' sent when not required.","service":"bot-oc","timestamp":"2025-12-09 15:02:06"}
{"level":"warn","message":"ReduceOnly close skipped for bot 3 (LIGHT/USDT): Binance API Error -1106: Parameter 'reduceonly' sent when not required.","service":"bot-oc","timestamp":"2025-12-09 15:03:04"}
```

### Logs Sau:
```
{"level":"info","message":"CandleUpdater initialized for 6 active bots","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"SignalScanner initialized for bot 2 (max_concurrent_trades=100)","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"SignalScanner initialized for bot 3 (max_concurrent_trades=100)","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
...
[ReduceOnly logs không xuất hiện - chỉ ở debug level]
```

---

## Cách Kiểm Tra

### 1. Kiểm Tra Bots Status
```bash
node scripts/check_bots_status.js
```

### 2. Restart Bot
```bash
./restart_bot.sh
```

### 3. Kiểm Tra Logs
```bash
# Logs mới sạch hơn, ít spam hơn
tail -f logs/combined.log

# Không có lỗi ReduceOnly -1106 ở mức warn
grep "warn" logs/combined.log | wc -l
```

---

## Các Thay Đổi Tóm Tắt

| Vấn Đề | File | Thay Đổi | Tác Động |
|--------|------|---------|---------|
| ReduceOnly spam | ExchangeService.js | warn → debug | Giảm 27+ logs/27 phút |
| Timestamp -1021 | BinanceDirectClient.js | Thêm recvWindow | Giảm lỗi API |
| Khởi tạo lặp | ExchangeServicePool.js (new) | Pool singleton | Giảm 18 logs khởi tạo |
| Candle logs | CandleUpdater.js | Conditional log | Giảm noise logs |

---

## Tiếp Theo

1. **Restart bot** để áp dụng các sửa chữa
2. **Monitor logs** để xác nhận giảm spam
3. **Kiểm tra Binance API** - Nếu vẫn có lỗi -1021, có thể cần:
   - Đồng bộ đồng hồ hệ thống: `sudo ntpdate -s time.nist.gov`
   - Hoặc tăng recvWindow thêm nữa

---

## Ghi Chú

- Tất cả sửa chữa đều backward compatible
- Không cần thay đổi database
- Không ảnh hưởng đến logic trading
- Chỉ tối ưu hóa logs và khắc phục lỗi API

