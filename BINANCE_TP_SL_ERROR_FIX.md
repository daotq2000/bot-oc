# Khắc Phục Lỗi Binance -4120: Order Type Not Supported

## 🔴 Vấn Đề

**Lỗi:** `Binance API Error -4120: Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.`

**Nguyên Nhân:**
- Binance Futures API không hỗ trợ `TAKE_PROFIT` và `STOP` order types ở endpoint `/fapi/v1/order`
- Cần sử dụng các order types khác hoặc Algo Order API

---

## 📋 Binance Futures Order Types

### Endpoint `/fapi/v1/order` Hỗ Trợ:
- ✅ `MARKET` - Market order
- ✅ `LIMIT` - Limit order
- ✅ `STOP_MARKET` - Stop market order
- ✅ `TAKE_PROFIT_MARKET` - Take profit market order
- ❌ `TAKE_PROFIT` - **NOT SUPPORTED** (Lỗi -4120)
- ❌ `STOP` - **NOT SUPPORTED** (Lỗi -4120)

### Algo Order API (Separate Endpoints):
- `/fapi/v1/openOrder` - Open orders
- `/fapi/v1/allOrders` - All orders
- Hỗ trợ `TAKE_PROFIT` và `STOP` types

---

## ✅ Giải Pháp

### Tùy Chọn 1: Sử Dụng TAKE_PROFIT_MARKET & STOP_MARKET (Khuyến Nghị)
**Ưu Điểm:**
- Đơn giản, không cần Algo Order API
- Tự động thực thi khi giá chạm trigger
- Hỗ trợ `closePosition=true`

**Nhược Điểm:**
- Market order khi trigger (có thể slippage)

### Tùy Chọn 2: Sử Dụng Algo Order API
**Ưu Điểm:**
- Hỗ trợ `TAKE_PROFIT` và `STOP` limit orders
- Tốt hơn cho slippage

**Nhược Điểm:**
- Cần endpoints riêng
- Phức tạp hơn

### Tùy Chọn 3: Sử Dụng LIMIT Orders + Manual Monitoring
**Ưu Điểm:**
- Kiểm soát tối đa

**Nhược Điểm:**
- Cần monitoring liên tục
- Có thể miss trigger

---

## 🔧 Khắc Phục (Tùy Chọn 1: Khuyến Nghị)

### Thay Đổi Order Types

**Trước:**
```javascript
// TP Order
type: 'TAKE_PROFIT'  // ❌ NOT SUPPORTED

// SL Order
type: 'STOP'  // ❌ NOT SUPPORTED
```

**Sau:**
```javascript
// TP Order
type: 'TAKE_PROFIT_MARKET'  // ✅ SUPPORTED

// SL Order
type: 'STOP_MARKET'  // ✅ SUPPORTED
```

### Cập Nhật BinanceDirectClient

**File:** `src/services/BinanceDirectClient.js`

#### 1. Cập Nhật createTpLimitOrder

