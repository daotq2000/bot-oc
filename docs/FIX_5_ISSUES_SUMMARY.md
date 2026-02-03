# Fix Summary: 5 Critical Issues in Bot Logs

**Date:** 2026-01-31  
**Branch:** ema

---

## Issues Fixed

### Issue #1: ReduceOnly Order Rejected (-2022) - 741 occurrences
**Root Cause:** Bot attempts to place TP/SL orders for positions that no longer exist on exchange (ghost positions).

**Fix Applied:**
1. Added `_verifyPositionExistsOnExchange()` helper in `PositionMonitor.js` to verify position exists BEFORE TP/SL placement
2. Added `_closeGhostPosition()` helper to properly close ghost positions with Telegram alerts
3. Early verification in `_placeExitOrderCore()` - if position doesn't exist, close it as ghost instead of trying to place orders
4. Self-healing in error handler - when -2022 occurs, verify position and close if ghost
5. BinanceDirectClient now returns `null` instead of throwing on -2022 in fallback logic to prevent retry loops

**Files Modified:**
- `/src/jobs/PositionMonitor.js` - Added verification and ghost cleanup helpers
- `/src/services/BinanceDirectClient.js` - Graceful handling of -2022 in fallback

---

### Issue #2: Ghost Positions (Position "Ma")
**Root Cause:** Positions exist in DB but were already closed on exchange (via TP/SL fill, liquidation, or manual close).

**Fix Applied:**
1. Pre-flight verification before any TP/SL placement
2. Automatic ghost position cleanup when detected
3. Created `scripts/cleanupGhostPositions.js` - standalone cleanup script for manual/scheduled runs

**Usage:**
```bash
# Dry run (report only)
node scripts/cleanupGhostPositions.js --dry-run --max-age-hours=1

# Live cleanup
node scripts/cleanupGhostPositions.js --max-age-hours=1
```

---

### Issue #3: Positions Stuck Without TP/SL (60000+ seconds)
**Root Cause:** TP/SL placement kept failing in retry loops due to ghost positions or other errors.

**Fix Applied:**
1. Break the retry loop - if position is ghost, close it instead of retrying
2. Add position existence check at the START of `_placeExitOrderCore()`
3. Clear `tp_sl_pending` flag when ghost is detected and closed

---

### Issue #4: DB Amount Reconciliation (40% mismatch)
**Root Cause:** DB amount (notional in USDT) doesn't match actual exchange position quantity.

**Fix Applied:**
1. During position verification, also sync the amount and entry_price from exchange to DB
2. Added reconciliation logic in `_placeExitOrderCore()`:
   - Get position details from exchange during verification
   - If mismatch > 5%, update DB with exchange values
   - Log reconciliation for audit

**Code Location:** `PositionMonitor.js` lines ~520-540

---

### Issue #5: TAKE_PROFIT_MARKET Not Supported
**Root Cause:** Some symbols don't support `TAKE_PROFIT_MARKET` order type.

**Fix Applied:**
1. Existing fallback in `BinanceDirectClient.createCloseTakeProfitMarket()` handles -4120 error
2. Fallback to LIMIT order with explicit quantity
3. Added graceful handling of -2022 in fallback:
   - If position doesn't exist during fallback, return `null` instead of throwing
   - This prevents retry loops and lets `PositionMonitor` handle cleanup

---

## New Files Created

1. **`/scripts/cleanupGhostPositions.js`**
   - Standalone script to clean up ghost positions
   - Supports dry-run mode
   - Configurable max age filter
   - Reports amount mismatches for reconciliation

---

## Testing Recommendation

1. **Run cleanup script in dry-run first:**
   ```bash
   node scripts/cleanupGhostPositions.js --dry-run --max-age-hours=1
   ```

2. **If results look correct, run live cleanup:**
   ```bash
   node scripts/cleanupGhostPositions.js --max-age-hours=1
   ```

3. **Monitor logs after restart:**
   - Should see fewer -2022 errors
   - Ghost positions should be auto-closed
   - TP/SL placement should succeed more often

---

## Metrics to Watch

| Metric | Before | Expected After |
|--------|--------|----------------|
| -2022 errors per hour | ~100+ | < 10 |
| Positions without TP/SL > 1 hour | Many | 0 |
| Amount mismatch warnings | Frequent | Rare (auto-reconciled) |
| Ghost positions | Accumulating | Auto-cleaned |

---

## Future Improvements (Recommended)

1. **Add cron job for cleanup script** - Run every 30 minutes to auto-clean ghost positions
2. **Add alerting** - Telegram alert when ghost position count exceeds threshold
3. **Cache symbol order types** - Pre-check if symbol supports TAKE_PROFIT_MARKET before attempting

---

## Rollback Plan

If issues occur, revert these files:
- `/src/jobs/PositionMonitor.js`
- `/src/services/BinanceDirectClient.js`

```bash
git checkout HEAD~1 -- src/jobs/PositionMonitor.js src/services/BinanceDirectClient.js
```
