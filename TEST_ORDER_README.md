# Hướng Dẫn Test Đặt Lệnh trên Binance Testnet

## Mô tả

Script `test_order.js` được tạo để giả lập đặt lệnh khi có signal khớp với strategy. Script sẽ:
1. Lấy một strategy có sẵn từ database
2. Lấy giá hiện tại từ Binance
3. Tính toán Entry Price, TP, SL theo strategy
4. Đặt market order trên Binance testnet
5. Lưu position vào database với TP/SL

## Cách sử dụng

### Chạy với strategy mặc định (tự động chọn)
```bash
node test_order.js
```

### Chạy với strategy ID cụ thể
```bash
node test_order.js <strategy_id>
```

Ví dụ:
```bash
node test_order.js 123
```

## Lưu ý

1. **Precision Error**: Một số symbol (như XAIUSDT) có precision đặc biệt từ Binance. Nếu gặp lỗi "Precision is over the maximum", hãy thử với strategy có symbol phổ biến hơn như BTCUSDT hoặc ETHUSDT.

2. **Take Profit**: Binance Futures không hỗ trợ đặt TP order tự động. Bot sẽ:
   - Lưu TP price vào database
   - PositionMonitor job sẽ theo dõi giá và đóng position khi TP được hit

3. **Testnet**: Script sử dụng Binance testnet, không ảnh hưởng đến tài khoản thật.

4. **Strategy Requirements**:
   - Strategy phải thuộc bot có exchange = 'binance'
   - Strategy phải active (is_active = TRUE)
   - Strategy phải có symbol kết thúc bằng USDT

## Output mẫu

```
=== Test Order Placement on Binance Testnet ===
Strategy: 123 - BTCUSDT
  Bot ID: 2
  Interval: 1m
  OC Threshold: 2.00%
  Extend: 60.00%
  Amount: 100.00 USDT
  Take Profit: 50.00
  Trade Type: both

Current price: 43250.50
OC: 0.15%, Direction: bullish
Selected side: long
Entry Price: 43250.50
Take Profit: 43281.25 (0.07%)
Stop Loss: 43219.75 (-0.07%)

=== Placing Order on Binance Testnet ===
Symbol: BTCUSDT
Side: BUY
Type: MARKET
Amount: 100.00 USDT

=== Order Placed Successfully ===
Position ID: 456
Order ID: 12345678
Entry Price: 43250.50
Take Profit: 43281.25
Stop Loss: 43219.75
```

## Troubleshooting

### Lỗi "Precision is over the maximum"
- Thử với strategy có symbol phổ biến hơn (BTCUSDT, ETHUSDT)
- Hoặc chỉnh sửa amount nhỏ hơn trong strategy

### Lỗi "No candle data"
- Đảm bảo CandleUpdater đã chạy và có dữ liệu candle cho symbol
- Kiểm tra symbol có tồn tại trên Binance không

### Lỗi "Bot not found"
- Kiểm tra bot_id trong strategy có tồn tại không
- Đảm bảo bot có exchange = 'binance'

