/**
 * Bollinger Bands Calculator
 * 
 * Used for trend confirmation and entry filtering.
 */
export class BB {
  /**
   * Calculate Bollinger Bands from values
   * @param {Object} options - { period, values, stdDev }
   * @returns {Array<{upper: number, middle: number, lower: number}>} Array of BB values
   */
  static calculate({ period, values, stdDev = 2 }) {
    if (!Array.isArray(values) || values.length < period) {
      return [];
    }

    const result = [];
    for (let i = period - 1; i < values.length; i++) {
      // Calculate SMA (middle band)
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += Number(values[i - j]) || 0;
      }
      const middle = sum / period;

      // Calculate Standard Deviation
      let sumSquaredDiff = 0;
      for (let j = 0; j < period; j++) {
        const diff = (Number(values[i - j]) || 0) - middle;
        sumSquaredDiff += diff * diff;
      }
      const std = Math.sqrt(sumSquaredDiff / period);

      // Calculate bands
      const deviation = std * stdDev;
      result.push({
        upper: middle + deviation,
        middle: middle,
        lower: middle - deviation
      });
    }
    return result;
  }
}
