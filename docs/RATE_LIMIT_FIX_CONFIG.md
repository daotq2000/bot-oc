# Rate Limit Fix Configuration

## 📋 Summary

This document describes the configuration values for the **CRITICAL FIX** that prevents Binance API rate limiting and IP bans.

### Problem Fixed
- **541 symbols** being tracked with **1082 WebSocket streams**
- WebSocket failures causing massive REST API fallback spam (hundreds of requests/second)
- Binance IP ban: "Way too many requests; IP banned until..."
- `/fapi/v1/klines` endpoint being hammered by `RealtimeOCDetector` and `IndicatorWarmup`

### Solution Implemented
1. ✅ **Disabled aggressive REST API fallback** in `RealtimeOCDetector` (can be re-enabled with proper safeguards)
2. ✅ **Integrated BinanceRequestScheduler** for market data requests
3. ✅ **Added circuit breaker** and rate limit blocking checks
4. ✅ **Increased rate limiting intervals** (200ms → 500ms for market data)
5. ✅ **Centralized rate limit handling** across all Binance API clients

---

## 🔧 Configuration Values

### Core Rate Limiting

| Config Key | Default | Description |
|-----------|---------|-------------|
| `BINANCE_USE_SCHEDULER_FOR_MARKET_DATA` | `true` | Use centralized request scheduler for market data (RECOMMENDED) |
| `BINANCE_MARKET_DATA_MIN_INTERVAL_MS` | `500` | Min interval between market data requests (increased from 200ms) |
| `BINANCE_MARKET_DATA_TIMEOUT_MS` | `20000` | Timeout for market data requests (20s) |
| `BINANCE_MIN_REQUEST_INTERVAL_MS` | `100` | Min interval for general requests |
| `BINANCE_REQUEST_INTERVAL_MS` | `125` | Request interval for scheduler (~8 req/sec) |
| `BINANCE_SIGNED_REQUEST_INTERVAL_MS` | `150` | Request interval for signed requests (~6.6 req/sec) |

### Rate Limit Blocking (429 Handling)

| Config Key | Default | Description |
|-----------|---------|-------------|
| `BINANCE_RATE_LIMIT_BLOCK_DURATION_MS` | `10000` | Block all requests for 10s when 429 detected |
| `BINANCE_REST_PRICE_COOLDOWN_MS` | `10000` | Cooldown for price REST fallback (increased from 5s) |

### Circuit Breaker

| Config Key | Default | Description |
|-----------|---------|-------------|
| `BINANCE_CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before opening circuit breaker |
| `BINANCE_CIRCUIT_BREAKER_TIMEOUT_MS` | `60000` | Cooldown period when circuit breaker opens (1 minute) |
| `BINANCE_CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | `2` | Successes needed to close circuit breaker |

### Request Scheduler

| Config Key | Default | Description |
|-----------|---------|-------------|
| `BINANCE_SCHED_MAINNET_BURST` | `5` | Process N mainnet requests before 1 testnet request |
| `BINANCE_SCHED_MAX_QUEUE` | `5000` | Max queue size before dropping requests |
| `BINANCE_SCHED_STATS_ENABLED` | `true` | Enable scheduler stats logging |
| `BINANCE_SCHED_STATS_INTERVAL_MS` | `10000` | Stats logging interval (10s) |

### RealtimeOCDetector - REST Fallback (DISABLED by default)

| Config Key | Default | Description |
|-----------|---------|-------------|
| `OC_REST_FALLBACK_ENABLED` | `false` | ⚠️ Enable REST API fallback for candle opens (NOT RECOMMENDED) |
| `OC_REST_FETCH_DELAY_MS` | `30` | Delay between REST fetch queue processing |
| `OC_REST_FETCH_MAX_QUEUE` | `300` | Max REST fetch queue size |
| `OC_REST_FETCH_CONCURRENT` | `2` | Concurrent REST fetches |
| `OC_REST_OPEN_FAIL_TTL_MS` | `4000` | TTL for failed open price cache |

### IndicatorWarmup - Klines Fetching

