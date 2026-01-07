# MEXC Exchange Implementation Guide

## 📋 Overview

MEXC exchange support has been successfully implemented into the bot system. The implementation follows the existing architecture and maintains compatibility with Binance and Gate.io exchanges.

## [object Object] Layer Strategy

The system uses a **hybrid approach**:

1. **Binance**: Direct HTTP API client (`BinanceDirectClient`) - for optimal performance
2. **MEXC & Gate.io**: CCXT wrapper - for simplicity and maintainability

### Key Design Decisions

- **CCXT Integration**: MEXC uses CCXT library for all operations
- **Unified Interface**: All exchanges implement the same interface through `ExchangeService`
- **Exchange-Specific Normalization**: Each exchange's response format is normalized to a common structure

## 📝 Implementation Details

### Phase 1: Research & Analysis ✅

**Completed:**
- Analyzed MEXC API structure and CCXT wrapper
- Identified key differences from Binance
- Documented MEXC-specific requirements

### Phase 2: Code Changes ✅

#### 2.1 Constants Update
**File**: `src/config/constants.js`
- Added `BINANCE: 'binance'` to `EXCHANGES` constant
- Ensures consistent exchange identification

#### 2.2 ExchangeService Enhancements
**File**: `src/services/ExchangeService.js`

**Changes:**
1. **Initialization**
   - Added MEXC UID configuration support
   - Set `defaultType: 'swap'` for MEXC futures trading
   - Added debug logging for MEXC-specific setup

2. **Balance Handling**
   - Normalized MEXC balance response format
   - Handles both `USDT` and `USDT_SWAP`/`USDT_SPOT` fields
   - Fallback logic for different balance structures

3. **Order Creation**
   - Added MEXC-specific error messages to soft error list
   - Handles MEXC precision errors gracefully
   - Supports fallback to market orders when limit orders fail

4. **Position Closing**
   - Added MEXC error handling for position closure
   - Handles "Position does not exist" errors
   - Graceful handling of race conditions

5. **Transfers**
   - MEXC transfer: `spot ↔ swap` (futures)
   - Binance transfer: `spot ↔ future`
   - Gate.io transfer: `spot ↔ future`

6. **Position Fetching**
   - Normalized MEXC position format to match Binance
   - Handles both `contracts` and `positionAmt` fields
   - Filters out closed/zero positions

#### 2.3 OrderService Error Handling
**File**: `src/services/OrderService.js`

**Changes:**
- Added MEXC price trigger error handling
- Supports fallback to market orders for:
  - "Order price is too high"
  - "Order price is too low"
  - "Invalid order price"
- Maintains existing Binance error handling

#### 2.4 PositionService Documentation
**File**: `src/services/PositionService.js`

**Changes:**
- Added comments explaining exchange-specific logic
- Documented how different exchanges handle position closure
- MEXC: Uses CCXT market order
- Binance: Uses direct API with reduce-only flag

#### 2.5 CandleService Format Normalization
**File**: `src/services/CandleService.js`

**Changes:**
- Added support for MEXC object-format candles
- Handles both array and object formats
- Normalizes field names: `o/h/l/c/v` → `open/high/low/close/volume`
- Supports `t` field for timestamp (MEXC alternative)

#### 2.6 BalanceManager
**File**: `src/jobs/BalanceManager.js`

**Status**: No changes needed
- Balance normalization handled in `ExchangeService.getBalance()`
- Transfer logic already supports MEXC through exchange-specific handling

## 🔧 MEXC-Specific Configuration

### Environment Variables

```env
# MEXC Sandbox Mode (optional)
MEXC_SANDBOX=false

# MEXC UID (optional, but recommended for better API performance)
# Set in bot configuration via database
```

### Bot Configuration

When creating a MEXC bot, provide:

```javascript
{
  bot_name: "MEXC Bot 1",
  exchange: "mexc",
  uid: "your_mexc_uid",  // Optional but recommended
  access_key: "your_api_key",
  secret_key: "your_secret_key",
  // ... other bot config
}
```

## 📊 MEXC API Differences

### Transfer Endpoints
- **MEXC**: `spot` ↔ `swap` (futures)
- **Binance**: `spot` ↔ `future`

### Balance Structure
- **Standard**: `USDT` field with `free`, `used`, `total`
- **MEXC Alternative**: `USDT_SWAP` or `USDT_SPOT` (handled by normalization)

### Position Format
- **Standard**: `contracts` field
- **MEXC Alternative**: `positionAmt` field (normalized to `contracts`)

### Error Messages
- "Invalid symbol" - Invalid trading pair
- "Insufficient balance" - Not enough balance
- "Order quantity is too small" - Below minimum notional
- "Price precision error" - Price precision issue
- "Quantity precision error" - Quantity precision issue
- "Order price is too high/low" - Price out of range

### Candle Format
- **Array**: `[timestamp, open, high, low, close, volume]` (standard CCXT)
- **Object**: `{t, o, h, l, c, v, ...}` (MEXC alternative)

