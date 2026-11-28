/**
 * 承载层的共享工具：配置归一化、token/ticket 解析、101 探活、identity 读写。
 * transports/*.js 与 index.js 都从这里取，避免循环依赖。
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROBE_INTERVAL_MS = 15_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
export const DEFAULT_RESTART_BASE_MS = 1_000;
export const DEFAULT_RESTART_MAX_MS = 30_000;
export const DEFAULT_TICKET_COMMAND_TIMEOUT_MS = 15_000;
/** 连续几次探活失败才动承载（避免 relay 抖一下就把链路踢掉）。 */
export const DEFAULT_FAILURES_BEFORE_RESTART = 2;
/** 主承载连续重启失败多少次后切 fallback。 */
export const DEFAULT_MAX_RESTARTS_BEFORE_FALLBACK = 5;

export const TRANSPORT_IDS = Object.freeze(['iroh', 'ssh', 'frp']);

const WEBSOCKET_NONCE = 'dGhlIHNhbXBsZSBub25jZQ==';
const TICKET_RE = /endpoint[a-z2-7]{40,}/i;

export function defaultCredFile() {
  return path.join(os.homedir(), '.dsh', '.credentials.yaml');
}

export function defaultIdentityFile() {
  return path.join(os.homedir(), '.dsh', 'iroh-link', 'identity.hex');
}

/**
 * 插件自带的 dumbpipe（`lib/iroh-link/vendor/iroh/`），找不到就要求 config.binaryPath。
 * 1.0.0 起由 dsh-html-panel 自带（与 team-mesh 的 `vendor/iroh/` 同版本二进制，
 * SHA-256 见 `vendor/iroh/README.md`），不再依赖任何别的插件的安装路径。
 */
export function defaultBinaryPath() {
  const exe = process.platform === 'win32' ? 'dumbpipe.exe' : 'dumbpipe';
  return fileURLToPath(new URL(`./vendor/iroh/${exe}`, import.meta.url));
}

export function normalizeTransportId(value, fallback) {
  return typeof value === 'string' && TRANSPORT_IDS.includes(value.trim()) ? value.trim() : fallback;
}

const asString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asArgv = (value) =>
  Array.isArray(value) ? value.filter((part) => typeof part === 'string' && part.length > 0) : [];
const asPort = (value) => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
};

/**
 * frp 段：对端 frpc 暴露出来的公网目标（如 `xxx.sakurafrp.cc:12345`）。
 * 非法值归一成 `''` / `0`，由 FrpTransport.start() 报可读错——归一化层不抛错。
 */
export function normalizeFrpTarget(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { remoteHost: asString(src.remoteHost), remotePort: asPort(src.remotePort) };
}

/**
 * 归一化 `dsh-html-panel` 的 `irohLink` 配置（1.0.0 起从 dsh-team-mesh 迁入）。非法
 * peer 直接丢弃（端口不合法），
 * 不抛错：承载坏了不能拖垮插件加载。
 *
 * 关键配置位：
 *   transport: 'iroh' | 'ssh' | 'frp'   （全局默认，可被 peer 覆盖）
 *   fallbackTransport: 'ssh'           （主承载连续失败后切过去）
 *   peers.<name>: { localPort, transport?, fallbackTransport?, ticket?, ticketFile?,
 *                   ticketCommand?: argv[], sshCommand?: argv[],
 *                   frp?: { remoteHost, remotePort } }
 */
export function normalizeIrohLinkConfig(raw, env = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const globalTransport = normalizeTransportId(src.transport, 'iroh');
  const globalFallback = normalizeTransportId(src.fallbackTransport, '');

  const peers = {};
  const rawPeers = src.peers && typeof src.peers === 'object' ? src.peers : {};
  for (const [name, spec] of Object.entries(rawPeers)) {
    if (!spec || typeof spec !== 'object') continue;
    const localPort = Number(spec.localPort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) continue;
    const ticket = asString(spec.ticket);
    peers[name] = {
      name,
      localPort,
      transport: normalizeTransportId(spec.transport, globalTransport),
      fallbackTransport: normalizeTransportId(spec.fallbackTransport, globalFallback),
      ticket: TICKET_RE.test(ticket) ? ticket : '',
      ticketFile: asString(spec.ticketFile),
      ticketCommand: asArgv(spec.ticketCommand),
      sshCommand: asArgv(spec.sshCommand),
      frp: normalizeFrpTarget(spec.frp),
    };
  }
  const num = (value, fallback, min) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  return {
    enabled: src.enabled === true && Object.keys(peers).length > 0,
    transport: globalTransport,
    fallbackTransport: globalFallback,
    binaryPath: asString(src.binaryPath) || env.binaryPath || defaultBinaryPath(),
    credFile: asString(src.credFile) || env.credFile || defaultCredFile(),
    identityFile: asString(src.identityFile) || env.identityFile || defaultIdentityFile(),
    probeIntervalMs: num(src.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS, 1_000),
    probeTimeoutMs: num(src.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 500),
    restartBaseMs: num(src.restartBaseMs, DEFAULT_RESTART_BASE_MS, 200),
    restartMaxMs: num(src.restartMaxMs, DEFAULT_RESTART_MAX_MS, 1_000),
    ticketCommandTimeoutMs: num(src.ticketCommandTimeoutMs, DEFAULT_TICKET_COMMAND_TIMEOUT_MS, 1_000),
    failuresBeforeRestart: Math.max(1, num(src.failuresBeforeRestart, DEFAULT_FAILURES_BEFORE_RESTART, 1)),
    maxRestartsBeforeFallback: Math.max(
      1,
      num(src.maxRestartsBeforeFallback, DEFAULT_MAX_RESTARTS_BEFORE_FALLBACK, 1),
    ),
    peers,
  };
}

