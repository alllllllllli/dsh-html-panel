import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  IrohLinkService,
  extractTicket,
  normalizeIrohLinkConfig,
  probeInterconnectLink,
  readInterconnectToken,
  runTicketCommand,
} from '../lib/iroh-link/index.js';
import { LocalFront } from '../lib/iroh-link/front.js';
import { FrpTransport } from '../lib/iroh-link/transports/frp.js';
import { IrohTransport } from '../lib/iroh-link/transports/iroh.js';
import { SshTransport } from '../lib/iroh-link/transports/ssh.js';

const TICKET_FULL = `endpoint${'a'.repeat(120)}`;
const TICKET_OTHER = `endpoint${'b'.repeat(120)}`;
const TOKEN = 'test-token-do-not-print';
const IDENTITY = 'c'.repeat(64);

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', null, 'SIGTERM');
  };
  return child;
}

function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeoutFn(fn, ms) {
      const handle = { fn, ms, unref() {} };
      pending.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {},
    async runNext() {
      const handle = pending.shift();
      assert.ok(handle, 'expected a pending timer');
      handle.fn();
      await flush();
      return handle.ms;
    },
  };
}

function memoryFs(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFileSync(file) {
      if (!store.has(file)) throw new Error(`ENOENT ${file}`);
      return store.get(file);
    },
    writeFileSync(file, data) {
      store.set(file, data);
    },
    mkdirSync() {},
  };
}

function baseConfig(overrides = {}, peerOverrides = {}) {
  return normalizeIrohLinkConfig({
    enabled: true,
    binaryPath: 'C:/fake/dumbpipe.exe',
    credFile: 'C:/fake/.credentials.yaml',
    identityFile: 'C:/fake/identity.hex',
    probeIntervalMs: 5000,
    restartBaseMs: 1000,
    restartMaxMs: 8000,
    peers: {
      mcloud: { localPort: 13086, ticket: TICKET_FULL, ...peerOverrides },
    },
    ...overrides,
  });
}

function credFiles() {
  return {
    'C:/fake/identity.hex': `${IDENTITY}\n`,
    'C:/fake/.credentials.yaml': `DSH_INTERCONNECT_TOKEN: ${TOKEN}\n`,
  };
}

// ---------- 纯函数 ----------

test('readInterconnectToken：三种写法都能解析，没有则 null', () => {
  assert.equal(readInterconnectToken('DSH_INTERCONNECT_TOKEN: abc123\n'), 'abc123');
  assert.equal(readInterconnectToken('DSH_INTERCONNECT_TOKEN: "a b c"\n'), 'a b c');
  assert.equal(readInterconnectToken("DSH_INTERCONNECT_TOKEN: 'qq'\n"), 'qq');
  assert.equal(readInterconnectToken('other: 1\n'), null);
  assert.equal(readInterconnectToken(''), null);
  assert.equal(readInterconnectToken(null), null);
});

test('extractTicket：能从命令输出/文件里抠出 ticket，没有则 null', () => {
  assert.equal(extractTicket(`connect-tcp ${TICKET_FULL}`), TICKET_FULL);
  assert.equal(extractTicket('no ticket here'), null);
  assert.equal(extractTicket('endpoint too-short'), null);
});

