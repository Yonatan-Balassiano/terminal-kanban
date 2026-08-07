// ============================================================
// AgentBoard — RPC client
// ============================================================

import * as net from 'net';
import type { RPCRequest, RPCResponse, RPCEvent, RPCMethod } from '../types/index.js';

function rpcTimeoutMs(method: RPCMethod): number {
  switch (method) {
    case 'chatTurn':
      // A single chat turn may span multiple Ollama/tool-call rounds.
      return 480_000;
    case 'shutdownManagedOllama':
      return 20_000;
    case 'createTaskPR':
    case 'mergeTaskPR':
    case 'triggerSync':
      return 45_000;
    case 'openSession':
    case 'recreateSession':
      return 20_000;
    case 'reconnectSession':
      // Cold SSH connect to a just-woken host, then a wrapper rebuild. The
      // workspace-start path answers immediately and finishes in the background.
      return 45_000;
    default:
      return 10_000;
  }
}

// --------------- RPCClient ----------------------------------

export class RPCClient {
  private readonly socketPath: string;
  private socket: net.Socket | null = null;

  /** Pending calls keyed by request id. */
  private pending = new Map<
    string,
    { resolve: (resp: RPCResponse) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** Active event subscription callbacks. */
  private eventListeners: Array<(event: RPCEvent) => void> = [];

  /** Incomplete line fragment carried across data events. */
  private readBuffer = '';

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  // --------------- connect ----------------------------------

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      this.socket = sock;

      sock.setEncoding('utf8');

      sock.connect(this.socketPath, () => {
        resolve();
      });

      sock.on('data', (chunk: string) => {
        this.readBuffer += chunk;
        const lines = this.readBuffer.split('\n');
        this.readBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // Malformed line from server — skip.
            continue;
          }

          // Distinguish RPCEvent (has `type`) from RPCResponse (has `id`).
          if (this.isRPCEvent(parsed)) {
            for (const listener of this.eventListeners) {
              try {
                listener(parsed);
              } catch {
                // Never let a listener crash the client.
              }
            }
          } else if (this.isRPCResponse(parsed)) {
            const pending = this.pending.get(parsed.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(parsed.id);
              pending.resolve(parsed);
            }
          }
        }
      });

      sock.on('error', (err) => {
        // Reject all pending calls.
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        this.pending.clear();
        reject(err);
      });

      sock.on('close', () => {
        const err = new Error('RPC socket closed');
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        this.pending.clear();
        this.eventListeners = [];
      });
    });
  }

  // --------------- disconnect -------------------------------

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // --------------- call -------------------------------------

  call<T>(method: RPCMethod, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('RPC client is not connected'));
        return;
      }

      const id = crypto.randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call timed out: ${method} (id=${id})`));
      }, rpcTimeoutMs(method));

      this.pending.set(id, {
        resolve: (resp: RPCResponse) => {
          if (resp.error) {
            reject(new Error(resp.error.message));
          } else {
            resolve(resp.result as T);
          }
        },
        reject,
        timer,
      });

      const req: RPCRequest = { id, method, params };
      try {
        this.socket.write(JSON.stringify(req) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: RPCMethod, params?: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('RPC client is not connected');
    }

    const req: RPCRequest = { id: '', method, params };
    this.socket.write(JSON.stringify(req) + '\n');
  }

  // --------------- subscribe --------------------------------

  /**
   * Sends a `subscribe` RPC call to opt in to server-push events, then
   * pipes all incoming `RPCEvent` messages to `onEvent`.
   *
   * Returns an unsubscribe function that removes the listener (but does NOT
   * tell the server to stop pushing — daemon push is currently broadcast-only).
   */
  subscribe(onEvent: (event: RPCEvent) => void): () => void {
    this.eventListeners.push(onEvent);

    // Fire-and-forget the subscribe call; errors are non-fatal here.
    this.call('subscribe').catch(() => {
      // Subscription handshake failed — remove the listener we just added.
      this.eventListeners = this.eventListeners.filter((l) => l !== onEvent);
    });

    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== onEvent);
    };
  }

  // --------------- type guards ------------------------------

  private isRPCEvent(v: unknown): v is RPCEvent {
    return (
      typeof v === 'object' &&
      v !== null &&
      'type' in v &&
      !('id' in v)
    );
  }

  private isRPCResponse(v: unknown): v is RPCResponse {
    return typeof v === 'object' && v !== null && 'id' in v;
  }
}

// --------------- createRPCClient ----------------------------

/**
 * Convenience factory — creates an RPCClient, connects it, and returns it.
 */
export async function createRPCClient(socketPath: string): Promise<RPCClient> {
  const client = new RPCClient(socketPath);
  await client.connect();
  return client;
}
