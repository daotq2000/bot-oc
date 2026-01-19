# 📊 Crypto-Alert Project Logic Analysis

## 🎯 Tổng Quan

**crypto-alert** là một advanced cryptocurrency trading bot với **12 Rules Pump Detection System**, intelligent signal generation, auto trading, và dynamic TP/SL management.

## 🏗️ Architecture

### **Main Entry Point: `hybrid-bot.js`**

```
HybridCryptoBot
  ├── MultiWebSocketManager (WebSocket connections)
  ├── WebSocketTechnicalSignals (Technical analysis)
  ├── EnhancedAutoTradeService (Auto trading)
  ├── PumpDetectionRules (12 Rules pump detection)
  ├── WebSocketPriceTracker (Price alerts)
  └── Various services (Health check, Crash recovery, etc.)
```

### **Core Flow:**

```
1. Initialize Services
   ├── TelegramService
   ├── BinanceFuturesClient (REST API)
   ├── MultiWebSocketManager (WebSocket)
   └── EnhancedAutoTradeService (if enabled)

2. Load Symbols
   ├── Load all futures symbols from Binance
   ├── Select top symbols by volume (max 850)
   └── Subscribe WebSocket for top symbols (max 50)

3. Start Analysis
   ├── Periodic Technical Analysis (every 15 min)
   ├── Event-Driven Analysis (on candle close)
   ├── Pump Detection (every 15 min)
   └── Price Alerts (real-time via WebSocket)

4. Signal Generation
   ├── Technical Analysis → Trading Signals
   ├── Pump Detection → Accumulation Scores
   └── Auto Trade Execution (if enabled)
```

## 🔥 12 Rules Pump Detection System

### **Scoring System (130 points max):**

| Rule | Points | Description |
|------|--------|-------------|
| #1 | 25 | Accumulation Detection (FLM pattern) |
| #2 | 15 | Volume Trend Analysis |
| #3 | 20 | Candle Pattern Analysis |
| #4 | 15 | Volume Spike Warning |
| #5 | 15 | Momentum Indicators |
| #6 | 10 | Timeframe Confirmation |
| #7 | 8 | Entry Timing (Spring/Shakeout) |
| #8 | 7 | Liquidity Trap Detection |
| #9 | - | Distribution Detection (Filter - negative) |
| #10 | 10 | Volume Confirmation |
| #11 | 10 | Time Confirmation |
| #12 | 8 | Retest Confirmation |

**Thresholds:**
- **Alert:** 80+ points → Telegram notification
- **Auto Trade:** 80+ points (configurable) → Execute trades automatically
- **Entry Confirmed:** 110+ points → High confidence entry

### **Rule #1: Accumulation Detection (25 points)**

**Logic:**
- Analyze last 40 candles (accumulation window)
- Check for ultra-low oscillation (0.1-0.3%)
- Check price range (< 0.5% = perfect accumulation)
- Check volume (low volume = accumulation phase)

**Enhanced:**
- **Entry Position Check:**
  - Penalize -15 points if entry near recent high (<5% from high)
  - Bonus +10 points if entry near recent low (<5% from low)

**Code:**
```javascript
checkAccumulation(data) {
  const recent = data.slice(-40);
  const priceRange = ((maxPrice - minPrice) / avgPrice) * 100;
  const avgChange = average of price changes;
  
  if (maxChange < 0.3 && priceRange < 0.5 && isLowVolume) {
    points = 25; // Ultra-low oscillation (FLM pattern)
  }
  
  // Entry position check
  if (distanceFromHigh < 5%) points -= 15; // Penalize
  if (distanceFromLow < 5%) points += 10; // Bonus
}
```

### **Rule #2: Volume Trend (15 points)**

**Logic:**
- Compare first half vs second half volume
- Volume increase > 50% = 15 points
- Volume increase > 30% = 10 points
- Volume increase > 10% = 5 points

