# Giải Thích Vấn Đề Ban Đầu: Auto-Cancel Entry Orders

## 🔴 Vấn Đề Bạn Gặp Phải

**Hiện tượng**: Lệnh entry bị tự động hủy khi giá market chưa khớp, nhưng khớp với OC (Open Condition) của Strategy.

**Ví dụ từ hình ảnh**:
- Bot: 42_USDT | Long
- Min5 | OC: 16.4% | Extend: 95% | TP: 35%
- Status: Completed
- Open price: 0.051771
- Amount: 1000.00 (100%)

Lệnh được tạo ở giá 0.051771 (khớp với OC), nhưng giá market chưa đạt đến, rồi lệnh bị hủy.

---

## 🔍 Nguyên Nhân Chính

### 1. **ENTRY_ORDER_TTL_MINUTES = 10**

Trong `src/app.js`, có cấu hình:

```javascript
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '10', 'Minutes before auto-cancel unfilled entry LIMIT orders');
```

**Ý nghĩa**: Lệnh entry LIMIT sẽ tự động bị hủy nếu không được fill trong **10 phút**.

### 2. **Cách Hoạt Động**

```
Timeline:
09:18:23 - Lệnh được tạo (giá khớp OC)
09:19:46 - Giá chưa khớp, lệnh vẫn open
09:23:24 - Giá chưa khớp, lệnh vẫn open
09:24:53 - Giá chưa khớp, lệnh vẫn open
09:28:23 - ⏰ 10 phút đã qua → Lệnh tự động bị hủy
```

### 3. **Tại Sao Lệnh Không Được Fill?**

- ✅ Lệnh được tạo ở giá OC (16.4% từ giá hiện tại)
- ❌ Nhưng giá market chưa đạt đến mức đó
- ⏰ Sau 10 phút → Lệnh bị hủy

---

## 💡 Giải Pháp

### Option 1: Tăng TTL (Khuyến Nghị cho Min5)

```javascript
// Thay vì 10 phút, dùng 30-60 phút
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '60', 'Minutes before auto-cancel unfilled entry LIMIT orders');
```

**Ưu điểm**: Lệnh có thêm thời gian để được fill  
**Nhược điểm**: Lệnh cũ có thể vẫn open khi có signal mới

### Option 2: Disable Auto-Cancel at Candle End

```javascript
// Tắt auto-cancel ở cuối candle
await AppConfig.set('ENABLE_CANDLE_END_CANCEL_FOR_ENTRY', 'false', 'Enable auto-cancel unfilled entry orders at candle end');
```

**Ưu điểm**: Lệnh không bị hủy ở cuối candle  
**Nhược điểm**: Lệnh cũ có thể tồn tại lâu

### Option 3: Kết Hợp Cả Hai (Tối Ưu)

```javascript
// Tăng TTL lên 30 phút
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '30', 'Minutes before auto-cancel unfilled entry LIMIT orders');

// Tắt auto-cancel ở cuối candle
await AppConfig.set('ENABLE_CANDLE_END_CANCEL_FOR_ENTRY', 'false', 'Enable auto-cancel unfilled entry orders at candle end');
```

---

## 📊 Khuyến Nghị Theo Timeframe

| Timeframe | TTL (phút) | Lý Do |
|-----------|-----------|-------|
| **1m** | 5-10 | Nhanh, không cần lâu |
| **5m** | 30-60 | Cần thời gian chờ |
| **15m** | 60-120 | Thường cần chờ lâu |
| **1h** | 120-240 | Rất cần thời gian |
| **4h+** | 240+ | Có thể chờ cả ngày |

**Cho Min5 của bạn**: Khuyến nghị **30-60 phút**

---

## 🔧 Cách Cập Nhật

### Cách 1: Cập Nhật Trong app.js

```javascript
// Tìm dòng này trong src/app.js
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '10', 'Minutes before auto-cancel unfilled entry LIMIT orders');

// Thay thành
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '60', 'Minutes before auto-cancel unfilled entry LIMIT orders');
```

### Cách 2: Cập Nhật Qua API (Nếu Có)

```bash
# Nếu có API endpoint để cập nhật config
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "key": "ENTRY_ORDER_TTL_MINUTES",
    "value": "60"
  }'
```

### Cách 3: Cập Nhật Trực Tiếp Database

```sql
UPDATE app_configs 
SET value = '60' 
WHERE key = 'ENTRY_ORDER_TTL_MINUTES';
```

---

## 📈 Ảnh Hưởng Của Thay Đổi

### Nếu Tăng TTL từ 10 → 60 phút:

**Ưu điểm**:
- ✅ Lệnh có thêm thời gian để được fill
- ✅ Giảm số lệnh bị hủy không cần thiết
- ✅ Tăng tỷ lệ entry thành công

