/**
 * ssh 承载（回退用）：`ssh -N -L 127.0.0.1:<localPort>:<host>:<remotePort>`。
 *
 * 这是「iroh 不可用时不把链路搞死」的退路：本地端口不变，dsh-interconnect
 * 完全无感。命令由配置的 `sshCommand` argv 决定（不经过 shell）。
 *
 * 已知边界：对端 DSH webserver 端口若每次重启都变，这条回退会失效——
 * 回退命令里的远端端口是静态的。需要动态端口时用 iroh（对端 iroh-host.ps1
 * 会重新发现端口），或在回退脚本里自己探端口。
 */

import { EventEmitter } from 'node:events';

export class SshTransport extends EventEmitter {
  constructor({ peer, config, deps = {} }) {
    super();
    this.id = 'ssh';
    this.peer = peer;
    this.config = config;
    this.deps = deps;
    this._bindPort = Number.isInteger(peer.listenPort) ? peer.listenPort : peer.localPort;
    this._child = null;
    this._stopping = false;
  }

  get localEndpoint() {
    return `127.0.0.1:${this._bindPort}`;
  }

  isRunning() {
    return this._child !== null;
  }

  get ticket() {
    return null;
  }

  _log(level, message) {
    try {
      this.deps.logger?.[level]?.(message);
    } catch {
      /* ignore */
    }
  }

  async start() {
    this._stopping = false;
    const template = this.peer.sshCommand;
    if (!Array.isArray(template) || template.length === 0) {
      throw new Error('ssh 承载需要 sshCommand（argv 数组，例如 [ssh, -N, -L, 127.0.0.1:{port}:127.0.0.1:53329, user@host]）');
    }
    if (!template.some((part) => part.includes('{port}'))) {
      throw new Error('sshCommand 里必须有 {port} 占位符（前端口由 LocalFront 持有，ssh 只能 bind 后端端口）');
    }
    const argv = template.map((part) => part.replaceAll('{port}', String(this._bindPort)));
    const child = this.deps.spawnFn(argv[0], argv.slice(1), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this._child = child;
    child?.on?.('error', (err) => {
      this._log('warn', `[iroh-link] ${this.peer.name} ssh 进程错误：${err?.message ?? err}`);
    });
    child?.once?.('exit', (code, signal) => {
      if (this._child === child) this._child = null;
      if (this._stopping) return;
      this.emit('exit', { code, signal });
    });
    try {
      child?.stderr?.on?.('data', (chunk) => {
        const line = String(chunk).trim();
        if (line) this._log('warn', `[iroh-link] ${this.peer.name} ssh: ${line.slice(0, 400)}`);
      });
    } catch {
      /* ignore */
    }
    this._log('info', `[iroh-link] ${this.peer.name} ssh 承载启动：${this.localEndpoint}`);
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
      ticket: null,
      ticketSource: '',
      lastError: null,
    };
  }
}
