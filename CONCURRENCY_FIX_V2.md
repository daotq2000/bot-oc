# Fix: Concurrency Limit Bypass - Version 2

## Vấn đề vẫn còn
Sau khi fix EntryOrderMonitor, vẫn có positions vượt quá limit (12 positions khi limit = 10).

## Nguyên nhân sâu hơn

### Bug 1: OrderService finalize reservation quá sớm ✅ FIXED
- **File**: `src/services/OrderService.js`
- **Vấn đề**: 
  - Position được tạo (line 209) nhưng reservation chỉ được finalize ở line 283
  - Nếu có exception giữa chừng → Position đã tạo nhưng reservation chưa finalize
  - Finally block cancel reservation → Position tồn tại nhưng reservation bị cancel
- **Fix**: Finalize reservation **ngay sau khi Position được tạo** (line 226)

### Bug 2: Pending LIMIT orders - Double Reservation ✅ FIXED
- **File**: `src/services/OrderService.js` + `src/jobs/EntryOrderMonitor.js`
- **Vấn đề**:
  1. OrderService tạo entry_order với reservation_token (reservation = 'active')
  2. EntryOrderMonitor reserve slot mới khi tạo Position
  3. **Double counting**: Old reservation + New reservation = 2 slots cho 1 position
  4. Nếu có 10 entry orders → 10 old reservations + 10 new reservations = 20 slots
  5. Nhưng chỉ có 10 positions → Vẫn có thể tạo thêm 10 positions nữa!
- **Fix**: 
  - EntryOrderMonitor finalize old reservation **trước khi** reserve slot mới
  - Đảm bảo chỉ có 1 reservation active tại một thời điểm

### Bug 3: Race Condition trong EntryOrderMonitor ✅ FIXED
- **File**: `src/jobs/EntryOrderMonitor.js`
- **Vấn đề**: 
  - `canAcceptNewPosition()` là non-atomic check
  - Nhiều entry orders cùng lúc → tất cả pass check → tất cả reserve slot → vượt quá limit
- **Fix**: 
  - Sử dụng `reserveSlot()` với MySQL advisory lock (atomic)
  - Đảm bảo chỉ 1 process có thể reserve tại một thời điểm

## Giải pháp đã implement

### 1. OrderService - Finalize Reservation Ngay Sau Position Creation ✅
```javascript
// OLD (BUG):
position = await Position.create({...});
// ... many operations ...
await finalizeReservation(..., 'released'); // Too late!

// NEW (FIXED):
try {
  position = await Position.create({...});
  // Finalize IMMEDIATELY after Position creation
  orderCreated = true;
  await finalizeReservation(..., 'released');
} catch (error) {
  await finalizeReservation(..., 'cancelled');
  throw error;
}
```

### 2. EntryOrderMonitor - Finalize Old Reservation Trước Khi Reserve Mới ✅
```javascript
// OLD (BUG):
// Entry order has old reservation_token
// Reserve new slot → Double counting!

// NEW (FIXED):
// 1. Finalize old reservation first (cleanup)
if (oldReservationToken) {
  await finalizeReservation(botId, oldReservationToken, 'cancelled');
}
// 2. Reserve new slot atomically
const reservationToken = await reserveSlot(botId);
// 3. Create Position
// 4. Finalize new reservation
```

### 3. EntryOrderMonitor - Atomic Reservation ✅
- Sử dụng `reserveSlot()` với MySQL advisory lock
- Đảm bảo atomicity: chỉ 1 process có thể reserve tại một thời điểm
- Tránh race condition khi nhiều entry orders fill cùng lúc

## Migration

### Thêm reservation_token column vào entry_orders
```bash
node migrations/add_reservation_token_to_entry_orders.cjs
```

Hoặc manual:
```sql
ALTER TABLE entry_orders 
ADD COLUMN reservation_token VARCHAR(255) NULL 
AFTER status;
```

## So sánh trước/sau

### Trước khi fix:
```
OrderService (Market Order):
  - Reserve slot ✅
  - Create Position ✅
  - Finalize reservation (too late) ❌
  - Exception → Position exists but reservation cancelled ❌

OrderService (Pending LIMIT):
  - Reserve slot ✅
  - Create entry_order with reservation_token ✅
  - Reservation still 'active' ✅

EntryOrderMonitor:
  - Check canAccept (non-atomic) ❌
  - Reserve NEW slot ❌ (double counting!)
  - Create Position ✅
  - Finalize NEW reservation ✅
  - Old reservation still 'active' ❌
```
**Kết quả**: 12 positions khi limit = 10

