# Plan: Remove Concurrency Reservations System

## 📊 IMPACT ANALYSIS

### Current Usage:
- **Table:** `concurrency_reservations` (160,279 records, all "released")
- **Code:** Used in `OrderService.executeSignal()`
- **Purpose:** Limit concurrent open positions per bot
- **Current Limits:** 10,000 (bot 2, 3) vs actual 746-1572 positions
- **Effectiveness:** ❌ NOT WORKING (limits too high, actual positions far below)

### Files Using ConcurrencyManager:
1. `src/services/OrderService.js` - Main usage
2. `src/services/ConcurrencyManager.js` - Implementation
3. `src/workers/StrategiesWorker.js` - Import
4. `src/jobs/EntryOrderMonitor.js` - Import
5. `src/jobs/PositionSync.js` - Import
6. `scripts/test_tp_sl_flow_binance.js` - Import

---

## ✅ BENEFITS OF REMOVAL

1. **Simpler Code:** Remove ~500 lines of complex locking logic
2. **Better Performance:** No DB queries for reservations
3. **Less DB Load:** Remove 160K+ records
4. **Easier Debugging:** One less system to troubleshoot
5. **Alternative Control:** Use leverage + margin instead

---

## ⚠️ RISKS

1. **No Position Limit:** Bots can open unlimited positions
   - **Mitigation:** Use low leverage (2-5x) + high margin
   
2. **Potential Over-trading:** Many positions at once
   - **Mitigation:** Adjust strategy parameters (higher OC threshold)
   
3. **Margin Exhaustion:** Run out of margin
   - **Mitigation:** Monitor balance, set alerts

---

## 🔧 REMOVAL STEPS

### Step 1: Remove from OrderService ✅

**File:** `src/services/OrderService.js`

**Changes:**
```javascript
// Remove import
- import { concurrencyManager } from './ConcurrencyManager.js';

// Remove reservation logic
- reservationToken = await concurrencyManager.reserveSlot(strategy.bot_id);
- await concurrencyManager.finalizeReservation(...);

// Remove limit check
- if (!reservationToken) { ... }
```

### Step 2: Remove ConcurrencyManager File ✅

**File:** `src/services/ConcurrencyManager.js`

**Action:** Delete file

### Step 3: Remove from Other Files ✅

**Files:**
- `src/workers/StrategiesWorker.js` - Remove import
- `src/jobs/EntryOrderMonitor.js` - Remove import
- `src/jobs/PositionSync.js` - Remove import
- `scripts/test_tp_sl_flow_binance.js` - Remove import

### Step 4: Drop Database Table ✅

**SQL:**
```sql
DROP TABLE concurrency_reservations;
```

### Step 5: Remove Config ✅

**SQL:**
```sql
DELETE FROM app_configs 
WHERE config_key IN (
  'CONCURRENCY_RESERVATION_TTL_SEC',
  'CONCURRENCY_LOCK_TIMEOUT'
);
```

### Step 6: Update Bot Limits (Optional) ✅

**SQL:**
```sql
-- Set realistic limits or NULL (unlimited)
UPDATE bots 
SET max_concurrent_trades = NULL 
WHERE id IN (2, 3, 9);
```

---

##[object Object]ALTERNATIVE RISK MANAGEMENT

### Instead of Concurrency Limits, Use:

1. **Low Leverage (2-5x)**
   ```sql
   UPDATE bots SET default_leverage = 3 WHERE id IN (2, 3, 9);
   ```

2. **High Margin Requirement**
   - Use larger position sizes
   - Keep more USDT in account
   
3. **Strategy-Level Limits**
   - Higher OC threshold (reduce signals)
   - Longer intervals (fewer opportunities)
   - Stricter extend conditions

4. **Balance Monitoring**
   - Alert when balance < threshold
   - Auto-stop trading if low balance
   - Daily PnL limits

5. **Per-Symbol Limits**
   - Only 1 position per symbol
   - Already implemented via `Position.findOpen(strategyId)`

---

## ✅ IMPLEMENTATION

Execute removal in order:

1. ✅ Backup database
2. ✅ Remove code references
3. ✅ Test without concurrency checks
4. ✅ Drop table
5. ✅ Monitor for issues
6. ✅ Adjust leverage/margin as needed

---

## 📝 TESTING PLAN

### Before Removal:
- Record current open positions
- Note any errors/warnings
- Check system behavior

### After Removal:
- Verify orders still place correctly
- Monitor position count
- Check for any errors
- Verify no code breaks

### Rollback Plan:
- Keep backup of ConcurrencyManager.js
- Keep SQL backup of table
- Can restore if needed

---

## 🎉 EXPECTED OUTCOME

**After Removal:**
- ✅ Simpler codebase
- ✅ Better performance
- ✅ Less DB overhead
- ✅ Easier maintenance
- ✅ Risk managed via leverage/margin

**Recommendation:** ✅ PROCEED WITH REMOVAL

The concurrency system is not providing value (limits too high, not enforced properly). Better to use leverage and margin for risk management.

---

**Analysis Date:** 2025-12-23 00:47 UTC+7  
**Recommendation:** REMOVE  
**Risk Level:** LOW (with proper leverage/margin settings)

