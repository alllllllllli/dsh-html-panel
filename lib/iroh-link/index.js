/**
 * iroh-link —— dsh-interconnect 的「承载层」（carrier），可插拔。
 *
 * dsh-interconnect 的协议层完全不动：它只认 `http://127.0.0.1:<localPort>` 能
 * 完成 WebSocket 升级（HTTP 101）+ token 校验。本模块负责把那个本地端口接到
 * 对端的 DSH webserver 上，**用哪种隧道是可换的**：
 *
 *   - `iroh`：n0-computer/dumbpipe 的 TCP-over-iroh（本机拉起进程）。
 *   - `ssh`（回退）：`ssh -N -L 127.0.0.1:<port>:<host>:<remotePort>`（本机拉起进程）。
 *   - `frp`：配置型承载，本机不起进程——对端 frpc 把 DSH webserver 暴露成公网
 *     `host:port`，LocalFront 直接转发过去（见 transports/frp.js）。
 *
 * transport 的最小接口（实现见 `transports/*.js`）：
 *
 *   class Transport {
 *     id: 'iroh' | 'ssh' | 'frp'
 *     localEndpoint: string          // 后端端点：iroh/ssh 是本地端口，frp 是公网 host:port
 *     ticket: string | null          // 需要带外交换的握手信息（iroh 有，ssh/frp 没有）
 *     async start(): Promise<void>   // 拉起承载进程；失败抛错（frp 为纯配置校验）
 *     stop(): void
 *     status(): { id, pid, state, localEndpoint, ticket, ticketSource, lastError }
 *     frontTarget?: { host, port }   // 可选：后端在远端（frp）时前端口直接转发过去
 *     // 子进程异常退出时 emit('exit', { code, signal })
 *   }
 *
 * 服务层管的是与隧道无关的东西：周期探活（/interconnect/link 的 101）、退避重启、
 * 主承载连续失败后切 fallback、状态快照。换一种隧道只需要新增一个 Transport？
 *
 * 四条硬约束（PoC 实测，别当理论）：
 * 1. 本地端口必须与 dsh-interconnect peers 配置里的端口一致，否则换承载要改
 *    profile（本模块的设计前提是「端口不变、只换后面那条隧道」）。
 * 2. 探活 101 才算通；拿到 401/403 说明隧道通但 token 不对，**不能重启隧道**。
 * 3. iroh 必须用完整 ticket（含直连地址/relay）；id-only ticket 依赖地址发现，
 *    实测现网连不上。ticket 走带外通道（命令/文件/静态），数据面不走 SSH。
 * 4. 对端 DSH webserver 端口每次重启都变，由对端 `iroh-host.ps1` 发现端口并
 *    重写 ticket 文件；本机重启承载时重取 ticket。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import {
  DEFAULT_FAILURES_BEFORE_RESTART,
  DEFAULT_MAX_RESTARTS_BEFORE_FALLBACK,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RESTART_BASE_MS,
  DEFAULT_RESTART_MAX_MS,
  DEFAULT_TICKET_COMMAND_TIMEOUT_MS,
  TRANSPORT_IDS,
  allocateFreePort,
  defaultBinaryPath,
  defaultCredFile,
  defaultIdentityFile,
  extractTicket,
  maskSecretLines,
  normalizeIrohLinkConfig,
  probeInterconnectLink,
  readInterconnectToken,
  runTicketCommand,
} from './shared.js';
import { LocalFront } from './front.js';
import { FrpTransport } from './transports/frp.js';
import { IrohTransport } from './transports/iroh.js';
import { SshTransport } from './transports/ssh.js';

/**
 * 可插拔点：加一种隧道 = 往这里加一行 + 写一个 Transport 子类。
 * key 是配置里 `transport` 的合法取值（TRANSPORT_IDS 同步维护）。
 */
export const TRANSPORTS = Object.freeze({
  iroh: IrohTransport,
  ssh: SshTransport,
  frp: FrpTransport,
});

