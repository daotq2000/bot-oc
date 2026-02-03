import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

/**
 * LogMonitorService
 * - Tails JSONL log files (combined.log, error.log)
 * - Detects websocket-related errors and triggers safe auto-fix hooks
 * - Debounced to prevent reconnect storms
 */
class LogMonitorService {
  constructor() {
    this._running = false;
    this._pollTimer = null;

    this._files = [];
    this._offsetByFile = new Map();
    this._inodeByFile = new Map();

    this._pollIntervalMs = 1000;
    this._maxBytesPerPoll = 512 * 1024;

    this._onEvent = null;

    this._cooldowns = new Map(); // key -> nextAllowedAt
    this._defaultCooldownMs = 15000;

    this._tickStarvation = {
      enabled: true,
      thresholdMs: 60000,
      checkEveryMs: 10000,
      timer: null,
      getState: null
    };
  }

  configure({
    logFiles,
    pollIntervalMs,
    maxBytesPerPoll,
    defaultCooldownMs,
    onEvent,
    tickStarvation
  } = {}) {
    if (Array.isArray(logFiles)) this._files = logFiles;
    if (Number.isFinite(pollIntervalMs)) this._pollIntervalMs = Math.max(200, pollIntervalMs);
    if (Number.isFinite(maxBytesPerPoll)) this._maxBytesPerPoll = Math.max(16 * 1024, maxBytesPerPoll);
    if (Number.isFinite(defaultCooldownMs)) this._defaultCooldownMs = Math.max(1000, defaultCooldownMs);
    if (typeof onEvent === 'function') this._onEvent = onEvent;

    if (tickStarvation && typeof tickStarvation === 'object') {
      this._tickStarvation.enabled = Boolean(tickStarvation.enabled ?? this._tickStarvation.enabled);
      if (Number.isFinite(tickStarvation.thresholdMs)) this._tickStarvation.thresholdMs = Math.max(5000, tickStarvation.thresholdMs);
      if (Number.isFinite(tickStarvation.checkEveryMs)) this._tickStarvation.checkEveryMs = Math.max(1000, tickStarvation.checkEveryMs);
      if (typeof tickStarvation.getState === 'function') this._tickStarvation.getState = tickStarvation.getState;
    }
  }

  start() {
    if (this._running) return;
    this._running = true;

    for (const f of this._files) {
      this._offsetByFile.set(f, 0);
      this._inodeByFile.set(f, null);
    }

    this._pollTimer = setInterval(() => {
      this._pollOnce().catch(err => {
        logger.warn(`[LogMonitor] poll error: ${err?.message || err}`);
      });
    }, this._pollIntervalMs);

    if (this._tickStarvation.enabled) {
      if (this._tickStarvation.timer) clearInterval(this._tickStarvation.timer);
      this._tickStarvation.timer = setInterval(() => {
        this._checkTickStarvation().catch(err => {
          logger.warn(`[LogMonitor] tick-starvation check error: ${err?.message || err}`);
        });
      }, this._tickStarvation.checkEveryMs);
    }

    logger.info(`[LogMonitor] Started (files=${this._files.length}, poll=${this._pollIntervalMs}ms)`);
  }

  stop() {
    this._running = false;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;

    if (this._tickStarvation.timer) clearInterval(this._tickStarvation.timer);
    this._tickStarvation.timer = null;

    logger.info('[LogMonitor] Stopped');
  }

  _shouldFire(key, cooldownMs = this._defaultCooldownMs) {
    const now = Date.now();
    const nextAllowedAt = Number(this._cooldowns.get(key) || 0);
    if (now < nextAllowedAt) return false;
    this._cooldowns.set(key, now + cooldownMs);
    return true;
  }

  async _pollOnce() {
    if (!this._running) return;

    for (const filePath of this._files) {
      await this._pollFile(filePath);
      // small yield to avoid long blocking loops
      await sleep(0);
    }
  }

