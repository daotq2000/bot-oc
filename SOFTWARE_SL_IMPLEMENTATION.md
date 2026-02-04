# Software Stop Loss Implementation Summary

## Problem
Binance Testnet does not support conditional orders (`STOP_MARKET`, `STOP`, `TAKE_PROFIT_MARKET`, `TAKE_PROFIT`) - all return error `-4120: "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead."`

This means positions on testnet cannot have exchange-level stop loss protection.

## Solution
Implemented software-based stop loss monitoring that:
1. Monitors position prices via WebSocket (or REST fallback)
2. When price hits SL level, places a MARKET order to close the position
3. Provides the same protection as exchange-level SL orders

## Implementation Details

### 1. New Service: `SoftwareStopLossService.js`
Location: `/src/services/SoftwareStopLossService.js`

Features:
- `checkAndTriggerSL(position)`: Checks if SL is breached and triggers close
- `_isSLBreached(side, currentPrice, slPrice)`: Determines if SL condition is met
- `_closePositionMarket(position)`: Places MARKET close order
- Throttling to prevent excessive checks (configurable via `SOFTWARE_SL_CHECK_INTERVAL_MS`)
- Deduplication to prevent duplicate closes (`_triggeredPositions` Set)

### 2. Database Migration
File: `/migrations/20260203000000-add-use-software-sl-to-positions.cjs`

Added `use_software_sl` column to `positions` table:
- Type: BOOLEAN
- Default: false
- When true, position uses software SL instead of exchange SL order

### 3. PositionMonitor Integration
File: `/src/jobs/PositionMonitor.js`

Changes:
- Import `getSoftwareStopLossService`
- Added `softwareSLServices` Map to store service instances per bot
- Added `_checkSoftwareStopLossPositions()` method
- Called in `monitorAllPositions()` after processing all positions

### 4. BinanceDirectClient Changes
File: `/src/services/BinanceDirectClient.js`

The `createSlLimitOrder()` method already:
- Tries `STOP_MARKET` first (works on mainnet)
- Falls back to `STOP` type on -4120 error
- Returns `null` if all conditional orders fail (CRITICAL: does NOT use LIMIT for SL!)

### 5. TP/SL Placement Logic
File: `/src/jobs/PositionMonitor.js` - `_placeTpSlForPosition()`

When `createStopLossLimit()` returns `null`:
1. Sets `use_software_sl = true` in database
2. Clears `tp_sl_pending` flag
3. Logs that position is using software SL

## Order Type Behavior

### On Mainnet (binance_testnet = false)
- `STOP_MARKET` works normally
- Exchange-level SL protection
- Software SL is only fallback if exchange orders fail

### On Testnet (binance_testnet = true)
- `STOP_MARKET` fails with -4120
- `STOP` fails with -4120
- Software SL is automatically enabled
- SL protection via MARKET order when price hits level

## Why LIMIT Orders Cannot Be Used as Stop Loss

LIMIT orders have the OPPOSITE behavior of what SL needs:
- **LIMIT BUY**: Fills when market price ≤ limit price
- **LIMIT SELL**: Fills when market price ≥ limit price

For a LONG position with SL below current price:
- A LIMIT SELL at SL price would NOT fill until price drops to SL
- But by then, you want to SELL, not wait for a limit fill!

For a SHORT position with SL above current price:
- A LIMIT BUY at SL price would fill IMMEDIATELY (current < SL)
- This is NOT stop loss behavior!

## Testing

### Test Scripts
1. `test_software_sl.js`: Verify integration
2. `test_sl_creation.js`: Test SL order creation and fallback
3. `enable_software_sl.js`: Batch enable software SL for existing positions

### Test Results (Feb 4, 2026)
```
Using testnet bot: ID=3
STOP_MARKET failed with -4120
STOP failed with -4120
SL order returned null (expected on testnet)
Enabled software SL for position 54
Verified: use_software_sl = 1
```

## Configuration

| Config Key | Default | Description |
|------------|---------|-------------|
| `SOFTWARE_SL_ENABLED` | true | Enable/disable software SL |
| `SOFTWARE_SL_CHECK_INTERVAL_MS` | 500 | Minimum interval between checks |

## Monitoring

Look for these log patterns:
- `[SoftwareSL]` - Software SL service logs
- `use_software_sl: 1` - Position using software SL
- `SL TRIGGERED` - When software SL closes a position

## Summary

✅ Testnet positions now have stop loss protection via software monitoring
✅ Mainnet positions still use exchange-level SL orders (preferred)
✅ Automatic fallback when exchange orders fail
✅ No dangerous LIMIT orders for SL
