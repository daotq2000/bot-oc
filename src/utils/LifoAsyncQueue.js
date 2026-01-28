export class LifoAsyncQueue {
  constructor({ concurrency = 1, maxSize = 1000, name = 'LifoAsyncQueue' } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxSize = Math.max(1, Number(maxSize) || 1);

    this._stack = []; // LIFO
    this._inFlight = 0;
    this._running = false;

    // Dedupe: key -> { task, resolve, reject, meta }
    this._pendingByKey = new Map();
  }

  get size() {
    return this._stack.length;
  }

  get inFlight() {
    return this._inFlight;
  }

  /**
   * Push a task to the top of the stack.
   * If key is provided, replaces any pending task with same key (LIFO semantics + dedupe).
   * @param {Object} opts
   * @param {string|null} opts.key
   * @param {Function} opts.fn async function
   * @param {number} opts.priority optional (higher first). default 0
   * @param {number} opts.maxRetries default 3
   * @param {number} opts.baseDelayMs default 200
   */
  push({ key = null, fn, priority = 0, maxRetries = 3, baseDelayMs = 200 } = {}) {
    if (typeof fn !== 'function') {
      throw new Error(`[${this.name}] push requires fn`);
    }

    // If queue is full, drop oldest (bottom of stack) to keep newest tasks.
    // IMPORTANT: if dropped task has a key, reject its promise.
    while (this._stack.length >= this.maxSize) {
      const dropped = this._stack.shift();
      if (dropped?.key && this._pendingByKey.has(dropped.key)) {
        const entry = this._pendingByKey.get(dropped.key);
        this._pendingByKey.delete(dropped.key);
        entry.reject(new Error(`[${this.name}] Dropped task due to maxSize overflow (key=${dropped.key})`));
      } else if (dropped?.reject) {
        dropped.reject(new Error(`[${this.name}] Dropped task due to maxSize overflow`));
      }
    }

    // Replace pending task with same key
    if (key && this._pendingByKey.has(key)) {
      const existing = this._pendingByKey.get(key);
      // Keep the promise chain: resolve/reject the SAME promise when latest runs.
      // So we reject the previous pending promise to prevent await deadlocks.
      try {
        existing.reject(new Error(`[${this.name}] Superseded by a newer task (key=${key})`));
      } catch (_) {}
      this._pendingByKey.delete(key);
      // Remove the existing task from stack (if present)
      this._stack = this._stack.filter(t => t.key !== key);
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
        enqueuedAt: Date.now()
      };

      if (key) this._pendingByKey.set(key, task);

      // Push to top (LIFO)
      this._stack.push(task);

      // Maintain priority within LIFO: newest wins, but if priority differs, higher priority bubbles to top.
      // Simple stable sort: by priority asc then by enqueuedAt asc, then pop() takes highest/newest.
      this._stack.sort((a, b) => {
        const pa = Number(a.priority) || 0;
        const pb = Number(b.priority) || 0;
        if (pa !== pb) return pa - pb;
        return (a.enqueuedAt || 0) - (b.enqueuedAt || 0);
      });

      this._drain();
    });
  }

  async _drain() {
    if (this._running) return;
    this._running = true;

    try {
      while (this._inFlight < this.concurrency && this._stack.length > 0) {
        const task = this._stack.pop(); // LIFO
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
        const res = await task.fn();
        if (key) this._pendingByKey.delete(key);
        task.resolve(res);
        return;
      } catch (e) {
        lastErr = e;
        attempt += 1;
        if (attempt > task.maxRetries) break;
        const backoff = task.baseDelayMs * attempt;
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    if (key) this._pendingByKey.delete(key);
    task.reject(lastErr || new Error(`[${this.name}] Task failed`));
  }
}

