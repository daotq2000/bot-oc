import { configService } from '../services/ConfigService.js';

export function shouldLogSampled(key, everyN = 10) {
  const enabled = configService.getBoolean('LOG_SAMPLING_ENABLED', true);
  if (!enabled) return true;

  const n = Math.max(1, Number(configService.getNumber(`LOG_SAMPLE_${String(key).toUpperCase()}_N`, everyN)) || everyN);
  if (n <= 1) return true;

  const r = Math.floor(Math.random() * n);
  return r === 0;
}

