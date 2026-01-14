/**
 * A simple in-memory cache that is valid only for a single scan cycle.
 * It's designed to be manually cleared at the start of each cycle.
 */
export class ScanCycleCache {
  constructor() {
    this.cache = new Map();
  }

  /**
   * Retrieves a value from the cache. If the value is a promise, it awaits it.
   * @param {string} key - The cache key.
   * @returns {Promise<any|undefined>} The cached value or undefined if not found.
   */
  async get(key) {
    const value = this.cache.get(key);
    return value;
  }

  /**
   * Stores a value (or a promise for a value) in the cache.
   * @param {string} key - The cache key.
   * @param {any|Promise<any>} value - The value or promise to store.
   */
  set(key, value) {
    this.cache.set(key, value);
  }

  /**
   * Checks if a key exists in the cache.
   * @param {string} key - The cache key.
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Clears the entire cache. Should be called at the start of each scan cycle.
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Gets a value from the cache or executes a fetch function if not present,
   * caching the result (which is expected to be a promise).
   * @param {string} key - The cache key.
   * @param {Function} fetchFn - An async function that returns a promise for the value.
   * @returns {Promise<any>}
   */
  getOrSet(key, fetchFn) {
    if (this.has(key)) {
      return this.get(key);
    }
    const promise = fetchFn();
    this.set(key, promise);
    return promise;
  }
}

