/**
 * Efficient LRU Cache với O(1) operations
 * 
 * Map trong JavaScript maintains insertion order, cho phép O(1) eviction
 * của least recently used item (first item).
 */
export class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map(); // Map maintains insertion order (LRU)
  }

  /**
   * Get value by key
   * Moves item to end (most recently used) - O(1)
   * @param {string} key
   * @returns {any|null}
   */
  get(key) {
    if (!this.cache.has(key)) return null;
    
    // Move to end (most recently used) - O(1)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Set value by key
   * Evicts least recently used if at capacity - O(1)
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    if (this.cache.has(key)) {
      // Update existing - move to end
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item) - O(1)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  /**
   * Check if key exists
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Delete key
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache size
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Get all entries (for cleanup/iteration)
   * @returns {Iterator}
   */
  entries() {
    return this.cache.entries();
  }

  /**
   * Get all keys
   * @returns {Iterator}
   */
  keys() {
    return this.cache.keys();
  }

  /**
   * Get all values
   * @returns {Iterator}
   */
  values() {
    return this.cache.values();
  }
}