/**
 * 从 credentials.yaml 文本里取 interconnect token。纯函数，方便测。
 * 取不到返回 null；**绝不把值打进日志**。
 */
export function readInterconnectToken(text) {
  if (typeof text !== 'string') return null;
  const match = /^[ \t]*DSH_INTERCONNECT_TOKEN[ \t]*:[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#"']+))/m.exec(text);
  if (!match) return null;
  const token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return token.length > 0 ? token : null;
}

/** 从任意文本（ticket 文件 / 命令输出）里抠出 ticket；没有返回 null。 */
export function extractTicket(text) {
  if (typeof text !== 'string') return null;
  const match = TICKET_RE.exec(text);
  return match ? match[0] : null;
}

/**
 * 探 `/interconnect/link`。
 * @returns {Promise<{upgraded: boolean, statusCode: number|null, error: string|null}>}
 *   upgraded=true 且 101 → 承载与 token 都对；
 *   有普通响应（401/403/...）→ 承载通、鉴权失败；
 *   error → 承载断（连不上/超时）。
 */
export function probeInterconnectLink({
  host = '127.0.0.1',
  port,
  token,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      req = http.request({
        host,
        port,
        method: 'GET',
        path: '/interconnect/link',
        timeout: timeoutMs,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': WEBSOCKET_NONCE,
          Authorization: `Bearer ${token ?? ''}`,
        },
      });
    } catch (err) {
      finish({ upgraded: false, statusCode: null, error: String(err?.message ?? err) });
      return;
    }
    req.on('upgrade', (res, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      finish({ upgraded: res?.statusCode === 101, statusCode: res?.statusCode ?? null, error: null });
    });
    req.on('response', (res) => {
      try {
        res.resume();
      } catch {
        /* ignore */
      }
      finish({ upgraded: false, statusCode: res?.statusCode ?? null, error: null });
    });
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      finish({ upgraded: false, statusCode: null, error: 'timeout' });
    });
    req.on('error', (err) => finish({ upgraded: false, statusCode: null, error: String(err?.message ?? err) }));
    req.end();
  });
}

/** 跑 ticketCommand（argv 数组，不经过 shell，Windows 下不会被引号坑）。 */
export function runTicketCommand(argv, { timeoutMs = DEFAULT_TICKET_COMMAND_TIMEOUT_MS, spawnFn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      reject(new Error('ticketCommand 是空数组'));
      return;
    }
    let child;
    try {
      child = spawnFn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    const done = (fn, value) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      fn(value);
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done(reject, new Error(`ticketCommand 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += String(chunk);
    });
    child.on('error', (err) => done(reject, err));
    child.on('exit', (code) => {
      if (code === 0) done(resolve, stdout.trim());
      else done(reject, new Error(`ticketCommand 退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}`));
    });
  });
}

/** ticket 日志里可能带 secret 行（dumbpipe 自动生成身份时会打），脱敏后再进日志。 */
export function maskSecretLines(line) {
  return /secret/i.test(line) ? line.replace(/\S{32,}/g, '***') : line;
}

/** 持久 iroh 身份：32 字节 hex。读不到就生成并 0600 落盘；失败返回 null。 */export function loadOrCreateIdentity(fsImpl, identityFile, log = () => {}) {
  try {
    const existing = fsImpl.readFileSync(identityFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing.toLowerCase();
    throw new Error('identity 文件内容不是 32 字节 hex');
  } catch {
    try {
      const generated = randomBytes(32).toString('hex');
      fsImpl.mkdirSync(path.dirname(identityFile), { recursive: true });
      fsImpl.writeFileSync(identityFile, `${generated}\n`, { mode: 0o600 });
      log(`已生成 iroh 身份（${identityFile}），注意备份`);
      return generated;
    } catch (err) {
      log(`iroh 身份读写失败，本次用临时身份：${err?.message ?? err}`);
      return null;
    }
  }
}

/**
 * 给隧道分配一个后端监听端口（前端口由 LocalFront 长期持有，不用它）。
 * 用 listen(0) 让内核挑，再关掉交给隧道进程 bind；有极小 race，但后端端口
 * 每次重启都换，冲突概率可忽略，服务层会把它当启动失败重试。
 */
export function allocateFreePort(exclude = new Set()) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        if (exclude.has(port)) resolve(allocateFreePort(exclude));
        else resolve(port);
      });
    });
  });
}

export { fs as defaultFs };
