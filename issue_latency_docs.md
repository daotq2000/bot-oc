# Post-Mortem & Fix: Bot Latency and Stalling Issue

## 1. Executive Summary

The trading bot experienced severe performance degradation, manifesting as high latency, WebSocket disconnects, and apparent stalling of operations. The root cause was not network latency but a **critically blocked Node.js event loop**. The blockage was caused by the `WebSocketOCConsumer` module being unable to cope with the high message rate of Binance's `bookTicker` stream. Its data processing logic, while throttled, was still too slow and frequent, leading to a feedback loop of processing backlogs and log spam that exacerbated the issue.

The definitive fix involved a multi-layered architectural change:
1.  **Architectural Shift**: Replaced the inefficient throttle/batch system in `WebSocketOCConsumer` with a **debounce** mechanism, drastically reducing the processing load by only acting on the latest tick in a burst.
2.  **System Hardening**: Implemented a robust **ping/pong keepalive** for market data WebSockets to prevent network-related disconnects (`code: 1006`).
3.  **Intelligent Reconnects**: De-coupled reconnection logic from latency metrics, now triggering reconnections based on data **starvation** (no messages for >15s) to prevent reconnect storms.
4.  **Enhanced Observability**: Added detailed **profiling** to pinpoint slow handlers by name and enriched logs/status endpoints with actionable metrics.

This solution ensures the bot remains responsive and stable, even under high market data volume.

## 2. Timeline of the Issue

- **Initial Report**: Bot becomes unresponsive, logs show high WebSocket latency (`p95 > 4000ms`).
- **Initial Investigation**: The bot appears to stop processing data, leading to missed trading signals.
- **Symptom**: Logs fill up with `EXTREME latency`, `Stale message detected`, and `Processing lag detected` warnings.
- **False Lead**: Initial suspicion fell on network issues or too many WebSocket connections.
- **Breakthrough**: Profiling logs revealed that a specific handler, `webSocketOCConsumerBinanceHandler`, was consistently slow (20-70ms per execution).
- **Resolution**: A series of architectural improvements were implemented, culminating in the debouncing fix for the identified bottleneck.

## 3. Root Cause Analysis

The issue stemmed from a combination of factors creating a vicious cycle:

1.  **Primary Cause: High Message Rate & Slow Consumer**
    - The `bookTicker` stream from Binance is extremely high-frequency.
    - The `WebSocketOCConsumer`'s `handlePriceTick` method, which performs heavy logic like OC detection and trend analysis, was identified as the main bottleneck.
    - The initial 250ms throttle was insufficient. For every symbol, the *first* tick would trigger this heavy logic, and with hundreds of symbols, the event loop was constantly busy.

2.  **Secondary Cause: Inefficient Throttling**
    - A simple **throttle** (process the first event, then ignore others for a period) is ill-suited for `bookTicker`. It processes stale data while ignoring the most recent ticks.
    - A **debounce** (wait for a quiet period, then process the *last* event) is far more efficient, as it reduces workload and acts on the most relevant price.

3.  **Aggravating Factor 1: Latency-Based Reconnects**
    - The system was configured to reconnect WebSocket connections when latency metrics (p95/median) crossed a threshold.
    - However, the high latency was a *symptom* of the blocked event loop, not a network problem.
    - This created a **reconnect storm**: the bot would detect high latency (because it was too busy to process messages on time), trigger a reconnect, and add more load to the already struggling system.

4.  **Aggravating Factor 2: Lack of Keepalive**
    - The market data WebSocket did not have a `ping/pong` keepalive mechanism.
    - This made it vulnerable to `code: 1006` disconnects from network intermediaries (proxies, NATs) that aggressively terminate idle TCP connections.

## 4. The Solution: A Multi-Layered Fix

The problem was solved with a series of targeted architectural improvements:

### Layer 1: Isolate the WebSocket Thread (The Foundation)
- **Tick Queue Architecture**: The `WebSocketManager` was refactored. The `on('message')` handler now does the bare minimum: parse the message, update the in-memory price cache, and push the tick into a queue. All heavy consumer logic was moved to a separate, asynchronous `TickProcessor` loop. This ensures the I/O thread is never blocked.

### Layer 2: Fix the Bottleneck (`WebSocketOCConsumer`)
- **Debouncing Implemented**: The core of the fix. The simple throttle in `WebSocketOCConsumer` was replaced with a **debounce** mechanism with a 200ms interval (`WS_OC_DEBOUNCE_MS`).
    - **Old Way (Throttle)**: A burst of 10 ticks for BTCUSDT in 100ms would trigger the heavy logic once with the *first* (oldest) tick.
    - **New Way (Debounce)**: The same burst of 10 ticks triggers the heavy logic only once, with the *tenth* (newest) tick, after a 200ms quiet period.
- **Result**: This change dramatically reduces the number of executions of the slow handler while improving the quality of the data being processed.

### Layer 3: Harden Connectivity & Reconnect Logic
- **Ping/Pong Keepalive**: A `ping/pong` mechanism was added to `WebSocketManager`. The bot now sends a ping every 20 seconds and expects a pong within 15 seconds, preventing `1006` disconnects from network intermediaries.
- **Starvation-Based Reconnects**: The faulty latency-based reconnect logic was completely removed. The system now only reconnects a connection if:
    1.  A `pong` is not received in time (a reliable sign of a dead connection).
    2.  No WebSocket messages of any kind have been received on that specific connection for over 15 seconds (Option 1).

### Layer 4: Enhance Observability
- **Named & Profiled Handlers**: All WebSocket price handlers were given explicit names (e.g., `webSocketOCConsumerBinanceHandler`).
- **Top-N Slow Handler Reporting**: The profiler was upgraded to aggregate performance data by handler name and periodically log the top N slowest handlers, making it trivial to identify future bottlenecks.
- **Detailed Status**: The `getStatus()` method was enriched with detailed metrics on the tick queue, reconnect queue, and per-connection keepalive status (`lastWsMessageAt`, `lastPongAt`).

## 5. Validation and Outcome

- **Lag Eliminated**: After deploying the debounce fix, the `webSocketOCConsumerBinanceHandler` no longer appears in the `Slow handlers top` log, and the `Processing lag detected` warnings have disappeared.
- **Stability Increased**: The new keepalive and starvation-based reconnect logic has stopped the reconnect storms, leading to stable, long-lived WebSocket connections.
- **Bot is Responsive**: The event loop is no longer blocked, and the bot processes market data and executes trades in a timely manner.