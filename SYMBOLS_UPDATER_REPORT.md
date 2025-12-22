# SymbolsUpdater Job - Diagnostic Report

**Date:** 2025-12-22 18:43 UTC+7  
**Status:** ✅ PARTIALLY WORKING - BINANCE OK, MEXC FAILING

---

## Executive Summary

### ✅ Binance: WORKING
- Updates every 15 minutes
- Last update: 5 minutes ago
- 534 symbols tracked
- 3 new symbols added in last 24h

### ❌ MEXC: FAILING
- Last successful update: 7 days ago
- Error: API timeout and 404 errors
- 727 symbols (stale data)

---

## Current Status

### Configuration

```
ENABLE_SYMBOLS_REFRESH: true
SYMBOLS_REFRESH_CRON: */15 * * * * (every 15 minutes)
```

### Last Update Times

| Exchange | Last Update | Minutes Ago | Total Symbols | Status |
|----------|-------------|-------------|---------------|--------|
| Binance  | 2025-12-22 04:32 | 5 min | 534 | ✅ OK |
| MEXC     | 2025-12-15 03:27 | 10,150 min (7 days) | 727 | ❌ STALE |

### Recently Added Symbols (Last 24h)

| Symbol | Exchange | Created At | Status |
|--------|----------|------------|--------|
| ZKPUSDT | binance | 2025-12-21 19:54 | ✅ Added |
| GUAUSDT | binance | 2025-12-21 19:54 | ✅ Added |
| IRUSDT | binance | 2025-12-21 19:54 | ✅ Added |

---

## Issues Found

### 1. MEXC API Errors

**Errors:**
```
Error: mexc GET https://api.mexc.co/api/v3/exchangeInfo request timed out (30000 ms)
Error: mexc {"code":404,"msg":"Not Found"}
```

**Root Cause:**
- MEXC API endpoint changed or deprecated
- Timeout issues (30s)
- 404 errors on swap markets endpoint

**Impact:**
- MEXC symbols not updated for 7 days
- New MEXC coins not added to watchlist
- Delisted MEXC coins not removed

### 2. Missing Strategy Cleanup

**Issue:** When symbols are delisted, strategies are not deleted

**Impact:**
- Strategies for delisted symbols remain in database
- Bot tries to trade delisted symbols
- Errors and wasted resources

**Fix Applied:** ✅ Added `Strategy.deleteBySymbols()` method

---

## Fixes Applied

### 1. Added Strategy Cleanup Logic

**File:** `src/models/Strategy.js`

```javascript
/**
 * Delete strategies for delisted symbols
 * @param {string} exchange - Exchange name (binance, mexc)
 * @param {Array<string>} delistedSymbols - Array of delisted symbols
 * @returns {Promise<number>} Number of deleted strategies
 */
static async deleteBySymbols(exchange, delistedSymbols) {
  // Delete strategies for symbols that are no longer on exchange
  const sql = `
    DELETE s FROM strategies s
    JOIN bots b ON s.bot_id = b.id
    WHERE b.exchange = ? AND s.symbol IN (?)
  `;
  return affectedRows;
}
```

### 2. Integrated Strategy Cleanup in ExchangeInfoService

**File:** `src/services/ExchangeInfoService.js`

Added logic to delete strategies when symbols are delisted:

```javascript
if (deletedCount > 0) {
  // Delete strategies for delisted symbols
  const delistedSymbols = currentDbSymbols.filter(s => !exchangeSymbols.includes(s));
  if (delistedSymbols.length > 0) {
    const deletedStrategiesCount = await Strategy.deleteBySymbols(exchange, delistedSymbols);
    logger.info(`Deleted ${deletedStrategiesCount} strategies for ${delistedSymbols.length} delisted symbols`);
  }
}
```

---

## How It Works

### Update Flow (Every 15 Minutes)

