/**
 * iroh 承载：本地 `dumbpipe connect-tcp` ↔ 对端 `dumbpipe listen-tcp`。
 *
 * 三件事都在这里：
 * 1. ticket 获取（ticketCommand → ticketFile → 静态 ticket，每次 start 都重取，
 *    因为对端 listener 重启后 ticket 会变）；
 * 2. 用持久身份（IROH_SECRET）拉起 dumbpipe，让对端看到的 NodeId 稳定；
 * 3. 把子进程退出上报给服务层（服务层统一做退避重启/切 fallback）。
 */

import { EventEmitter } from 'node:events';

import { extractTicket, loadOrCreateIdentity, maskSecretLines } from '../shared.js';

export class IrohTransport extends EventEmitter {
  constructor({ peer, config, deps = {} }) {
    super();
    this.id = 'iroh';
    this.peer = peer;
    this.config = config;
    this.deps = deps;
    // 真正 bind 的是后端端口（服务层分配、每次重启轮换）；前端口由 LocalFront 持有。
    this._bindPort = Number.isInteger(peer.listenPort) ? peer.listenPort : peer.localPort;
    this._child = null;
    this._ticket = '';
    this._ticketSource = '';
    this._stopping = false;
  }

  get localEndpoint() {
    return `127.0.0.1:${this._bindPort}`;
  }

  isRunning() {
    return this._child !== null;
  }

  get ticket() {
    return this._ticket;
  }

  _log(level, message) {
    try {
      this.deps.logger?.[level]?.(message);
    } catch {
      /* ignore */
    }
  }

  async _resolveTicket() {
    const peer = this.peer;
    const runCommand = this.deps.runCommandFn;
    if (peer.ticketCommand?.length && typeof runCommand === 'function') {
      try {
        const output = await runCommand(peer.ticketCommand, {
          timeoutMs: this.config.ticketCommandTimeoutMs,
        });
        const ticket = extractTicket(output);
        if (ticket) return { ticket, source: 'command' };
        this._log('warn', `[iroh-link] ${peer.name} ticketCommand 输出里没有 ticket`);
      } catch (err) {
        this._log('warn', `[iroh-link] ${peer.name} ticketCommand 失败：${err?.message ?? err}`);
      }
    }
    if (peer.ticketFile) {
      try {
        const ticket = extractTicket(this.deps.fsImpl.readFileSync(peer.ticketFile, 'utf8'));
        if (ticket) return { ticket, source: 'file' };
        this._log('warn', `[iroh-link] ${peer.name} ticket 文件里没有 ticket：${peer.ticketFile}`);
      } catch (err) {
        this._log('warn', `[iroh-link] ${peer.name} 读 ticket 文件失败：${err?.message ?? err}`);
      }
    }
    if (peer.ticket) return { ticket: peer.ticket, source: 'static' };
    throw new Error('没有可用 ticket（ticketCommand / ticketFile / ticket 都不可用）');
  }

  async start() {
    this._stopping = false;
    const { ticket, source } = await this._resolveTicket();
    this._ticket = ticket;
    this._ticketSource = source;
    const env = { ...process.env };
    const identity = loadOrCreateIdentity(this.deps.fsImpl, this.config.identityFile, (message) =>
      this._log('info', `[iroh-link] ${message}`),
    );
    if (identity) env.IROH_SECRET = identity;
    const args = ['connect-tcp', '--addr', this.localEndpoint, ticket];
    const child = this.deps.spawnFn(this.config.binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    });
    this._child = child;
    child?.on?.('error', (err) => {
      this._log('warn', `[iroh-link] ${this.peer.name} dumbpipe 进程错误：${err?.message ?? err}`);
    });
    child?.once?.('exit', (code, signal) => {
      if (this._child === child) this._child = null;
      if (this._stopping) return;
      this.emit('exit', { code, signal });
    });
    try {
      let buffered = '';
      child?.stderr?.on?.('data', (chunk) => {
        buffered += String(chunk);
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this._log('warn', `[iroh-link] ${this.peer.name}: ${maskSecretLines(line.trim())}`);
        }
      });
    } catch {
      /* stdio 不可用就只是少日志 */
    }
    this._log('info', `[iroh-link] ${this.peer.name} iroh 承载启动：${this.localEndpoint} <- ticket(${source})`);
  }

  stop() {
    this._stopping = true;
    const child = this._child;
    this._child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  status() {
    return {
      id: this.id,
      pid: this._child?.pid ?? null,
      state: this._child ? 'running' : 'stopped',
      localEndpoint: this.localEndpoint,
      ticket: this._ticket,
      ticketSource: this._ticketSource,
      lastError: null,
    };
  }
}
