/**
 * LocalFront —— 稳定前端口。
 *
 * 为什么需要它（实测踩出来的）：
 * dsh-interconnect 只认一个固定本地端口（如 127.0.0.1:13086）。如果隧道进程
 * 直接 bind 这个端口，一旦重启，Windows 上旧连接的 TIME_WAIT 会让新进程
 * bind 失败（WSAEADDRINUSE 10048），恢复要等 TIME_WAIT 过期（几十秒到两分钟）。
 * 那期间链路只能靠 fallback，体验很差。
 *
 * 做法：前端口由本进程长期持有（只 bind 一次），隧道 bind 一个**动态的后端口**
 * （13087、13088… 轮换）。隧道重启 = 换后端口 + `setTarget(newPort)`，前端口
 * 从不释放，所以永不吃 TIME_WAIT，恢复时间 ≈ 重启隧道本身（几秒）。
 *
 * frp 承载没有本地后端端口：`setTarget({ host, port })` 直接转发到对端 frpc
 * 暴露出来的公网目标（SakuraFrp 的 `xxx.sakurafrp.cc:<port>`），前端口语义不变。
 *
 * 代价：多一跳本机回环转发（微秒级），以及重启瞬间已有连接会断（DSH 自己重连）。
 */

import net from 'node:net';

export class LocalFront {
  constructor({ localPort, logger = null } = {}) {
    this.localPort = localPort;
    this.logger = logger;
    // 后端目标：{ host, port }。默认本机回环（iroh/ssh 隧道），frp 时是公网 remote host:port。
    this.target = null;
    this.server = null;
    this.sockets = new Set();
  }

  get endpoint() {
    return `127.0.0.1:${this.localPort}`;
  }

  _log(level, message) {
    try {
      this.logger?.[level]?.(message);
    } catch {
      /* ignore */
    }
  }

  listen() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._handle(socket));
      server.once('error', (err) => {
        server.close();
        reject(new Error(`前端口 127.0.0.1:${this.localPort} 监听失败：${err?.message ?? err}`));
      });
      server.listen(this.localPort, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (err) => this._log('warn', `[iroh-link] 前端口错误：${err?.message ?? err}`));
        this.server = server;
        resolve();
      });
    });
  }

  /**
   * 切换后端目标；传 null 表示暂停转发（重启隧道期间新连接直接断，让 DSH 自己重连）。
   * - 数字：本机回环 `127.0.0.1:<port>`（iroh/ssh 隧道 bind 的后端端口）；
   * - `{ host, port }`：远程目标（frp：对端 frpc 暴露出来的公网 host:port）。
   */
  setTarget(target) {
    if (target && typeof target === 'object') {
      const port = Number(target.port);
      const host = typeof target.host === 'string' ? target.host.trim() : '';
      this.target =
        Number.isInteger(port) && port > 0 && port <= 65535 && host ? { host, port } : null;
      return;
    }
    this.target = Number.isInteger(target) && target > 0 ? { host: '127.0.0.1', port: target } : null;
  }

  _handle(downstream) {
    this.sockets.add(downstream);
    downstream.once('close', () => this.sockets.delete(downstream));
    downstream.on('error', () => {
      /* 连接被重置是常态，交给 close */
    });
    const target = this.target;
    if (!target) {
      downstream.destroy();
      return;
    }
    const upstream = net.connect({ host: target.host, port: target.port });
    this.sockets.add(upstream);
    const closeBoth = () => {
      downstream.destroy();
      upstream.destroy();
    };
    upstream.once('close', () => {
      this.sockets.delete(upstream);
      downstream.destroy();
    });
    upstream.on('error', closeBoth);
    downstream.on('close', () => {
      upstream.destroy();
    });
    upstream.once('connect', () => {
      downstream.pipe(upstream);
      upstream.pipe(downstream);
      downstream.resume();
    });
  }

  close() {
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.target = null;
    if (server) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
  }
}
