# TP/SL Order Fix Summary

## Problem

Binance Futures Testnet (and potentially mainnet) returns error `-4120: Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.` for all conditional order types:
- `TAKE_PROFIT`
- `TAKE_PROFIT_MARKET`
- `STOP_MARKET`
- `STOP`
- `TRAILING_STOP_MARKET`

This caused all TP/SL orders to fail with `response=null`.

## Root Cause

Binance has deprecated conditional orders on the standard `/fapi/v1/order` endpoint and moved them to new Algo Order API endpoints. However, the Binance Testnet does not seem to support these new endpoints.

## Solution

### For Take Profit (TP) Orders

**Changed `createTpLimitOrder()` in `BinanceDirectClient.js`:**

1. First attempts `TAKE_PROFIT` order type (for production compatibility)
2. On error `-4120`, **immediately falls back to plain `LIMIT` order**
3. LIMIT orders work because:
   - For LONG positions: SELL LIMIT at price > current price will wait until price rises
   - For SHORT positions: BUY LIMIT at price < current price will wait until price falls
   - This achieves the same TP behavior

**Code change:**
```javascript
// When -4120 error detected, skip all conditional types and use LIMIT directly
if (errorCode === -4120 || errorMsg.includes('-4120') || ...) {
  const limitParams = {
    symbol: normalizedSymbol,
    side: orderSide,
    type: 'LIMIT',
    price: stopPriceStr,
    quantity: ...,
    timeInForce: 'GTC'
  };
  // Place LIMIT order
}
```

### For Stop Loss (SL) Orders

**`createSlLimitOrder()` already handles this correctly:**

1. First attempts `STOP_MARKET` order type
2. On error `-4120`, attempts `STOP` (stop-limit) order type
3. **Does NOT use LIMIT order** because LIMIT cannot work as SL:
   - LIMIT BUY fills when price <= limit price (would fill immediately if SL > current for SHORT)
   - LIMIT SELL fills when price >= limit price (would fill immediately if SL < current for LONG)
4. Returns `null` when all conditional types fail

**For SL protection without exchange-level orders:**
- `PositionMonitor` should monitor price via WebSocket
- When price hits SL level, place MARKET order to close position
- This is software-based SL protection

## Test Results

On Binance Testnet:

| Order Type | Before Fix | After Fix |
|------------|------------|-----------|
| `createTpLimitOrder()` | ❌ Failed (null) | ✅ Works (LIMIT fallback) |
| `createSlLimitOrder()` | ❌ Failed (null) | ⚠️ Returns null (expected) |

## Test Scripts Created

1. **`test_tp_sl_types.js`** - Tests all order types to discover supported/unsupported types
2. **`test_tp_sl_with_position.js`** - Opens real position and tests TP/SL orders
3. **`test_tp_sl_service.js`** - Tests the `createTpLimitOrder()` and `createSlLimitOrder()` methods

## Recommendations

### For Testnet
- TP orders now work using LIMIT fallback
- SL must be handled by software-based monitoring (PositionMonitor)

### For Production (Mainnet)
- The fix is backward compatible
- If mainnet supports conditional orders, they will be used
- If not, LIMIT fallback will work for TP
- SL should ideally work on mainnet, but if not, software monitoring is the fallback

### Future Improvements
1. Implement proper Algo Order API support if Binance fully migrates to it
2. Add configuration to prefer LIMIT orders directly (skip conditional attempts)
3. Enhance PositionMonitor with more robust SL monitoring
