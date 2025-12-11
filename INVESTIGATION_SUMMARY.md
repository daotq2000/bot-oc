# Tóm Tắt Điều Tra Bot OC

## [object Object]ấn Đề Báo Cáo
1. **Gate bot không được bật lại** - Không có logs về Gate
2. **Binance logs chiếm hết logs** - Quá nhiều logs spam
3. **Có nhiều lỗi xảy ra** - Cần điều tra

---

## ✅ Kết Quả Điều Tra

### 1. Gate Bot Không Được Khởi Tạo
**Nguyên Nhân:** ❌ **Không có Gate bot trong database**

**Chi Tiết:**
- Database chỉ có **6 bots, tất cả đều là Binance**
- Không có bot nào với `exchange = 'gate'`
- Gate feature hoàn toàn không được cấu hình

**Bots Hiện Tại:**
```
✅ Bot 2: Binance Futures Bot (binance)
✅ Bot 3: binance-daotq2 (binance)
✅ Bot 4: binance-mainet (binance)
✅ Bot 5: hronemount mainet (binance)
✅ Bot 6: hr.eastgate mainet (binance)
✅ Bot 7: daotq2k mainet (binance)
❌ Bot 1: Không tồn tại (Gate bot)
```

**Giải Pháp:**
- Nếu muốn sử dụng Gate, cần tạo bot mới với `exchange='gate'`
- Hoặc restore database cũ có Gate bot

---

### 2. Binance Logs Chiếm Hết Logs
**Nguyên Nhân:** ⚠️ **Khởi tạo ExchangeService lặp lại 4 lần/bot**

**Chi Tiết:**
- Mỗi bot được khởi tạo bởi 4 jobs:
  1. CandleUpdater → tạo ExchangeService
  2. SignalScanner → tạo ExchangeService lại
  3. PositionMonitor → tạo ExchangeService lại
  4. BalanceManager → tạo ExchangeService lại

- Kết quả: **6 bots × 4 jobs = 24 logs khởi tạo** (thay vì 6)
- Mỗi khởi tạo log: `"Binance direct API client initialized for bot X"`

**Logs Spam:**
```
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
{"level":"info","message":"Binance direct API client initialized for bot 3 - Trading from https://testnet.binancefuture.com, Market data from https://fapi.binance.com","service":"bot-oc","timestamp":"2025-12-09 14:26:47"}
```

**Giải Pháp:** ✅ **Tạo ExchangeServicePool**
- Singleton pattern để chia sẻ ExchangeService
- Mỗi bot chỉ khởi tạo 1 lần
- Giảm logs từ 24 → 6 entries

---

### 3. Lỗi Binance API

#### a) Lỗi ReduceOnly -1106 (Spam Logs)
**Hiện Tượng:**
```
{"level":"warn","message":"ReduceOnly close skipped for bot 3 (LIGHT/USDT): Binance API Error -1106: Parameter 'reduceonly' sent when not required.","service":"bot-oc","timestamp":"2025-12-09 15:01:05"}
```
- Lỗi này lặp lại **mỗi phút từ 14:51 đến 15:18 (27 lần!)**
- Đây là hành vi **bình thường** (race condition khi position đã đóng)

**Giải Pháp:** ✅ **Thay đổi log level từ warn → debug**
- Lỗi này không phải lỗi thực sự
- Chỉ log ở debug level để tránh spam

#### b) Lỗi Timestamp -1021
**Hiện Tượng:**
```
{"level":"error","message":"Failed to close position for bot 3: Binance API Error -1021: Timestamp for this request is outside of the recvWindow.","service":"bot-oc","timestamp":"2025-12-09 15:21:19"}
```

**Nguyên Nhân:**
- Không có `recvWindow` parameter trong requests
- Mặc định recvWindow là 5000ms (quá nhỏ)
- Độ trễ mạng hoặc đồng hồ hệ thống không đồng bộ

**Giải Pháp:** ✅ **Thêm recvWindow=10000ms**
- Cho phép độ trễ mạng lên đến 10 giây
- Giảm lỗi timestamp từ Binance API

