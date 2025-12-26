# Phân Tích Việc Sử Dụng Locking trong Codebase

**Date:** 2025-01-27

---

## 📋 Tổng Quan

Codebase sử dụng **2 loại locking** để tránh race conditions:

1. **Pessimistic Lock** (SELECT FOR UPDATE) - Chỉ có 1 chỗ
2. **Soft Lock** (is_processing flag) - Nhiều chỗ

---

## 🔒 1. Pessimistic Lock (SELECT FOR UPDATE)

### Vị Trí: `src/jobs/PositionSync.js`

**Method:** `createMissingPosition()` (dòng 351-522)

**Mục đích:** Tránh race condition khi tạo position từ exchange sync

**Code:**
```javascript
// SAFEGUARD: Check for existing position with SELECT FOR UPDATE to prevent race conditions
// This locks the rows and prevents concurrent creation
const [existing] = await connection.execute(
  `SELECT p.id, p.symbol, p.side
   FROM positions p
   JOIN strategies s ON p.strategy_id = s.id
   WHERE s.bot_id = ? 
     AND p.status = 'open'
     AND p.side = ?
     AND (
       p.symbol = ? OR 
       p.symbol = ? OR 
       s.symbol = ? OR 
       s.symbol = ?
     )
   LIMIT 1
   FOR UPDATE`,
  [botId, side, normalizedSymbol, `${normalizedSymbol}/USDT`, normalizedSymbol, `${normalizedSymbol}/USDT`]
);
```

**Cách hoạt động:**
1. Bắt đầu transaction
2. SELECT FOR UPDATE → lock rows matching criteria
3. Kiểm tra nếu position đã tồn tại → rollback
4. Nếu không → tạo position mới
5. Commit transaction

**Lợi ích:**
- ✅ Đảm bảo không tạo duplicate position khi nhiều process sync cùng lúc
- ✅ Lock ở database level → an toàn nhất

**Nhược điểm:**
- ⚠️ Chỉ có 1 chỗ sử dụng
- ⚠️ Các chỗ tạo position khác không dùng pessimistic lock

---

## 🔐 2. Soft Lock (is_processing flag)

### Vị Trí: Nhiều chỗ

**Cách hoạt động:**
```sql
-- Acquire lock
UPDATE positions 
SET is_processing = 1 
WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)

-- Release lock
UPDATE positions SET is_processing = 0 WHERE id = ?
```

### 2.1. PositionMonitor.js

**Method:** `placeTpSlOrders()` (dòng 107-230)

**Mục đích:** Tránh race condition khi nhiều instance cùng place TP/SL orders

**Code:**
```javascript
// RACE CONDITION FIX: Use soft lock to prevent concurrent TP/SL placement
// Try to acquire lock by setting is_processing flag
const [lockResult] = await pool.execute(
  `UPDATE positions 
   SET is_processing = 1 
   WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)`,
  [position.id]
);

if (lockResult.affectedRows === 0) {
  // Lock acquisition failed - another process is handling this position
  logger.debug(`[Place TP/SL] Position ${position.id} is already being processed by another instance, skipping`);
  return;
}
```

### 2.2. PositionService.js

**Method:** `updatePosition()` (dòng 422-476)

**Mục đích:** Tránh race condition khi update position (trailing TP/SL)

**Code:**
```javascript
// CRITICAL FIX: Use soft lock to prevent race condition with PositionSync
const [lockResult] = await pool.execute(
  `UPDATE positions 
   SET is_processing = 1 
   WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)`,
  [position.id]
);

if (lockResult.affectedRows === 0) {
  // Lock acquisition failed
  logger.debug(`[PositionService] Could not acquire lock for position ${position.id}, skipping update`);
  return;
}
```

### 2.3. PositionSync.js

**Method:** `syncPositions()` (dòng 69-320)

**Mục đích:** Tránh race condition khi sync positions từ exchange