## 🧪 Testing Checklist

### Unit Tests
- [ ] MEXC balance normalization
- [ ] MEXC position format normalization
- [ ] MEXC error handling in order creation
- [ ] MEXC candle format conversion
- [ ] MEXC transfer logic

### Integration Tests
- [ ] Create order on MEXC
- [ ] Close position on MEXC
- [ ] Fetch positions from MEXC
- [ ] Transfer spot to futures
- [ ] Transfer futures to spot
- [ ] Fetch candles from MEXC

### Paper Trading
- [ ] Test on MEXC sandbox (if available)
- [ ] Verify order execution
- [ ] Verify position tracking
- [ ] Verify balance management

### Live Trading
- [ ] Small amount testing
- [ ] Monitor for errors
- [ ] Verify PnL calculations
- [ ] Verify transfer operations

## 🚀 Deployment Steps

1. **Database Migration** (if needed)
   - No schema changes required
   - Existing `bots` table supports MEXC

2. **Environment Setup**
   - Set `MEXC_SANDBOX=false` for production
   - Configure MEXC API credentials

3. **Bot Creation**
   - Create bot with `exchange: 'mexc'`
   - Provide API key, secret, and UID

4. **Strategy Configuration**
   - Use existing strategy format
   - MEXC supports same symbols as Binance

5. **Monitoring**
   - Monitor logs for MEXC-specific errors
   - Track balance transfers
   - Monitor position lifecycle

## 📈 Performance Considerations

### CCXT Overhead
- MEXC uses CCXT wrapper (not direct API like Binance)
- Slightly higher latency than Binance
- Trade-off: Simplicity vs. Performance

### Rate Limiting
- MEXC has rate limits (check MEXC API docs)
- CCXT has built-in rate limiting (`enableRateLimit: true`)
- Sequential bot processing in BalanceManager prevents rate limit issues

### Caching
- Exchange info cached in `ExchangeInfoService`
- Reduces API calls for symbol metadata
- Fallback to REST API if cache miss

## [object Object]

### Common Issues

**Issue**: "Invalid symbol" error
- **Cause**: Symbol not available on MEXC
- **Solution**: Verify symbol is tradable on MEXC futures

**Issue**: "Insufficient balance" error
- **Cause**: Not enough balance for order
- **Solution**: Check balance and transfer more funds

**Issue**: "Order quantity is too small" error
- **Cause**: Order below minimum notional
- **Solution**: Increase order amount in strategy config

**Issue**: Position not closing
- **Cause**: Race condition or insufficient position
- **Solution**: Check if position was already closed by TP/SL

### Debug Logging

Enable debug logging for MEXC:
```javascript
// In logger configuration
logger.level = 'debug';
```

Look for:
- `MEXC UID configured`
- `MEXC configured for swap trading`
- `Order created for bot`
- `Position closed for bot`

## 📚 References

### Files Modified
1. `src/config/constants.js` - Added BINANCE constant
2. `src/services/ExchangeService.js` - MEXC integration
3. `src/services/OrderService.js` - Error handling
4. `src/services/PositionService.js` - Documentation
5. `src/services/CandleService.js` - Format normalization

### Key Classes
- `ExchangeService` - Main exchange interface
- `OrderService` - Order execution
- `PositionService` - Position management
- `CandleService` - Market data
- `BalanceManager` - Balance management

### CCXT Documentation
- [CCXT MEXC](https://docs.ccxt.com/en/latest/manual/exchanges/mexc.html)
- [CCXT Futures Trading](https://docs.ccxt.com/en/latest/manual/trading.html)

## ✅ Implementation Status

**Phase 1: Research** ✅ Complete
- MEXC API analyzed
- CCXT wrapper evaluated
- Architecture planned

**Phase 2: Implementation** ✅ Complete
- Constants updated
- ExchangeService enhanced
- OrderService updated
- PositionService documented
- CandleService normalized
- BalanceManager verified

**Phase 3: Testing** ⏳ Pending
- Unit tests needed
- Integration tests needed
- Paper trading recommended
- Live trading verification

**Phase 4: Deployment** ⏳ Pending
- Environment setup
- Bot creation
- Strategy configuration
- Monitoring setup

## 🎯 Next Steps

1. **Write Unit Tests**
   - Test MEXC-specific normalization
   - Test error handling
   - Test format conversions

2. **Integration Testing**
   - Test with MEXC sandbox (if available)
   - Verify end-to-end flows
   - Monitor for edge cases

3. **Paper Trading**
   - Test on MEXC with small amounts
   - Verify order execution
   - Monitor balance transfers

4. **Production Deployment**
   - Deploy to production
   - Monitor closely
   - Gather performance metrics

## 📞 Support

For issues or questions:
1. Check logs for error messages
2. Review this guide for troubleshooting
3. Check MEXC API documentation
4. Review CCXT documentation

---

**Last Updated**: 2025-12-05
**Status**: Implementation Complete, Testing Pending

