// ============================================================
// AgentBoard — the daemon socket remote cards reach over SSH
// ============================================================
//
// A third transport in front of the same `dispatch()`, for the agentboard CLI
// running inside a remote (ssh-backend) card. Its socket is forwarded to the
// remote host (`SocketForward`), so anything on that host running as the user
// can connect to it — which is why it is not the main socket:
//
// - only the methods in `REMOTE_RPC_METHODS` are reachable — what the remote
//   CLI's commands need, nothing that edits repos, config or other cards'
//   sessions;
// - every call but `daemonStatus` carries the calling card's token, an HMAC of
//   its task id the daemon handed to that card's session alone, so a call is
//   made *as* a card, never as whichever card it names;
// - and the parameters that name a card as the actor are pinned to that card:
//   `notifyTaskSession`'s `fromTaskId` is always the caller (the same rule as
//   the web board), and `createTask`, `openSession` and `addTaskBranch` only
//   reach the caller and the cards below it.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { RPCMethod, RPCRequest, RPCResponse } from '../types/index.js';
import type { ServiceContainer } from './index.js';
import { dispatch } from './server.js';

export const REMOTE_RPC_METHODS: ReadonlySet<RPCMethod> = new Set<RPCMethod>([
  'daemonStatus',
  'getBoard',
  'getFleetStatus',
  'listRepos',
  'createTask',
  'openSession',
  'notifyTaskSession',
  'addTaskBranch',
]);

/** Answered without a token, so `agentboard doctor` can test the path end to end. */
const TOKENLESS_METHODS: ReadonlySet<RPCMethod> = new Set<RPCMethod>(['daemonStatus']);

/** A request line longer than this is dropped with the connection. */
const MAX_LINE_BYTES = 1024 * 1024;
const TOKEN_SEPARATOR = '.';
/** A walk up `parentTaskId` longer than this is a cycle, not a family. */
const MAX_FAMILY_DEPTH = 64;

/** Where the daemon listens for remote cards: a private dir next to the main socket. */
export function remoteRpcSocketPath(): string {
  const uid = process.getuid?.() ?? 'user';
  return path.join(os.tmpdir(), `agentboard-${uid}-remote`, 'rpc.sock');
}

/**
 * Mints and checks the per-card tokens.
 *
 * Stateless on purpose: a remote session outlives the daemon that started it
 * (the agent keeps running in the remote tmux), so a token kept only in memory
 * would stop working on the first daemon restart. An HMAC under a secret kept
 * in the state dir verifies the same way across restarts, and needs no table.
 */
export class RemoteCallerTokens {
  constructor(private readonly secret: Buffer) {}

  static loadOrCreate(stateDir: string): RemoteCallerTokens {
    const file = path.join(stateDir, 'remote-cli-secret');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 64) {
        return new RemoteCallerTokens(Buffer.from(existing, 'hex'));
      }
    } catch {
      // Not created yet.
    }
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, secret.toString('hex') + '\n', { mode: 0o600 });
    return new RemoteCallerTokens(secret);
  }

  private sign(taskId: string): string {
    return crypto.createHmac('sha256', this.secret).update(taskId).digest('hex');
  }

  mint(taskId: string): string {
    return `${taskId}${TOKEN_SEPARATOR}${this.sign(taskId)}`;
  }

  /** The card a token was minted for, or null. */
  verify(token: unknown): string | null {
    if (typeof token !== 'string') {
      return null;
    }
    const at = token.lastIndexOf(TOKEN_SEPARATOR);
    if (at <= 0) {
      return null;
    }
    const taskId = token.slice(0, at);
    const given = Buffer.from(token.slice(at + 1));
    const expected = Buffer.from(this.sign(taskId));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
      ? taskId
      : null;
  }
}

interface FamilyLookup {
  getTask(id: string): { parentTaskId?: string } | null;
}

/** Whether `taskId` is `callerId` or a card somewhere below it. */
export function isCallerOrDescendant(board: FamilyLookup, callerId: string, taskId: string): boolean {
  let current: string | undefined = taskId;
  for (let depth = 0; current && depth < MAX_FAMILY_DEPTH; depth += 1) {
    if (current === callerId) {
      return true;
    }
    current = board.getTask(current)?.parentTaskId;
  }
  return false;
}