test('normalizeIrohLinkConfig：默认关闭；transport 可配；非法端口 peer 丢弃', () => {
  assert.equal(normalizeIrohLinkConfig(undefined).enabled, false);
  assert.equal(normalizeIrohLinkConfig({ peers: {} }).enabled, false);
  assert.equal(normalizeIrohLinkConfig({ enabled: true }).enabled, false);

  const config = normalizeIrohLinkConfig({
    enabled: true,
    transport: 'ssh',
    fallbackTransport: 'frp',
    peers: {
      good: { localPort: 13086, ticket: TICKET_FULL },
      override: { localPort: 13087, transport: 'frp' },
      badPort: { localPort: 'not-a-port' },
      badPort2: { localPort: 70000 },
      badTicket: { localPort: 13088, ticket: 'nope' },
      withSsh: { localPort: 13089, sshCommand: ['ssh', '-N', '-L', '127.0.0.1:13089:127.0.0.1:53329', 'u@h'] },
    },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.transport, 'ssh');
  assert.equal(config.fallbackTransport, 'frp');
  assert.deepEqual(Object.keys(config.peers).sort(), ['badTicket', 'good', 'override', 'withSsh']);
  assert.equal(config.peers.good.transport, 'ssh', 'peer 没写 transport 时继承全局');
  assert.equal(config.peers.override.transport, 'frp');
  assert.equal(config.peers.badTicket.ticket, '');
  assert.equal(config.peers.withSsh.sshCommand.length, 5);
  assert.equal(config.probeIntervalMs, 15_000);
  assert.equal(config.failuresBeforeRestart, 2);
  assert.equal(normalizeIrohLinkConfig({ enabled: true, transport: 'bogus', peers: { a: { localPort: 1 } } }).transport, 'iroh');
});

test('normalizeIrohLinkConfig：frp 段归一化（remoteHost 去空格、remotePort 只认 1-65535 整数）', () => {
  const config = normalizeIrohLinkConfig({
    enabled: true,
    transport: 'frp',
    peers: {
      server: { localPort: 13080, frp: { remoteHost: '  tunnel.sakurafrp.cc  ', remotePort: '12345' } },
      missing: { localPort: 13081 },
      badPort: { localPort: 13082, frp: { remoteHost: 'h.example', remotePort: 'nope' } },
      tooBig: { localPort: 13083, frp: { remoteHost: 'h.example', remotePort: 70000 } },
    },
  });
  assert.equal(config.transport, 'frp');
  assert.deepEqual(config.peers.server.frp, { remoteHost: 'tunnel.sakurafrp.cc', remotePort: 12345 });
  assert.deepEqual(config.peers.missing.frp, { remoteHost: '', remotePort: 0 });
  assert.equal(config.peers.badPort.frp.remotePort, 0);
  assert.equal(config.peers.tooBig.frp.remotePort, 0);
});

test('probeInterconnectLink：101 升级算通，普通响应算"承载通/鉴权失败"，连不上算断', async () => {
  const upgradeServer = http.createServer();
  upgradeServer.on('upgrade', (req, socket) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.destroy();
  });
  await new Promise((resolve) => upgradeServer.listen(0, '127.0.0.1', resolve));
  const upgradePort = upgradeServer.address().port;
  try {
    const good = await probeInterconnectLink({ port: upgradePort, token: TOKEN, timeoutMs: 2000 });
    assert.equal(good.upgraded, true);
    assert.equal(good.statusCode, 101);
  } finally {
    upgradeServer.close();
  }

  const denyServer = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end('no');
  });
  await new Promise((resolve) => denyServer.listen(0, '127.0.0.1', resolve));
  const denyPort = denyServer.address().port;
  try {
    const denied = await probeInterconnectLink({ port: denyPort, token: TOKEN, timeoutMs: 2000 });
    assert.equal(denied.upgraded, false);
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.error, null);
  } finally {
    denyServer.close();
  }

  const dead = await probeInterconnectLink({ port: 1, token: TOKEN, timeoutMs: 500 });
  assert.equal(dead.upgraded, false);
  assert.equal(dead.statusCode, null);
  assert.ok(dead.error);
});

test('runTicketCommand：正常输出、退出码非 0、超时', async () => {
  const ok = await runTicketCommand([process.execPath, '-e', `console.log('${TICKET_FULL}')`]);
  assert.equal(extractTicket(ok), TICKET_FULL);

  await assert.rejects(runTicketCommand([process.execPath, '-e', 'process.exit(3)']), /退出码 3/);

  await assert.rejects(
    runTicketCommand([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 }),
    /超时/,
  );
});

// ---------- transports ----------

test('IrohTransport：ticket 取 command → file → static，start 时带持久身份', async () => {
  const spawns = [];
  const config = baseConfig({}, { ticketCommand: ['ssh', 'h', 'type', 'ticket.txt'] });
  const transport = new IrohTransport({
    peer: config.peers.mcloud,
    config,
    deps: {
      spawnFn: (bin, args, opts) => {
        spawns.push({ bin, args, opts });
        return fakeChild();
      },
      fsImpl: memoryFs(credFiles()),
      runCommandFn: async () => `connect-tcp ${TICKET_FULL}`,
      logger: null,
    },
  });
  assert.equal(transport.localEndpoint, '127.0.0.1:13086');
  await transport.start();
  assert.equal(spawns[0].bin, 'C:/fake/dumbpipe.exe');
  assert.deepEqual(spawns[0].args, ['connect-tcp', '--addr', '127.0.0.1:13086', TICKET_FULL]);
  assert.equal(spawns[0].opts.env.IROH_SECRET, IDENTITY);
  assert.equal(transport.ticket, TICKET_FULL);
  assert.equal(transport.status().ticketSource, 'command');
  transport.stop();
});