**Code:**
```javascript
// Acquire soft lock before updating position
const [lockResult] = await pool.execute(
  `UPDATE positions 
   SET is_processing = 1 
   WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)`,
  [dbPos.id]
);

if (lockResult.affectedRows === 0) {
  // Lock acquisition failed - another process is handling this position
  logger.debug(`[PositionSync] Could not acquire lock for position ${dbPos.id}, skipping`);
  continue;
}
```

**Lợi ích:**
- ✅ Đơn giản, không cần transaction
- ✅ Tránh được race condition giữa các process
- ✅ Có backward compatibility (nếu column không tồn tại)

**Nhược điểm:**
- ⚠️ Không phải database-level lock → có thể có race condition nếu 2 queries chạy cùng lúc
- ⚠️ Phụ thuộc vào việc release lock đúng cách (finally block)

---

## ❌ 3. Các Chỗ KHÔNG Sử Dụng Locking

### 3.1. EntryOrderMonitor.js

**Method:** `_confirmEntryWithPosition()` (dòng 300-376)

**Vấn đề:** Tạo position không có pessimistic lock

**Code hiện tại:**
```javascript
position = await Position.create({
  strategy_id: entry.strategy_id,
  bot_id: botId,
  // ...
});

await EntryOrder.markFilled(entry.id);
```

**Rủi ro:**
- ⚠️ Nếu 2 process cùng confirm entry order → có thể tạo duplicate position
- ⚠️ Hiện tại chỉ dựa vào UNIQUE constraint và error handling

**Error handling:**
```javascript
if (posError?.code === 'ER_DUP_ENTRY' || posError?.message?.includes('Duplicate entry')) {
  logger.warn(`Position creation failed due to duplicate (likely race condition). Entry order ${entry.id} will be marked as filled.`);
  await EntryOrder.markFilled(entry.id);
}
```

### 3.2. OrderService.js

**Method:** `executeSignal()` (dòng 330-360)

**Vấn đề:** Tạo position không có pessimistic lock

**Code hiện tại:**
```javascript
position = await Position.create({
  strategy_id: strategy.id,
  bot_id: strategy.bot_id,
  // ...
});
```

**Rủi ro:**
- ⚠️ Nếu 2 signal cùng lúc → có thể tạo duplicate position
- ⚠️ Hiện tại chỉ dựa vào UNIQUE constraint

---

## 📊 So Sánh

| Loại Lock | Vị Trí | Mục Đích | An Toàn | Phức Tạp |
|-----------|--------|----------|---------|----------|
| **Pessimistic** | PositionSync.createMissingPosition | Tạo position từ exchange | ✅✅✅ Rất an toàn | ⚠️ Cần transaction |
| **Soft Lock** | PositionMonitor.placeTpSlOrders | Place TP/SL orders | ✅✅ Tương đối an toàn | ✅ Đơn giản |
| **Soft Lock** | PositionService.updatePosition | Update position (trailing TP) | ✅✅ Tương đối an toàn | ✅ Đơn giản |
| **Soft Lock** | PositionSync.syncPositions | Sync positions | ✅✅ Tương đối an toàn | ✅ Đơn giản |
| **Không có** | EntryOrderMonitor._confirmEntryWithPosition | Tạo position từ entry order | ⚠️ Dựa vào UNIQUE | ✅ Đơn giản |
| **Không có** | OrderService.executeSignal | Tạo position từ signal | ⚠️ Dựa vào UNIQUE | ✅ Đơn giản |

---

## 🔍 Phân Tích Rủi Ro

### 1. Race Condition khi Tạo Position

**Scenario:**
- Process A: EntryOrderMonitor confirm entry order → tạo position
- Process B: PositionSync phát hiện position trên exchange → tạo position
- **Kết quả:** Có thể tạo duplicate (nếu UNIQUE constraint không đủ)

**Giải pháp hiện tại:**
- ✅ UNIQUE constraint trên `(strategy_id, symbol, side, status='open')`
- ✅ Error handling cho `ER_DUP_ENTRY`
- ⚠️ Nhưng vẫn có thể có race condition nếu 2 process cùng tạo cùng lúc