/**
 * The request as the caller is allowed to make it: identity parameters pinned
 * to the caller, and a refusal for a card outside its family. Throws with the
 * message the remote CLI prints.
 */
export function restrictRemoteRequest(
  req: RPCRequest,
  callerId: string,
  board: FamilyLookup,
): RPCRequest {
  const params = { ...((req.params ?? {}) as Record<string, unknown>) };
  const requireFamily = (taskId: unknown, what: string) => {
    if (typeof taskId !== 'string' || !isCallerOrDescendant(board, callerId, taskId)) {
      throw new Error(
        `A remote card can only ${what} itself or its own subtasks (this is card ${callerId}).`,
      );
    }
  };

  switch (req.method) {
    case 'notifyTaskSession':
      params['fromTaskId'] = callerId;
      break;
    case 'createTask':
      params['parentTaskId'] = params['parentTaskId'] ?? callerId;
      requireFamily(params['parentTaskId'], 'create subtasks under');
      break;
    case 'openSession':
      requireFamily(params['taskId'], 'open sessions for');
      break;
    case 'addTaskBranch':
      requireFamily(params['taskId'], 'attach pull requests to');
      break;
    default:
      break;
  }
  return { ...req, params };
}

/** One request off the wire, answered. Exported for tests. */
export async function handleRemoteRequest(
  raw: string,
  services: ServiceContainer,
  tokens: RemoteCallerTokens,
  mainSocketPath: string,
): Promise<RPCResponse> {
  let parsed: Partial<RPCRequest> & { token?: unknown };
  try {
    parsed = JSON.parse(raw) as Partial<RPCRequest> & { token?: unknown };
  } catch {
    return { id: '', error: { code: -32700, message: 'Parse error' } };
  }
  const id = typeof parsed.id === 'string' ? parsed.id : '';
  const method = parsed.method as RPCMethod;

  if (!REMOTE_RPC_METHODS.has(method)) {
    return {
      id,
      error: { code: -32601, message: `${String(method)} is not available to a remote card` },
    };
  }

  const req: RPCRequest = { id, method, params: parsed.params };
  if (TOKENLESS_METHODS.has(method)) {
    return dispatch(req, services, mainSocketPath);
  }

  const callerId = tokens.verify(parsed.token);
  if (!callerId || !services.board.getTask(callerId)) {
    return {
      id,
      error: {
        code: -32001,
        message:
          'Not authorized: this shell has no valid AgentBoard card token. ' +
          'Run the command from inside a remote card (its token is in $AGENTBOARD_RPC_TOKEN, or .agentboard/rpc-token in its worktree).',
      },
    };
  }

  let restricted: RPCRequest;
  try {
    restricted = restrictRemoteRequest(req, callerId, services.board);
  } catch (error) {
    return { id, error: { code: -32003, message: (error as Error).message } };
  }
  return dispatch(restricted, services, mainSocketPath);
}

/**
 * A directory only this user can enter, refused if something else already
 * owns the name. On Linux `/tmp` is shared, and a directory planted there by
 * another user would otherwise hold the daemon's socket.
 */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`Refusing to use ${dir} for the remote socket: not a directory owned by this user`);
  }
  fs.chmodSync(dir, 0o700);
}

export interface RemoteRpcServerOptions {
  socketPath: string;
  mainSocketPath: string;
  services: ServiceContainer;
  tokens: RemoteCallerTokens;
}

export function startRemoteRpcServer(opts: RemoteRpcServerOptions): net.Server {
  ensurePrivateDir(path.dirname(opts.socketPath));
  try {
    fs.unlinkSync(opts.socketPath);
  } catch {
    // No stale socket.
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        handleRemoteRequest(trimmed, opts.services, opts.tokens, opts.mainSocketPath)
          .catch((): RPCResponse => ({ id: '', error: { code: -32000, message: 'Internal error' } }))
          .then((response) => {
            if (!socket.destroyed) {
              socket.write(JSON.stringify(response) + '\n');
            }
          });
      }
    });

    socket.on('error', () => {
      // Client went away mid-call; nothing to clean up.
    });
  });

  server.listen(opts.socketPath, () => {
    try {
      fs.chmodSync(opts.socketPath, 0o600);
    } catch {
      // The private directory is the real boundary.
    }
  });
  return server;
}
