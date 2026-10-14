import { EventEmitter } from 'events';
import * as fs from 'fs';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../src/daemon/index.js';
import { createWebServer, loadOrCreateWebToken, WEB_TOKEN_COOKIE } from '../src/daemon/web-server.js';

const TOKEN = 'a'.repeat(64);

interface Harness {
  server: http.Server;
  port: number;
  events: EventEmitter;
  services: ServiceContainer;
  staticDir: string;
}

async function startHarness(): Promise<Harness> {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-web-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>board</title>');
  const events = new EventEmitter();
  const services = {
    view: { getBoardSnapshot: () => ({ tasks: [{ id: 't1' }], repos: [] }) },
    session: {
      openSession: vi.fn(async () => ({ id: 's1', backendType: 'tmux', backendSessionId: 'ab_t1' })),
      getFleetStatus: vi.fn(async () => []),
    },
    webLayout: { isRunning: vi.fn(async () => true), focus: vi.fn(async () => '%7') },
    board: { deleteTask: vi.fn() },
  } as unknown as ServiceContainer;

  // The port is only known after listening, and the Host check needs it, so
  // bind first on an ephemeral port and build the real server for that port.
  const probe = createWebServer({ services, socketPath: '/tmp/x.sock', port: 0, token: TOKEN, staticDir, events });
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const server = createWebServer({ services, socketPath: '/tmp/x.sock', port, token: TOKEN, staticDir, events });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, events, services, staticDir };
}

function rpc(h: Harness, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${h.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${WEB_TOKEN_COOKIE}=${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ method, params }),
  });
}

describe('web server', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    h.server.closeAllConnections();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    fs.rmSync(h.staticDir, { recursive: true, force: true });
  });

  it('answers an allowed method through the shared dispatch', async () => {
    const res = await rpc(h, 'getBoard');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tasks: unknown[] } };
    expect(body.result.tasks).toHaveLength(1);
  });

  it('refuses methods outside the read-only allowlist', async () => {
    const res = await rpc(h, 'deleteTask', { taskId: 't1' });
    expect(res.status).toBe(403);
  });

  it('requires the token', async () => {
    const res = await rpc(h, 'getBoard', {}, { Cookie: '' });
    expect(res.status).toBe(401);
    const bearer = await rpc(h, 'getBoard', {}, { Cookie: '', Authorization: `Bearer ${TOKEN}` });
    expect(bearer.status).toBe(200);
  });

  it('refuses a cross-site origin even with a valid cookie', async () => {
    const res = await rpc(h, 'getBoard', {}, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    const own = await rpc(h, 'getBoard', {}, { Origin: `http://127.0.0.1:${h.port}` });
    expect(own.status).toBe(200);
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const http = await import('http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: h.port, path: '/', headers: { Host: `evil.example:${h.port}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('swaps the handed-over token for an HttpOnly cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/?t=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain(`${WEB_TOKEN_COOKIE}=${TOKEN}`);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');

    const wrong = await fetch(`http://127.0.0.1:${h.port}/?t=nope`, { redirect: 'manual' });
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('focusTask opens the session and puts its pane in the web layout', async () => {
    const res = await rpc(h, 'focusTask', { taskId: 't1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { paneId: string } };
    expect(body.result.paneId).toBe('%7');
    expect(h.services.webLayout?.focus).toHaveBeenCalledWith('ab_t1');
  });

  it('focusTask starts nothing when the web layout is not running', async () => {
    vi.mocked(h.services.webLayout!.isRunning).mockResolvedValueOnce(false);
    const res = await rpc(h, 'focusTask', { taskId: 't1' });
    expect(res.status).toBe(500);
    expect(h.services.session.openSession).not.toHaveBeenCalled();
  });

  it('serves the app shell for unknown paths and blocks traversal', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/some/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>board</title>');
    const traversal = await fetch(`http://127.0.0.1:${h.port}/%2e%2e/%2e%2e/etc/passwd`);
    expect(await traversal.text()).not.toContain('root:');
  });

  it('streams board pushes over SSE but not live terminal output', async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/api/events`, {
      headers: { Cookie: `${WEB_TOKEN_COOKIE}=${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    h.events.emit('event', { type: 'session_update', payload: { taskId: 't1', data: 'secret' } });
    h.events.emit('event', { type: 'board_patch', payload: { tasks: [] } });

    let text = '';
    while (!text.includes('board_patch')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain('event: board_patch');
    expect(text).not.toContain('secret');
  });
});

describe('loadOrCreateWebToken', () => {
  it('creates a private token once and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-web-token-'));
    const first = loadOrCreateWebToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateWebToken(dir)).toBe(first);
    expect(fs.statSync(path.join(dir, 'web-token')).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
