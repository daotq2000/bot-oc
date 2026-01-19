# ✅ Trend Filter Enhancements - Multi-Timeframe Gate + Pullback + Volatility Filter

## Tổng quan

Đã implement **Hướng 2** để cải thiện độ chính xác xác định xu hướng và giảm lỗ:

1. **Multi-timeframe trend gate (15m)** - Xác định trend/regime trên timeframe lớn hơn
2. **Pullback confirmation (5m)** - Tránh vào lệnh khi giá đang "chạy thẳng"
3. **Volatility filter (ATR%)** - Lọc thị trường quá "lì" hoặc quá sốc
4. **ADX threshold nâng lên 25** - Lọc gắt hơn để tránh sideway

---

## Các thay đổi chính

### 1. Multi-Timeframe Trend Gate (15m)

**File:** `src/indicators/trendFilter.js`, `src/consumers/WebSocketOCConsumer.js`

- **Trend/Regime timeframe:** `15m` (thay vì `1m`)
- **Entry timing:** Vẫn dùng `1m` hoặc `5m` cho timing
- **Logic:**
  - Tạo separate `TrendIndicatorsState` cho `15m` (`_trendIndicators15m`)
  - Gate trend dựa trên EMA/ADX/RSI trên `15m`
  - Entry timing vẫn dựa trên `1m` hoặc `5m`

**Config:**
- `TREND_ADX_MIN=25` (default: 25, có thể tune)

---

### 2. Pullback Confirmation (5m EMA20)

**File:** `src/indicators/entryFilters.js`

**Rule (LONG):**
- Giá phải chạm hoặc đi dưới `EMA20(5m)` ít nhất 1 lần
- Nến 5m phải đóng cửa **trên EMA20(5m)** (confirmation)
- Chỉ khi đủ điều kiện mới cho phép entry

**Rule (SHORT):** Đối xứng

**Config:**
- `PULLBACK_CONFIRMATION_ENABLED=true` (default: true, có thể tắt)

---

### 3. Volatility Filter (ATR%)

**File:** `src/indicators/entryFilters.js`, `src/indicators/atr.js`

**Rule:**
- `ATR% = (ATR(14) / price) * 100`
- Chỉ trade khi: `0.15% <= ATR%(15m) <= 2.0%`
- Nếu ATR% quá thấp → thị trường quá "lì", dễ whipsaw → bỏ
- Nếu ATR% quá cao → thị trường quá sốc, dễ quét SL → bỏ

**Config:**
- `VOLATILITY_FILTER_ENABLED=true` (default: true)
- `VOL_ATR_MIN_PCT=0.15` (default: 0.15%)
- `VOL_ATR_MAX_PCT=2.0` (default: 2.0%)

---

### 4. ADX Threshold: 20 → 25

**File:** `src/indicators/trendFilter.js`

- **Trước:** `ADX < 20` → reject
- **Sau:** `ADX < 25` → reject (configurable)

**Config:**
- `TREND_ADX_MIN=25` (default: 25)

---

## Files đã thay đổi

1. **`src/indicators/atr.js`** (NEW) - ATR indicator class
2. **`src/indicators/entryFilters.js`** (NEW) - Pullback + volatility filter helpers
3. **`src/indicators/trendFilter.js`** - Support multi-timeframe (15m state)
4. **`src/indicators/TrendIndicatorsState.js`** - Add ATR support
5. **`src/indicators/IndicatorWarmup.js`** - Support warmup 15m candles
6. **`src/consumers/WebSocketOCConsumer.js`** - Multi-timeframe gate + pullback + volatility

---

## Config flags (có thể bật/tắt)

### Trend Gate
- `TREND_ADX_MIN=25` - ADX threshold (default: 25)

### Pullback Confirmation
- `PULLBACK_CONFIRMATION_ENABLED=true` - Bật/tắt pullback filter (default: true)

### Volatility Filter
- `VOLATILITY_FILTER_ENABLED=true` - Bật/tắt volatility filter (default: true)
- `VOL_ATR_MIN_PCT=0.15` - ATR% tối thiểu (default: 0.15%)
- `VOL_ATR_MAX_PCT=2.0` - ATR% tối đa (default: 2.0%)

### Warmup
- `INDICATORS_WARMUP_CANDLES_15M=50` - Số lượng 15m candles để warmup (default: 50)

---

## Cách verify sau khi restart

### 1. Check warmup 15m state
```bash
grep -i "Warmup complete.*15m\|warmed up.*15m\|15m.*warmup" logs/combined.log | tail -50
```

### 2. Check trend gate với 15m
```bash
grep -i "Trend filters rejected entry.*15m\|All filters PASSED.*15m\|15m gate" logs/combined.log | tail -50
```

### 3. Check pullback filter
```bash
grep -i "Pullback filter rejected\|pullback_confirmed" logs/combined.log | tail -50
```

### 4. Check volatility filter
```bash
grep -i "Volatility filter rejected\|volatility_ok\|ATR%" logs/combined.log | tail -50
```

### 5. Check ADX threshold
```bash
grep -i "ADX.*>= 25\|adx15m_sideways" logs/combined.log | tail -50
```

---

## Expected behavior

### Trước khi có filter:
- Bot vào lệnh nhiều hơn nhưng nhiều lệnh "rác" (sideway, whipsaw)
- Lỗ nhiều hơn do vào lệnh ngược trend lớn

### Sau khi có filter:
- Bot vào lệnh ít hơn nhưng **chất lượng cao hơn**
- Chỉ vào lệnh khi:
  - Trend 15m rõ ràng (ADX >= 25)
  - EMA alignment trên 15m OK
  - Pullback confirmation trên 5m OK
  - Volatility trong range hợp lý (0.15% - 2.0%)

---

## Lưu ý quan trọng

1. **15m candles cần được subscribe** - WebSocketManager đã có `CandleAggregator(['1m', '5m', '15m', '30m'])`, nhưng cần đảm bảo bot subscribe kline stream cho 15m
2. **Warmup sẽ lâu hơn** - Vì phải warmup cả 1m và 15m state, warmup có thể mất 5-10 phút (đã optimize rate limit)
3. **Pullback filter có thể quá gắt** - Nếu thấy bot vào lệnh quá ít, có thể tắt pullback filter (`PULLBACK_CONFIRMATION_ENABLED=false`)
4. **Volatility filter cần tune theo coin** - Một số coin có ATR% thấp/high tự nhiên, có thể cần điều chỉnh `VOL_ATR_MIN_PCT` và `VOL_ATR_MAX_PCT`

---

## Next steps (optional)

1. **PriceAlertScanner** - Cần update tương tự để apply multi-timeframe gate
2. **MEXC support** - Hiện tại chỉ Binance có full support (15m candles), MEXC chỉ có partial filter
3. **Backtesting** - Nên backtest với historical data để verify improvement

---

## Troubleshooting

### Bot không vào lệnh gì cả
- Check log: `grep -i "Trend filters rejected\|Pullback filter rejected\|Volatility filter rejected" logs/combined.log`
- Có thể filter quá gắt → giảm `TREND_ADX_MIN` xuống 22 hoặc tắt pullback/volatility filter

### 15m state không warmed up
- Check log: `grep -i "Warmup.*15m\|15m.*warmup" logs/combined.log`
- Có thể do rate limit → tăng `INDICATORS_WARMUP_BATCH_DELAY_MS` hoặc giảm `INDICATORS_WARMUP_CANDLES_15M`

### Lỗi "atr14 is not defined"
- Check xem `TrendIndicatorsState` đã có ATR chưa → restart bot để load code mới

