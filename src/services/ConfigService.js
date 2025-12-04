import { AppConfig } from '../models/AppConfig.js';
import logger from '../utils/logger.js';

class ConfigService {
  constructor() {
    this.cache = new Map();
    this.loaded = false;
    this.lastLoadedAt = 0;
  }

  async loadAll() {
    try {
      const rows = await AppConfig.findAll();
      this.cache.clear();
      for (const row of rows) {
        this.cache.set(String(row.config_key).toUpperCase(), row.config_value);
      }
      this.loaded = true;
      this.lastLoadedAt = Date.now();
      logger.info(`[ConfigService] Loaded ${rows.length} app configs from database.`);
    } catch (e) {
      logger.error(`[ConfigService] Failed to load app configs: ${e?.message || e}`);
      // keep loaded=false; callers should fallback gracefully
    }
  }

  getRaw(key) {
    if (!key) return null;
    const k = String(key).toUpperCase();
    if (this.cache.has(k)) return this.cache.get(k);
    return null;
  }

  getString(key, defVal = null) {
    const v = this.getRaw(key);
    if (v === null || v === undefined || v === '') return defVal;
    return String(v);
  }

  getNumber(key, defVal = 0) {
    const v = this.getRaw(key);
    if (v === null || v === undefined || v === '') return defVal;
    const n = Number(v);
    return Number.isFinite(n) ? n : defVal;
  }

  getBoolean(key, defVal = false) {
    const v = this.getRaw(key);
    if (v === null || v === undefined || v === '') return defVal;
    const s = String(v).toLowerCase().trim();
    if (['1','true','yes','y','on'].includes(s)) return true;
    if (['0','false','no','n','off'].includes(s)) return false;
    return defVal;
  }
}

export const configService = new ConfigService();

