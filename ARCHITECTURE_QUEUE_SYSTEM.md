# 🏗️ ARCHITECTURE: PositionMonitor → Queue System

**Ngày**: 2026-01-22  
**Status**: 📋 Design Document

---

## 🎯 MỤC TIÊU

Chuyển đổi từ **"scan-everything"** sang **queue-based architecture** để:
- ✅ Tránh event loop blocking
- ✅ Tách safety layer (TP/SL) khỏi strategy layer (ADV_TPSL)
- ✅ Implement 2-phase commit cho TP/SL
- ✅ Respect event loop và back-pressure

---

## 📊 KIẾN TRÚC HIỆN TẠI (VẤN ĐỀ)

```
PositionMonitor (10s interval)
  ↓
  Scan ALL positions (456 positions)
  ↓
  For each position:
    - placeExitOrder() → TP + SL (sequential)
    - monitorPosition() → ADV_TPSL features
  ↓
  Result: 6-8 phút cycle time → Event loop blocked
```

**Vấn đề**:
- ❌ Xử lý tất cả positions cùng lúc
- ❌ TP và SL trong cùng function → race condition với -2022
- ❌ ADV_TPSL và TP/SL placement không tách biệt
- ❌ Không có back-pressure

---

## 🏗️ KIẾN TRÚC MỚI (ĐỀ XUẤT)

### **Phase 1: Detection Layer (PositionMonitor)**

```
PositionMonitor (10s interval)
  ↓
  Scan positions (lightweight, chỉ detect)
  ↓
  For each position:
    - Check missing TP/SL → Enqueue to TP_SL_QUEUE
    - Check needs monitoring → Enqueue to MONITOR_QUEUE
  ↓
  Result: < 1 giây (chỉ detect, không xử lý)
```

### **Phase 2: Queue System**

```
TP_SL_QUEUE (BullMQ / In-Memory)
  ├─ Priority: HIGH (missing TP/SL)
  ├─ Priority: EMERGENCY (age > 10s)
  └─ Concurrency: 3-5 workers

MONITOR_QUEUE (BullMQ / In-Memory)
  ├─ Priority: LOW (has TP/SL, needs monitoring)
  └─ Concurrency: 2-3 workers
```

### **Phase 3: Worker System**

```
TP_SL_WORKER (Concurrency: 3-5)
  ├─ Phase 1: Place TP
  │   ├─ Create TP order
  │   ├─ Persist exit_order_id
  │   └─ Enqueue SL job (separate)
  │
  └─ Phase 2: Place SL (separate worker)
      ├─ Check position still open
      ├─ Check TP not filled
      ├─ Place SL order
      └─ Persist sl_order_id

MONITOR_WORKER (Concurrency: 2-3)
  ├─ Update dynamic SL
  ├─ Check TP/SL hit
  ├─ Trailing TP
  └─ ADV_TPSL features (if enabled)
```

---

## 🔧 IMPLEMENTATION PLAN

### **Step 1: In-Memory Queue (Quick Win)**

Không cần BullMQ ngay, dùng in-memory queue với:
- Priority queue (heap)
- Worker threads (hoặc async workers)
- Back-pressure mechanism

```javascript
// src/queues/TP_SL_Queue.js
class TPSLQueue {
  constructor() {
    this.queue = new PriorityQueue((a, b) => {
      // Emergency positions first (age > 10s)
      if (a.isEmergency && !b.isEmergency) return -1;
      if (!a.isEmergency && b.isEmergency) return 1;
      // Then by age (oldest first)
      return b.ageMs - a.ageMs;
    });
    this.workers = [];
    this.maxConcurrency = 5;
  }
  
  enqueue(position, priority = 'normal') {
    const ageMs = Date.now() - new Date(position.opened_at).getTime();
    this.queue.push({
      position,
      priority,
      isEmergency: ageMs > 10000, // 10s
      ageMs,
      timestamp: Date.now()
    });
  }
  
  async process() {
    // Worker logic
  }
}
```

### **Step 2: 2-Phase Commit**

```javascript
// Phase 1: Place TP
async function placeTP(position) {
  // 1. Check position still open
  const exchangePos = await exchangeService.getOpenPositions(position.symbol);
  if (!exchangePos || exchangePos.length === 0) {
    logger.warn(`Position ${position.id} no longer open, skipping TP`);
    return;
  }
  
  // 2. Place TP order
  const tpOrder = await exchangeService.createTakeProfit(...);
  
  // 3. Persist exit_order_id
  await Position.update(position.id, { exit_order_id: tpOrder.id });
  
  // 4. Enqueue SL job (separate)
  slQueue.enqueue(position, { tpOrderId: tpOrder.id });
}

// Phase 2: Place SL (separate worker)
async function placeSL(position, { tpOrderId }) {
  // 1. Check position still open
  const exchangePos = await exchangeService.getOpenPositions(position.symbol);
  if (!exchangePos || exchangePos.length === 0) {
    logger.warn(`Position ${position.id} no longer open, skipping SL`);
    return;
  }
  
  // 2. Check TP not filled (critical!)
  const tpOrder = await exchangeService.getOrderStatus(position.symbol, tpOrderId);
  if (tpOrder.status === 'FILLED') {
    logger.warn(`TP ${tpOrderId} already filled, canceling SL placement`);
    return;
  }
  
  // 3. Check position quantity > 0
  const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
  if (!quantity || quantity <= 0) {
    logger.warn(`Position ${position.id} quantity = 0, skipping SL (may cause -2022)`);
    return;
  }
  
  // 4. Place SL order
  const slOrder = await exchangeService.createStopLossLimit(...);
  
  // 5. Persist sl_order_id
  await Position.update(position.id, { sl_order_id: slOrder.id });
}
```