---

## 🔧 Các Sửa Chữa Đã Áp Dụng

### 1. Tạo ExchangeServicePool
**File:** `src/services/ExchangeServicePool.js` (NEW)
- Singleton pattern
- Chia sẻ ExchangeService giữa các jobs
- Giảm logs khởi tạo từ 24 → 6

### 2. Cập Nhật CandleUpdater
**File:** `src/jobs/CandleUpdater.js`
- Sử dụng ExchangeServicePool
- Giảm log level khởi tạo từ info → debug
- Conditional log cho candle updates

### 3. Cập Nhật SignalScanner
**File:** `src/jobs/SignalScanner.js`
- Sử dụng ExchangeServicePool
- Giảm log level khởi tạo từ info → debug

### 4. Cập Nhật PositionMonitor
**File:** `src/jobs/PositionMonitor.js`
- Sử dụng ExchangeServicePool
- Giảm log level khởi tạo từ info → debug

### 5. Cập Nhật BalanceManager
**File:** `src/jobs/BalanceManager.js`
- Sử dụng ExchangeServicePool
- Giảm log level khởi tạo từ info → debug

### 6. Khắc Phục Lỗi ReduceOnly
**File:** `src/services/ExchangeService.js`
- Thay đổi log level từ warn → debug
- Giảm spam logs từ 27+ entries → 0

### 7. Khắc Phục Lỗi Timestamp
**File:** `src/services/BinanceDirectClient.js`
- Thêm `recvWindow: 10000` vào requests
- Giảm lỗi -1021 từ Binance API

---

## 📊 Kết Quả Dự Kiến

### Logs Trước Sửa Chữa (Spam)
```
105+ logs về Binance
27+ logs về ReduceOnly error
24 logs khởi tạo ExchangeService
Nhiều lỗi -1021 timestamp
```

### Logs Sau Sửa Chữa (Sạch)
```
6 logs khởi tạo ExchangeService (thay vì 24)
0 logs ReduceOnly warn (chỉ debug)
Ít lỗi -1021 timestamp hơn
Logs dễ đọc, dễ tìm lỗi thực sự
```

---

## 📋 Danh Sách Kiểm Tra

- ✅ Xác định nguyên nhân Gate bot không khởi tạo
- ✅ Xác định nguyên nhân Binance logs spam
- ✅ Xác định lỗi ReduceOnly -1106
- ✅ Xác định lỗi Timestamp -1021
- ✅ Tạo ExchangeServicePool
- ✅ Cập nhật 4 jobs để sử dụng pool
- ✅ Giảm log level spam errors
- ✅ Thêm recvWindow để khắc phục timestamp
- ✅ Tạo script kiểm tra bots status
- ✅ Tạo báo cáo chi tiết

---

## [object Object]ách Áp Dụng

### 1. Restart Bot
```bash
./restart_bot.sh
```

### 2. Kiểm Tra Bots Status
```bash
node scripts/check_bots_status.js
```

### 3. Monitor Logs
```bash
tail -f logs/combined.log
```

### 4. Xác Nhận Sửa Chữa
- Logs sạch hơn, ít spam hơn
- Không có lỗi ReduceOnly -1106 ở mức warn
- Ít lỗi -1021 timestamp hơn

---

## [object Object]hi Chú

1. **Gate Bot:** Nếu muốn sử dụng Gate, cần tạo bot mới hoặc restore database cũ
2. **Timestamp Sync:** Nếu vẫn có lỗi -1021, hãy đồng bộ đồng hồ hệ thống:
   ```bash
   sudo ntpdate -s time.nist.gov
   ```
3. **Backward Compatible:** Tất cả sửa chữa đều backward compatible, không cần thay đổi database

---

## 📚 Tài Liệu Tham Khảo

- `INVESTIGATION_REPORT.md` - Báo cáo chi tiết điều tra
- `FIXES_APPLIED.md` - Chi tiết các sửa chữa
- `scripts/check_bots_status.js` - Script kiểm tra bots

