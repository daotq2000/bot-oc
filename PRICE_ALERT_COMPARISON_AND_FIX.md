# 🔍 Price Alert Comparison & Fix - Branch ema vs Main

## 📋 Vấn Đề

**Branch main:** Nhận được alerts đều đặn ✅  
**Branch ema (hiện tại):** Không nhận được alerts ❌

## 🔍 Phân Tích Logs

### **Từ logs/combined.log:**

1. **Config đúng:**
   - `scanner=true websocket=true` ✅
   - `PRICE_ALERT_USE_SCANNER=true` ✅
   - `PRICE_ALERT_USE_WEBSOCKET=true` ✅

2. **Initialization OK:**
   - PriceAlertScanner initialized ✅
   - RealtimeOCDetector initialized ✅
   - 2 active configs found ✅
   - 541 Binance symbols, 750 MEXC symbols ✅

3. **Vấn đề phát hiện:**
   - ❌ **KHÔNG có logs về `PriceAlertScanner.start()`**
   - ❌ **KHÔNG có logs về `PriceAlertScanner started`**
   - ❌ **KHÔNG có logs về scan activity**
   - ❌ **KHÔNG có logs về `getAccurateOpen` failures**
   - ❌ **KHÔNG có logs về alerts being sent**

## 🐛 Root Causes

### **1. PriceAlertScanner chưa được start**

**Vấn đề:** Trong `PriceAlertWorker.start()`, có check `ENABLE_ALERTS` nhưng có thể bị skip hoặc có lỗi silent.

**Code hiện tại:**
```javascript
// PriceAlertWorker.start()
const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
if (!alertsEnabled) {
  logger.info('[PriceAlertWorker] ENABLE_ALERTS=false, Price Alert Worker will not start');
  return; // ❌ Early return - không start
}
```

**Fix:** Thêm logging để debug:
```javascript
logger.info(`[PriceAlertWorker] ENABLE_ALERTS=${alertsEnabled}, proceeding with start...`);
```

### **2. AlertMode defaults = false**

**Vấn đề:** Trong `AlertMode.js`, cả 2 defaults đều là `false`:
```javascript
useScanner() {
  return configService.getBoolean('PRICE_ALERT_USE_SCANNER', false); // ❌ default false
}
useWebSocket() {
  return configService.getBoolean('PRICE_ALERT_USE_WEBSOCKET', false); // ❌ default false
}
```

**Nhưng:** Config trong DB đã set `true`, nên không phải vấn đề này.

### **3. PriceAlertScanner.scan() có early returns**

**Vấn đề:** Có nhiều early returns trong `scan()`:
```javascript
// Check master ENABLE_ALERTS switch first
const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
if (!alertsEnabled) {
  logger.debug('[PriceAlertScanner] Alerts disabled by ENABLE_ALERTS config, skipping scan');
  return; // ❌ Early return
}

const enabled = configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true);
if (!enabled) {
  logger.debug('[PriceAlertScanner] Price alert checking is disabled');
  return; // ❌ Early return
}

const activeConfigs = this.cachedConfigs || [];
if (activeConfigs.length === 0) {
  logger.debug('[PriceAlertScanner] No active price alert configs');
  return; // ❌ Early return
}
```

**Fix:** Thêm logging để debug tại sao scan bị skip.

### **4. getAccurateOpen() có thể fail silently**

**Vấn đề:** Đã fix fallback, nhưng có thể vẫn có vấn đề với WebSocket data.

## ✅ Fixes Đề Xuất

### **Fix 1: Thêm comprehensive logging**

```javascript
// PriceAlertWorker.start()
async start() {
  if (this.isRunning) {
    logger.warn('[PriceAlertWorker] Already running');
    return;
  }

  const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
  logger.info(`[PriceAlertWorker] ENABLE_ALERTS=${alertsEnabled}`);
  
  if (!alertsEnabled) {
    logger.info('[PriceAlertWorker] ENABLE_ALERTS=false, Price Alert Worker will not start');
    return;
  }

  try {
    this.isRunning = true;

    const scannerEnabled = alertMode.useScanner();
    const websocketEnabled = alertMode.useWebSocket();
    logger.info(`[PriceAlertWorker] Starting... mode: scanner=${scannerEnabled} websocket=${websocketEnabled}`);

    // Start PriceAlertScanner (polling) if enabled
    if (scannerEnabled) {
      if (!this.priceAlertScanner) {
        logger.warn('[PriceAlertWorker] Scanner mode enabled but priceAlertScanner is null. Creating a new instance...');
        // ... existing code
      }

      try {
        logger.info('[PriceAlertWorker] Starting PriceAlertScanner...');
        this.priceAlertScanner.start();
        logger.info(`[PriceAlertWorker] ✅ PriceAlertScanner.start() called (scanner.isRunning=${this.priceAlertScanner.isRunning})`);
        
        // ✅ NEW: Verify scanner is actually running
        if (!this.priceAlertScanner.isRunning) {
          logger.error('[PriceAlertWorker] ❌ PriceAlertScanner.start() was called but scanner.isRunning is still false!');
        }
      } catch (e) {
        logger.error('[PriceAlertWorker] ❌ PriceAlertScanner.start() failed:', e?.message || e, e?.stack);
      }
    } else {
      logger.info('[PriceAlertWorker] Scanner mode disabled; not starting PriceAlertScanner');
    }

    // WebSocket alerts
    if (websocketEnabled) {
      logger.info(`[PriceAlertWorker] WebSocket alerts enabled (alertEnabled=${realtimeOCDetector.alertEnabled})`);
    } else {
      logger.info('[PriceAlertWorker] WebSocket alerts disabled');
    }

    logger.info('[PriceAlertWorker] ✅ Price Alert system started');
  } catch (error) {
    logger.error('[PriceAlertWorker] ❌ Failed to start Price Alert system:', error?.message || error, error?.stack);
    // Don't throw - try to continue
  }
}
```

