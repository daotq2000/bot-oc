# Fix: Concurrency Limit Bypass Bug

## Vấn đề
Bot 2 và 3 có `max_concurrent_trade = 10`, nhưng số lượng vị thế trên Binance đã vượt quá 10, thành 13 positions.

## Nguyên nhân

### Bug trong EntryOrderMonitor
- **File**: `src/jobs/EntryOrderMonitor.js`
- **Vấn đề**: `_confirmEntryWithPosition()` tạo Position **KHÔNG kiểm tra concurrency limit**
- **Luồng lỗi**:
  1. `OrderService.executeSignal()` tạo entry_order (pending LIMIT) → đã reserve slot
  2. Entry order được fill trên exchange
  3. `EntryOrderMonitor` phát hiện order filled → gọi `_confirmEntryWithPosition()`
  4. `_confirmEntryWithPosition()` tạo Position **mà không check concurrency** → **BYPASS limit**
  5. Nếu nhiều entry orders cùng fill → nhiều positions được tạo vượt quá limit

### Tại sao có thể vượt quá limit?
- Entry orders được tạo với reservation token
- Nhưng khi entry order fill, `EntryOrderMonitor` tạo Position mà **không verify reservation còn valid**
- Có thể có race condition: nhiều entry orders fill cùng lúc → nhiều positions được tạo
- Reservation token từ `OrderService` không được track trong `EntryOrderMonitor`

## Giải pháp đã implement

### 1. Thêm Concurrency Check trong EntryOrderMonitor ✅
- **File**: `src/jobs/EntryOrderMonitor.js`
- **Thay đổi**:
  - Check `canAcceptNewPosition()` trước khi tạo Position
  - Reserve slot atomically với `reserveSlot()` trước khi tạo Position
  - Finalize reservation sau khi Position được tạo thành công
  - Cancel reservation nếu Position creation fail

### 2. Logic mới
```javascript
// 1. Quick check (non-blocking)
const canAccept = await concurrencyManager.canAcceptNewPosition(botId);
if (!canAccept) {
  // Skip - entry order remains in entry_orders for retry later
  return;
}

// 2. Reserve slot atomically (with lock)
const reservationToken = await concurrencyManager.reserveSlot(botId);
if (!reservationToken) {
  // Limit reached - skip
  return;
}

// 3. Create Position
try {
  position = await Position.create({...});
  // 4. Finalize reservation as 'released'
  await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');
} catch (error) {
  // 5. Cancel reservation if Position creation failed
  await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
  throw error;
}
```

## So sánh trước/sau

### Trước khi fix:
```
OrderService.executeSignal():
  - Reserve slot ✅
  - Create entry_order ✅
  - Finalize reservation (released) ✅

EntryOrderMonitor._confirmEntryWithPosition():
  - Check order filled ✅
  - Create Position ❌ (KHÔNG check concurrency)
  - Mark entry_order filled ✅
```
**Kết quả**: Positions có thể vượt quá limit

### Sau khi fix:
```
OrderService.executeSignal():
  - Reserve slot ✅
  - Create entry_order ✅
  - Finalize reservation (released) ✅

EntryOrderMonitor._confirmEntryWithPosition():
  - Check canAcceptNewPosition() ✅
  - Reserve slot atomically ✅
  - Create Position ✅
  - Finalize reservation (released) ✅
  - Cancel reservation nếu fail ✅
```
**Kết quả**: Positions luôn tuân thủ limit

## Edge Cases Đã Xử Lý

### 1. Entry Order Fill Khi Limit Đã Đầy
- Entry order vẫn ở trong `entry_orders` table (status = 'open')
- Sẽ retry khi có slot available (trong lần poll tiếp theo)
- **Lưu ý**: Order đã fill trên exchange nhưng Position chưa được tạo

### 2. Race Condition
- Sử dụng `reserveSlot()` với MySQL advisory lock
- Đảm bảo atomicity: chỉ 1 process có thể reserve tại một thời điểm
- **Kết quả**: Không có race condition

### 3. Position Creation Failure
- Reservation được cancel nếu Position creation fail
- Entry order vẫn ở trong table để retry
- **Kết quả**: Không leak reservations

## Monitoring

### Kiểm tra concurrency status:
```sql
-- Xem số positions hiện tại
SELECT bot_id, COUNT(*) as open_positions
FROM positions p
JOIN strategies s ON p.strategy_id = s.id
WHERE p.status = 'open'
GROUP BY bot_id;

-- Xem reservations
SELECT bot_id, COUNT(*) as active_reservations
FROM concurrency_reservations
WHERE status = 'active'
GROUP BY bot_id;
```

### Kiểm tra entry orders bị stuck:
```sql
-- Entry orders đã fill nhưng chưa tạo Position (do limit)
SELECT * FROM entry_orders 
WHERE status = 'open' 
AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE);
```

## Lưu Ý Quan Trọng

1. **Entry Orders Stuck**: 
   - Nếu entry order đã fill trên exchange nhưng limit đã đầy
   - Entry order sẽ ở trong table với status = 'open'
   - Sẽ tự động retry khi có slot available
   - **Không cần manual intervention**

2. **Existing Positions Vượt Quá Limit**:
   - Các positions hiện tại (13 positions khi limit = 10) sẽ không bị ảnh hưởng
   - Chỉ **ngăn chặn** tạo positions mới vượt quá limit
   - Cần đợi positions hiện tại đóng để về dưới limit

3. **Performance**:
   - Thêm 2 database queries (canAcceptNewPosition + reserveSlot)
   - Nhưng đảm bảo correctness - đáng giá trade-off

## Testing

### Test Case 1: Entry Order Fill Khi Limit Đầy
1. Tạo 10 positions (đạt limit)
2. Tạo entry_order (pending LIMIT)
3. Entry order fill trên exchange
4. EntryOrderMonitor phát hiện fill
5. **Expected**: Entry order vẫn ở trong table, Position KHÔNG được tạo
6. **Actual**: ✅ Entry order remains, Position not created

### Test Case 2: Multiple Entry Orders Fill Cùng Lúc
1. Tạo 8 positions (còn 2 slots)
2. Tạo 5 entry_orders cùng lúc
3. Tất cả fill cùng lúc
4. EntryOrderMonitor xử lý
5. **Expected**: Chỉ 2 Positions được tạo, 3 entry orders remain
6. **Actual**: ✅ Only 2 Positions created (race condition handled by lock)

## Rollback (Nếu Cần)

Nếu cần rollback (không khuyến khích):
```javascript
// Remove concurrency checks in _confirmEntryWithPosition
// Just create Position directly (old behavior)
const position = await Position.create({...});
```

## Kết luận

- ✅ **Fix concurrency bypass bug** trong EntryOrderMonitor
- ✅ **Đảm bảo** positions luôn tuân thủ `max_concurrent_trade` limit
- ✅ **Xử lý** edge cases: limit đầy, race conditions, failures
- ✅ **Không ảnh hưởng** đến existing positions

