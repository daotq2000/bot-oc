# Stop Loss by USDT Amount - Test Scripts

## Tổng quan

Các script test này được tạo để verify tính năng tính Stop Loss theo số tiền USDT thay vì phần trăm.

## Scripts

### 1. `test_stoploss_by_amount.js`

Script test unit cho function `calculateInitialStopLossByAmount`.

**Chạy test:**
```bash
node scripts/test_stoploss_by_amount.js
```

**Test cases bao gồm:**
- ✅ Basic LONG position calculation
- ✅ Basic SHORT position calculation
- ✅ Small quantity, large SL amount
- ✅ Large quantity, small SL amount
- ✅ Invalid inputs (zero, negative values)
- ✅ Edge cases (SL would be negative, SL equals entry)
- ✅ Real-world scenarios (BTC, ETH positions)
- ✅ Comparison with old percentage-based method
- ✅ Precision tests

**Kết quả mong đợi:**
- Tất cả 14 test cases đều pass
- Verify công thức tính đúng: `Loss = |SL - Entry| * quantity`
- Verify SL price được tính chính xác cho cả LONG và SHORT

### 2. `test_stoploss_integration.js`

Script test integration với PositionService và các service thực tế.

**Chạy test:**
```bash
node scripts/test_stoploss_integration.js
```

**Test cases bao gồm:**
- ✅ PositionService.calculateUpdatedStopLoss với mock position
- ✅ Existing SL không được recalculate
- ✅ Quantity fallback từ amount/entry khi không lấy được từ exchange
- ✅ Invalid stoploss trả về null
- ✅ Calculation consistency across multiple scenarios
- ✅ Edge cases (large SL amount relative to position)

**Kết quả mong đợi:**
- Tất cả 6 test cases đều pass
- Verify integration với PositionService hoạt động đúng
- Verify fallback logic khi không lấy được quantity từ exchange

## Cách tính SL mới

### Công thức

**LONG Position:**
```
SL = Entry - (SL_amount / quantity)
Loss = (Entry - SL) * quantity = SL_amount
```

**SHORT Position:**
```
SL = Entry + (SL_amount / quantity)
Loss = (SL - Entry) * quantity = SL_amount
```

### Ví dụ

**LONG Position:**
- Entry: $100,000
- Quantity: 0.1 BTC
- SL Amount: 100 USDT
- **SL Price:** $100,000 - (100 / 0.1) = $99,000
- **Loss khi chạm SL:** (100,000 - 99,000) * 0.1 = 100 USDT ✅

**SHORT Position:**
- Entry: $50,000
- Quantity: 0.2 BTC
- SL Amount: 50 USDT
- **SL Price:** $50,000 + (50 / 0.2) = $50,250
- **Loss khi chạm SL:** (50,250 - 50,000) * 0.2 = 50 USDT ✅

## Thay đổi trong code

### Files đã được cập nhật:

1. **`src/utils/calculator.js`**
   - Thêm function `calculateInitialStopLossByAmount`

2. **`src/services/PositionService.js`**
   - Cập nhật `calculateUpdatedStopLoss` để sử dụng `calculateInitialStopLossByAmount`
   - Lấy quantity từ exchange hoặc tính từ amount/entry

3. **`src/jobs/PositionMonitor.js`**
   - Cập nhật `placeTPAndSL` để sử dụng `calculateInitialStopLossByAmount`

4. **`src/services/OrderService.js`**
   - Cập nhật để tính SL bằng `calculateInitialStopLossByAmount`

5. **`src/consumers/WebSocketOCConsumer.js`**
   - Cập nhật để tính SL bằng `calculateInitialStopLossByAmount`

## Lưu ý

1. **Database:** `strategy.stoploss` bây giờ là số USDT (không phải phần trăm)
   - Ví dụ: `stoploss = 100` → mất 100 USDT khi chạm SL

2. **Quantity:** 
   - Ưu tiên lấy từ exchange (chính xác nhất)
   - Fallback: tính từ `amount / entry_price`

3. **Validation:**
   - SL phải > 0
   - LONG: SL < Entry
   - SHORT: SL > Entry
   - Nếu không thỏa mãn → trả về null (không set SL)

## Troubleshooting

### Test fail?
- Kiểm tra xem có lỗi syntax không: `node --check scripts/test_stoploss_by_amount.js`
- Kiểm tra imports có đúng không
- Verify function `calculateInitialStopLossByAmount` có tồn tại trong `calculator.js`

### Integration test fail?
- Kiểm tra PositionService có được import đúng không
- Verify mock ExchangeService hoạt động đúng
- Kiểm tra async/await có được xử lý đúng không

## Kết quả test

**Unit Tests:** ✅ 14/14 passed
**Integration Tests:** ✅ 6/6 passed

Tất cả test cases đều pass, tính năng sẵn sàng sử dụng!