test('IrohTransport：command 失败退到 ticket 文件，再退到静态 ticket；每次 start 重取', async () => {
  let commandFails = true;
  const spawns = [];
  const config = baseConfig({}, { ticketCommand: ['ssh', 'h'], ticketFile: 'C:/fake/ticket.txt', ticket: TICKET_OTHER });
  const fsImpl = memoryFs({ ...credFiles(), 'C:/fake/ticket.txt': TICKET_FULL });
  const transport = new IrohTransport({
    peer: config.peers.mcloud,
    config,
    deps: {
      spawnFn: (bin, args) => {
        spawns.push(args);
        return fakeChild();
      },
      fsImpl,
      runCommandFn: async () => {
        if (commandFails) throw new Error('ssh down');
        return `connect-tcp ${TICKET_OTHER}`;
      },
      logger: null,
    },
  });
  await transport.start();
  assert.equal(spawns[0][3], TICKET_FULL, 'command 失败 → 文件');
  assert.equal(transport.status().ticketSource, 'file');

  fsImpl.store.delete('C:/fake/ticket.txt');
  commandFails = false;
  await transport.start();
  assert.equal(spawns[1][3], TICKET_OTHER, '重取时优先 command');
  assert.equal(transport.status().ticketSource, 'command');
  transport.stop();
});

test('IrohTransport：没有 ticket 时 start 抛错（不能假装通）', async () => {
  const config = baseConfig({ peers: { mcloud: { localPort: 13086 } } });
  const transport = new IrohTransport({
    peer: config.peers.mcloud,
    config,
    deps: { spawnFn: () => fakeChild(), fsImpl: memoryFs(credFiles()), runCommandFn: async () => '', logger: null },
  });
  await assert.rejects(transport.start(), /ticket/);
});

test('SshTransport：把 {port} 换成后端端口拉 ssh，缺命令/缺占位符都报错', async () => {
  const config = baseConfig({}, { sshCommand: ['ssh.exe', '-N', '-L', '127.0.0.1:{port}:127.0.0.1:53329', 'u@h'] });
  const calls = [];
  const transport = new SshTransport({
    peer: config.peers.mcloud,
    config,
    deps: {
      spawnFn: (bin, args) => {
        calls.push({ bin, args });
        return fakeChild();
      },
      logger: null,
    },
  });
  await transport.start();
  assert.equal(calls[0].bin, 'ssh.exe');
  assert.deepEqual(calls[0].args, ['-N', '-L', '127.0.0.1:13086:127.0.0.1:53329', 'u@h']);
  assert.equal(transport.localEndpoint, '127.0.0.1:13086');
  transport.stop();

  const bare = normalizeIrohLinkConfig({ enabled: true, peers: { m: { localPort: 13086 } } });
  const noCmd = new SshTransport({ peer: bare.peers.m, config: bare, deps: { spawnFn: () => fakeChild(), logger: null } });
  await assert.rejects(noCmd.start(), /sshCommand/);

  const noPort = normalizeIrohLinkConfig({
    enabled: true,
    peers: { m: { localPort: 13086, sshCommand: ['ssh.exe', '-N', '-L', '127.0.0.1:13086:127.0.0.1:53329', 'u@h'] } },
  });
  const noPlaceholder = new SshTransport({
    peer: noPort.peers.m,
    config: noPort,
    deps: { spawnFn: () => fakeChild(), logger: null },
  });
  await assert.rejects(noPlaceholder.start(), /\{port\}/);
});

function frpConfig(peerOverrides = {}, configOverrides = {}) {
  return baseConfig(configOverrides, {
    transport: 'frp',
    frp: { remoteHost: 'tunnel.sakurafrp.cc', remotePort: 12345 },
    ...peerOverrides,
  });
}