export {
  DEFAULT_FAILURES_BEFORE_RESTART,
  DEFAULT_MAX_RESTARTS_BEFORE_FALLBACK,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RESTART_BASE_MS,
  DEFAULT_RESTART_MAX_MS,
  DEFAULT_TICKET_COMMAND_TIMEOUT_MS,
  TRANSPORT_IDS,
  allocateFreePort,
  defaultBinaryPath,
  defaultCredFile,
  defaultIdentityFile,
  extractTicket,
  maskSecretLines,
  normalizeIrohLinkConfig,
  probeInterconnectLink,
  readInterconnectToken,
  runTicketCommand,
};
/**
 * 承载服务：每个 peer 一条本地端口，负责选 transport、探活、退避重启、
 * 主承载挂了切 fallback。隧道细节全在 transports/*.js 里。
 */
export class IrohLinkService {
  constructor({
    config,
    logger = null,
    transports = TRANSPORTS,
    spawnFn = nodeSpawn,
    probeFn = probeInterconnectLink,
    fsImpl = fs,
    runCommandFn = runTicketCommand,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
    createFront = (opts) => new LocalFront(opts),
    allocatePortFn = allocateFreePort,
  } = {}) {
    this.config = config?.peers ? config : normalizeIrohLinkConfig(config);
    this.logger = logger;
    this.transports = transports;
    this.createFront = createFront;
    this.allocatePortFn = allocatePortFn;
    this.deps = { spawnFn, fsImpl, runCommandFn, now, logger };
    this.probeFn = probeFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.now = now;
    this._started = false;
    this._timer = null;
    this._token = null;
    /** @type {Record<string, import('./front.js').LocalFront>} */
    this._fronts = {};
    this._usedPorts = new Set();
    /** @type {Record<string, any>} */
    this._states = {};
    for (const peer of Object.values(this.config.peers ?? {})) {
      this._states[peer.name] = {
        transport: null,
        transportId: peer.transport,
        usingFallback: false,
        pid: null,
        state: 'stopped',
        ticket: '',
        restarts: 0,
        backoffStep: 0,
        failures: 0,
        lastError: null,
        lastExit: null,
        lastProbeAt: null,
        retryTimer: null,
        bootTimer: null,
        frontRetryTimer: null,
      };
    }
  }

  _log(level, message) {
    try {
      this.logger?.[level]?.(`[iroh-link] ${message}`);
    } catch {
      /* 日志坏了不能影响承载 */
    }
  }

  _tokenValue() {
    if (this._token) return this._token;
    try {
      this._token = readInterconnectToken(this.deps.fsImpl.readFileSync(this.config.credFile, 'utf8'));
    } catch {
      this._token = null;
    }
    return this._token;
  }

  _clearTimer(st, name) {
    const handle = st[name];
    if (handle === null || handle === undefined) return;
    try {
      this.clearTimeoutFn(handle);
    } catch {
      /* ignore */
    }
    st[name] = null;
  }

  _transportDeps() {
    return { ...this.deps };
  }

  /** 前端口：每个 peer 一个，整个服务生命周期只 bind 一次（躲开 TIME_WAIT）。 */
  async _ensureFront(peer) {
    const existing = this._fronts[peer.name];
    if (existing) return existing;
    const front = this.createFront({ localPort: peer.localPort, logger: this.logger ?? null });
    await front.listen();
    this._fronts[peer.name] = front;
    return front;
  }

  _frontOf(peer) {
    return this._fronts[peer.name] ?? null;
  }

  /**
   * 前端口占不到（常见：旧的 ssh -L 还占着 13086）时定期重试——
   * 不能因为启动瞬间端口被占就把这个 peer 永久废掉。
   */
  _scheduleFrontRetry(peer) {
    const st = this._states[peer.name];
    if (!this._started || st.frontRetryTimer) return;
    st.frontRetryTimer = this.setTimeoutFn(async () => {
      st.frontRetryTimer = null;
      if (!this._started || this._fronts[peer.name]) return;
      try {
        await this._ensureFront(peer);
        const front = this._fronts[peer.name];
        this._log('info', `${peer.name} 前端口已就绪：${front?.endpoint}`);
        await this._activate(peer, st);
      } catch (err) {
        st.state = 'down';
        st.lastError = `前端口: ${err?.message ?? err}`;
        this._log('warn', `${peer.name} 前端口仍不可用：${st.lastError}`);
        this._scheduleFrontRetry(peer);
      }
    }, this.config.probeIntervalMs);
    st.frontRetryTimer?.unref?.();
  }