### **Rule #3: Candle Pattern (20 points)**

**Logic:**
- Count accumulation candles (high volume + low movement)
- > 10 accumulation candles = 20 points

### **Rule #4: Volume Spike (15 points)**

**Logic:**
- Detect sudden volume increase (2x-5x average)
- Volume spike with sideways price = accumulation signal

### **Rule #5: Momentum Indicators (15 points)**

**Logic:**
- RSI, MACD momentum analysis
- Check for momentum divergence

### **Rule #6: Timeframe Confirmation (10 points)**

**Logic:**
- Check consistency across 1m, 5m, 15m timeframes
- 3 timeframes confirm = 10 points
- 2 timeframes confirm = 5 points

### **Rule #7: Entry Timing (8 points)**

**Logic:**
- Detect Spring/Shakeout pattern (Wyckoff)
- Volume spike + price recovery = perfect entry
- Spring detected = 8 points

### **Rule #8: Liquidity Trap (7 points)**

**Logic:**
- Detect fake breakdowns
- Price dips below support then recovers

### **Rule #9: Distribution Detection (Filter - Negative)**

**Logic:**
- **LOẠI TRỪ** distribution phases
- Volume tăng + giá giảm = distribution (sắp dump)
- Distribution score > 50 = REJECT signal

**Code:**
```javascript
checkDistribution(data, volumes, prices) {
  // Volume tăng nhưng giá giảm = distribution
  if (volumeIncrease > 50 && priceChange < -0.5) {
    distributionScore += 50; // REJECT
  }
  
  // Nhiều nến đỏ với volume cao = distribution
  if (redCandlesHighVol > greenCandlesHighVol + 3) {
    distributionScore += 20;
  }
  
  return distributionScore; // > 50 = REJECT
}
```

### **Rule #10: Volume Confirmation (10 points)**

**Logic:**
- Breakout với volume spike (2x-5x average)
- Candle body ratio > 0.6 = strong breakout
- Volume divergence detection (false breakout filter)

### **Rule #11: Time Confirmation (10 points)**

**Logic:**
- Multiple closes above breakout level
- Distance from breakout > 2% = strong confirmation
- Higher timeframe (15m) confirmation

### **Rule #12: Retest Confirmation (8 points)**

**Logic:**
- Price retests breakout level with low volume
- Rejection candle after retest = confirmation
- Low-risk entry point

## 🚀 Auto Trading Workflow

### **EnhancedAutoTradeService Flow:**

```
1. Signal Received
   ├── From Technical Analysis (TechnicalSignalCalculator)
   ├── From Pump Detection (PumpDetectionRules)
   └── From WebSocket Technical Signals

2. Signal Validation
   ├── Check confidence threshold (BUY: 65%, SELL: 70%)
   ├── Check position limits (max 4 concurrent)
   ├── Check daily limit (max 20 trades/day)
   ├── Check DCA threshold (max 50 USDT per symbol)
   └── Smart Entry Filter (trend, volatility, etc.)

3. Trade Execution
   ├── Calculate position size (default: 5 USDT)
   ├── Set leverage (dynamic, up to 50x)
   ├── Place market order
   └── Setup TP/SL orders

4. Position Management
   ├── Dynamic TP/SL management
   ├── Trailing stop loss
   └── Take profit optimization
```

### **Smart Entry Filter:**

**Checks:**
- Trend alignment (H4 EMA200)
- Volatility filter (ATR-based)
- Pullback confirmation
- Distribution filter

**Reject if:**
- Distribution detected
- Counter-trend entry
- High volatility (ATR% too high)
- No pullback confirmation

## 📊 Technical Analysis System

### **TechnicalSignalCalculator:**

**Indicators:**
- EMA200 (trend)
- MACD (momentum)
- RSI (momentum)
- Volume (confirmation)
- Candlesticks (patterns)

**Multi-timeframe:**
- H1 (primary)
- H4 (trend confirmation)