test('FrpTransport：配置型承载——start 不拉进程，状态/前端口目标语义与其它 transport 一致', async () => {
  const config = frpConfig();
  let spawned = 0;
  const transport = new FrpTransport({
    peer: config.peers.mcloud,
    config,
    deps: {
      spawnFn: () => {
        spawned += 1;
        return fakeChild();
      },
      logger: null,
    },
  });
  assert.equal(transport.localEndpoint, 'tunnel.sakurafrp.cc:12345');
  assert.deepEqual(transport.frontTarget, { host: 'tunnel.sakurafrp.cc', port: 12345 });
  assert.equal(transport.ticket, null);
  assert.equal(transport.isRunning(), false);
  assert.equal(transport.status().state, 'stopped');

  await transport.start();
  assert.equal(spawned, 0, 'frp 本机不起任何进程');
  assert.equal(transport.isRunning(), true);
  const status = transport.status();
  assert.equal(status.id, 'frp');
  assert.equal(status.pid, null);
  assert.equal(status.state, 'running');
  assert.equal(status.ticket, null);
  assert.equal(status.lastError, null);

  const exits = [];
  transport.once('exit', (info) => exits.push(info));
  transport.stop();
  assert.equal(transport.isRunning(), false);
  assert.equal(transport.status().state, 'stopped');
  assert.equal(exits.length, 1, 'stop 要 emit exit，服务层 _waitStopped 才不会空等');
  transport.stop(); // 幂等
  assert.equal(exits.length, 1);
});

test('FrpTransport：缺 frp 段 / remoteHost 非法 / remotePort 非法 → 可读报错，不假装通', async () => {
  const cases = [
    { peer: {}, pattern: /peer\.frp\.remoteHost/ },
    { peer: { frp: { remoteHost: 'tunnel.sakurafrp.cc' } }, pattern: /peer\.frp\.remotePort/ },
    { peer: { frp: { remoteHost: 'tunnel.sakurafrp.cc', remotePort: 'nope' } }, pattern: /peer\.frp\.remotePort/ },
    { peer: { frp: { remoteHost: 'tunnel.sakurafrp.cc:12345', remotePort: 12345 } }, pattern: /remoteHost 不合法/ },
  ];
  for (const { peer, pattern } of cases) {
    const config = baseConfig({}, { transport: 'frp', ...peer });
    const transport = new FrpTransport({ peer: config.peers.mcloud, config });
    await assert.rejects(transport.start(), pattern);
    assert.equal(transport.isRunning(), false);
    assert.equal(transport.status().state, 'stopped');
    assert.match(transport.status().lastError, pattern);
  }
});

// ---------- service ----------

class FakeTransport extends EventEmitter {
  static instances = [];
  constructor({ peer, config, deps }) {
    super();
    this.id = 'iroh';
    this.peer = peer;
    this.config = config;
    this.deps = deps;
    this.child = null;
    this.startCount = 0;
    FakeTransport.instances.push(this);
  }

  get localEndpoint() {
    return `127.0.0.1:${this.peer.listenPort ?? this.peer.localPort}`;
  }

  get ticket() {
    return `ticket-${this.startCount}`;
  }

  isRunning() {
    return this.child !== null;
  }

  async start() {
    this.startCount += 1;
    this.child = { pid: 500 + this.startCount };
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      this.child = null;
      this.emit('exit', { code: null, signal: 'SIGTERM' });
    }
  }

  status() {
    return {
      id: this.id,
      pid: this.child?.pid ?? null,
      state: this.child ? 'running' : 'stopped',
      ticket: this.ticket,
      ticketSource: 'static',
    };
  }
}

class FakeSsh extends FakeTransport {
  constructor(opts) {
    super(opts);
    this.id = 'ssh';
  }
}

class FakeFrp extends FakeTransport {
  async start() {
    throw new Error('mock 主承载启动失败');
  }
}

const REGISTRY = { iroh: FakeTransport, ssh: FakeSsh, frp: FakeFrp };

