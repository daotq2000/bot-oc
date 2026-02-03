import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ChildProcessManager {
  constructor() {
    this.children = new Map(); // name -> { proc, script, env, startedAt, lastMessageAt, status, lastHeartbeatAt, restartCount, lastStats }
  }

  start(name, scriptRelative, env = {}, opts = {}) {
    const script = path.resolve(__dirname, '..', scriptRelative);
    const autoRestart = opts.autoRestart !== false;

    const childInfo = {
      proc: null,
      script,
      env,
      startedAt: 0,
      lastMessageAt: 0,
      lastHeartbeatAt: 0,
      status: 'starting',
      restartCount: 0,
      autoRestart,
      lastStats: null,
      lastStatsAt: 0
    };

    const spawn = () => {
      const p = fork(script, {
        env: { ...process.env, ...env },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
      });

      childInfo.proc = p;
      childInfo.startedAt = Date.now();
      childInfo.status = 'running';

      p.on('message', (msg) => {
        childInfo.lastMessageAt = Date.now();
        if (msg?.type === 'heartbeat') {
          childInfo.lastHeartbeatAt = Date.now();
        }
        if (msg?.type === 'status') {
          childInfo.status = msg.status || childInfo.status;
        }
        if (msg?.type === 'stats') {
          childInfo.lastStats = msg.stats || null;
          childInfo.lastStatsAt = Date.now();
        }
      });

      p.on('exit', (code, signal) => {
        childInfo.status = `exited:${code ?? 'null'}:${signal ?? 'null'}`;
        logger.warn(`[ChildProcessManager] Child ${name} exited code=${code} signal=${signal}`);
        if (autoRestart) {
          const delay = Math.min(30000, 1000 * Math.max(1, childInfo.restartCount + 1));
          childInfo.restartCount++;
          setTimeout(() => spawn(), delay);
        }
      });

      p.on('error', (err) => {
        childInfo.status = 'error';
        logger.error(`[ChildProcessManager] Child ${name} error: ${err?.message || err}`);
      });
    };

    spawn();
    this.children.set(name, childInfo);
    return childInfo;
  }

  stop(name) {
    const child = this.children.get(name);
    if (!child?.proc) return false;
    try {
      child.proc.send?.({ type: 'shutdown' });
      setTimeout(() => {
        try { child.proc.kill('SIGTERM'); } catch (_) {}
      }, 5000);
      return true;
    } catch (_) {
      return false;
    }
  }

  stopAll() {
    for (const name of this.children.keys()) {
      this.stop(name);
    }
  }

  getStatus() {
    const out = {};
    for (const [name, c] of this.children.entries()) {
      out[name] = {
        pid: c.proc?.pid || null,
        script: c.script,
        status: c.status,
        startedAt: c.startedAt,
        lastMessageAt: c.lastMessageAt,
        lastHeartbeatAt: c.lastHeartbeatAt,
        restartCount: c.restartCount,
        lastStats: c.lastStats,
        lastStatsAt: c.lastStatsAt
      };
    }
    return out;
  }
}