### **Signal Generation Logic:**

```
1. Calculate Indicators (H1 + H4)
   ├── EMA200 (trend direction)
   ├── MACD (momentum)
   ├── RSI (momentum)
   ├── Volume ratio
   └── Candlestick patterns

2. Factor Analysis
   ├── Bullish factors (trend, momentum, volume)
   ├── Bearish factors (trend, momentum, volume)
   └── Calculate strength for each

3. Signal Decision
   ├── RSI Override Rules:
   │   ├── RSI < 20: REJECT (too oversold)
   │   ├── RSI > 90: REJECT (too overbought)
   │   ├── RSI < 30: Strong BUY (override bearish)
   │   └── RSI > 70: Strong SELL (override bullish)
   │
   ├── Trend Alignment (H4 EMA200):
   │   ├── Price > EMA200: Bullish trend
   │   └── Price < EMA200: Bearish trend
   │
   └── Confluence Check:
       ├── Need 2+ factors OR strength ≥40%
       └── Reject if insufficient confluence

4. Confidence Calculation
   ├── Base confidence = factor strength
   ├── Apply penalties (trend distance, RSI neutral)
   └── Final confidence score

5. Signal Output
   ├── BUY/SELL/HOLD
   ├── Confidence (0-100%)
   ├── Strength (WEAK/MODERATE/STRONG)
   └── Entry/TP/SL prices
```

### **RSI Override Rules (Critical):**

**Extreme Zones (REJECT):**
- RSI < 20: REJECT BUY (falling knife)
- RSI > 90: REJECT SELL (FOMO trap)

**Strong Zones (Override):**
- RSI < 30: Strong BUY (override bearish signals)
- RSI > 70: Strong SELL (override bullish signals)

**Moderate Zones (Block Counter-trend):**
- RSI 30-35: REJECT SELL (oversold zone)
- RSI 65-70: REJECT BUY (overbought zone)

**Neutral Zone (35-65):**
- Allow signals but with penalty
- Reject if confidence < 30%

## 🔄 WebSocket Technical Signals

### **Event-Driven Analysis:**

**On Candle Close:**
```
1. Candle Close Event
   ├── Update OHLCV data
   ├── Store to MySQL (if enabled)
   └── Trigger analysis

2. Technical Analysis
   ├── Calculate indicators
   ├── Generate signal
   └── Check thresholds

3. Pump Detection
   ├── Run 12 Rules check
   ├── Calculate accumulation score
   └── Check thresholds (80+ alert, 80+ auto trade)

4. Actions
   ├── Send Telegram alert (if score >= 80)
   ├── Execute auto trade (if score >= 80 && enabled)
   └── Update position management
```

### **Periodic Analysis:**

**Schedule:**
- Default: Every 15 minutes
- Configurable via `ANALYSIS_INTERVAL`
- Adaptive interval based on signal quality:
  - High quality (≥80%): 15 min (base)
  - Low quality (≤60%): 5 min (fast)

**Time Windows:**
- Configurable via `ANALYSIS_SCHEDULE`
- Example: "9-17" (9 AM to 5 PM UTC)
- Example: "0,2,4,6,8,10,12,14,16,18,20,22" (every 2 hours)

## 🛡️ Risk Management

### **Position Limits:**
- **Max Concurrent Trades:** 4 positions (configurable)
- **Max Daily Trades:** 20 trades/day (configurable)
- **Position Size:** Default 5 USDT, max 100 USDT
- **DCA Threshold:** 50 USDT per symbol (blocks new positions)

### **DCA Protection:**
- Automatically blocks new position orders when total position ≥ 50 USDT
- Preserves Take Profit and Stop Loss orders
- Auto-cancels pending position orders
- Prevents over-leveraging per symbol

### **Leverage Management:**
- Dynamic leverage up to 50x (configurable)
- Per-coin leverage settings
- LeverageManagementService handles all leverage operations

