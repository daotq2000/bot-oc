# Binance Trigger Orders Module

Module này cung cấp các hàm để đặt lệnh trên Binance Futures với trigger orders (không chiếm margin trước khi kích hoạt).

## ✅ Các hàm đã được tạo

### 1. `createEntryTriggerOrder(symbol, side, entryPrice, quantity)`

Đặt lệnh entry bằng STOP_MARKET order:
- **LONG**: BUY STOP_MARKET với `positionSide=LONG`
- **SHORT**: SELL STOP_MARKET với `positionSide=SHORT`

**Đặc điểm:**
- Không chiếm margin cho đến khi `stopPrice` được kích hoạt
- Tự động format price và quantity theo `tickSize` và `stepSize`
- Tự động đảm bảo notional value >= 100 USDT

**Ví dụ:**
```javascript
const entryOrder = await binanceClient.createEntryTriggerOrder(
  'BTCUSDT',
  'long',
  87000,  // entry trigger price
  0.001   // quantity
);
```

### 2. `createTpLimitOrder(symbol, side, tpPrice, quantity)`

Đặt lệnh Take Profit bằng TAKE_PROFIT limit order:
- Tự động format price theo `tickSize`
- Sử dụng `closePosition=true` hoặc `quantity` nếu được cung cấp
- `reduceOnly=true` để đảm bảo chỉ đóng position

**Ví dụ:**
```javascript
const tpOrder = await binanceClient.createTpLimitOrder(
  'BTCUSDT',
  'long',
  88000,  // TP price
  0.001   // quantity (optional, nếu không có sẽ dùng closePosition=true)
);
```

### 3. `createSlLimitOrder(symbol, side, slPrice, quantity)`

Đặt lệnh Stop Loss bằng STOP limit order:
- Tự động format price theo `tickSize`
- Sử dụng `closePosition=true` hoặc `quantity` nếu được cung cấp
- `reduceOnly=true` để đảm bảo chỉ đóng position

**Ví dụ:**
```javascript
const slOrder = await binanceClient.createSlLimitOrder(
  'BTCUSDT',
  'long',
  86000,  // SL price
  0.001   // quantity (optional)
);
```

## 🔧 Các hàm hỗ trợ

### `formatPrice(price, tickSize)`
Format giá theo tickSize của symbol.

### `formatQuantity(quantity, stepSize)`
Format quantity theo stepSize của symbol.

### `getTickSize(symbol)`
Lấy tickSize (price precision) từ Binance exchangeInfo.

### `getStepSize(symbol)`
Lấy stepSize (quantity precision) từ Binance exchangeInfo.

### `makeRequestWithRetry(endpoint, method, params, requiresAuth, retries)`
Make request với retry logic cho lỗi 5xx và xử lý các lỗi phổ biến:
- `-4061`: Position side mismatch
- `-1111`: Precision error
- `-2019`: Insufficient margin

## 📋 Flow đặt lệnh hoàn chỉnh

```javascript
// 1. Đặt entry trigger order
const entryOrder = await binanceClient.createEntryTriggerOrder(
  'BTCUSDT',
  'long',
  87000,
  0.001
);

// 2. Chờ entry order được fill (sử dụng webhook hoặc polling)
// Khi order status = 'FILLED', tiếp tục bước 3

// 3. Đặt TP và SL orders
const tpOrder = await binanceClient.createTpLimitOrder(
  'BTCUSDT',
  'long',
  88000,  // TP price
  0.001   // quantity
);

const slOrder = await binanceClient.createSlLimitOrder(
  'BTCUSDT',
  'long',
  86000,  // SL price
  0.001   // quantity
);
```

## ⚠️ Lưu ý quan trọng

1. **Entry Order**: Sử dụng `STOP_MARKET` - không chiếm margin cho đến khi trigger
2. **TP/SL Orders**: Phải đặt SAU KHI entry order được fill
3. **Precision**: Tự động format theo `tickSize` và `stepSize` từ Binance
4. **Notional Value**: Tự động đảm bảo >= 100 USDT (yêu cầu của Binance)
5. **Position Side**: Phải khớp với cài đặt trên Binance account (ONE-WAY hoặc HEDGE mode)

## 🧪 Test

Chạy test script:
```bash
node test_trigger_order.js [strategy_id]
```

Script sẽ:
1. Lấy strategy từ database
2. Tính toán entry price, TP, SL
3. Đặt entry trigger order
4. Hiển thị hướng dẫn đặt TP/SL sau khi entry fill

## 📝 Error Handling

Module tự động xử lý:
- **Retry**: Tự động retry 3 lần cho lỗi 5xx
- **Precision**: Tự động format theo tickSize/stepSize
- **Notional**: Tự động tăng quantity để đạt minimum 100 USDT
- **Common Errors**: 
  - `-4061`: Position side mismatch
  - `-1111`: Precision error (đã được fix tự động)
  - `-2019`: Insufficient margin

## 🔄 Integration với OrderService

Để tích hợp vào OrderService, cần:
1. Thay `createOrder()` bằng `createEntryTriggerOrder()`
2. Thêm logic để detect khi entry order fill
3. Tự động đặt TP/SL orders sau khi entry fill