**Nhược điểm**:
- ⚠️ Lệnh cũ có thể vẫn open khi có signal mới
- ⚠️ Có thể tạo nhiều lệnh open cùng lúc
- ⚠️ Cần quản lý max_concurrent_trades cẩn thận

### Giải Pháp Nhược Điểm:

```javascript
// Tăng max concurrent trades
bot.max_concurrent_trades = 10; // Thay vì 5

// Hoặc tắt auto-cancel ở cuối candle
await AppConfig.set('ENABLE_CANDLE_END_CANCEL_FOR_ENTRY', 'false');
```

---

## [object Object]ến Lược Tối Ưu

### Cho Min5 Timeframe:

```javascript
// 1. Tăng TTL lên 30 phút (đủ cho Min5)
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '30', 'Minutes before auto-cancel unfilled entry LIMIT orders');

// 2. Tắt auto-cancel ở cuối candle
await AppConfig.set('ENABLE_CANDLE_END_CANCEL_FOR_ENTRY', 'false', 'Enable auto-cancel unfilled entry orders at candle end');

// 3. Tăng max concurrent trades
// (Cập nhật trong database hoặc bot settings)
UPDATE bots SET max_concurrent_trades = 10 WHERE id = your_bot_id;

// 4. Monitor logs để xem số lệnh open
// tail -f logs/app.log | grep "open position"
```

---

## 📝 Monitoring & Debugging

### Kiểm Tra Logs:

```bash
# Xem lệnh bị hủy
tail -f logs/app.log | grep -i "cancel\|ttl"

# Xem lệnh được tạo
tail -f logs/app.log | grep -i "order created"

# Xem lệnh được fill
tail -f logs/app.log | grep -i "filled\|position opened"
```

### Kiểm Tra Database:

```sql
-- Xem lệnh đang open
SELECT * FROM positions WHERE status = 'open';

-- Xem lệnh bị hủy gần đây
SELECT * FROM positions WHERE status = 'cancelled' ORDER BY updated_at DESC LIMIT 10;

-- Xem config hiện tại
SELECT * FROM app_configs WHERE key LIKE '%TTL%' OR key LIKE '%CANCEL%';
```

---

## ✅ Checklist Để Giải Quyết Vấn Đề

- [ ] Kiểm tra ENTRY_ORDER_TTL_MINUTES hiện tại
- [ ] Xác định timeframe của strategy (Min5)
- [ ] Tăng TTL lên 30-60 phút
- [ ] Tắt ENABLE_CANDLE_END_CANCEL_FOR_ENTRY nếu cần
- [ ] Tăng max_concurrent_trades nếu cần
- [ ] Khởi động lại ứng dụng
- [ ] Monitor logs để xem kết quả
- [ ] Điều chỉnh nếu cần thiết

---

## 🔄 Quy Trình Kiểm Tra

### 1. Xác Định Vấn Đề Hiện Tại

```bash
# Kiểm tra config hiện tại
curl http://localhost:3000/api/config?key=ENTRY_ORDER_TTL_MINUTES
```

### 2. Cập Nhật Config

```javascript
// Trong src/app.js
await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '60', '...');
```

### 3. Khởi Động Lại

```bash
npm start
```

### 4. Tạo Signal Mới & Monitor

```bash
# Xem logs
tail -f logs/app.log | grep -i "order\|cancel\|ttl"

# Xem positions
curl http://localhost:3000/api/positions
```

### 5. Đánh Giá Kết Quả

- Có bao nhiêu lệnh được fill?
- Có bao nhiêu lệnh bị hủy?
- Thời gian trung bình từ khi tạo đến fill?

---

## 💬 Tóm Tắt

**Vấn đề**: Lệnh entry bị hủy sau 10 phút vì TTL hết hạn

**Giải pháp**: Tăng `ENTRY_ORDER_TTL_MINUTES` từ 10 → 30-60 phút

**Khuyến nghị cho Min5**:
```javascript
ENTRY_ORDER_TTL_MINUTES=60
ENABLE_CANDLE_END_CANCEL_FOR_ENTRY=false
max_concurrent_trades=10
```

**Kết quả mong đợi**:
- ✅ Lệnh có thêm thời gian để được fill
- ✅ Giảm số lệnh bị hủy không cần thiết
- ✅ Tăng tỷ lệ entry thành công

---

## 📞 Cần Giúp Đỡ?

Nếu vấn đề vẫn tiếp tục:

1. Kiểm tra logs: `tail -f logs/app.log`
2. Kiểm tra database: `SELECT * FROM app_configs WHERE key LIKE '%TTL%'`
3. Kiểm tra strategy settings: OC, Extend, TP có hợp lý không?
4. Kiểm tra market conditions: Giá có đạt OC không?

---

**Last Updated**: 2025-12-12  
**Status**: ✅ Giải Pháp Đầy Đủ