**Giải pháp đề xuất:**
- ✅ Sử dụng pessimistic lock (SELECT FOR UPDATE) trước khi tạo position
- ✅ Hoặc sử dụng soft lock (is_processing) cho entry order

### 2. Race Condition khi Update Position

**Scenario:**
- Process A: PositionMonitor update trailing TP
- Process B: PositionSync update position từ exchange
- **Kết quả:** Có thể overwrite lẫn nhau

**Giải pháp hiện tại:**
- ✅ Soft lock (is_processing) → đã được implement
- ✅ Các process check lock trước khi update

### 3. Race Condition khi Place TP/SL

**Scenario:**
- Process A: PositionMonitor place TP/SL
- Process B: PositionMonitor place TP/SL (nếu chạy 2 instance)
- **Kết quả:** Có thể tạo duplicate TP/SL orders

**Giải pháp hiện tại:**
- ✅ Soft lock (is_processing) → đã được implement
- ✅ Check lock trước khi place orders

---

## 💡 Đề Xuất Cải Thiện

### 1. Thêm Pessimistic Lock cho EntryOrderMonitor

**File:** `src/jobs/EntryOrderMonitor.js`

**Method:** `_confirmEntryWithPosition()`

**Đề xuất:**
```javascript
async _confirmEntryWithPosition(botId, entry, overrideEntryPrice = null) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    // Check for existing position with SELECT FOR UPDATE
    const [existing] = await connection.execute(
      `SELECT p.id FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE s.bot_id = ? 
         AND p.status = 'open'
         AND p.side = ?
         AND (p.symbol = ? OR s.symbol = ?)
       LIMIT 1
       FOR UPDATE`,
      [botId, entry.side, entry.symbol, entry.symbol]
    );
    
    if (existing.length > 0) {
      await connection.rollback();
      logger.info(`[EntryOrderMonitor] Position already exists for entry ${entry.id}, skipping`);
      await EntryOrder.markFilled(entry.id);
      return;
    }
    
    // Create position
    position = await Position.create({...});
    await EntryOrder.markFilled(entry.id);
    
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
```

### 2. Thêm Pessimistic Lock cho OrderService

**File:** `src/services/OrderService.js`

**Method:** `executeSignal()`

**Đề xuất:** Tương tự như EntryOrderMonitor, thêm SELECT FOR UPDATE trước khi tạo position.

### 3. Cải Thiện Soft Lock

**Vấn đề:** Soft lock có thể bị miss nếu 2 queries chạy cùng lúc

**Giải pháp:** Sử dụng `SELECT ... FOR UPDATE` trong transaction thay vì `UPDATE` trực tiếp:

```javascript
// Thay vì:
UPDATE positions SET is_processing = 1 WHERE id = ? AND is_processing = 0

// Nên dùng:
BEGIN TRANSACTION;
SELECT * FROM positions WHERE id = ? FOR UPDATE;
UPDATE positions SET is_processing = 1 WHERE id = ?;
COMMIT;
```

---

## ✅ Kết Luận

### Hiện Trạng:
1. ✅ **Pessimistic lock:** Có 1 chỗ (PositionSync.createMissingPosition)
2. ✅ **Soft lock:** Có nhiều chỗ (PositionMonitor, PositionService, PositionSync)
3. ⚠️ **Không có lock:** EntryOrderMonitor, OrderService (dựa vào UNIQUE constraint)

### Rủi Ro:
- ⚠️ EntryOrderMonitor và OrderService có thể tạo duplicate position nếu race condition xảy ra
- ⚠️ Soft lock không hoàn toàn an toàn (có thể miss nếu 2 queries chạy cùng lúc)

### Đề Xuất:
- ✅ Thêm pessimistic lock cho EntryOrderMonitor và OrderService
- ✅ Cải thiện soft lock bằng cách sử dụng SELECT FOR UPDATE trong transaction

---

**Report Generated:** 2025-01-27