### **Fix 2: Thêm logging trong PriceAlertScanner.scan()**

```javascript
async scan() {
  // Prevent overlapping scans
  if (this.isScanning) {
    logger.debug('[PriceAlertScanner] Scan already in progress, skipping');
    return;
  }

  this.isScanning = true;
  const scanStartTime = Date.now();

  try {
    // Check master ENABLE_ALERTS switch first
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    logger.debug(`[PriceAlertScanner] ENABLE_ALERTS=${alertsEnabled}`);
    if (!alertsEnabled) {
      logger.info('[PriceAlertScanner] Alerts disabled by ENABLE_ALERTS config, skipping scan'); // ✅ Changed to info
      return;
    }

    const enabled = configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true);
    logger.debug(`[PriceAlertScanner] PRICE_ALERT_CHECK_ENABLED=${enabled}`);
    if (!enabled) {
      logger.info('[PriceAlertScanner] Price alert checking is disabled'); // ✅ Changed to info
      return;
    }

    // ✅ OPTIMIZED: Refresh configs theo TTL
    await this.refreshConfigsIfNeeded();

    const activeConfigs = this.cachedConfigs || [];
    logger.debug(`[PriceAlertScanner] Active configs: ${activeConfigs.length}`);
    if (activeConfigs.length === 0) {
      logger.info('[PriceAlertScanner] No active price alert configs'); // ✅ Changed to info
      return;
    }

    // ... rest of scan logic
  } catch (error) {
    logger.error('PriceAlertScanner scan failed:', error?.message || error, error?.stack);
  } finally {
    this.isScanning = false;
  }
}
```

### **Fix 3: Verify PriceAlertScanner.start() implementation**

```javascript
// PriceAlertScanner.start()
start() {
  if (this.isRunning) {
    logger.warn('PriceAlertScanner is already running');
    return;
  }

  this.isRunning = true;
  logger.info(`[PriceAlertScanner] ✅ Setting isRunning=true`);

  // ✅ REALTIME: Register WebSocket price handlers for immediate OC detection
  this.registerPriceHandlers();

  // ✅ PERFORMANCE: Polling chỉ là safety-net khi WS miss.
  const interval = configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 1000);
  logger.info(`[PriceAlertScanner] Scan interval: ${interval}ms`);

  const runLoop = async () => {
    if (!this.isRunning) {
      logger.debug('[PriceAlertScanner] isRunning=false, stopping scan loop');
      return;
    }
    try {
      await this.scan();
    } catch (error) {
      logger.error('PriceAlertScanner scan error:', error?.message || error, error?.stack);
    } finally {
      // ✅ Avoid timer pile-up: schedule next run only after finishing current scan
      if (this.isRunning) {
        this.scanInterval = setTimeout(runLoop, interval);
      }
    }
  };

  // First run asap
  this.scanInterval = setTimeout(runLoop, 0);
  logger.info(`[PriceAlertScanner] ✅ Started with interval ${interval}ms (WebSocket realtime + polling safety-net)`);
  logger.info(`[PriceAlertScanner] ✅ scanInterval=${this.scanInterval ? 'set' : 'null'}, isRunning=${this.isRunning}`);
}
```

## 🧪 Testing Steps

1. **Check logs sau khi apply fixes:**
   ```bash
   # Check PriceAlertWorker start
   grep "PriceAlertWorker.*Starting" logs/combined.log
   grep "PriceAlertScanner.start() called" logs/combined.log
   grep "PriceAlertScanner.*Started" logs/combined.log
   
   # Check scan activity
   grep "PriceAlertScanner.*scan" logs/combined.log | head -20
   grep "Scan completed" logs/combined.log
   
   # Check alerts
   grep "Threshold met" logs/combined.log
   grep "Sending alert" logs/combined.log
   ```

2. **Verify configs:**
   ```sql
   SELECT * FROM app_configs WHERE config_key IN ('PRICE_ALERT_USE_SCANNER', 'PRICE_ALERT_USE_WEBSOCKET', 'ENABLE_ALERTS', 'PRICE_ALERT_CHECK_ENABLED');
   ```

3. **Check PriceAlertConfigs:**
   ```sql
   SELECT * FROM price_alert_configs WHERE is_active = 1;
   ```

## 📝 Summary

**Vấn đề chính:** PriceAlertScanner có thể chưa được start hoặc scan bị skip do early returns.

**Fixes:**
1. ✅ Thêm comprehensive logging
2. ✅ Verify PriceAlertScanner.start() được gọi và hoạt động
3. ✅ Thêm logging trong scan() để debug early returns
4. ✅ Verify isRunning flag

**Next steps:**
1. Apply fixes
2. Restart bot
3. Check logs để verify scanner đang chạy
4. Monitor alerts

