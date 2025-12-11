# Báo Cáo Điều Tra Vấn Đề Bot

## Tóm Tắt Vấn Đề
1. **Gate bot không được khởi tạo** - Không có logs về Gate exchange
2. **Binance logs chiếm hết logs** - Quá nhiều logs từ Binance (105+ entries)
3. **Lỗi Timestamp -1021** - Binance API trả về lỗi timestamp ngoài recvWindow
4. **Lỗi ReduceOnly -1106** - Spam logs từ lỗi parameter 'reduceonly'

---

## Chi Tiết Vấn Đề

### 1. Gate Bot Không Được Khởi Tạo ❌

**Hiện Tượng:**
- Logs khởi tạo chỉ hiển thị bots: 2, 3, 4, 5, 6, 7
- Không có logs về bot 1 (Gate bot)
- Không có logs khởi tạo ExchangeService cho Gate

**Nguyên Nhân (Xác Nhận):**
✅ **KHÔNG CÓ GATE BOT TRONG DATABASE**
- Database chỉ có 6 bots, tất cả đều là Binance
- Không có bot nào với exchange = 'gate'
- Gate feature hoàn toàn không được cấu hình

**Bots Hiện Tại:**
```
Bot 2: Binance Futures Bot (binance) - ACTIVE
Bot 3: binance-daotq2 (binance) - ACTIVE
Bot 4: binance-mainet (binance) - ACTIVE
Bot 5: hronemount mainet (binance) - ACTIVE
Bot 6: hr.eastgate mainet (binance) - ACTIVE
Bot 7: daotq2k mainet (binance) - ACTIVE
```

**Logs Liên Quan:**
```
CandleUpdater initialized for bot 3
CandleUpdater initialized for bot 4
CandleUpdater initialized for bot 5
CandleUpdater initialized for bot 6
CandleUpdater initialized for bot 7
CandleUpdater initialized for bot 2
```
⚠️ **Bot 1 hoàn toàn vắng mặt**

---

### 2. Binance Logs Chiếm Hết Logs 📊

**Hiện Tượng:**
- Logs combined.log có 105+ entries về Binance
- Logs bị spam bởi các thông báo:
  - "Binance direct API client initialized for bot X"
  - "setMarginType warning for SYMBOL"
  - "ReduceOnly close skipped for bot 3 (LIGHT/USDT)"

**Nguyên Nhân:**
1. **Khởi tạo lặp lại** - ExchangeService được khởi tạo nhiều lần:
   - CandleUpdater.initialize() → tạo ExchangeService
   - SignalScanner.initialize() → tạo ExchangeService lại
   - PositionMonitor.initialize() → tạo ExchangeService lại
   - BalanceManager.initialize() → tạo ExchangeService lại
   
   **Mỗi bot được khởi tạo 4 lần!**

2. **Spam logs từ lỗi ReduceOnly**:
   ```
   ReduceOnly close skipped for bot 3 (LIGHT/USDT): 
   Binance API Error -1106: Parameter 'reduceonly' sent when not required.
   ```
   Lỗi này lặp lại mỗi phút từ 14:51 đến 15:18 (27 lần!)

---

### 3. Lỗi Timestamp -1021 ⏰

**Hiện Tượng:**
```
Binance API Error -1021: Timestamp for this request is outside of the recvWindow.
```

**Nguyên Nhân:**
- Đồng hồ hệ thống không đồng bộ với Binance API
- recvWindow mặc định quá nhỏ
- Độ trễ mạng cao

**Ảnh Hưởng:**
- Không thể đóng position
- Không thể cập nhật position
- Gây lỗi liên tục

---

### 4. Lỗi ReduceOnly -1106 🔴

**Hiện Tượng:**
```
ReduceOnly close skipped for bot 3 (LIGHT/USDT): 
Binance API Error -1106: Parameter 'reduceonly' sent when not required.
```

**Nguyên Nhân:**
- Tham số `reduceonly` được gửi khi position đã đóng
- Hoặc position không tồn tại trên Binance

**Ảnh Hưởng:**
- Spam logs (27+ entries trong 27 phút)
- Không thể đóng position

---

## Giải Pháp Đề Xuất

### 1. Khắc Phục Gate Bot Không Khởi Tạo
```sql
-- Kiểm tra bot 1
SELECT * FROM bots WHERE id = 1;

-- Nếu is_active = 0, bật nó
UPDATE bots SET is_active = TRUE WHERE id = 1;
```

### 2. Tối Ưu Hóa Khởi Tạo ExchangeService
- **Hiện tại:** Mỗi job tạo ExchangeService riêng → 4 lần/bot
- **Giải pháp:** Tạo ExchangeService pool/cache được chia sẻ

### 3. Giảm Spam Logs ReduceOnly
- Thay đổi log level từ `warn` → `debug` cho lỗi này
- Hoặc thêm rate limiting (chỉ log 1 lần/5 phút)

### 4. Khắc Phục Lỗi Timestamp -1021
- Đồng bộ đồng hồ hệ thống
- Tăng recvWindow trong BinanceDirectClient
- Thêm retry logic với time sync

---

## Các File Cần Sửa

1. **src/jobs/CandleUpdater.js** - Giảm spam logs
2. **src/jobs/SignalScanner.js** - Giảm spam logs
3. **src/jobs/PositionMonitor.js** - Giảm spam logs
4. **src/jobs/BalanceManager.js** - Giảm spam logs
5. **src/services/BinanceDirectClient.js** - Khắc phục timestamp
6. **src/services/ExchangeService.js** - Tối ưu khởi tạo

---

## Ưu Tiên Sửa

1. **Cao** - Khắc phục Gate bot không khởi tạo
2. **Cao** - Giảm spam logs ReduceOnly
3. **Trung** - Khắc phục lỗi Timestamp -1021
4. **Trung** - Tối ưu khởi tạo ExchangeService

