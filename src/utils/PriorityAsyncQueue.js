/**
 * PriorityAsyncQueue - Age-based priority queue for TP/SL placement
 * 
 * Key features:
 * - Priority based on position age (older positions = higher priority)
 * - Per-bot concurrency control
 * - Global concurrency control for multi-bot scenarios
 * - Task deduplication with key
 * - Exponential backoff retry
 * - Task timeout handling
 * - Batch verification support
 */
export class PriorityAsyncQueue {
  /**
   * @param {Object} options
   * @param {number} options.concurrency - Max concurrent tasks (default: 5)
   * @param {number} options.maxSize - Max queue size (default: 500)
   * @param {string} options.name - Queue name for logging
   * @param {number} options.taskTimeoutMs - Task timeout in ms (default: 30000)
   */
  constructor({ 
    concurrency = 5, 
    maxSize = 500, 
    name = 'PriorityAsyncQueue',
    taskTimeoutMs = 30000
  } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, Number(concurrency) || 5);
    this.maxSize = Math.max(1, Number(maxSize) || 500);
    this.taskTimeoutMs = Math.max(5000, Number(taskTimeoutMs) || 30000);

    // Priority queue: sorted by priority DESC (higher = more urgent)
    this._queue = [];
    this._inFlight = 0;
    this._running = false;

    // Dedupe: key -> task reference
    this._pendingByKey = new Map();
    
