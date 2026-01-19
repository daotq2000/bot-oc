import { configService } from './ConfigService.js';

/**
 * Alert mode switches for experimentation.
 *
 * PRICE_ALERT_USE_SCANNER=true  => enable PriceAlertScanner (polling)
 * PRICE_ALERT_USE_WEBSOCKET=true => enable RealtimeOCDetector event-driven (WS ticks)
 *
 * Default: scanner=false, websocket=true (realtime)
 */
export const alertMode = {
  useScanner() {
    // ✅ Option 1: Chỉ dùng PriceAlertScanner với order execution
    return configService.getBoolean('PRICE_ALERT_USE_SCANNER', true);
  },
  useWebSocket() {
    // ⚠️ Disable RealtimeOCDetector để tránh duplicate alerts/orders
    return configService.getBoolean('PRICE_ALERT_USE_WEBSOCKET', true);
  }
};
