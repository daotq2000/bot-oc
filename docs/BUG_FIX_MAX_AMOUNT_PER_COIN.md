# Bug Fix: max_amount_per_coin Reject Logic

## 🐛 Vấn đề

Bot 10, 11 có `is_reverse_strategy = false` và có signal match nhưng không có lệnh nào được mở.

### Root Cause

1. **Logic reject sai:** Code đang reject khi `projectedAmount >= maxAmountPerCoin`
   - Với `max_amount_per_coin = 1000` và `amount = 1000`
   - `projected = 0 + 1000 = 1000`
   - `1000 >= 1000` → REJECT ❌

2. **Missing field:** `max_amount_per_coin` không được load trong Strategy query
   - OrderService log hiển thị `max=0.00` (sai)
   - PositionLimitService có đúng giá trị `max=1000.00`

## ✅ Fix

### 1. Fix reject logic

**File:** `src/services/PositionLimitService.js`

**Before:**
```javascript
// Reject nếu projectedAmount >= maxAmountPerCoin
if (projectedAmount >= maxAmountPerCoin) {
  return false;
}
```

**After:**
```javascript
// Reject nếu projectedAmount > maxAmountPerCoin (chỉ reject khi vượt, cho phép khi bằng)
if (projectedAmount > maxAmountPerCoin) {
  return false;
}
```

**Impact:**
- Cho phép order khi `projected = max` (đạt đúng limit)
- Chỉ reject khi `projected > max` (vượt limit)

### 2. Fix Strategy model - Load max_amount_per_coin

**File:** `src/models/Strategy.js`

**Before:**
```javascript
SELECT s.*, b.bot_name, b.exchange, b.is_reverse_strategy FROM strategies s
```

**After:**
```javascript
SELECT s.*, b.bot_name, b.exchange, b.is_reverse_strategy, b.max_amount_per_coin FROM strategies s
```

**Impact:**
- Strategy object giờ có `max_amount_per_coin` trong `strategy.bot`
- OrderService log sẽ hiển thị đúng giá trị

## 📊 Test Case

### Before Fix:
- `max_amount_per_coin = 1000`
- `current = 0`
- `new = 1000`
- `projected = 1000`
- `1000 >= 1000` → **REJECT** ❌

### After Fix:
- `max_amount_per_coin = 1000`
- `current = 0`
- `new = 1000`
- `projected = 1000`
- `1000 > 1000` → **ALLOW** ✅

### Edge Cases:
- `projected = 1000.01 > 1000` → **REJECT** ✅
- `projected = 1000 = 1000` → **ALLOW** ✅
- `projected = 999.99 < 1000` → **ALLOW** ✅

## 🔍 Debug Script

Created `scripts/debug_bot_limit.js` để check bot configuration:

```bash
node scripts/debug_bot_limit.js 10
```

Shows:
- Bot configuration
- Active strategies
- Current positions per symbol
- Remaining capacity

## ✅ Validation

- [x] Logic changed from `>=` to `>`
- [x] Strategy model loads `max_amount_per_coin`
- [x] Debug script created
- [x] No breaking changes

## 📝 Related Files

- `src/services/PositionLimitService.js` - Fixed reject logic
- `src/models/Strategy.js` - Added max_amount_per_coin to query
- `scripts/debug_bot_limit.js` - Debug script

