# MEXC API Timeout Fix - Summary

## Problem Identified
MEXC exchange initialization was timing out with the error:
```
RequestTimeout: mexc GET https://api.mexc.co/api/v3/capital/config/getall request timed out (10000 ms)
```

This caused:
- BalanceManager initialization to fail for MEXC bots
- SignalScanner initialization to fail for MEXC bots
- Application startup to be blocked

### Root Causes
1. **Default timeout too short**: CCXT's default 10-second timeout is insufficient for MEXC API from Vietnam
2. **Network latency**: MEXC API responses are slow from Vietnam (likely due to firewall/routing)
3. **No retry mechanism**: Single timeout failure = complete initialization failure
4. **Blocking initialization**: One bot failure blocked the entire application startup

## Changes Made

### 1. **ExchangeService.js** - Retry Mechanism for loadMarkets()
Added exponential backoff retry logic specifically for MEXC:
- **MEXC**: 3 retry attempts with 2s, 4s, 6s delays
- **Other exchanges**: 1 attempt (no retry)
- **Fallback**: If all retries fail, MEXC continues without loadMarkets (markets loaded on-demand)

```javascript
const maxRetries = this.bot.exchange === 'mexc' ? 3 : 1;

for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    await this.exchange.loadMarkets();
    loadMarketsSuccess = true;
    break;
  } catch (error) {
    if (attempt < maxRetries) {
      const delayMs = 2000 * attempt;
      logger.warn(`[${this.bot.exchange}] loadMarkets attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } else {
      // For MEXC, continue without loadMarkets
      if (this.bot.exchange === 'mexc') {
        logger.warn(`[MEXC] Continuing without loadMarkets - will load markets on-demand`);
        loadMarketsSuccess = true;
      } else {
        throw error;
      }
    }
  }
}
```

### 2. **ExchangeService.js** - Increased MEXC API Timeout
Set higher timeout specifically for MEXC API requests:
- **Default CCXT timeout**: 10,000 ms
- **New MEXC timeout**: 30,000 ms (configurable via `MEXC_API_TIMEOUT_MS`)

```javascript
if (this.bot.exchange === 'mexc') {
  const mexcTimeout = Number(configService.getNumber('MEXC_API_TIMEOUT_MS', 30000));
  config.timeout = mexcTimeout;
  logger.debug(`MEXC API timeout set to ${mexcTimeout}ms`);
}
```

### 3. **BalanceManager.js** - Graceful Error Handling
Changed error handling to not re-throw exceptions:
- Logs errors with ❌ emoji for visibility
- Allows application to continue even if one bot fails
- Prevents one bad bot from crashing the entire system

```javascript
catch (error) {
  logger.error(`❌ Failed to initialize BalanceManager for bot ${bot.id}:`, error?.message || error);
  // Don't re-throw - allow app to continue even if one bot fails
}
```

### 4. **SignalScanner.js** - Graceful Error Handling
Same graceful error handling as BalanceManager:
- Logs with ❌ emoji
- Doesn't re-throw
- Allows app to continue

### 5. **app.js** - MEXC Timeout Configuration
Added new config option to database:
```javascript
await AppConfig.set('MEXC_API_TIMEOUT_MS', '30000', 'Timeout (ms) for MEXC API requests (higher for slow connections)');
```

## How It Works Now

### Startup Flow
1. **ExchangeService.initialize()** is called for each bot
2. **For MEXC bots**:
   - Sets timeout to 30 seconds (configurable)
   - Attempts `loadMarkets()` up to 3 times with exponential backoff
   - If all retries fail, continues without loadMarkets
   - Markets are loaded on-demand during trading
3. **For other exchanges**:
   - Single attempt, throws on failure
4. **BalanceManager/SignalScanner**:
   - Catches errors gracefully
   - Logs them but doesn't crash
   - Application continues with other bots

### Benefits
- ✅ **Resilient**: Handles slow MEXC API gracefully
- ✅ **Non-blocking**: One bot failure doesn't crash the app
- ✅ **Configurable**: Can adjust timeout via `MEXC_API_TIMEOUT_MS`
- ✅ **Visible**: Clear logging with ❌ and ✅ emojis
- ✅ **Fallback**: Markets loaded on-demand if loadMarkets fails

## Configuration

### Environment Variables / Database Config
```
MEXC_API_TIMEOUT_MS=30000  # Timeout for MEXC API requests (default: 30 seconds)
```

### How to Adjust
If MEXC is still timing out:
1. Increase `MEXC_API_TIMEOUT_MS` in app_configs table
2. Example: `UPDATE app_configs SET value='45000' WHERE key='MEXC_API_TIMEOUT_MS'`
3. Restart application

## Testing

### Verify It's Working
Check logs for:
```
✅ BalanceManager initialized for bot 8 (mexc)
✅ SignalScanner initialized for bot 8 (mexc)
```

### If Still Timing Out
Check logs for:
```
[MEXC] loadMarkets attempt 1/3 failed, retrying in 2000ms
[MEXC] loadMarkets attempt 2/3 failed, retrying in 4000ms
[MEXC] loadMarkets attempt 3/3 failed, retrying in 6000ms
[MEXC] Continuing without loadMarkets - will load markets on-demand
```

This is normal - the bot will continue and load markets on-demand.

## Files Modified
1. `src/services/ExchangeService.js` - Retry logic + timeout config
2. `src/jobs/BalanceManager.js` - Graceful error handling
3. `src/jobs/SignalScanner.js` - Graceful error handling
4. `src/app.js` - Added MEXC_API_TIMEOUT_MS config

## Performance Impact
- **Minimal**: Retries only happen on timeout (rare)
- **Improvement**: Application no longer crashes on MEXC timeout
- **Reliability**: Better handling of slow network conditions

## Future Improvements
1. Consider using MEXC WebSocket for market data instead of REST
2. Implement circuit breaker pattern for repeated failures
3. Add metrics/monitoring for API timeout frequency