function buildService({ config, files, probeFn, createFront, transports }) {
  const timers = manualTimers();
  const logs = [];
  const fronts = [];
  FakeTransport.instances = [];
  let nextBackendPort = 13090;
  const service = new IrohLinkService({
    config,
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    transports: transports ?? REGISTRY,
    fsImpl: memoryFs(files ?? credFiles()),
    probeFn: probeFn ?? (async () => ({ upgraded: true, statusCode: 101, error: null })),
    // 单测不占真实端口：假前端口 + 可预测的后端端口
    createFront:
      createFront ??
      (({ localPort }) => {
        const front = {
          localPort,
          endpoint: `127.0.0.1:${localPort}`,
          target: null,
          listen: async () => {},
          setTarget(port) {
            front.target = port;
          },
          close() {
            front.closed = true;
          },
        };
        fronts.push(front);
        return front;
      }),
    allocatePortFn: async () => {
      nextBackendPort += 1;
      return nextBackendPort;
    },
    ...timers,
  });
  return { service, timers, logs, fronts };
}

test('服务：起 iroh 承载 → 探活 101 → up；前端口固定、后端端口轮换', async () => {
  const { service, timers, logs, fronts } = buildService({ config: baseConfig() });
  await service.start();
  await flush();
  assert.equal(FakeTransport.instances.length, 1);
  assert.equal(FakeTransport.instances[0].id, 'iroh');
  assert.equal(fronts[0].target, 13091, '前端口应指向分配的后端端口');
  await timers.runNext(); // 首次探活
  const status = service.status();
  assert.equal(status.peers[0].state, 'up');
  assert.equal(status.peers[0].transport, 'iroh');
  assert.equal(status.peers[0].localEndpoint, '127.0.0.1:13086');
  assert.equal(status.peers[0].backendEndpoint, '127.0.0.1:13091');
  assert.equal(status.peers[0].frontReady, true);
  assert.equal(status.peers[0].pid, 501);
  assert.ok(!logs.map(([, m]) => m).join('\n').includes(TOKEN), '日志不能带 token');
  service.stop();
  assert.equal(service.status().peers[0].state, 'stopped');
  assert.equal(fronts[0].closed, true);
});

test('服务：前端口被占（旧隧道没关）→ 定时重试，端口空出来后自动起承载', async () => {
  let listenAttempts = 0;
  const { service, timers } = buildService({
    config: baseConfig(),
    createFront: ({ localPort }) => ({
      endpoint: `127.0.0.1:${localPort}`,
      setTarget() {},
      close() {},
      async listen() {
        listenAttempts += 1;
        if (listenAttempts === 1) throw new Error('EADDRINUSE 13086');
      },
    }),
  });
  await service.start();
  await flush();
  assert.equal(service.status().peers[0].state, 'down');
  assert.match(service.status().peers[0].lastError, /EADDRINUSE/);
  assert.equal(timers.pending.length, 1, '应安排前端口重试');
  await timers.runNext(); // 重试：这次成功 → 起承载
  await flush();
  assert.equal(listenAttempts, 2);
  assert.equal(FakeTransport.instances.length, 1);
  await timers.runNext(); // 首次探活
  assert.equal(service.status().peers[0].state, 'up');
  service.stop();
});

test('服务：401 = 承载通但鉴权失败，只标 degraded，不重启', async () => {
  const { service, timers } = buildService({
    config: baseConfig(),
    probeFn: async () => ({ upgraded: false, statusCode: 401, error: null }),
  });
  await service.start();
  await flush();
  await timers.runNext();
  await service.tick('mcloud');
  const status = service.status();
  assert.equal(status.peers[0].state, 'degraded');
  assert.match(status.peers[0].lastError, /401/);
  assert.equal(FakeTransport.instances.length, 1, '鉴权问题重启承载没有意义');
  assert.equal(timers.pending.length, 0);
  service.stop();
});

test('服务：承载进程退出 → 退避重拉（transport.start 再调一次）', async () => {
  const { service, timers } = buildService({ config: baseConfig() });
  await service.start();
  await flush();
  await timers.runNext(); // 首次探活
  FakeTransport.instances[0].emit('exit', { code: 1, signal: null });
  await flush();
  const delay = await timers.runNext();
  assert.equal(delay, 1000, '第一次重试用基础退避');
  await flush();
  assert.equal(FakeTransport.instances.length, 2);
  assert.equal(service.status().peers[0].restarts, 1);
  service.stop();
});