| Config Key | Default | Description |
|-----------|---------|-------------|
| `INDICATOR_WARMUP_USE_LEGACY_FETCH` | `false` | Use legacy direct fetch instead of BinanceDirectClient (NOT RECOMMENDED) |
| `INDICATORS_WARMUP_FAST_MODE` | `false` | Enable fast warmup mode (higher RPM) |
| `INDICATORS_WARMUP_MAX_REQUESTS_PER_MINUTE` | `400` | Max requests per minute (900 in fast mode) |
| `INDICATORS_WARMUP_BATCH_DELAY_MS` | `5000` | Delay between warmup batches (200ms in fast mode) |
| `INDICATORS_WARMUP_429_RETRY_DELAY_MS` | `10000` | Initial delay after 429 (10s) |
| `INDICATORS_WARMUP_429_BACKOFF_MULTIPLIER` | `1.5` | Exponential backoff multiplier for 429 retries |

### Price Ticker Fallback

| Config Key | Default | Description |
|-----------|---------|-------------|
| `BINANCE_TICKER_REST_FALLBACK` | `false` | ⚠️ Enable REST fallback for ticker price (can cause rate limits if WebSocket fails) |

---

## 🚨 Critical Recommendations

### DO NOT Enable These Unless Absolutely Necessary:
1. ❌ `OC_REST_FALLBACK_ENABLED=true` - This was the main cause of rate limit issues
2. ❌ `BINANCE_TICKER_REST_FALLBACK=true` - Only enable if WebSocket is confirmed stable
3. ❌ `INDICATOR_WARMUP_USE_LEGACY_FETCH=true` - Legacy mode bypasses rate limit protection

### DO Enable/Configure:
1. ✅ `BINANCE_USE_SCHEDULER_FOR_MARKET_DATA=true` (default) - Always use scheduler
2. ✅ Monitor `BINANCE_SCHED_STATS_ENABLED=true` to see request patterns
3. ✅ Increase `BINANCE_RATE_LIMIT_BLOCK_DURATION_MS` if still getting rate limited (e.g., 30000ms)
4. ✅ Fix WebSocket connections to avoid REST API dependency

---

## 📊 Monitoring

### Check BinanceRequestScheduler Stats
Logs appear every 10 seconds when `BINANCE_SCHED_STATS_ENABLED=true`:

```
[BinanceScheduler] qMain=0 qTest=0 processed=1234 (main=1200, test=34) signed=450 unsigned=784 sampleMs=10000
```

**What to watch:**
- `qMain` / `qTest` should stay low (<100) - high values indicate backpressure
- `processed` should grow steadily without rate limit errors
- If you see `BINANCE_SCHED_QUEUE_OVERFLOW_*` errors, increase `BINANCE_SCHED_MAX_QUEUE`

### Check Rate Limit Blocks
Look for these error messages:

```
[Binance-RateLimit] 🚫 RATE LIMIT (429) DETECTED! Blocking ALL requests for 10000ms until 2026-01-18T08:20:56.007Z
[Binance-RateLimit] 🧪 Testing connection after rate limit block...
[Binance-RateLimit] ✅ Connection test passed! Rate limit cleared. Resuming requests.
```

**If you see frequent rate limit blocks:**
1. Check if WebSocket connections are stable (all should be `connected: true`)
2. Increase `BINANCE_RATE_LIMIT_BLOCK_DURATION_MS` to 30000ms or higher
3. Decrease `INDICATORS_WARMUP_MAX_REQUESTS_PER_MINUTE` to 200-300
4. Ensure `OC_REST_FALLBACK_ENABLED=false` (default)

### Check Circuit Breaker
```
[Binance] Circuit breaker: Moving to HALF_OPEN state
[Binance] Circuit breaker: Too many failures, opening circuit
```

**If circuit breaker opens frequently:**
- Indicates persistent API failures (network issues, Binance downtime)
- Increase `BINANCE_CIRCUIT_BREAKER_TIMEOUT_MS` for longer cooldown
- Check network connectivity and Binance status

---

## 🔍 Troubleshooting

### Still Getting Rate Limited?

1. **Check WebSocket Status**
   ```javascript
   // In logs, search for:
   [PriceAlertWorker] ❌ Binance WebSocket failed to connect after 3 attempts
   ```
   - If WebSocket connections are failing, fix them first
   - All connections should show `connected: true` in status

