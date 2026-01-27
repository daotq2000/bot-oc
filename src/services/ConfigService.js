import { AppConfig } from '../models/AppConfig.js';
import logger from '../utils/logger.js';

class ConfigService {
  constructor() {
    this.cache = new Map();
    this.loaded = false;
    this.lastLoadedAt = 0;
  }

  /**
   * For some runtime toggles we want ENV to override DB (for quick tests).
   * Example: ADV_TPSL_* toggles.
   */
  _shouldPreferEnv(key) {
    const k = String(key || '').toUpperCase();
    return (
      k.startsWith('ADV_TPSL_') ||
      k.startsWith('PNL_ALERT_') ||
      k.startsWith('ENTRY_GATE_TRACE_') ||
      k.startsWith('WS_OC_GATE_')
    );
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
    const envKey = String(key).toUpperCase();
    const envVal = process.env[envKey];
    if (this._shouldPreferEnv(key) && envVal !== undefined && envVal !== '') {
      return String(envVal);
    }

    const v = this.getRaw(key);
    if (v === null || v === undefined || v === '') {
      // Fallback to environment variable if not found in database
      if (envVal !== undefined && envVal !== '') {
        return String(envVal);
      }
      return defVal;
    }
    return String(v);
  }

  getNumber(key, defVal = 0) {
    const envKey = String(key).toUpperCase();
    const envVal = process.env[envKey];
    if (this._shouldPreferEnv(key) && envVal !== undefined && envVal !== '') {
      const n = Number(envVal);
      return Number.isFinite(n) ? n : defVal;
    }

    const raw = this.getRaw(key);
    let source = raw;
    if (raw === null || raw === undefined || raw === '') {
      if (envVal === undefined || envVal === '') return defVal;
      source = envVal;
    }
    const n = Number(source);
    return Number.isFinite(n) ? n : defVal;
  }

  getBoolean(key, defVal = false) {
    const envKey = String(key).toUpperCase();
    const envVal = process.env[envKey];
    if (this._shouldPreferEnv(key) && envVal !== undefined && envVal !== '') {
      const s = String(envVal).toLowerCase().trim();
      if (['1','true','yes','y','on'].includes(s)) return true;
      if (['0','false','no','n','off'].includes(s)) return false;
      return defVal;
    }

    const raw = this.getRaw(key);
    let source = raw;
    if (raw === null || raw === undefined || raw === '') {
      if (envVal === undefined || envVal === '') return defVal;
      source = envVal;
    }
    const s = String(source).toLowerCase().trim();
    if (['1','true','yes','y','on'].includes(s)) return true;
    if (['0','false','no','n','off'].includes(s)) return false;
    return defVal;
  }
}

export const configService = new ConfigService();