test('服务：主承载反复失败 → 切 fallback=ssh', async () => {
  const config = baseConfig(
    { fallbackTransport: 'ssh', maxRestartsBeforeFallback: 2 },
    { sshCommand: ['ssh.exe', '-N', '-L', '127.0.0.1:{port}:127.0.0.1:53329', 'u@h'] },
  );
  const { service, timers } = buildService({
    config,
    probeFn: async () => ({ upgraded: false, statusCode: null, error: 'ECONNREFUSED' }),
  });
  await service.start();
  await flush();
  await timers.runNext(); // 探活失败 1/2
  await service.tick('mcloud'); // 失败 2/2 → 重启 #1
  assert.equal(service.status().peers[0].state, 'restarting');
  await timers.runNext(); // 退避结束 → 新 iroh 承载
  await flush();
  await timers.runNext(); // 新承载探活失败 1/2
  await service.tick('mcloud'); // 失败 2/2 → 重启 #2
  await timers.runNext(); // 退避结束 → 再起 iroh
  await flush();
  await timers.runNext(); // 探活失败 1/2
  await service.tick('mcloud'); // 失败 2/2 → 触发 fallback
  await flush();
  await timers.runNext(); // fallback 的首次探活
  const status = service.status();
  assert.equal(status.peers[0].usingFallback, true);
  assert.equal(status.peers[0].transport, 'ssh');
  assert.ok(FakeTransport.instances.some((instance) => instance.id === 'ssh'), '应出现 ssh 承载');
  service.stop();
});

test('服务：主承载启动失败 → unsupported 且报错，不假装可用', async () => {
  const config = baseConfig({ transport: 'frp' });
  const { service } = buildService({ config });
  await service.start();
  await flush();
  const status = service.status();
  assert.equal(status.peers[0].state, 'unsupported');
  assert.match(status.peers[0].lastError, /mock 主承载启动失败/);
  service.stop();
});

test('服务：frp 主承载启动失败 + ssh fallback → 自动退到 ssh', async () => {
  const config = baseConfig(
    { transport: 'frp', fallbackTransport: 'ssh' },
    { sshCommand: ['ssh.exe', '-N', '-L', '127.0.0.1:{port}:127.0.0.1:53329', 'u@h'] },
  );
  const { service, timers } = buildService({ config });
  await service.start();
  await flush();
  await timers.runNext(); // fallback 承载的首次探活
  const status = service.status();
  assert.equal(status.peers[0].usingFallback, true);
  assert.equal(status.peers[0].transport, 'ssh');
  service.stop();
});

test('服务：frp 承载 → LocalFront 直连公网后端，101 判 up（不占本地后端端口）', async () => {
  const config = frpConfig();
  const { service, timers, fronts } = buildService({ config, transports: { frp: FrpTransport } });
  await service.start();
  await flush();
  assert.deepEqual(fronts[0].target, { host: 'tunnel.sakurafrp.cc', port: 12345 }, '前端口要指向公网目标');
  const started = service.status().peers[0];
  assert.equal(started.transport, 'frp');
  assert.equal(started.pid, null);
  assert.equal(started.backendEndpoint, 'tunnel.sakurafrp.cc:12345');
  await timers.runNext(); // 首次探活
  assert.equal(service.status().peers[0].state, 'up');
  service.stop();
  assert.equal(service.status().peers[0].state, 'stopped');
});

test('服务：frp 承载 + 401 → 只 degraded、不重启（三档语义复用）', async () => {
  const config = frpConfig();
  const { service, timers } = buildService({
    config,
    transports: { frp: FrpTransport },
    probeFn: async () => ({ upgraded: false, statusCode: 401, error: null }),
  });
  await service.start();
  await flush();
  await timers.runNext();
  const status = service.status().peers[0];
  assert.equal(status.state, 'degraded');
  assert.match(status.lastError, /401/);
  assert.equal(timers.pending.length, 0, '鉴权失败不该安排重启');
  service.stop();
});

test('服务：frp 配置缺字段 → unsupported 且报可读错误', async () => {
  const config = baseConfig({}, { transport: 'frp' });
  const { service } = buildService({ config, transports: { frp: FrpTransport } });
  await service.start();
  await flush();
  const status = service.status().peers[0];
  assert.equal(status.state, 'unsupported');
  assert.match(status.lastError, /peer\.frp\.remoteHost/);
  service.stop();
});

