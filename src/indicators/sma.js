/**
 * Simple Moving Average (SMA) Calculator
 * 
 * Used for Volume MA calculation in entry filters.
 */
export class SMA {
  /**
   * Calculate SMA array from values
   * @param {Object} options - { period, values }
   * @returns {number[]} Array of SMA values
   */
  static calculate({ period, values }) {
    if (!Array.isArray(values) || values.length < period) {
      return [];
    }

    const result = [];
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += Number(values[i - j]) || 0;
      }
      result.push(sum / period);
    }
    return result;
  }
}
