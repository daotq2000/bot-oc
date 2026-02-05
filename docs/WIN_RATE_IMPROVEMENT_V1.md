# Cải Thiện Bot-OC: Win Rate & Entry Filters

## Tổng Quan Thay Đổi

Ngày: 2026-02-04

### 1. Cải Thiện PositionSync (Win Rate & PnL Issues)

#### A. Thêm Retry Logic với Exponential Backoff

**File:** `src/jobs/PositionSync.js`

**Vấn đề:** Khi sync thất bại do network/API timeout, không có cơ chế retry, dẫn đến mất đồng bộ.

**Giải pháp:**
- Thêm hàm `_retryWithBackoff()` với exponential backoff
- Default: 3 lần retry với delay 2s → 4s → 8s
- Tự động retry khi fetch positions từ exchange thất bại

```javascript
// Example usage
exchangePositions = await this._retryWithBackoff(
  () => exchangeService.getOpenPositions(),
  3,    // maxRetries
  2000  // baseDelayMs
);
```

#### B. PositionSync Interval

**Status:** Đã được cấu hình là 30s (30000ms) trong `src/config/constants.js`

Có thể điều chỉnh qua environment variable:
```bash
POSITION_SYNC_INTERVAL_MS=30000
```

#### C. Verify TP/SL Orders Before Closing (Đã có)

PositionSync đã có logic verify TP/SL orders:
- Check `exit_order_id` (TP order) trước khi đóng position
- Check `sl_order_id` (SL order) trước khi đóng position
- Xác định đúng close_reason: `tp_hit`, `sl_hit`, hoặc `sync_not_on_exchange`

---

### 2. Entry Filters Mới

#### A. Market Regime Detection

**File:** `src/indicators/marketRegimeFilter.js`

**Mục đích:** Xác định thị trường đang trending hay ranging để tránh trade ngược xu hướng.

**Loại Regime:**
- `STRONG_TREND`: ADX >= 30 → Tốt cho trend-following
- `WEAK_TREND`: ADX 20-30 → Cho phép với caution
- `RANGING`: ADX < 20 → Tránh trend-following
- `VOLATILE`: ATR% quá cao → Không trade

**Config:**
```bash
# Enable/disable
MARKET_REGIME_FILTER_ENABLED=true

# ADX thresholds
REGIME_ADX_STRONG_TREND=30
REGIME_ADX_WEAK_TREND=20

# ATR% thresholds
REGIME_ATR_VOLATILE_HIGH=3.0
REGIME_ATR_QUIET_LOW=0.3

# EMA thresholds
REGIME_EMA_SLOPE_FLAT=0.0005
REGIME_EMA_SEPARATION_MIN=0.002
```

**Usage:**
```javascript
import { checkMarketRegimeGate, MARKET_REGIME } from '../indicators/marketRegimeFilter.js';

const result = checkMarketRegimeGate(indicatorState15m, currentPrice, 'FOLLOWING_TREND');
if (!result.ok) {
  console.log(`Entry blocked: ${result.reason}, regime: ${result.regime}`);
}
```

#### B. Funding Rate Filter

**File:** `src/indicators/fundingRateFilter.js`

**Mục đích:** Tránh entry vào hướng có sentiment quá extreme (funding rate cao).

**Logic:**
- Funding > +0.10%: Avoid LONG (longs paying too much, potential squeeze)
- Funding < -0.10%: Avoid SHORT (shorts paying too much, potential squeeze)
- Funding trong neutral zone: Cho phép cả 2 hướng

**Config:**
```bash
# Enable/disable
FUNDING_RATE_FILTER_ENABLED=true

# Thresholds (per 8-hour funding period)
FUNDING_EXTREME_POSITIVE=0.10   # 0.10% = 10 bps
FUNDING_EXTREME_NEGATIVE=-0.10
FUNDING_HIGH_POSITIVE=0.05
FUNDING_HIGH_NEGATIVE=-0.05

# Fail open when can't fetch
FUNDING_FAIL_OPEN=true
```