  /**
   * 停掉旧 transport 并等它真的退出再起新的。
   * 不等的话两个进程会抢同一个后端端口（实测会打出 WSAEADDRINUSE 10048）。
   */
  async _waitStopped(transport, timeoutMs = 2_000) {
    if (!transport) return;
    if (typeof transport.isRunning === 'function' && !transport.isRunning()) return;
    await new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer !== null) this.clearTimeoutFn(timer);
        resolve();
      };
      timer = this.setTimeoutFn(finish, timeoutMs);
      timer?.unref?.();
      transport.once?.('exit', finish);
      try {
        transport.stop();
      } catch {
        /* ignore */
      }
    });
  }

  /** 后端端口每次重启都换，避免和上个进程的 TIME_WAIT 撞车。 */
  async _allocateBackendPort() {
    const port = await this.allocatePortFn(this._usedPorts);
    this._usedPorts.add(port);
    return port;
  }

  _createTransport(peer, transportId) {
    const Ctor = this.transports?.[transportId];
    if (typeof Ctor !== 'function') throw new Error(`未知 transport：${transportId}`);
    const transport = new Ctor({ peer, config: this.config, deps: this._transportDeps() });
    transport.on?.('exit', (info) => this._onTransportExit(peer, transport, info));
    return transport;
  }

  _onTransportExit(peer, transport, info) {
    const st = this._states[peer.name];
    if (!st || st.transport !== transport) return;
    st.transport = null;
    st.pid = null;
    st.lastExit = { code: info?.code ?? null, signal: info?.signal ?? null, at: this.now() };
    this._frontOf(peer)?.setTarget(null);
    if (!this._started) return;
    this._scheduleRestart(peer, st, `承载进程退出 code=${st.lastExit.code}`);
  }

  _scheduleRestart(peer, st, reason) {
    if (!this._started || st.retryTimer !== null) return;
    if (!st.usingFallback && peer.fallbackTransport && st.restarts >= this.config.maxRestartsBeforeFallback) {
      this._log('warn', `${peer.name} 主承载连续失败 ${st.restarts} 次，切换 fallback=${peer.fallbackTransport}`);
      this._activate(peer, st, { fallback: true }).catch((err) => {
        st.state = 'down';
        st.lastError = `fallback: ${err?.message ?? err}`;
        this._log('warn', `${peer.name} fallback 启动失败：${st.lastError}`);
      });
      return;
    }
    const step = Math.min(st.backoffStep, 10);
    const delay = Math.min(this.config.restartMaxMs, this.config.restartBaseMs * 2 ** step);
    st.backoffStep += 1;
    st.restarts += 1;
    st.state = 'restarting';
    st.lastError = reason;
    st.retryTimer = this.setTimeoutFn(() => {
      st.retryTimer = null;
      this._activate(peer, st, { fallback: st.usingFallback }).catch((err) => {
        st.state = 'down';
        st.lastError = `${st.transportId}: ${err?.message ?? err}`;
        this._scheduleRestart(peer, st, st.lastError);
      });
    }, delay);
    st.retryTimer?.unref?.();
    this._log('warn', `${peer.name} 承载重启，${delay}ms 后重试（${reason}）`);
  }

  async _activate(peer, st, { fallback = false } = {}) {
    if (!this._started) return;
    this._clearTimer(st, 'retryTimer');
    this._clearTimer(st, 'bootTimer');
    const transportId = fallback ? peer.fallbackTransport : peer.transport;
    if (!transportId) throw new Error('没有可用的 transport');
    const front = this._frontOf(peer);
    const previous = st.transport;
    st.transport = null;
    st.pid = null;
    front?.setTarget(null); // 重启期间新连接直接断，让 DSH 自己重连
    await this._waitStopped(previous);
    st.usingFallback = fallback;
    st.transportId = transportId;
    st.state = 'starting';
    peer.listenPort = await this._allocateBackendPort();
    const transport = this._createTransport(peer, transportId);
    st.transport = transport;
    try {
      await transport.start();
    } catch (err) {
      st.transport = null;
      st.state = 'unsupported';
      st.lastError = `${transportId}: ${err?.message ?? err}`;
      this._log('warn', `${peer.name} ${st.lastError}`);
      if (!fallback && peer.fallbackTransport) {
        // 主承载连启动都做不到（如 frp 配置缺字段）→ 直接走 fallback
        await this._activate(peer, st, { fallback: true });
        return;
      }
      throw err;
    }
    const status = transport.status?.() ?? {};
    st.pid = status.pid ?? null;
    st.ticket = status.ticket ?? '';
    st.failures = 0; // 新承载从零开始记失败次数
    // 后端在远端时（frp）没有本地后端端口：前端口直接指到 transport 给的目标。
    front?.setTarget(transport.frontTarget ?? peer.listenPort);
    this._log(
      'info',
      `${peer.name} 承载启动：${transportId}${fallback ? '（fallback）' : ''} 前端口 ${front?.endpoint ?? `<未监听>`} -> 后端 ${transport.localEndpoint} pid=${st.pid}`,
    );
    st.bootTimer = this.setTimeoutFn(() => {
      st.bootTimer = null;
      void this._tickPeer(peer);
    }, 800);
    st.bootTimer?.unref?.();
  }

  async _tickPeer(peer) {
    const st = this._states[peer.name];
    if (!st || !this._started) return;
    if (!st.transport) return;
    const token = this._tokenValue();
    if (!token) {
      st.state = 'degraded';
      st.lastError = '没有 interconnect token（credentials.yaml）';
      return;
    }
    const probe = await this.probeFn({
      port: peer.localPort,
      token,
      timeoutMs: this.config.probeTimeoutMs,
    });
    st.lastProbeAt = this.now();
    if (probe.upgraded) {
      if (st.state !== 'up') {
        this._log('info', `${peer.name} 承载健康（101，${st.transportId}）`);
      }
      st.state = 'up';
      st.failures = 0;
      st.backoffStep = 0;
      st.restarts = 0;
      st.lastError = null;
      return;
    }
    if (typeof probe.statusCode === 'number' && probe.statusCode > 0) {
      // 承载通、只是鉴权不对：重启承载没用，别把链路踢了。
      st.state = 'degraded';
      st.lastError = `HTTP ${probe.statusCode}（承载通但鉴权失败，检查两边 token）`;
      this._log('warn', `${peer.name} ${st.lastError}`);
      return;
    }
    st.failures += 1;
    st.state = 'degraded';
    st.lastError = `探活失败：${probe.error ?? 'unknown'}（${st.failures}/${this.config.failuresBeforeRestart}）`;
    if (st.failures >= this.config.failuresBeforeRestart) {
      const transport = st.transport;
      st.transport = null;
      st.pid = null;
      this._frontOf(peer)?.setTarget(null);
      await this._waitStopped(transport);
      this._scheduleRestart(peer, st, st.lastError);
    }
  }

  /** 起服务：每个 peer 先占住前端口，再起承载，并开始周期探活。 */
  async start() {
    if (this._started) return;
    this._started = true;
    this._log(
      'info',
      `承载服务启动（transport=${this.config.transport}，fallback=${this.config.fallbackTransport || 'none'}）`,
    );
    const peers = Object.values(this.config.peers ?? {});
    for (const peer of peers) {
      try {
        await this._ensureFront(peer);
      } catch (err) {
        const st = this._states[peer.name];
        st.state = 'down';
        st.lastError = `前端口: ${err?.message ?? err}`;
        this._log('warn', `${peer.name} 前端口监听失败，稍后重试：${st.lastError}`);
        this._scheduleFrontRetry(peer);
      }
    }
    const initial = peers
      .filter((peer) => this._fronts[peer.name])
      .map((peer) =>
        this._activate(peer, this._states[peer.name]).catch((err) => {
          this._log('warn', `${peer.name} 初始启动失败：${err?.message ?? err}`);
        }),
      );
    this._timer = this.setIntervalFn(() => {
      for (const peer of peers) {
        void this._tickPeer(peer).catch((err) => this._log('warn', `${peer.name} 探活异常：${err?.message ?? err}`));
      }
    }, this.config.probeIntervalMs);
    this._timer?.unref?.();
    await Promise.all(initial);
  }

  /** 手动触发一次探活/重启判定（测试与运维用）。 */
  async tick(name) {
    const peer = this.config.peers?.[name];
    if (!peer) return false;
    await this._tickPeer(peer);
    return true;
  }

  /** 手动切 transport（运维用）：'iroh' | 'ssh' | 'frp'。 */
  async switchTransport(name, transportId) {
    const peer = this.config.peers?.[name];
    if (!peer) throw new Error(`未知 peer：${name}`);
    if (!TRANSPORT_IDS.includes(transportId)) throw new Error(`未知 transport：${transportId}`);
    peer.transport = transportId;
    await this._activate(peer, this._states[name], { fallback: false });
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._timer !== null) {
      try {
        this.clearIntervalFn(this._timer);
      } catch {
        /* ignore */
      }
      this._timer = null;
    }
    for (const [name, st] of Object.entries(this._states)) {
      this._clearTimer(st, 'retryTimer');
      this._clearTimer(st, 'bootTimer');
      this._clearTimer(st, 'frontRetryTimer');
      const transport = st.transport;
      st.transport = null;
      st.pid = null;
      try {
        transport?.stop?.();
      } catch {
        /* ignore */
      }
      try {
        this._fronts[name]?.close();
      } catch {
        /* ignore */
      }
      st.state = 'stopped';
      this._log('info', `${name} 承载已停止`);
    }
    this._fronts = {};
    this._usedPorts.clear();
  }

  status() {
    return {
      started: this._started,
      transport: this.config.transport,
      fallbackTransport: this.config.fallbackTransport,
      peers: Object.values(this.config.peers ?? {}).map((peer) => {
        const st = this._states[peer.name];
        const transport = st.transport;
        const transportStatus = transport?.status?.() ?? {};
        const front = this._frontOf(peer);
        return {
          name: peer.name,
          localPort: peer.localPort,
          localEndpoint: front?.endpoint ?? `127.0.0.1:${peer.localPort}`,
          backendEndpoint: transport?.localEndpoint ?? null,
          frontReady: Boolean(front),
          transport: st.transportId,
          usingFallback: st.usingFallback,
          state: st.state,
          pid: st.pid,
          ticket: transportStatus.ticket ?? st.ticket,
          ticketSource: transportStatus.ticketSource ?? '',
          restarts: st.restarts,
          backoffStep: st.backoffStep,
          failures: st.failures,
          lastError: st.lastError,
          lastExit: st.lastExit,
          lastProbeAt: st.lastProbeAt,
        };
      }),
    };
  }
}

/**
 * 插件装配用的一步式入口：config 里 irohLink.enabled=true 才起。
 * 返回 disposer；任何异常都只记日志，不拖垮插件加载。
 */
export function installIrohLink({ ctx, config, logger } = {}) {
  const normalized = normalizeIrohLinkConfig(config);
  if (!normalized.enabled) return () => {};
  let service;
  try {
    service = new IrohLinkService({ config: normalized, logger: logger ?? ctx?.logger });
    void service.start();
  } catch (err) {
    try {
      (logger ?? ctx?.logger)?.warn?.(`[dsh-html-panel] 承载未启动：${err?.message ?? err}`);
    } catch {
      /* ignore */
    }
    return () => {};
  }
  try {
    (logger ?? ctx?.logger)?.info?.(
      `[dsh-html-panel] 承载已启用：${Object.entries(normalized.peers)
        .map(([name, peer]) => `${name}(${peer.transport})`)
        .join(', ')}`,
    );
  } catch {
    /* ignore */
  }
  return () => service.stop();
}