test('服务：switchTransport 手动切回 iroh', async () => {
  const config = baseConfig({}, { transport: 'ssh', sshCommand: ['ssh.exe', '-N', '-L', '127.0.0.1:{port}:127.0.0.1:53329', 'u@h'] });
  const { service, timers } = buildService({ config });
  await service.start();
  await flush();
  await service.switchTransport('mcloud', 'iroh');
  await flush();
  await timers.runNext();
  const status = service.status();
  assert.equal(status.peers[0].transport, 'iroh');
  assert.equal(status.peers[0].usingFallback, false);
  service.stop();
});

// ---------- LocalFront（真套接字，验证 TIME_WAIT 规避用的稳定前端口） ----------

function freeNetPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function bannerServer(letter) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', () => socket.write(letter));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function roundTrip(port, payload = 'x') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => socket.write(payload));
    socket.once('data', (chunk) => {
      socket.destroy();
      finish(null, String(chunk));
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish(new Error('timeout'));
    });
    socket.once('error', (err) => finish(err));
    socket.once('close', () => finish(new Error('closed without data')));
  });
}

test('LocalFront：前端口 → 后端，setTarget 切换后端，暂停时新连接直接断', async () => {
  const backendA = await bannerServer('A');
  const backendB = await bannerServer('B');
  const front = new LocalFront({ localPort: await freeNetPort() });
  await front.listen();
  try {
    front.setTarget(backendA.port);
    assert.equal(await roundTrip(front.localPort), 'A');
    front.setTarget(backendB.port);
    assert.equal(await roundTrip(front.localPort), 'B');
    front.setTarget(null);
    await assert.rejects(roundTrip(front.localPort));
  } finally {
    front.close();
    backendA.server.close();
    backendB.server.close();
  }
});

test('LocalFront：setTarget 支持远程 host:port（frp 公网后端），数字形式仍走本机回环', async () => {
  const backend = await bannerServer('R');
  const front = new LocalFront({ localPort: await freeNetPort() });
  await front.listen();
  try {
    front.setTarget({ host: '127.0.0.1', port: backend.port });
    assert.equal(await roundTrip(front.localPort), 'R');
    front.setTarget(backend.port); // 数字 = 127.0.0.1:<port>（iroh/ssh）
    assert.equal(await roundTrip(front.localPort), 'R');
    front.setTarget({ host: '', port: backend.port }); // 非法目标 = 暂停转发
    await assert.rejects(roundTrip(front.localPort));
  } finally {
    front.close();
    backend.server.close();
  }
});

// ---------- 1.0.0：大管家插件 apply() 的接线（承载层内建后的挂载 / 卸载） ----------

/** 端口现在能否 bind 上（能 = 空闲）。 */
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('真 apply()：config.irohLink 启用时占住前端口，插件卸载时释放（重载不撞 10048）', async () => {
  const { apply } = await import('../lib/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-iroh-link-'));
  const credFile = path.join(tmp, '.credentials.yaml');
  fs.writeFileSync(credFile, 'DSH_INTERCONNECT_TOKEN: test-token-do-not-print\n');
  const localPort = await freeNetPort();
  assert.equal(await canBind(localPort), true, '前置：前端口本来是空的');

  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    get() {
      return null;
    },
    webServer: { register() { return () => {}; } },
  };
  try {
    // frp 承载 = 纯配置、本机零进程；只借它验证「前端口被占住 / 被释放」这条接线。
    apply(ctx, {
      irohLink: {
        enabled: true,
        transport: 'frp',
        probeIntervalMs: 60_000,
        credFile,
        identityFile: path.join(tmp, 'identity.hex'),
        peers: { local: { localPort, frp: { remoteHost: '127.0.0.1', remotePort: 1 } } },
      },
    });
    // start() 是异步的：等 LocalFront 真的 bind 上前端口（最多 3s）。
    let bound = false;
    for (let i = 0; i < 60 && !bound; i += 1) {
      await delay(50);
      bound = (await canBind(localPort)) === false;
    }
    assert.equal(bound, true, '承载启用后前端口应被 LocalFront 占住');
    assert.ok(disposers.length > 0, 'ctx.effect 必须收回一个 disposer');

    for (const dispose of disposers.reverse()) dispose();
    assert.equal(await canBind(localPort), true, '卸载后前端口必须释放，否则重载会 10048');
  } finally {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
