# Position Delete Protection

## Vấn đề đã phát hiện

### 1. Foreign Key CASCADE DELETE
- Foreign key constraint `fk_positions_bot_id` có `ON DELETE CASCADE`
- Khi bot bị xóa → tất cả positions của bot đó bị xóa tự động
- Điều này rất nguy hiểm vì:
  - Open positions bị xóa → PositionMonitor không thể monitor
  - Historical data bị mất
  - Không có audit trail

### 2. Bot.delete() không check open positions
- `Bot.delete()` có thể xóa bot mà không kiểm tra open positions
- Dẫn đến CASCADE DELETE của tất cả positions

### 3. Strategy.delete() không check open positions
- `Strategy.delete()` có thể xóa strategy mà không kiểm tra open positions
- `Strategy.deleteBySymbols()` cũng không check

## Giải pháp đã triển khai

### 1. Migration: Fix Foreign Key Constraint
**File**: `migrations/20251227000000-fix-positions-fk-cascade-delete.cjs`

- Thay đổi foreign key constraint từ `ON DELETE CASCADE` → `ON DELETE RESTRICT`
- RESTRICT ngăn chặn xóa bot nếu có positions đang reference
- Đảm bảo positions chỉ được xóa thông qua explicit `Position.close()` hoặc `Position.cancel()`

**Chạy migration**:
```bash
node migrations/20251227000000-fix-positions-fk-cascade-delete.cjs
```

### 2. Bot.delete() Protection
**File**: `src/models/Bot.js`

- Thêm check open positions trước khi xóa bot
- Throw error nếu có open positions
- Log warning nếu có closed positions (sẽ bị xóa nếu CASCADE vẫn còn)

```javascript
// CRITICAL PROTECTION: Check for open positions before deletion
const openPositionsCount = await Position.countOpenByBot(id);
if (openPositionsCount > 0) {
  throw new Error(`Cannot delete bot ${id}: Bot has ${openPositionsCount} open position(s)`);
}
```

### 3. Strategy.delete() Protection
**File**: `src/models/Strategy.js`

- Thêm check open positions trước khi xóa strategy
- Throw error với chi tiết open positions
- List affected positions để dễ debug

```javascript
// CRITICAL PROTECTION: Check for open positions before deletion
const openPositions = await Position.findOpen(id);
if (openPositions.length > 0) {
  throw new Error(`Cannot delete strategy ${id}: Strategy has ${openPositions.length} open position(s)`);
}
```

### 4. Strategy.deleteBySymbols() Protection
**File**: `src/models/Strategy.js`

- Thêm check open positions cho tất cả strategies sẽ bị xóa
- Throw error với chi tiết affected strategies và positions
- Chỉ xóa strategies nếu không có open positions

## Các nơi có thể xóa position

### ✅ An toàn (chỉ UPDATE status, không DELETE):
1. `Position.close()` - UPDATE status = 'closed'
2. `Position.cancel()` - UPDATE status = 'cancelled'
3. `PositionService.closePosition()` - Gọi `Position.close()`
4. `PositionSync` - UPDATE status = 'closed' khi sync

### ❌ Nguy hiểm (đã được bảo vệ):
1. `Bot.delete()` - **ĐÃ BẢO VỆ**: Check open positions trước
2. `Strategy.delete()` - **ĐÃ BẢO VỆ**: Check open positions trước
3. `Strategy.deleteBySymbols()` - **ĐÃ BẢO VỆ**: Check open positions trước
4. Foreign key CASCADE DELETE - **ĐÃ BẢO VỆ**: Migration thay đổi thành RESTRICT

### ⚠️ Test/Development Scripts (cần cẩn thận):
1. `scripts/clear_data_test.js` - DELETE positions (chỉ dùng cho test)
2. Test files - DELETE positions trong cleanup (chỉ test)

## Script test_tp_sl_flow_binance.js

**Kết quả kiểm tra**: ✅ **AN TOÀN**
- Script chỉ xóa temp strategy (`deleteTempStrategy`)
- Không xóa position
- Position được tạo bởi `OrderService.executeSignal` và được monitor bởi PositionMonitor

## Best Practices

### 1. Không bao giờ DELETE position trực tiếp
```sql
-- ❌ KHÔNG BAO GIỜ LÀM ĐIỀU NÀY:
DELETE FROM positions WHERE id = ?;

-- ✅ ĐÚNG: Dùng Position.close() hoặc Position.cancel()
await Position.close(positionId, closePrice, pnl, reason);
```

### 2. Luôn check open positions trước khi xóa bot/strategy
```javascript
// ✅ ĐÚNG: Check trước khi xóa
const openCount = await Position.countOpenByBot(botId);
if (openCount > 0) {
  throw new Error(`Cannot delete: ${openCount} open positions`);
}
```

### 3. Sử dụng Position.close() thay vì DELETE
```javascript
// ✅ ĐÚNG: Close position (UPDATE status)
await Position.close(positionId, closePrice, pnl, 'tp_hit');

// ❌ SAI: Delete position
await pool.execute('DELETE FROM positions WHERE id = ?', [positionId]);
```

## Migration Instructions

1. **Backup database trước khi chạy migration**
2. **Chạy migration**:
   ```bash
   node migrations/20251227000000-fix-positions-fk-cascade-delete.cjs
   ```
3. **Verify**:
   ```sql
   SHOW CREATE TABLE positions;
   -- Kiểm tra: ON DELETE RESTRICT (không phải CASCADE)
   ```

## Rollback (nếu cần)

```bash
# Rollback migration (KHÔNG KHUYẾN NGHỊ)
node -e "require('./migrations/20251227000000-fix-positions-fk-cascade-delete.cjs').down()"
```

**Lưu ý**: Rollback về CASCADE là nguy hiểm và không được khuyến nghị.

## Kết luận

- ✅ Foreign key constraint đã được sửa: CASCADE → RESTRICT
- ✅ Bot.delete() đã có protection: Check open positions
- ✅ Strategy.delete() đã có protection: Check open positions
- ✅ Strategy.deleteBySymbols() đã có protection: Check open positions
- ✅ Script test_tp_sl_flow_binance.js: An toàn, không xóa position
- ✅ Positions chỉ được "xóa" thông qua UPDATE status (close/cancel)

**Positions sẽ không bao giờ bị xóa khỏi database nữa, chỉ được đánh dấu là 'closed' hoặc 'cancelled'.**

