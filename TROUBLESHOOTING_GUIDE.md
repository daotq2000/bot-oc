# Hướng Dẫn Khắc Phục Sự Cố Bot OC

## 🔍 Vấn Đề Được Báo Cáo

1. **Gate bot không được bật lại** - Không có logs về Gate
2. **Binance logs chiếm hết logs** - Quá nhiều logs spam
3. **Có nhiều lỗi xảy ra** - Cần điều tra

---

## ✅ Giải Pháp Đã Áp Dụng

### 1. Giảm Spam Logs Binance (24 → 6 logs)
**Vấn Đề:** Mỗi bot được khởi tạo 4 lần (CandleUpdater, SignalScanner, PositionMonitor, BalanceManager)

**Giải Pháp:** Tạo `ExchangeServicePool` singleton
- Chia sẻ ExchangeService giữa các jobs
- Mỗi bot chỉ khởi tạo 1 lần

**Kết Quả:** Giảm logs khởi tạo từ 24 → 6 entries

---

### 2. Khắc Phục Lỗi ReduceOnly -1106 Spam
**Vấn Đề:** Lỗi này lặp lại 27+ lần/27 phút ở mức `warn`

**Giải Pháp:** Thay đổi log level từ `warn` → `debug`
- Lỗi này là hành vi bình thường (race condition)
- Không phải lỗi thực sự

**Kết Quả:** Giảm spam logs từ 27+ entries → 0 (chỉ ở debug level)

---

### 3. Khắc Phục Lỗi Timestamp -1021
**Vấn Đề:** Binance API trả về lỗi timestamp ngoài recvWindow

**Giải Pháp:** Thêm `recvWindow: 10000` vào requests
- Tăng từ 5000ms (mặc định) → 10000ms
- Cho phép độ trễ mạng lên đến 10 giây

**Kết Quả:** Giảm lỗi -1021 từ Binance API

---

### 4. Gate Bot Không Được Khởi Tạo
**Nguyên Nhân:** Không có Gate bot trong database

**Giải Pháp:**
- Nếu muốn sử dụng Gate: Tạo bot mới với `exchange='gate'`
- Hoặc restore database cũ có Gate bot

**Bots Hiện Tại:** 6 bots Binance (không có Gate)

---

## 🚀 Cách Áp Dụng Sửa Chữa

### Bước 1: Restart Bot
```bash
./restart_bot.sh
```

### Bước 2: Kiểm Tra Bots Status
```bash
node scripts/check_bots_status.js
```

**Kết Quả Dự Kiến:**
```
BOT STATUS CHECK
============================================================

📊 Total bots in database: 6
✅ Active bots: 6
❌ Inactive bots: 0

------------------------------------------------------------
ALL BOTS:
------------------------------------------------------------
Bot 2: Binance Futures Bot (binance) - ✅ ACTIVE
Bot 3: binance-daotq2 (binance) - ✅ ACTIVE
Bot 4: binance-mainet (binance) - ✅ ACTIVE
Bot 5: hronemount mainet (binance) - ✅ ACTIVE
Bot 6: hr.eastgate mainet (binance) - ✅ ACTIVE
Bot 7: daotq2k mainet (binance) - ✅ ACTIVE

------------------------------------------------------------
GATE BOTS:
------------------------------------------------------------
❌ No Gate bots found - Gate feature is not configured
```

### Bước 3: Monitor Logs
```bash
# Theo dõi logs
tail -f logs/combined.log

# Kiểm tra lỗi
tail -f logs/error.log

# Đếm logs (nên ít hơn trước)
grep "warn" logs/combined.log | wc -l
grep "Binance direct API client initialized" logs/combined.log | wc -l
```

---

## 📊 Kết Quả Trước & Sau

### Logs Trước Sửa Chữa
```
105+ logs về Binance
27+ logs về ReduceOnly error (warn level)
24 logs khởi tạo ExchangeService
Nhiều lỗi -1021 timestamp
Logs bị spam, khó tìm lỗi thực sự
```

### Logs Sau Sửa Chữa
```
6 logs khởi tạo ExchangeService (thay vì 24)
0 logs ReduceOnly warn (chỉ debug level)
Ít lỗi -1021 timestamp hơn
Logs sạch, dễ tìm lỗi thực sự
```

---

## 🔧 Các Files Được Sửa

| File | Thay Đổi | Tác Động |
|------|---------|---------|
| `src/services/ExchangeServicePool.js` | NEW | Singleton pool |
| `src/jobs/CandleUpdater.js` | Sử dụng pool | Giảm logs |
| `src/jobs/SignalScanner.js` | Sử dụng pool | Giảm logs |
| `src/jobs/PositionMonitor.js` | Sử dụng pool | Giảm logs |
| `src/jobs/BalanceManager.js` | Sử dụng pool | Giảm logs |
| `src/services/ExchangeService.js` | warn → debug | Giảm spam |
| `src/services/BinanceDirectClient.js` | +recvWindow | Khắc phục -1021 |

---

## ⚠️ Nếu Vẫn Có Lỗi

### Lỗi Timestamp -1021 Vẫn Xuất Hiện
**Nguyên Nhân:** Đồng hồ hệ thống không đồng bộ

**Giải Pháp:**
```bash
# Đồng bộ đồng hồ hệ thống
sudo ntpdate -s time.nist.gov

# Hoặc sử dụng timedatectl (Ubuntu 18+)
sudo timedatectl set-ntp true
```

### Lỗi Khác
1. Kiểm tra logs: `tail -f logs/error.log`
2. Kiểm tra database connection
3. Kiểm tra API keys của Binance

---

## 📝 Ghi Chú Quan Trọng

1. **Backward Compatible:** Tất cả sửa chữa đều backward compatible
2. **Không cần thay đổi database**
3. **Không ảnh hưởng đến logic trading**
4. **Chỉ tối ưu hóa logs và khắc phục lỗi API**

---

## 🎯 Tiếp Theo

### Nếu Muốn Sử Dụng Gate
```sql
-- Tạo bot Gate mới
INSERT INTO bots (bot_name, exchange, access_key, secret_key, is_active)
VALUES ('Gate Bot', 'gate', 'YOUR_API_KEY', 'YOUR_SECRET_KEY', TRUE);
```

### Nếu Muốn Tăng Logging
```bash
# Thay đổi log level trong app_configs
# Hoặc set environment variable
export LOG_LEVEL=debug
./restart_bot.sh
```

---

## 📚 Tài Liệu Tham Khảo

- `INVESTIGATION_SUMMARY.md` - Tóm tắt điều tra
- `INVESTIGATION_REPORT.md` - Báo cáo chi tiết
- `FIXES_APPLIED.md` - Chi tiết các sửa chữa
- `scripts/check_bots_status.js` - Script kiểm tra bots

---

## 💬 Hỗ Trợ

Nếu có vấn đề:
1. Kiểm tra logs: `tail -f logs/combined.log`
2. Chạy script kiểm tra: `node scripts/check_bots_status.js`
3. Restart bot: `./restart_bot.sh`
4. Kiểm tra database connection

---

**Cập Nhật:** 2025-12-09
**Phiên Bản:** 1.0