    // Metrics
    this._totalProcessed = 0;
    this._totalDropped = 0;
    this._totalTimeout = 0;
    this._totalFailed = 0;
  }

  get size() {
    return this._queue.length;
  }

  get inFlight() {
    return this._inFlight;
  }

  get metrics() {
    return {
      pending: this._queue.length,
      inFlight: this._inFlight,
      totalProcessed: this._totalProcessed,
      totalDropped: this._totalDropped,
      totalTimeout: this._totalTimeout,
      totalFailed: this._totalFailed
    };
  }

  /**
   * Push a task to the queue with age-based priority
   * @param {Object} opts
   * @param {string|null} opts.key - Unique key for deduplication (e.g., `tpsl:${positionId}`)
   * @param {Function} opts.fn - Async function to execute
   * @param {number} opts.priority - Priority value (higher = more urgent). Use position age in ms.
   * @param {number} opts.maxRetries - Max retry attempts (default: 2)
   * @param {number} opts.baseDelayMs - Base delay for exponential backoff (default: 200)
   */
  push({ key = null, fn, priority = 0, maxRetries = 2, baseDelayMs = 200 } = {}) {
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`[${this.name}] push requires fn`));
    }

    // If queue is full, drop LOWEST priority tasks (newest/least urgent)
    while (this._queue.length >= this.maxSize) {
      // Queue is sorted by priority DESC, so shift() removes the lowest priority (at the end after sort)
      // Actually, we need to remove from the back (lowest priority)
      const dropped = this._queue.pop();
      if (dropped?.key && this._pendingByKey.has(dropped.key)) {
        const entry = this._pendingByKey.get(dropped.key);
        this._pendingByKey.delete(dropped.key);
        entry.reject(new Error(`[${this.name}] Dropped low-priority task (key=${dropped.key})`));
        this._totalDropped++;
      } else if (dropped?.reject) {
        dropped.reject(new Error(`[${this.name}] Dropped low-priority task`));
        this._totalDropped++;
      }
    }

    // Replace existing task with same key (take the HIGHER priority one)
    if (key && this._pendingByKey.has(key)) {
      const existing = this._pendingByKey.get(key);
      
      // If new task has higher priority, replace existing
      if (priority > existing.priority) {
        try {
          existing.reject(new Error(`[${this.name}] Superseded by higher-priority task (key=${key})`));
        } catch (_) {}
        this._pendingByKey.delete(key);
        this._queue = this._queue.filter(t => t.key !== key);
      } else {
        // Existing task has higher or equal priority, return existing promise
        return new Promise((resolve, reject) => {
          // Link to existing task's result
          const existingTask = this._queue.find(t => t.key === key);
          if (existingTask) {
            existingTask._additionalResolvers = existingTask._additionalResolvers || [];
            existingTask._additionalResolvers.push({ resolve, reject });
          } else {
            reject(new Error(`[${this.name}] Task not found (key=${key})`));
          }
        });
      }
    }

    return new Promise((resolve, reject) => {
      const task = {
        key,
        fn,
        priority: Number(priority) || 0,
        maxRetries: Math.max(0, Number(maxRetries) || 0),
        baseDelayMs: Math.max(0, Number(baseDelayMs) || 0),
        resolve,
        reject,
        enqueuedAt: Date.now(),
        _additionalResolvers: []
      };

      if (key) this._pendingByKey.set(key, task);

      this._queue.push(task);

      // Sort by priority DESC (highest priority first)
      this._queue.sort((a, b) => b.priority - a.priority);

      this._drain();
    });
  }

  /**
   * Push multiple tasks at once (batch push)
   * @param {Array<Object>} tasks - Array of task options
   * @returns {Promise<Array>} - Array of results
   */
  pushBatch(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return Promise.resolve([]);
    }
    return Promise.allSettled(tasks.map(t => this.push(t)));
  }

  async _drain() {
    if (this._running) return;
    this._running = true;

    try {
      while (this._inFlight < this.concurrency && this._queue.length > 0) {
        const task = this._queue.shift(); // Get highest priority (first element)
        if (!task) continue;

        // Task might have been superseded
        if (task.key && !this._pendingByKey.has(task.key)) {
          continue;
        }

        this._inFlight += 1;

        this._runTask(task)
          .catch(() => {})
          .finally(() => {
            this._inFlight -= 1;
            // Continue draining
            setImmediate(() => this._drain());
          });
      }
    } finally {
      this._running = false;
    }
  }

  async _runTask(task) {
    const { key } = task;

    let attempt = 0;
    let lastErr = null;

    while (attempt <= task.maxRetries) {
      try {
        // Task timeout
        const res = await this._runWithTimeout(task.fn, this.taskTimeoutMs);
        
        if (key) this._pendingByKey.delete(key);
        
        // Resolve main and additional resolvers
        task.resolve(res);
        for (const { resolve } of task._additionalResolvers || []) {
          try { resolve(res); } catch (_) {}
        }
        
        this._totalProcessed++;
        return;
      } catch (e) {
        lastErr = e;
        
        // Check if it's a timeout
        if (e?.message?.includes('TIMEOUT')) {
          this._totalTimeout++;
        }
        
        // Check if it's a non-retryable error
        const errMsg = e?.message || '';
        if (
          errMsg.includes('-2022') || // ReduceOnly rejected (ghost position)
          errMsg.includes('position_not_found') ||
          errMsg.includes('ghost_') ||
          errMsg.includes('TIMEOUT')
        ) {
          // Don't retry these errors
          break;
        }
        
        attempt += 1;
        if (attempt > task.maxRetries) break;
        
        const backoff = Math.min(task.baseDelayMs * Math.pow(2, attempt), 5000);
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    if (key) this._pendingByKey.delete(key);
    
    // Reject main and additional resolvers
    const error = lastErr || new Error(`[${this.name}] Task failed`);
    task.reject(error);
    for (const { reject } of task._additionalResolvers || []) {
      try { reject(error); } catch (_) {}
    }
    
    this._totalFailed++;
  }

  /**
   * Run function with timeout
   */
  async _runWithTimeout(fn, timeoutMs) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`[${this.name}] TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }

  /**
   * Clear all pending tasks
   */
  clear() {
    const dropped = this._queue.length;
    for (const task of this._queue) {
      try {
        task.reject(new Error(`[${this.name}] Queue cleared`));
        for (const { reject } of task._additionalResolvers || []) {
          try { reject(new Error(`[${this.name}] Queue cleared`)); } catch (_) {}
        }
      } catch (_) {}
    }
    this._queue = [];
    this._pendingByKey.clear();
    this._totalDropped += dropped;
    return dropped;
  }

  /**
   * Check if task with key is pending or in flight
   */
  has(key) {
    return this._pendingByKey.has(key);
  }
}

/**
 * GlobalTPSLQueueManager - Manages TP/SL queues for multiple bots
 * 
 * Features:
 * - Per-bot queues with fair scheduling
 * - Global rate limiting
 * - Batch position verification
 * - Automatic ghost position cleanup
 */
export class GlobalTPSLQueueManager {
  constructor(options = {}) {
    this.perBotConcurrency = Number(options.perBotConcurrency) || 3;
    this.globalConcurrency = Number(options.globalConcurrency) || 10;
    this.maxQueueSizePerBot = Number(options.maxQueueSizePerBot) || 200;
    this.taskTimeoutMs = Number(options.taskTimeoutMs) || 30000;
    
    // Per-bot queues
    this._queues = new Map(); // botId -> PriorityAsyncQueue
    
    // Global concurrency semaphore
    this._globalInFlight = 0;
    this._globalWaiters = [];
    
    // Position verification cache (reduces API calls)
    this._verificationCache = new Map(); // `${botId}:${symbol}` -> { positions, timestamp }
    this._verificationCacheTTL = 5000; // 5 seconds
    
    // Metrics
    this._startTime = Date.now();
  }

  /**
   * Get or create queue for a bot
   */
  getQueue(botId) {
    const id = String(botId);
    if (this._queues.has(id)) return this._queues.get(id);

    const queue = new PriorityAsyncQueue({
      concurrency: this.perBotConcurrency,
      maxSize: this.maxQueueSizePerBot,
      name: `TPSLQueue(bot=${id})`,
      taskTimeoutMs: this.taskTimeoutMs
    });

    this._queues.set(id, queue);
    return queue;
  }

  /**
   * Push a TP/SL task with global concurrency control
   */
  async pushTask(botId, { key, fn, priority, maxRetries = 2, baseDelayMs = 200 }) {
    const queue = this.getQueue(botId);
    
    // Wrap fn with global concurrency control
    const wrappedFn = async () => {
      // Acquire global semaphore
      await this._acquireGlobal();
      try {
        return await fn();
      } finally {
        this._releaseGlobal();
      }
    };

    return queue.push({
      key,
      fn: wrappedFn,
      priority,
      maxRetries,
      baseDelayMs
    });
  }

  /**
   * Acquire global concurrency slot
   */
  async _acquireGlobal() {
    if (this._globalInFlight < this.globalConcurrency) {
      this._globalInFlight++;
      return;
    }
    
    // Wait for a slot
    return new Promise(resolve => {
      this._globalWaiters.push(resolve);
    });
  }

  /**
   * Release global concurrency slot
   */
  _releaseGlobal() {
    this._globalInFlight--;
    
    // Wake up a waiter
    if (this._globalWaiters.length > 0 && this._globalInFlight < this.globalConcurrency) {
      const waiter = this._globalWaiters.shift();
      this._globalInFlight++;
      waiter();
    }
  }

  /**
   * Get cached exchange positions or fetch new
   */
  async getCachedExchangePositions(botId, exchangeService, symbol = null) {
    const cacheKey = `${botId}:${symbol || 'all'}`;
    const cached = this._verificationCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < this._verificationCacheTTL)) {
      return cached.positions;
    }

    try {
      const positions = await exchangeService.getOpenPositions(symbol);
      const result = Array.isArray(positions) ? positions : [];
      
      this._verificationCache.set(cacheKey, {
        positions: result,
        timestamp: Date.now()
      });
      
      return result;
    } catch (e) {
      // On error, return cached data if available (stale but better than nothing)
      if (cached) return cached.positions;
      throw e;
    }
  }

  /**
   * Clear verification cache for a bot
   */
  clearVerificationCache(botId = null) {
    if (botId) {
      for (const key of this._verificationCache.keys()) {
        if (key.startsWith(`${botId}:`)) {
          this._verificationCache.delete(key);
        }
      }
    } else {
      this._verificationCache.clear();
    }
  }

  /**
   * Get global metrics across all queues
   */
  getMetrics() {
    const metrics = {
      botsCount: this._queues.size,
      globalInFlight: this._globalInFlight,
      globalWaiters: this._globalWaiters.length,
      totalPending: 0,
      totalInFlight: 0,
      totalProcessed: 0,
      totalDropped: 0,
      totalTimeout: 0,
      totalFailed: 0,
      perBot: {}
    };

    for (const [botId, queue] of this._queues.entries()) {
      const qMetrics = queue.metrics;
      metrics.perBot[botId] = qMetrics;
      metrics.totalPending += qMetrics.pending;
      metrics.totalInFlight += qMetrics.inFlight;
      metrics.totalProcessed += qMetrics.totalProcessed;
      metrics.totalDropped += qMetrics.totalDropped;
      metrics.totalTimeout += qMetrics.totalTimeout;
      metrics.totalFailed += qMetrics.totalFailed;
    }

    return metrics;
  }

  /**
   * Get summary string for logging
   */
  getSummary() {
    const m = this.getMetrics();
    return `bots=${m.botsCount} pending=${m.totalPending} inFlight=${m.totalInFlight}/${this.globalConcurrency} ` +
           `processed=${m.totalProcessed} dropped=${m.totalDropped} timeout=${m.totalTimeout} failed=${m.totalFailed}`;
  }
}