  async _pollFile(filePath) {
    if (!filePath) return;

    let st;
    try {
      st = fs.statSync(filePath);
    } catch (_) {
      // File may not exist yet
      return;
    }

    const inode = st.ino;
    const prevInode = this._inodeByFile.get(filePath);
    if (prevInode && inode !== prevInode) {
      // rotated/recreated
      this._offsetByFile.set(filePath, 0);
    }
    this._inodeByFile.set(filePath, inode);

    const size = st.size;
    let offset = Number(this._offsetByFile.get(filePath) || 0);
    if (offset > size) offset = 0;

    const remaining = size - offset;
    if (remaining <= 0) return;

    const toRead = Math.min(remaining, this._maxBytesPerPoll);

    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      const read = fs.readSync(fd, buf, 0, toRead, offset);
      if (read <= 0) return;

      const chunk = buf.slice(0, read).toString('utf8');
      offset += read;
      this._offsetByFile.set(filePath, offset);

      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this._handleLine(line, filePath);
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }

  _emit(event) {
    try {
      this._onEvent?.(event);
    } catch (e) {
      logger.warn(`[LogMonitor] onEvent error: ${e?.message || e}`);
    }
  }

  _handleLine(line, filePath) {
    const obj = safeJsonParse(line);
    if (!obj) return;

    const level = String(obj.level || '').toLowerCase();
    const msg = String(obj.message || '');

    // WS reconnect triggers
    const isBinanceWs = msg.includes('[Binance-WS]');
    const isMexcWs = msg.includes('[MEXC-WS]');
    const isUserStream = msg.includes('[WS] User stream');

    if (level === 'error' || level === 'warn') {
      // Binance
      if (isBinanceWs) {
        if (
          msg.includes('Connection closed') ||
          msg.includes('Error:') ||
          msg.includes('Pong not received') ||
          msg.includes('starvation')
        ) {
          if (this._shouldFire('binance_ws_recover', 15000)) {
            this._emit({ type: 'recover_binance_ws', source: path.basename(filePath), message: msg, level });
          }
        }
      }

      // MEXC
      if (isMexcWs) {
        if (
          msg.includes('WebSocket disconnected') ||
          msg.includes('WebSocket error') ||
          msg.includes('Max reconnect attempts reached')
        ) {
          if (this._shouldFire('mexc_ws_recover', 15000)) {
            this._emit({ type: 'recover_mexc_ws', source: path.basename(filePath), message: msg, level });
          }
        }
      }

      // User stream
      if (isUserStream) {
        if (msg.includes('closed') || msg.includes('error')) {
          if (this._shouldFire('userstream_recover', 15000)) {
            this._emit({ type: 'recover_userstream', source: path.basename(filePath), message: msg, level });
          }
        }
      }

      // Generic: ECONNRESET/ETIMEDOUT
      if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('EAI_AGAIN')) {
        if (this._shouldFire('net_recover', 20000)) {
          this._emit({ type: 'recover_network', source: path.basename(filePath), message: msg, level });
        }
      }
    }
  }

  async _checkTickStarvation() {
    if (!this._tickStarvation.enabled) return;
    if (typeof this._tickStarvation.getState !== 'function') return;

    const st = this._tickStarvation.getState();
    if (!st) return;

    const isRunning = Boolean(st.isRunning);
    const timeSinceLastTick = st.timeSinceLastTick;

    if (!isRunning) return;
    if (timeSinceLastTick == null) return;

    if (timeSinceLastTick > this._tickStarvation.thresholdMs) {
      if (this._shouldFire('ws_tick_starvation', 30000)) {
        this._emit({
          type: 'recover_tick_starvation',
          source: 'tickStarvation',
          message: `WS tick starvation detected: ${Math.round(timeSinceLastTick / 1000)}s without ticks`,
          level: 'warn'
        });
      }
    }
  }
}

export const logMonitorService = new LogMonitorService();

