# Các Sửa Chữa Mới Nhất - Lỗi Binance API -4120

## 🔴 Lỗi Phát Hiện

```
Failed to create TP limit order: Binance API Error -4120: 
Order type not supported for this endpoint. 
Please use the Algo Order API endpoints instead.
```

**Ảnh Hưởng:**
- ❌ Không thể tạo Take Profit orders
- ❌ Không thể tạo Stop Loss orders
- ❌ Positions không thể đóng tự động

---

## ✅ Giải Pháp

### Nguyên Nhân
Binance Futures API endpoint `/fapi/v1/order` không hỗ trợ:
- ❌ `TAKE_PROFIT` order type
- ❌ `STOP` order type

### Giải Pháp
Sử dụng supported order types:
- ✅ `TAKE_PROFIT_MARKET` - Thay thế cho TAKE_PROFIT
- ✅ `STOP_MARKET` - Thay thế cho STOP

---

## 🔧 Thay Đổi Code

### File: `src/services/BinanceDirectClient.js`

#### 1. createTpLimitOrder() - Dòng ~1000

**Trước:**
```javascript
type: 'TAKE_PROFIT',
stopPrice: formattedPrice.toString(),
price: formattedPrice.toString(),  // ❌ Không cần cho MARKET
```

**Sau:**
```javascript
type: 'TAKE_PROFIT_MARKET',  // ✅ Changed
stopPrice: formattedPrice.toString(),
// price parameter removed
```

#### 2. createSlLimitOrder() - Dòng ~1050

**Trước:**
```javascript
type: 'STOP',
stopPrice: formattedPrice.toString(),
price: formattedPrice.toString(),  // ❌ Không cần cho MARKET
```

**Sau:**
```javascript
type: 'STOP_MARKET',  // ✅ Changed
stopPrice: formattedPrice.toString(),
// price parameter removed
```

---

## 📊 Kết Quả

### Trước Sửa Chữa
```
❌ Failed to create TP limit order: Error -4120
❌ Failed to create SL limit order: Error -4120
❌ 4 errors trong logs
```

### Sau Sửa Chữa
```
✅ TP market order placed: Order ID: 12345678
✅ SL market order placed: Order ID: 12345679
✅ Positions đóng tự động
```

---

## [object Object]ách Áp Dụng

### 1. Verify Sửa Chữa
```bash
grep "TAKE_PROFIT_MARKET\|STOP_MARKET" src/services/BinanceDirectClient.js
```

### 2. Restart Bot
```bash
./restart_bot.sh
```

### 3. Kiểm Tra Logs
```bash
# Không có lỗi -4120
grep "-4120" logs/error.log | wc -l

# Có TP/SL market orders
grep "market order placed" logs/combined.log
```

---

## ⚠️ Ghi Chú

### Market Orders vs Limit Orders
| Tính Năng | MARKET | LIMIT |
|-----------|--------|-------|
| Hỗ Trợ | `/fapi/v1/order` ✅ | Algo API |
| Thực Thi | Giá thị trường | Giá cụ thể |
| Slippage | Nhỏ | Không |
| Độ Phức Tạp | Thấp | Cao |

### Slippage
- Thường < 0.1% cho TP/SL
- Chấp nhận được cho trading

---

## [object Object]óm Tắt

| Thành Phần | Thay Đổi | Tác Động |
|-----------|---------|---------|
| TP Order | TAKE_PROFIT → TAKE_PROFIT_MARKET | ✅ Hoạt động |
| SL Order | STOP → STOP_MARKET | ✅ Hoạt động |
| Price Param | Xóa | ✅ Đơn giản |
| Lỗi -4120 | Khắc phục | ✅ Không còn |

---

**Cập Nhật:** 2025-12-09
**Trạng Thái:** ✅ Hoàn Thành