**Usage:**
```javascript
import { checkFundingRateGate } from '../indicators/fundingRateFilter.js';

const result = await checkFundingRateGate('LONG', exchangeService, 'BTCUSDT');
if (!result.ok) {
  console.log(`Entry blocked: ${result.reason}, funding: ${result.fundingRatePct}%`);
}
```

---

### 3. Tích Hợp vào WebSocketOCConsumer

**File:** `src/consumers/WebSocketOCConsumer.js`

Các filter mới được tích hợp vào flow entry:
1. Volume VMA Gate
2. Bollinger Gate
3. **Market Regime Gate (NEW)**
4. **Funding Rate Gate (NEW)**

Log output khi all filters pass:
```
✅ All filters PASSED (15m gate) | strategy=123 symbol=BTCUSDT 
  type=FOLLOWING_TREND direction=bullish | 
  CONDITIONS: EMA ✓ ADX ✓ RSI ✓ ATR% ✓ Pullback ✓ 
  RVOL ✓ Donchian ✓ VMA ✓ BB ✓ Regime=STRONG_TREND ✓ Funding=0.0050% ✓
```

---

### 4. Danh Sách File Thay Đổi

| File | Thay đổi |
|------|----------|
| `src/jobs/PositionSync.js` | Thêm `_retryWithBackoff()` method |
| `src/indicators/marketRegimeFilter.js` | **NEW** - Market Regime Detection |
| `src/indicators/fundingRateFilter.js` | **NEW** - Funding Rate Filter |
| `src/indicators/entryFilters.js` | Tích hợp và export filter mới, thêm `runAllEntryFilters()` |
| `src/consumers/WebSocketOCConsumer.js` | Tích hợp filter mới vào entry flow |

---

### 5. Cách Sử Dụng

#### Enable All Filters (recommended):
```bash
# .env
MARKET_REGIME_FILTER_ENABLED=true
FUNDING_RATE_FILTER_ENABLED=true
VOLUME_VMA_GATE_ENABLED=true
BOLLINGER_GATE_ENABLED=true
PULLBACK_CONFIRMATION_ENABLED=true
VOLATILITY_FILTER_ENABLED=true
RVOL_FILTER_ENABLED=true
```

#### Disable Specific Filter:
```bash
# Disable funding rate filter if exchange doesn't support
FUNDING_RATE_FILTER_ENABLED=false
```

#### Use Combined Filter Function:
```javascript
import { runAllEntryFilters } from '../indicators/entryFilters.js';

const result = await runAllEntryFilters({
  direction: 'bullish',
  currentPrice: 50000,
  indicatorState: snap1m,
  indicatorState15m: snap15m,
  exchangeService: orderService.exchangeService,
  symbol: 'BTCUSDT',
  strategyType: 'FOLLOWING_TREND'
});

if (!result.ok) {
  console.log(`Entry blocked by: ${result.blockedBy}`);
  console.log(`Summary: ${result.summary}`);
}
```

---

### 6. Monitoring

Check filter rejection logs:
```bash
grep "filter rejected entry" logs/combined.log | tail -50
```

Check filter pass rate:
```bash
grep "All filters PASSED" logs/combined.log | wc -l
grep "filter rejected" logs/combined.log | wc -l
```

---

### 7. Kỳ Vọng Cải Thiện

- **Win Rate:** Tăng từ ~42% lên ~50-55% nhờ lọc các entry không tốt
- **Sync Issues:** Giảm sync errors nhờ retry logic
- **False Entries:** Giảm entry vào market ranging hoặc extreme sentiment

---

## Notes

- Tất cả filter đều có config enable/disable riêng
- Funding Rate filter chỉ hoạt động với futures (có funding rate)
- Market Regime dùng data 15m để xác định regime
- Tất cả filter đều "fail-open" nếu data không sẵn sàng
