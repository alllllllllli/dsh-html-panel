/**
 * 真管道集成测试：必须能看到 `vendor/iroh/dumbpipe.exe`（或 DSH_IROH_BIN 指向的
 * 可执行文件）才跑；没有二进制就 skip，不把别人的环境搞红。
 *
 * 这里验证的是「dumbpipe listen-tcp ↔ dumbpipe connect-tcp 能把一条真实 TCP
 * 连接带过去」——本机回环就够证明管道本身，跨机 PoC 见 docs/iroh-link.md。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  IrohLinkService,
  defaultBinaryPath,
  normalizeIrohLinkConfig,
  probeInterconnectLink,
} from '../lib/iroh-link/index.js';

const BIN = process.env.DSH_IROH_BIN || defaultBinaryPath();
const AVAILABLE = fs.existsSync(BIN) && process.env.DSH_IROH_SKIP_INTEGRATION !== '1';
const TOKEN = 'integration-token';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** 等 listen-tcp 在 stderr 打出 ticket（完整 ticket 在短 ticket 前面）。 */
function waitForTicket(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等 ticket 超时，stderr=${buffer.slice(-500)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = /connect-tcp\s+(endpoint[a-z2-7]{40,})/i.exec(buffer);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`listen-tcp 提前退出 code=${code}，stderr=${buffer.slice(-500)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

test(
  'iroh 真管道：listen-tcp → connect-tcp 把 /interconnect/link 的 101 带过去',
  { skip: AVAILABLE ? false : `没有 dumbpipe 可执行文件：${BIN}` },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iroh-link-'));
    const credFile = path.join(tmp, '.credentials.yaml');
    fs.writeFileSync(credFile, `DSH_INTERCONNECT_TOKEN: ${TOKEN}\n`);
    const targetPort = await freePort();

    // 假 DSH：只认 Upgrade + 正确 token，回 101；否则 401。
    const fakeDsh = http.createServer((req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    fakeDsh.on('upgrade', (req, socket) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.destroy();
    });
    await new Promise((resolve) => fakeDsh.listen(targetPort, '127.0.0.1', resolve));

    const listener = spawn(BIN, ['listen-tcp', '--host', `127.0.0.1:${targetPort}`], {
      env: { ...process.env, IROH_SECRET: randomBytes(32).toString('hex') },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let service = null;
    try {
      const ticket = await waitForTicket(listener);
      const localPort = await freePort();
      const config = normalizeIrohLinkConfig({
        enabled: true,
        binaryPath: BIN,
        credFile,
        identityFile: path.join(tmp, 'identity.hex'),
        probeIntervalMs: 2_000,
        probeTimeoutMs: 3_000,
        peers: { local: { localPort, ticket } },
      });
      service = new IrohLinkService({ config });
      await service.start();

      let state = 'starting';
      for (let i = 0; i < 60; i += 1) {
        await delay(250);
        state = service.status().peers[0].state;
        if (state === 'up') break;
      }
      assert.equal(state, 'up', `承载没起来：${JSON.stringify(service.status())}`);

      // 连续多次新连接都能打通（每条 TCP 连接对应一条独立 iroh stream）
      for (let i = 0; i < 3; i += 1) {
        const probe = await probeInterconnectLink({ port: localPort, token: TOKEN, timeoutMs: 8_000 });
        assert.equal(probe.upgraded, true, `第 ${i + 1} 次探测失败：${JSON.stringify(probe)}`);
      }
      // 错误 token 必须拿到 401（证明不是无脑放行）
      const denied = await probeInterconnectLink({ port: localPort, token: 'wrong', timeoutMs: 8_000 });
      assert.equal(denied.upgraded, false);
      assert.equal(denied.statusCode, 401);
    } finally {
      service?.stop();
      try {
        listener.kill();
      } catch {
        /* ignore */
      }
      fakeDsh.close();
      await delay(300);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

/**
 * frp 回环集成：不需要真的 SakuraFrp/frpc。
 * 在本机起一个 node:net 临时 TCP 服务当「对端 frpc 暴露出来的公网地址」，
 * 配成 frp 的 remoteHost/remotePort，验证服务层 → LocalFront → 公网目标这条链：
 * 101 判通、401 判承载通但鉴权失败、纯字节流也能双向转发。
 */
test('frp 回环集成：LocalFront 把前端口转发到 node:net 临时 TCP 服务（101 / 401 / 字节流）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-link-'));
  const credFile = path.join(tmp, '.credentials.yaml');
  fs.writeFileSync(credFile, `DSH_INTERCONNECT_TOKEN: ${TOKEN}\n`);

  // 假 DSH（在「对端」那边）：GET /interconnect/link + 正确 token → 101；否则 401；
  // 非 HTTP 数据原样回写，证明 LocalFront 转发的是字节流而不只是握手。
  const remote = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      const head = String(chunk);
      if (!head.startsWith('GET ')) {
        socket.write(`echo:${head}`);
        return;
      }
      const authorized = head.toLowerCase().includes(`authorization: bearer ${TOKEN}`.toLowerCase());
      socket.write(
        authorized
          ? 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
          : 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n',
      );
    });
  });
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const remotePort = remote.address().port;
  const localPort = await freePort();
  const config = normalizeIrohLinkConfig({
    enabled: true,
    transport: 'frp',
    credFile,
    probeIntervalMs: 60_000,
    probeTimeoutMs: 3_000,
    peers: { server: { localPort, frp: { remoteHost: '127.0.0.1', remotePort } } },
  });
  const service = new IrohLinkService({ config });
  try {
    await service.start();
    const started = service.status().peers[0];
    assert.equal(started.frontReady, true);
    assert.equal(started.transport, 'frp');
    assert.equal(started.backendEndpoint, `127.0.0.1:${remotePort}`);

    // 101 = 通：服务层用 credentials.yaml 里的 token 探前端口，判 up。
    await service.tick('server');
    assert.equal(service.status().peers[0].state, 'up');

    // 401 = 承载通但鉴权失败（错误 token 直接探前端口）。
    const denied = await probeInterconnectLink({ port: localPort, token: 'wrong', timeoutMs: 3_000 });
    assert.equal(denied.upgraded, false);
    assert.equal(denied.statusCode, 401);

    // 字节流回环：raw TCP 经 LocalFront → 远端临时服务再回来。
    const echoed = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: localPort });
      socket.setTimeout(3_000);
      socket.once('connect', () => socket.write('ping'));
      socket.once('data', (chunk) => {
        socket.destroy();
        resolve(String(chunk));
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('timeout'));
      });
      socket.once('error', reject);
    });
    assert.equal(echoed, 'echo:ping');
  } finally {
    service.stop();
    remote.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