```
1. Fetch symbols from exchange API
   ├─ Binance: fapi.binance.com/fapi/v1/exchangeInfo
   └─ MEXC: api.mexc.co (via CCXT)

2. Compare with database (symbol_filters)
   ├─ New symbols → INSERT
   ├─ Existing symbols → UPDATE
   └─ Delisted symbols → DELETE

3. Delete strategies for delisted symbols (NEW)
   └─ Find strategies with delisted symbols
   └─ DELETE from strategies table

4. Reload in-memory cache
   └─ Update filtersCache Map
```

### Deletion Logic

**When a symbol is delisted:**

1. **symbol_filters table:**
   ```sql
   DELETE FROM symbol_filters
   WHERE exchange = 'binance' AND symbol NOT IN (current_symbols)
   ```

2. **strategies table:** (NEW)
   ```sql
   DELETE s FROM strategies s
   JOIN bots b ON s.bot_id = b.id
   WHERE b.exchange = 'binance' AND s.symbol IN (delisted_symbols)
   ```

---

## MEXC API Issue

### Problem

MEXC API is returning errors:
- Timeout: 30s
- 404 Not Found on swap markets endpoint

### Possible Causes

1. **API endpoint changed**
   - MEXC may have updated their API
   - CCXT library may be outdated

2. **Rate limiting**
   - Too many requests
   - IP blocked

3. **Network issues**
   - Firewall blocking
   - DNS resolution problems

### Temporary Workaround

MEXC symbols are still functional (using 7-day-old data):
- 727 symbols in database
- WebSocket still working
- Trading still possible

### Recommended Actions

1. **Update CCXT library:**
   ```bash
   npm update ccxt
   pm2 restart bot-oc
   ```

2. **Check MEXC API documentation:**
   - Verify correct endpoints
   - Check for API changes

3. **Add fallback logic:**
   - Use alternative MEXC API endpoints
   - Implement retry with exponential backoff

4. **Monitor:**
   - Check if MEXC updates succeed after CCXT update
   - Verify new symbols are added

---

## Verification Steps

### 1. Check if SymbolsUpdater is running

```bash
pm2 logs bot-oc | grep "SymbolsUpdater"
```

Expected output:
```
[SymbolsUpdater] Started with cron: */15 * * * *
[SymbolsUpdater] Refreshing Binance and MEXC symbol filters...
[SymbolsUpdater] Binance symbol filters updated
```

### 2. Check for deleted strategies

```bash
pm2 logs bot-oc | grep "Deleted.*strategies"
```

Expected output (when symbols are delisted):
```
Deleted X strategies for Y delisted symbols: SYMBOL1, SYMBOL2, ...
```

### 3. Verify symbol counts

```sql
SELECT 
  exchange,
  COUNT(*) as total_symbols,
  MAX(updated_at) as last_update
FROM symbol_filters
GROUP BY exchange;
```

---

## Recommendations

### Immediate Actions

1. ✅ **Strategy cleanup logic added** - will run on next symbol update
2. ⚠️ **MEXC API issue** - needs investigation
3. ✅ **Binance working** - no action needed

### Long-term Improvements

1. **Add retry logic for MEXC:**
   - Exponential backoff
   - Alternative endpoints
   - Better error handling

2. **Add monitoring:**
   - Alert when symbol update fails
   - Track update success rate
   - Monitor delisted symbols

3. **Add manual trigger:**
   - API endpoint to force symbol update
   - Script to manually sync symbols

---

## Conclusion

**Status:** ✅ PARTIALLY WORKING

- **Binance:** Working perfectly (updates every 15 min)
- **MEXC:** Failing (API errors, needs fix)
- **Strategy Cleanup:** ✅ Added (will work on next successful update)

**Action Required:**
1. Update CCXT library: `npm update ccxt`
2. Monitor MEXC API status
3. Consider alternative MEXC endpoints

---

**Report Generated:** 2025-12-22 18:43 UTC+7  
**Binance Status:** ✅ WORKING  
**MEXC Status:** ❌ NEEDS FIX  
**Strategy Cleanup:** ✅ IMPLEMENTED

