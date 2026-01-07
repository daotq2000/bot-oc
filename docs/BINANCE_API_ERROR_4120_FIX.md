# Khắc Phục Lỗi Binance API -4120

## Vấn Đề
**Lỗi:** `Binance API Error -4120: Order type not supported for this endpoint`

**Nguyên Nhân:**
- Endpoint `/fapi/v1/order` không hỗ trợ `TAKE_PROFIT` và `STOP` order types
- Cần sử dụng `TAKE_PROFIT_MARKET` và `STOP_MARKET` thay thế

## Giải Pháp
Thay đổi order types trong `src/services/BinanceDirectClient.js`:

1. **TP Order:** `TAKE_PROFIT` → `TAKE_PROFIT_MARKET`
2. **SL Order:** `STOP` → `STOP_MARKET`

## Thay Đổi Code

### createTpLimitOrder()
- Thay `type: 'TAKE_PROFIT'` → `type: 'TAKE_PROFIT_MARKET'`
- Xóa `price` parameter

### createSlLimitOrder()
- Thay `type: 'STOP'` → `type: 'STOP_MARKET'`
- Xóa `price` parameter

## Kết Quả
✅ TP/SL orders sẽ được tạo thành công
✅ Positions có thể đóng tự động

## Lưu Ý
- Market orders có thể có slippage nhỏ
- Nếu muốn limit orders, cần implement Algo Order API