```javascript
async createTpLimitOrder(symbol, side, tpPrice, quantity = null) {
  const normalizedSymbol = this.normalizeSymbol(symbol);

  // Get precision info & account mode
  const [tickSize, stepSize, dualSide] = await Promise.all([
    this.getTickSize(normalizedSymbol),
    this.getStepSize(normalizedSymbol),
    this.getDualSidePosition()
  ]);

  // Format price
  const formattedPrice = this.formatPrice(tpPrice, tickSize);

  // Safety check to prevent -2021 "Order would immediately trigger"
  const currentPrice = await this.getPrice(normalizedSymbol);
  if (currentPrice) {
    if (side === 'long' && formattedPrice <= currentPrice) {
      logger.warn(`[TP-SKIP] TP price ${formattedPrice} for LONG is at or below current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
      return null;
    }
    if (side === 'short' && formattedPrice >= currentPrice) {
      logger.warn(`[TP-SKIP] TP price ${formattedPrice} for SHORT is at or above current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
      return null;
    }
  }

  // Determine position side
  const positionSide = side === 'long' ? 'LONG' : 'SHORT';
  // For TP: long position closes with SELL, short position closes with BUY
  const orderSide = side === 'long' ? 'SELL' : 'BUY';

  const params = {
    symbol: normalizedSymbol,
    side: orderSide,
    type: 'TAKE_PROFIT_MARKET',  // ✅ Changed from TAKE_PROFIT
    stopPrice: formattedPrice.toString(), // Trigger price
    closePosition: quantity ? 'false' : 'true',
    timeInForce: 'GTC'
  };

  // Only include positionSide in dual-side (hedge) mode
  if (dualSide) {
    params.positionSide = positionSide;
  }

  // Add quantity if provided
  if (quantity) {
    const formattedQuantity = this.formatQuantity(quantity, stepSize);
    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity}`);
    }
    params.quantity = formattedQuantity;
  }

  logger.info(`Creating TP market order: ${orderSide} ${normalizedSymbol} @ ${formattedPrice}${dualSide ? ` (${positionSide})` : ''}`);

  try {
    const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
    logger.info(`✅ TP market order placed: Order ID: ${data.orderId}`);
    return data;
  } catch (error) {
    logger.error(`Failed to create TP market order:`, error);
    throw error;
  }
}
```

#### 2. Cập Nhật createSlLimitOrder

```javascript
async createSlLimitOrder(symbol, side, slPrice, quantity = null) {
  const normalizedSymbol = this.normalizeSymbol(symbol);
  
  // Get precision info & account mode
  const [tickSize, stepSize, dualSide] = await Promise.all([
    this.getTickSize(normalizedSymbol),
    this.getStepSize(normalizedSymbol),
    this.getDualSidePosition()
  ]);
  
  // Format price
  const formattedPrice = this.formatPrice(slPrice, tickSize);
  
  // Determine position side
  const positionSide = side === 'long' ? 'LONG' : 'SHORT';
  // For SL: long position closes with SELL, short position closes with BUY
  const orderSide = side === 'long' ? 'SELL' : 'BUY';
  
  const params = {
    symbol: normalizedSymbol,
    side: orderSide,
    type: 'STOP_MARKET',  // ✅ Changed from STOP
    stopPrice: formattedPrice.toString(), // Trigger price
    closePosition: quantity ? 'false' : 'true',
    timeInForce: 'GTC'
  };

  // Only include positionSide in dual-side (hedge) mode
  if (dualSide) {
    params.positionSide = positionSide;
  }
  
  // Add quantity if provided
  if (quantity) {
    const formattedQuantity = this.formatQuantity(quantity, stepSize);
    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity}`);
    }
    params.quantity = formattedQuantity;
  }
  
  logger.info(`Creating SL market order: ${orderSide} ${normalizedSymbol} @ ${formattedPrice}${dualSide ? ` (${positionSide})` : ''}`);
  
  try {
    const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
    logger.info(`✅ SL market order placed: Order ID: ${data.orderId}`);
    return data;
  } catch (error) {
    logger.error(`Failed to create SL market order:`, error);
    throw error;
  }
}
```

---

## 📝 Ghi Chú Quan Trọng

### Sự Khác Biệt: LIMIT vs MARKET

| Tính Năng | TAKE_PROFIT (Limit) | TAKE_PROFIT_MARKET |
|-----------|-------------------|-------------------|
| Hỗ Trợ | Algo Order API | `/fapi/v1/order` ✅ |
| Thực Thi | Limit price | Market price |
| Slippage | Thấp | Cao |
| Độ Phức Tạp | Cao | Thấp |

### Khi Nào Dùng MARKET:
- ✅ Khi muốn chắc chắn thực thi
- ✅ Khi không quan tâm slippage nhỏ
- ✅ Khi muốn đơn giản hóa code

### Khi Nào Dùng LIMIT (Algo API):
- ✅ Khi muốn kiểm soát giá thực thi
- ✅ Khi slippage là vấn đề
- ✅ Khi có thời gian implement Algo API

---

## [object Object]ách Áp Dụng

### 1. Cập Nhật BinanceDirectClient.js
Thay đổi `TAKE_PROFIT` → `TAKE_PROFIT_MARKET` và `STOP` → `STOP_MARKET`

### 2. Restart Bot
```bash
./restart_bot.sh
```

### 3. Kiểm Tra Logs
```bash
tail -f logs/combined.log | grep "TP market order\|SL market order"
```

---

## ⚠️ Lưu Ý

1. **Market Orders:** Sẽ thực thi ở giá thị trường, có thể có slippage
2. **Testnet vs Mainnet:** Hành vi có thể khác nhau
3. **Backup Plan:** Nếu vẫn có lỗi, có thể implement Algo Order API

---

## 📚 Tài Liệu Tham Khảo

- Binance Futures API: https://binance-docs.github.io/apidocs/futures/en/
- Order Types: https://binance-docs.github.io/apidocs/futures/en/#new-order-trade
- Algo Orders: https://binance-docs.github.io/apidocs/futures/en/#algo-orders-user_data

---

**Cập Nhật:** 2025-12-09
**Phiên Bản:** 1.0