### **Distribution Filter:**
- Rule #9 detects distribution phases
- Rejects signals if distribution score > 50
- Prevents buying before dump

## 📈 Key Differences vs bot-oc

### **crypto-alert:**
1. **12 Rules Pump Detection** - Focused on accumulation/pump patterns
2. **Auto Trading** - Automatic trade execution based on scores
3. **Multi-timeframe Analysis** - H1 + H4 for trend confirmation
4. **RSI Override Rules** - Strong rules to prevent counter-trend trades
5. **Distribution Filter** - Explicit filter to reject distribution phases
6. **DCA Protection** - Position size control per symbol
7. **Event-Driven + Periodic** - Both candle close events and periodic scans

### **bot-oc (current):**
1. **OC Detection** - Open-Close percentage detection
2. **Strategy-Based** - Execute based on strategy configs
3. **Trend Filters** - EMA + ADX + RSI filters
4. **Price Alerts** - Telegram alerts for volatility
5. **WebSocket Real-time** - Real-time OC detection via WebSocket
6. **No Auto Trading** - Manual strategy execution only

## 🔍 Key Insights

### **1. Pump Detection vs OC Detection:**

**crypto-alert (Pump Detection):**
- Focuses on **accumulation phase** before pump
- 12 rules analyze 40-minute window
- Scores accumulation quality (0-130 points)
- Entry timing based on Spring/Shakeout patterns

**bot-oc (OC Detection):**
- Focuses on **price movement** (open-close %)
- Real-time detection via WebSocket
- Threshold-based alerts
- Strategy-based execution

### **2. Signal Generation:**

**crypto-alert:**
- Multi-factor confluence system
- RSI override rules prevent counter-trend
- Trend alignment required (H4 EMA200)
- Distribution filter prevents bad entries

**bot-oc:**
- Trend filters (EMA + ADX + RSI)
- Multi-timeframe gates (1m + 15m)
- Pullback confirmation
- Volatility filter

### **3. Risk Management:**

**crypto-alert:**
- DCA protection (50 USDT threshold)
- Max concurrent positions (4)
- Daily trade limit (20)
- Distribution filter

**bot-oc:**
- Strategy-based limits
- Position duplicate prevention
- Trend filter gates
- No explicit DCA protection

## 💡 Potential Improvements for bot-oc

### **1. Accumulation Detection:**
- Add accumulation phase detection (similar to Rule #1)
- Detect ultra-low oscillation patterns
- Entry position check (penalize entries near high)

### **2. Distribution Filter:**
- Add explicit distribution detection
- Reject signals during distribution phases
- Similar to Rule #9 in crypto-alert

### **3. RSI Override Rules:**
- Add stronger RSI rules to prevent counter-trend
- Reject extreme RSI zones (< 20, > 90)
- Override signals in strong RSI zones (< 30, > 70)

### **4. Multi-timeframe Trend:**
- Use H4 timeframe for trend confirmation (like crypto-alert)
- Require trend alignment before entry
- Similar to H4 EMA200 check

### **5. Entry Timing:**
- Add Spring/Shakeout detection
- Better entry timing based on Wyckoff patterns
- Similar to Rule #7

## 📝 Summary

**crypto-alert** là một sophisticated trading bot với:
- ✅ 12 Rules Pump Detection System (130 points)
- ✅ Auto trading với intelligent filters
- ✅ Multi-timeframe analysis
- ✅ Strong risk management (DCA, distribution filter)
- ✅ Event-driven + periodic analysis

**Key strengths:**
- Accumulation detection rất tốt
- Distribution filter prevents bad entries
- RSI override rules prevent counter-trend
- Multi-timeframe trend confirmation

**Potential integration points:**
- Accumulation detection logic
- Distribution filter
- RSI override rules
- Entry timing (Spring/Shakeout)
- Multi-timeframe trend confirmation

