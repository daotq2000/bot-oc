# Verification Checklist

## Pre-Deployment
- [ ] All code changes reviewed
- [ ] No syntax errors in modified files
- [ ] Database migrations applied (if any)
- [ ] Backup created

## Post-Deployment

### Application Startup
- [ ] Application starts without errors
- [ ] No crash on bot initialization
- [ ] All services initialized successfully

### Binance WebSocket
- [ ] Log shows: `[Binance-WS] Initializing Binance WebSocket manager...`
- [ ] Log shows: `[Binance-WS] Connecting to wss://fstream.binance.com/stream?streams=...`
- [ ] Log shows: `[Binance-WS] ✅ Connected successfully`
- [ ] Log shows: `[Binance-WS] Status: X/Y connections open, Z total streams`
- [ ] WebSocket status shows active connections

### Binance Signal Detection
- [ ] Log shows: `[SignalScanner] Subscribing Binance WS to N symbols`
- [ ] Log shows: `[Signal] Strategy X (SYMBOL): Candle OPEN - OC=X.XX%`
- [ ] NO log showing: `Price for SYMBOL not available in cache`
- [ ] Binance strategies are detecting signals

### MEXC Initialization
- [ ] Log shows: `✅ BalanceManager initialized for bot X (mexc)`
- [ ] Log shows: `✅ SignalScanner initialized for bot X (mexc)`
- [ ] MEXC bots are initialized successfully
- [ ] No timeout errors in logs

### MEXC Signal Detection
- [ ] Log shows: `[SignalScanner] Subscribing MEXC WS to N symbols`
- [ ] MEXC strategies are detecting signals
- [ ] MEXC WebSocket is connected

### Error Handling
- [ ] If one bot fails, others continue
- [ ] Error logs show ❌ emoji
- [ ] Success logs show ✅ emoji
- [ ] Application doesn't crash on bot failure

### Configuration
- [ ] `MEXC_API_TIMEOUT_MS` config exists in database
- [ ] Default value is 30000 (30 seconds)
- [ ] Can be updated without restart (if needed)

## Functional Tests

### Binance Trading
- [ ] Create test strategy on Binance
- [ ] Monitor for signal detection
- [ ] Verify signal is detected in real-time
- [ ] Verify trade is placed

### MEXC Trading
- [ ] Create test strategy on MEXC
- [ ] Monitor for signal detection
- [ ] Verify signal is detected
- [ ] Verify trade is placed

### Responsiveness Comparison
- [ ] Binance detection speed ≈ MEXC detection speed
- [ ] Both exchanges respond similarly to price changes
- [ ] No significant lag in either exchange

## Performance Metrics

### WebSocket
- [ ] Connection established within 2 seconds
- [ ] Symbols subscribed within 5 seconds
- [ ] Price updates flowing in real-time
- [ ] No connection drops

### API Calls
- [ ] MEXC loadMarkets succeeds on first try (if network good)
- [ ] MEXC loadMarkets retries if timeout (if network slow)
- [ ] No excessive API calls
- [ ] Rate limits not exceeded

### Memory
- [ ] Memory usage stable
- [ ] No memory leaks
- [ ] WebSocket connections don't leak memory

## Logging Quality

### Binance Logs
- [ ] Clear connection status
- [ ] Shows which symbols are subscribed
- [ ] Shows price availability
- [ ] Shows signal detection

### MEXC Logs
- [ ] Clear initialization status
- [ ] Shows retry attempts if timeout
- [ ] Shows graceful fallback
- [ ] Shows signal detection

### Error Logs
- [ ] Errors are clear and actionable
- [ ] Stack traces are present
- [ ] Error messages are descriptive
- [ ] No spam or duplicate errors

## Rollback Plan (if needed)

If issues occur:
1. [ ] Identify the problem from logs
2. [ ] Check if it's a configuration issue
3. [ ] Try increasing timeouts first
4. [ ] If still failing, rollback to previous version
5. [ ] Investigate root cause

## Sign-Off

- [ ] All checks passed
- [ ] Ready for production
- [ ] Monitoring enabled
- [ ] Alert thresholds set

---

## Quick Verification Command

```bash
# Check for successful initialization
grep -E "✅|Connected successfully" logs/error.log | tail -20

# Check for WebSocket status
grep "Binance-WS.*Status" logs/error.log | tail -5

# Check for signal detection
grep "Signal.*Candle OPEN" logs/error.log | tail -10

# Check for errors
grep "❌" logs/error.log | tail -10
```

---

**All checks passed? You're good to go!** ✅

