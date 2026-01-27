# ✅ Fix: Đóng Position = MARKET Khi Vượt Target PNL & Dịch Chuyển TP Theo Reduce/Up_Reduce

**Ngày fix**: 2026-01-22

---

## 🐛 Vấn Đề 1: Đóng Position = MARKET Khi Vượt Target PNL Không Hoạt Động

### Nguyên nhân:
1. **Logic tính expectedPnL sai** cho percentage-based TP:
   - Code cũ: `expectedPnL = (position.amount * tpPercent) / 100`
   - Vấn đề: Công thức này không chính xác vì không tính đến entry price và side (long/short)
   - Ví dụ: Với entry=100, amount=1000 USDT, TP=5% (50), công thức cũ tính sai

2. **Thiếu logging** để debug:
   - Không có log để biết tại sao logic không trigger
   - Không biết expectedPnL được tính như thế nào

### Fix đã áp dụng:
1. ✅ **Sửa logic tính expectedPnL**:
   ```javascript
   // OLD (sai):
   expectedPnL = (position.amount * tpPercent) / 100;
   
   // NEW (đúng):
   const tpPrice = calculateTakeProfit(entryPrice, takeProfitValue, position.side);
   expectedPnL = calculatePnL(entryPrice, tpPrice, position.amount, position.side);
   ```
   - Sử dụng `calculateTakeProfit` để tính TP price
   - Sử dụng `calculatePnL` để tính expected PnL (giống như cách tính PnL thực tế)

2. ✅ **Thêm logging chi tiết**:
   - Log expectedPnL calculation
   - Log PnL check với threshold_met flag
   - Log khi trigger close position

### File thay đổi:
- `src/services/PositionService.js` (line ~138-184)

---

## 🐛 Vấn Đề 2: Dịch Chuyển TP Theo Reduce/Up_Reduce Không Hoạt Động

### Nguyên nhân:
1. **reduce/up_reduce không được load từ strategy**:
   - Code cũ chỉ lấy từ `position.reduce` và `position.up_reduce`
   - Nếu position object không có các field này (do JOIN không load), trailing sẽ không hoạt động
   - Nếu reduce/up_reduce = 0, trailing sẽ bị skip

2. **Thiếu logging** để debug:
   - Không biết tại sao trailing không hoạt động
   - Không biết reduce/up_reduce có giá trị gì

### Fix đã áp dụng:
1. ✅ **Load reduce/up_reduce từ strategy nếu missing**:
   ```javascript
   // OLD (chỉ lấy từ position):
   const reduce = Number(position.reduce || 0);
   const upReduce = Number(position.up_reduce || 0);
   
   // NEW (load từ strategy nếu missing):
   if ((reduce === 0 && upReduce === 0) || (!position.reduce && !position.up_reduce)) {
     const strategy = await Strategy.findById(position.strategy_id);
     if (strategy) {
       reduce = Number(strategy.reduce || 0);
       upReduce = Number(strategy.up_reduce || 0);
     }
   }
   ```

2. ✅ **Thêm logging chi tiết**:
   - Log khi load reduce/up_reduce từ strategy
   - Log warning khi trailingPercent = 0 (trailing disabled)
   - Log khi skip trailing do trailingPercent = 0

3. ✅ **Cải thiện logic check**:
   - Check cả `minutesForTrailing > 0` VÀ `trailingPercent > 0`
   - Log rõ ràng khi skip trailing

### File thay đổi:
- `src/services/PositionService.js` (line ~496-650)

---

## 📊 Kết Quả Mong Đợi

### Sau khi fix:
1. ✅ **Đóng position = MARKET khi vượt target PNL**:
   - Logic tính expectedPnL chính xác
   - Trigger close position khi `pnl >= expectedPnL`
   - Log chi tiết để debug

2. ✅ **Dịch chuyển TP theo reduce/up_reduce**:
   - reduce/up_reduce được load đúng từ strategy
   - Trailing TP hoạt động với reduce (SHORT) và up_reduce (LONG)
   - Log chi tiết để debug

---

## 🔍 Cách Kiểm Tra

### 1. Kiểm tra đóng position = MARKET:
```bash
# Tìm log khi PnL vượt target
grep "Take Profit reached (PnL-based)" logs/combined.log

# Tìm log PnL check
grep "TP PnL check" logs/combined.log
```

### 2. Kiểm tra trailing TP:
```bash
# Tìm log khi load reduce/up_reduce từ strategy
grep "Loaded reduce/up_reduce from strategy" logs/combined.log

# Tìm log trailing TP calculation
grep "TP Trail.*Calculated new TP" logs/combined.log

# Tìm log khi trailing disabled
grep "Trailing disabled" logs/combined.log
```

---

## ⚠️ Lưu Ý

1. **Position model phải JOIN với strategies**:
   - Đảm bảo `Position.findOpen()` và `Position.findById()` có JOIN với strategies
   - Đã có trong code hiện tại, nhưng fix thêm fallback load từ strategy

2. **reduce/up_reduce phải > 0**:
   - Nếu reduce = 0 và up_reduce = 0, trailing sẽ không hoạt động (static mode)
   - Đây là behavior đúng - trailing chỉ hoạt động khi có giá trị > 0

3. **ExpectedPnL calculation**:
   - Với percentage-based TP, sử dụng `calculateTakeProfit` và `calculatePnL`
   - Đảm bảo tính toán chính xác cho cả LONG và SHORT

---

**Các fix đã được apply và sẵn sàng để test**

