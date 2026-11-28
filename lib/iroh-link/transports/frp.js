/**
 * frp 承载：对端跑 frpc，把它本机的 DSH webserver 端口暴露成公网地址
 * （SakuraFrp / NATAPP 这类标准 frp 协议的 SaaS），本机**不跑任何进程**，
 * 只把 LocalFront 的后端目标指到那个公网 `host:port`。
 *
 * 与 iroh/ssh 的区别：
 *   - iroh/ssh 在本机拉起隧道进程、bind 一个动态本地后端端口；frp 没有本地进程、
 *     没有本地后端端口，后端就是公网地址（由对端 frpc 维护）。
 *   - 因此 start() 是「校验配置 + 置 active」的 no-op，stop() 只改状态，
 *     pid 恒为 null；`frontTarget` 让服务层把 LocalFront 指到公网目标
 *     （其它 transport 没有该成员，服务层回退到分配的后端端口）。
 *
 * 生命周期/探活语义与其他 transport 一致：服务层照旧探前端口 `/interconnect/link`
 * （101=通；401/403=承载通、鉴权失败不重启；连不上=断）。本类只负责如实报告
 * 「配置是否可用」，不假装隧道可达。
 *
 * 已知边界（不要把下面的说成已验证）：
 *   - 对端 DSH webserver 端口每次重启都会变，frpc 的本地端口是静态配置；对端需要
 *     自己把 frpc 指向固定端口（或像 iroh-host.ps1 那样发现端口后重配 frpc）。
 *     本轮不做对端 frpc 守护，也不做动态端口发现。
 *   - 只封装 TCP 隧道（frp 的本地端口转发）。HTTP(S) 反代隧道依赖 webserver 接受
 *     第三方 Host——DSH 实测没有 Host 校验（docs/iroh-link.md §7），但本轮不封装。
 *   - 不在 start() 里做网络 IO（不校验公网目标可达）：可达性是服务层三档探活的事，
 *     start() 失败语义只表示「配置坏了」。
 */

import { EventEmitter } from 'node:events';

import { normalizeFrpTarget } from '../shared.js';

/** 只收域名/IP；带端口或路径的一律在 start() 里报可读错。 */
const HOST_RE = /^[^\s/:]+$/;

export class FrpTransport extends EventEmitter {
  constructor({ peer, config, deps = {} }) {
    super();
    this.id = 'frp';
    this.peer = peer;
    this.config = config;
    this.deps = deps;
    this.target = normalizeFrpTarget(peer?.frp);
    this._active = false;
    this._lastError = null;
  }

  /** 服务层把 transport.localEndpoint 当「后端端点」展示：frp 的后端就是公网目标。 */
  get localEndpoint() {
    const { remoteHost, remotePort } = this.target;
    return remoteHost && remotePort
      ? `${remoteHost}:${remotePort}`
      : `127.0.0.1:${this.peer.localPort}`;
  }

  /** 服务层据此把 LocalFront 指到公网目标；其它 transport 没有这个成员。 */
  get frontTarget() {
    const { remoteHost, remotePort } = this.target;
    return remoteHost && remotePort ? { host: remoteHost, port: remotePort } : null;
  }

  get ticket() {
    return null;
  }

  isRunning() {
    return this._active;
  }

  _log(level, message) {
    try {
      this.deps.logger?.[level]?.(message);
    } catch {
      /* 日志坏了不能影响承载 */
    }
  }

  _fail(message) {
    this._lastError = message;
    return new Error(message);
  }

  async start() {
    const { remoteHost, remotePort } = this.target;
    if (!remoteHost) {
      throw this._fail(
        'frp 承载需要 peer.frp.remoteHost（对端 frpc 暴露的公网域名或 IP，例如 xxx.sakurafrp.cc）',
      );
    }
    if (!HOST_RE.test(remoteHost)) {
      throw this._fail(
        `frp 承载的 peer.frp.remoteHost 不合法：${remoteHost}（只填域名/IP，端口写到 peer.frp.remotePort）`,
      );
    }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw this._fail(`frp 承载需要 peer.frp.remotePort（1-65535 的整数，当前 ${remotePort}）`);
    }
    this._active = true;
    this._lastError = null;
    this._log(
      'info',
      `[iroh-link] ${this.peer.name} frp 承载就绪：前端口 127.0.0.1:${this.peer.localPort} -> 公网 ${remoteHost}:${remotePort}（本机不起进程，对端 frpc 负责暴露）`,
    );
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    // 没有子进程可等：服务层的 _waitStopped 靠 'exit' 事件判断停干净，这里补一个。
    this.emit('exit', { code: null, signal: 'SIGTERM' });
  }

  status() {
    return {
      id: this.id,
      pid: null,
      state: this._active ? 'running' : 'stopped',
      localEndpoint: this.localEndpoint,
      ticket: null,
      ticketSource: '',
      lastError: this._lastError,
    };
  }
}