2. **Verify Config**
   ```sql
   SELECT * FROM configs WHERE key LIKE 'BINANCE_%' OR key LIKE 'OC_%' OR key LIKE 'INDICATOR_%';
   ```
   - Ensure no aggressive values are set
   - Verify scheduler is enabled

3. **Check Request Patterns**
   - Look for repeated requests to same endpoint/symbol
   - Check for retry loops (errors causing immediate retries)

4. **Reduce Tracked Symbols**
   - 541 symbols with 1082 streams is very high
   - Consider prioritizing important symbols only
   - Use `INDICATORS_WARMUP_PRIORITY_SYMBOLS` to warm up critical symbols first

### Emergency: Already IP Banned?

If you're already banned, Binance shows:
```
"Way too many requests; IP(171.236.58.85) banned until 1768725416206. Please use the websocket for live updates to avoid bans."
```

**Recovery steps:**
1. **Stop the bot immediately**
2. Wait until the ban expires (timestamp is in milliseconds)
3. **Before restarting:**
   - Set `OC_REST_FALLBACK_ENABLED=false` (if not already)
   - Set `BINANCE_RATE_LIMIT_BLOCK_DURATION_MS=30000` (30 seconds)
   - Set `INDICATORS_WARMUP_MAX_REQUESTS_PER_MINUTE=200` (very conservative)
   - Verify WebSocket connections are working
4. Restart bot and monitor closely

---

## 📝 Example Configuration (Safe Defaults)

```bash
# Core Rate Limiting
BINANCE_USE_SCHEDULER_FOR_MARKET_DATA=true
BINANCE_MARKET_DATA_MIN_INTERVAL_MS=500
BINANCE_MIN_REQUEST_INTERVAL_MS=100

# Rate Limit Blocking
BINANCE_RATE_LIMIT_BLOCK_DURATION_MS=10000

# Circuit Breaker
BINANCE_CIRCUIT_BREAKER_THRESHOLD=5
BINANCE_CIRCUIT_BREAKER_TIMEOUT_MS=60000

# Request Scheduler
BINANCE_SCHED_MAX_QUEUE=5000
BINANCE_SCHED_STATS_ENABLED=true

# RealtimeOCDetector (DISABLED)
OC_REST_FALLBACK_ENABLED=false

# IndicatorWarmup (Conservative)
INDICATOR_WARMUP_USE_LEGACY_FETCH=false
INDICATORS_WARMUP_MAX_REQUESTS_PER_MINUTE=400
INDICATORS_WARMUP_BATCH_DELAY_MS=5000

# Price Ticker (DISABLED unless WebSocket stable)
BINANCE_TICKER_REST_FALLBACK=false
```

---

## ✅ Success Indicators

You've successfully fixed rate limiting when you see:

1. ✅ No more `Rate limit (429)` errors in logs
2. ✅ No more `IP banned until...` errors
3. ✅ BinanceScheduler stats show steady progress without queue buildup
4. ✅ WebSocket connections remain stable (`connected: true`)
5. ✅ Market data requests complete successfully without timeouts

---

## 📚 Related Files Modified

1. `/src/services/RealtimeOCDetector.js` - Disabled aggressive REST fallback
2. `/src/services/BinanceDirectClient.js` - Added scheduler integration, circuit breaker checks
3. `/src/indicators/IndicatorWarmup.js` - Switched to BinanceDirectClient for centralized rate limiting
4. `/src/services/BinanceRequestScheduler.js` - Already existed, now properly utilized

---

## 🎯 Next Steps (Optional Improvements)

1. **Fix WebSocket Stability**
   - Investigate why 22 connections are all `connected: false`
   - Ensure proper reconnection logic
   - Monitor `timeSinceLastWsMessage` and `timeSinceLastPong`

2. **Reduce Symbol Count**
   - 541 symbols is very high for tracking
   - Consider filtering to only active/liquid symbols
   - Use priority-based warmup for important symbols

3. **Add Metrics Dashboard**
   - Track request rates per endpoint
   - Monitor queue sizes over time
   - Alert on rate limit blocks

4. **Optimize Candle Data Caching**
   - Cache candle opens more aggressively (5-15 minutes)
   - Use Redis for distributed caching
   - Pre-fetch candles at bucket boundaries

---

**Last Updated:** 2026-01-18  
**Version:** 1.0.0  
**Status:** ✅ Production Ready