### **Step 3: PositionMonitor Refactor**

```javascript
// src/jobs/PositionMonitor.js
async monitorAllPositions() {
  // 1. Lightweight scan (only detect)
  const openPositions = await Position.findOpen();
  
  // 2. Categorize positions
  for (const pos of openPositions) {
    const needsTPSL = !pos.exit_order_id || !pos.sl_order_id;
    const ageMs = Date.now() - new Date(pos.opened_at).getTime();
    
    if (needsTPSL) {
      // Enqueue to TP/SL queue
      tpSlQueue.enqueue(pos, ageMs > 10000 ? 'emergency' : 'high');
    } else {
      // Enqueue to monitor queue
      monitorQueue.enqueue(pos, 'normal');
    }
  }
  
  // 3. Let workers process queues (non-blocking)
  // PositionMonitor cycle completes in < 1s
}
```

---

## 🚨 EMERGENCY FAIL-SAFE MODE

### **Trigger Conditions**:
1. Position age > 10s without TP/SL
2. Event loop delay > 200ms
3. Watchdog degrade mode active

### **Actions**:
1. **Bypass all throttling** for emergency positions
2. **Force TP/SL placement** immediately (parallel, no delay)
3. **Skip ADV_TPSL** features (safety first)
4. **Alert Telegram** with emergency notification

```javascript
// src/services/EmergencyFailSafe.js
class EmergencyFailSafe {
  async processEmergency(position) {
    logger.error(`[Emergency] Processing position ${position.id} (age: ${position.ageMs}ms)`);
    
    // 1. Place TP immediately (no delay, no throttling)
    const tpOrder = await exchangeService.createTakeProfit(...);
    await Position.update(position.id, { exit_order_id: tpOrder.id });
    
    // 2. Place SL immediately (no delay, no throttling)
    const slOrder = await exchangeService.createStopLossLimit(...);
    await Position.update(position.id, { sl_order_id: slOrder.id });
    
    // 3. Alert Telegram
    await telegramService.sendMessage(chatId, `🚨 EMERGENCY: TP/SL placed for position ${position.id}`);
  }
}
```

---

## 📊 SLO + ALERT RULES

### **SLO (Service Level Objectives)**:

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Position TP/SL delay | < 10s | > 30s |
| PositionMonitor cycle time | < 1s | > 5s |
| Event loop delay (mean) | < 20ms | > 50ms |
| Event loop delay (max) | < 100ms | > 200ms |
| WebSocket processing lag | < 100ms | > 500ms |
| TP/SL placement success rate | > 99% | < 95% |

### **Alert Rules**:

```javascript
// src/services/AlertService.js
class AlertService {
  checkSLOs() {
    // Position TP/SL delay
    const positionsWithoutTPSL = await Position.findOpenWithoutTPSL();
    for (const pos of positionsWithoutTPSL) {
      const ageMs = Date.now() - new Date(pos.opened_at).getTime();
      if (ageMs > 30000) { // 30s
        await this.sendAlert('CRITICAL', `Position ${pos.id} without TP/SL for ${ageMs}ms`);
      }
    }
    
    // Event loop delay
    const metrics = watchdogService.getMetrics();
    if (metrics.mean > 50 || metrics.max > 200) {
      await this.sendAlert('WARNING', `Event loop delay high: mean=${metrics.mean}ms, max=${metrics.max}ms`);
    }
    
    // Cycle time
    const cycleTime = positionMonitor.getLastCycleTime();
    if (cycleTime > 5000) {
      await this.sendAlert('WARNING', `PositionMonitor cycle time: ${cycleTime}ms`);
    }
  }
}
```

---

## 🔄 MIGRATION PATH

### **Phase 1: Quick Wins (Current)**
- ✅ Emergency TP/SL SLA enforcement
- ✅ Watchdog job type differentiation
- ✅ Adaptive chunking
- ✅ Yielding với setImmediate()

### **Phase 2: Queue System (Next)**
- ⏳ In-memory queue implementation
- ⏳ 2-phase commit (TP → SL)
- ⏳ Worker threads for heavy operations
- ⏳ Back-pressure mechanism

### **Phase 3: Full Architecture (Future)**
- ⏳ BullMQ integration
- ⏳ Horizontal scaling
- ⏳ Distributed queue
- ⏳ Advanced monitoring & alerting

---

## 📝 NOTES

- **Queue vs Direct Processing**: Queue system cho phép back-pressure và rate limiting tốt hơn
- **2-Phase Commit**: Tránh -2022 error bằng cách check position state trước khi place SL
- **Emergency Mode**: Bypass tất cả throttling cho safety-critical operations
- **SLO Monitoring**: Real-time metrics để detect issues sớm

---

**Status**: 📋 Design Document - Ready for Implementation  
**Priority**: P0 (Critical for scalability)

