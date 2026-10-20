// ============================================================
// AgentBoard — local web server for the browser board
// ============================================================
//
// A second transport in front of the same `dispatch()` the Unix socket uses:
// `POST /api/rpc` for calls, `GET /api/events` (Server-Sent Events) for the
// pushes `serverEvents` fans out, and the built React app from `dist/web`.
//
// It binds 127.0.0.1 only, but that is not enough on its own: any page open in
// the user's browser can send requests to localhost. So every API call needs
// the token from the state dir (handed over once through `agentboard web` and
// kept in an HttpOnly cookie), the Host header must name this server (DNS
// rebinding), a cross-site Origin is refused, and only the methods in
// `WEB_RPC_METHODS` are reachable — the card actions the TUI offers, and no
// configuration, raw input or remote-host methods.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { EventEmitter } from 'events';
import type { RPCEvent, RPCMethod, RPCRequest } from '../types/index.js';
import type { ServiceContainer } from './index.js';
import { dispatch, serverEvents } from './server.js';

export { loadOrCreateWebToken, webBoardUrl } from './web-token.js';

/**
 * Everything the browser can call. This list is the web board's whole write
 * surface: widen it deliberately. Messages go through `notifyTaskSession`
 * (one verified, submitted turn, or queued) — never `sendInput`, which types raw
 * keystrokes. Teleport is in (preflight first, the same checks the TUI's
 * Ctrl+T shows); reconnect is not. Also left out: repo and config edits,
 * `deleteTask`'s `purge` and `notifyTaskSession`'s `fromTaskId` (both
 * stripped below).
 */
export const WEB_RPC_METHODS: ReadonlySet<RPCMethod> = new Set<RPCMethod>([
  // read
  'daemonStatus',
  'getBoard',
  'getFleetStatus',
  'getAttentionItems',
  'getReleaseStatus',
  'getConversation',
  // sessions
  'focusTask',
  'notifyTaskSession',
  'openSession',
  'recreateSession',
  'teleportTaskPreflight',
  'teleportTask',
  // cards
  'createTask',
  'renameTask',
  'setTaskPinned',
  'updateTaskDescription',
  'deleteTask',
  // pull requests
  'createTaskPR',
  'mergeTaskPR',
  'commentTaskPR',
  'triggerSync',
]);

export const WEB_TOKEN_COOKIE = 'agentboard_web';
const MAX_BODY_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Where the built React app lives, from either `dist/daemon` or `src/daemon` under tsx. */
export function resolveWebStaticDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(moduleDir, '../web'), path.resolve(moduleDir, '../../dist/web')];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

export interface WebServerOptions {
  services: ServiceContainer;
  socketPath: string;
  port: number;
  token: string;
  staticDir: string | null;
  /** Injected by tests; the daemon's own emitter otherwise. */
  events?: EventEmitter;
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(req: http.IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createWebServer(opts: WebServerOptions): http.Server {
  const events = opts.events ?? serverEvents;
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  const isAuthorized = (req: http.IncomingMessage): boolean => {
    const cookie = readCookie(req, WEB_TOKEN_COOKIE);
    if (cookie && tokensMatch(cookie, opts.token)) {
      return true;
    }
    const auth = req.headers.authorization;
    return typeof auth === 'string' && auth.startsWith('Bearer ')
      ? tokensMatch(auth.slice('Bearer '.length), opts.token)
      : false;
  };

  const handleRpc = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body: { method?: unknown; params?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { method?: unknown; params?: unknown };
    } catch {
      sendJson(res, 400, { error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const method = body.method;
    if (typeof method !== 'string' || !WEB_RPC_METHODS.has(method as RPCMethod)) {
      sendJson(res, 403, {
        error: { code: -32601, message: `Method not available to the web board: ${String(method)}` },
      });
      return;
    }
    let params = body.params;
    if (method === 'deleteTask' && params && typeof params === 'object') {
      params = { ...(params as Record<string, unknown>), purge: false };
    }
    if (method === 'notifyTaskSession' && params && typeof params === 'object') {
      // A message from the browser is from the user, never "from" another card.
      params = { ...(params as Record<string, unknown>), fromTaskId: undefined };
    }
    const rpcReq: RPCRequest = {
      id: crypto.randomUUID(),
      method: method as RPCMethod,
      params,
    };
    const response = await dispatch(rpcReq, opts.services, opts.socketPath);
    sendJson(res, response.error ? 500 : 200, response);
  };

  const handleEvents = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const handler = (event: RPCEvent) => {
      // Live terminal output is for the one client watching that session.
      if (event.type === 'session_update') {
        return;
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload ?? null)}\n\n`);
    };
    events.on('event', handler);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      events.off('event', handler);
    });
  };

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => {
    if (!opts.staticDir) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The web board is not built. Run `npm run build:web`.');
      return;
    }
    const root = opts.staticDir;
    let file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Single-page app: unknown paths get the shell.
      file = path.join(root, 'index.html');
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
    const cache = file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  };

  return http.createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? '';
      if (!allowedHosts.has(host)) {
        res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unknown host');
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Cross-origin requests are not allowed');
        return;
      }

      const url = new URL(req.url ?? '/', `http://${host}`);

      // One-time hand-over from `agentboard web`: swap the token in the URL for
      // a cookie, so it does not linger in the address bar or history.
      const handedToken = url.searchParams.get('t');
      if (handedToken !== null && req.method === 'GET') {
        url.searchParams.delete('t');
        const location = url.pathname + (url.search || '');
        if (tokensMatch(handedToken, opts.token)) {
          res.writeHead(302, {
            'Set-Cookie': `${WEB_TOKEN_COOKIE}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/`,
            Location: location,
          });
        } else {
          res.writeHead(302, { Location: location });
        }
        res.end();
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!isAuthorized(req)) {
          sendJson(res, 401, {
            error: { code: 401, message: 'Not signed in. Open the board with `agentboard web`.' },
          });
          return;
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          await handleRpc(req, res);
          return;
        }
        if (url.pathname === '/api/events' && req.method === 'GET') {
          handleEvents(req, res);
          return;
        }
        sendJson(res, 404, { error: { code: 404, message: 'Not found' } });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      serveStatic(req, res, url.pathname);
    })().catch((err: unknown) => {
      opts.services.logError?.('web request failed', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: -32000, message: 'Internal error' } });
      } else {
        res.end();
      }
    });
  });
}

/** Starts listening on 127.0.0.1; a busy port is logged, never fatal to the daemon. */
export function startWebServer(opts: WebServerOptions): http.Server {
  const server = createWebServer(opts);
  server.on('error', (err) => {
    opts.services.logError?.(`web board could not listen on 127.0.0.1:${opts.port}`, err);
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}