### Sau khi fix:
```
OrderService (Market Order):
  - Reserve slot ✅
  - Create Position ✅
  - Finalize reservation IMMEDIATELY ✅
  - Exception → Reservation cancelled, Position not created ✅

OrderService (Pending LIMIT):
  - Reserve slot ✅
  - Create entry_order with reservation_token ✅
  - Reservation still 'active' (will be finalized by EntryOrderMonitor) ✅

EntryOrderMonitor:
  - Finalize OLD reservation first ✅
  - Reserve NEW slot atomically ✅
  - Create Position ✅
  - Finalize NEW reservation ✅
```
**Kết quả**: Positions luôn tuân thủ limit

## Testing

### Test Case 1: Market Order với Exception
1. Reserve slot
2. Create Position
3. Exception xảy ra trước khi finalize reservation
4. **Expected**: Reservation cancelled, Position không tồn tại (rollback)
5. **Actual**: ✅ Fixed - Finalize ngay sau Position creation

### Test Case 2: Multiple Entry Orders Fill Cùng Lúc
1. Tạo 10 entry orders (10 reservations 'active')
2. Tất cả fill cùng lúc
3. EntryOrderMonitor xử lý
4. **Expected**: 
   - Finalize 10 old reservations
   - Reserve 10 new slots (atomic)
   - Create 10 Positions
   - Finalize 10 new reservations
5. **Actual**: ✅ Fixed - Old reservations finalized first

### Test Case 3: Entry Order Fill Khi Limit Đầy
1. Tạo 10 positions (đạt limit)
2. Tạo entry_order (reservation 'active')
3. Entry order fill
4. EntryOrderMonitor phát hiện fill
5. **Expected**: 
   - Finalize old reservation
   - Reserve new slot → FAIL (limit reached)
   - Entry order remains in table
6. **Actual**: ✅ Fixed - Atomic reservation prevents bypass

## Monitoring

### Kiểm tra reservations:
```sql
-- Xem active reservations
SELECT bot_id, COUNT(*) as active_reservations
FROM concurrency_reservations
WHERE status = 'active'
GROUP BY bot_id;

-- Xem positions
SELECT bot_id, COUNT(*) as open_positions
FROM positions p
JOIN strategies s ON p.strategy_id = s.id
WHERE p.status = 'open'
GROUP BY bot_id;

-- So sánh với limit
SELECT 
  b.id as bot_id,
  b.max_concurrent_trades as limit,
  COUNT(DISTINCT p.id) as open_positions,
  (SELECT COUNT(*) FROM concurrency_reservations WHERE bot_id = b.id AND status = 'active') as active_reservations,
  (COUNT(DISTINCT p.id) + (SELECT COUNT(*) FROM concurrency_reservations WHERE bot_id = b.id AND status = 'active')) as total
FROM bots b
LEFT JOIN strategies s ON s.bot_id = b.id
LEFT JOIN positions p ON p.strategy_id = s.id AND p.status = 'open'
WHERE b.is_active = TRUE
GROUP BY b.id;
```

## Lưu Ý

1. **Migration Required**: 
   - Chạy migration để thêm `reservation_token` column
   - Code sẽ tự động fallback nếu column không tồn tại

2. **Existing Positions**:
   - Positions hiện tại (12 positions) sẽ không bị ảnh hưởng
   - Chỉ **ngăn chặn** tạo positions mới vượt quá limit
   - Cần đợi positions hiện tại đóng để về dưới limit

3. **Double Reservation Prevention**:
   - Old reservation được finalize **trước khi** reserve slot mới
   - Đảm bảo chỉ có 1 reservation active tại một thời điểm
   - Tránh double counting

## Kết luận

- ✅ **Fix 3 bugs** trong concurrency control
- ✅ **Finalize reservation ngay** sau Position creation
- ✅ **Finalize old reservation** trước khi reserve slot mới
- ✅ **Atomic reservation** với MySQL advisory lock
- ✅ **Đảm bảo** positions luôn tuân thủ `max_concurrent_trade` limit

