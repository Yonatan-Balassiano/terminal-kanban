import { spawn } from 'child_process';
import { posix } from 'path';

/**
 * How long a forward has to stay up before its next failure counts as a fresh
 * one rather than a continuation of the same outage.
 */
const STABLE_CONNECTION_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/**
 * Consecutive failed launches before the forward stops retrying on its own and
 * waits for the next {@link SocketForward.ensure}. A host that is asleep or
 * off-VPN should not be dialled every 30s forever — every dial goes through the
 * same `coder ssh` proxy a user's own connection would.
 */
const MAX_CONSECUTIVE_FAILURES = 5;
/** A cold connect to a Coder workspace measured ~8s; the bind follows it. */
const VERIFY_ATTEMPTS = 15;
const VERIFY_INTERVAL_MS = 2_000;
/** How often an `up` forward is re-checked from {@link SocketForward.ensure}. */
const RECHECK_INTERVAL_MS = 60_000;
const SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SERVER_ALIVE_COUNT_MAX = 3;
const CONNECT_TIMEOUT_SECONDS = 25;

export type SocketForwardState = 'stopped' | 'connecting' | 'up' | 'down';

export interface SocketForwardStatus {
  state: SocketForwardState;
  host: string;
  localSocket: string;
  remoteSocket: string | null;
  /** When `state` last changed. */
  since: number;
  /** How many times the ssh process has been (re)launched. */
  launches: number;
  lastError?: string;
}

/** The slice of a child process the forward needs; injectable for tests. */
export interface ForwardProcess {
  onExit(listener: (code: number | null, stderr: string) => void): void;
  kill(): void;
}

export interface SocketForwardOptions {
  host: string;
  /** The daemon's remote-RPC socket on this machine. */
  localSocket: string;
  /**
   * Runs a command on the remote host, over the daemon's own multiplexed
   * transport. Used to prepare the socket's directory and to check the bind.
   */
  remoteExec: (argv: string[]) => Promise<unknown>;
  spawnForward?: (args: string[]) => ForwardProcess;
  now?: () => number;
  log?: (message: string) => void;
  /** Overridable so tests don't sit through real retry and verify intervals. */
  timing?: Partial<{
    initialBackoffMs: number;
    maxBackoffMs: number;
    verifyAttempts: number;
    verifyIntervalMs: number;
    recheckIntervalMs: number;
  }>;
}

function spawnSsh(args: string[]): ForwardProcess {
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // Only the tail matters; a banner must not grow this without bound.
    stderr = (stderr + chunk).slice(-2_000);
  });
  return {
    onExit(listener) {
      child.on('error', (error) => listener(null, error.message));
      child.on('exit', (code) => listener(code, stderr));
    },
    kill() {
      child.kill('SIGTERM');
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Keeps the daemon's remote-RPC socket reachable as a unix socket on the remote
 * host (`ssh -N -R <remote>:<local>`), so the agentboard CLI inside a remote
 * card can talk to this board.
 *
 * Its own ssh connection, not a forward on the ControlMaster: the master exits
 * after `ControlPersist` with no clients, taking a listener with it, and is
 * replaced wholesale by a reconnect. A dedicated process lives exactly as long
 * as the forward does, and its exit is the signal to relaunch it.
 *
 * Coder's SSH server never reports a failed bind — `ExitOnForwardFailure` does
 * nothing against it, ssh just sits there — so the socket is checked on the
 * remote host with `test -S` instead of trusting the process being alive. It
 * does replace a stale socket file at the path and removes it on disconnect,
 * both verified live; the directory is created 0700 first because it ignores
 * `StreamLocalBindMask` and binds 0755.
 */
export class SocketForward {
  private readonly host: string;
  private readonly localSocket: string;
  private readonly remoteExec: (argv: string[]) => Promise<unknown>;
  private readonly spawnForward: (args: string[]) => ForwardProcess;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly timing: Required<NonNullable<SocketForwardOptions['timing']>>;

  private remoteSocket: string | null = null;
  private wanted = false;
  private child: ForwardProcess | null = null;
  private launching = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private failures = 0;
  private upSince: number | null = null;
  private lastCheckedAt = 0;
  private checking = false;
  private status: SocketForwardStatus;

  constructor(options: SocketForwardOptions) {
    this.host = options.host;
    this.localSocket = options.localSocket;
    this.remoteExec = options.remoteExec;
    this.spawnForward = options.spawnForward ?? spawnSsh;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.timing = {
      initialBackoffMs: INITIAL_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      verifyAttempts: VERIFY_ATTEMPTS,
      verifyIntervalMs: VERIFY_INTERVAL_MS,
      recheckIntervalMs: RECHECK_INTERVAL_MS,
      ...options.timing,
    };
    this.backoffMs = this.timing.initialBackoffMs;
    this.status = {
      state: 'stopped',
      host: this.host,
      localSocket: this.localSocket,
      remoteSocket: null,
      since: this.now(),
      launches: 0,
    };
  }

  getStatus(): SocketForwardStatus {
    return { ...this.status };
  }

  /**
   * Ask for the forward to be up. Cheap and idempotent — callers on the hot
   * path (every inspect) call it freely. Starts the forward when it is not
   * running, resumes retrying after the failure cap, and re-checks an `up`
   * forward at most once a {@link RECHECK_INTERVAL_MS}.
   */
  ensure(remoteSocket: string): void {
    this.wanted = true;
    if (this.remoteSocket !== remoteSocket) {
      this.remoteSocket = remoteSocket;
      this.status.remoteSocket = remoteSocket;
      if (this.child) {
        // A different path (a new $HOME) needs a new process; its exit relaunches.
        const child = this.child;
        this.child = null;
        child.kill();
        return;
      }
    }

    if (this.child || this.launching || this.retryTimer) {
      if (this.status.state === 'up') {
        void this.recheck();
      }
      return;
    }
    this.failures = 0;
    void this.launch();
  }

  /** Stop forwarding and stop retrying. The remote socket goes with the connection. */
  stop(): void {
    this.wanted = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const child = this.child;
    this.child = null;
    child?.kill();
    this.setState('stopped');
  }

  private setState(state: SocketForwardState, error?: string): void {
    if (this.status.state !== state) {
      this.status.since = this.now();
      this.log(`socket forward ${this.host}: ${state}${error ? ` (${error})` : ''}`);
    }
    this.status.state = state;
    if (error !== undefined) {
      this.status.lastError = error;
    }
  }

  private sshArgs(remoteSocket: string): string[] {
    return [
      '-o',
      'BatchMode=yes',
      // Its own connection — see the class comment.
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StreamLocalBindUnlink=yes',
      '-o',
      `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
      '-o',
      `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
      '-o',
      `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
      '-N',
      '-R',
      `${remoteSocket}:${this.localSocket}`,
      this.host,
    ];
  }

  private async launch(): Promise<void> {
    const remoteSocket = this.remoteSocket;
    if (!this.wanted || !remoteSocket) {
      return;
    }
    this.launching = true;
    this.setState('connecting');

    try {
      const dir = posix.dirname(remoteSocket);
      await this.remoteExec(['sh', '-c', `mkdir -p "$1" && chmod 700 "$1"`, 'sh', dir]);
    } catch (error) {
      this.launching = false;
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!this.wanted || this.remoteSocket !== remoteSocket) {
      this.launching = false;
      return;
    }

    const child = this.spawnForward(this.sshArgs(remoteSocket));
    this.child = child;
    this.launching = false;
    this.status.launches += 1;
    child.onExit((code, stderr) => this.onChildExit(child, code, stderr));

    for (let attempt = 0; attempt < this.timing.verifyAttempts; attempt += 1) {
      await sleep(this.timing.verifyIntervalMs);
      if (this.child !== child) {
        return;
      }
      if (await this.socketIsBound(remoteSocket)) {
        this.upSince = this.now();
        this.lastCheckedAt = this.now();
        this.failures = 0;
        this.backoffMs = this.timing.initialBackoffMs;
        this.setState('up');
        return;
      }
    }
    if (this.child === child) {
      // Connected or not, the socket never appeared: treat it as a failure and
      // let the exit handler schedule the retry.
      this.status.lastError = `${remoteSocket} never appeared on ${this.host}`;
      child.kill();
    }
  }

  private async socketIsBound(remoteSocket: string): Promise<boolean> {
    try {
      await this.remoteExec(['test', '-S', remoteSocket]);
      return true;
    } catch {
      return false;
    }
  }

  /** The workspace can be rebuilt under a live process; the socket is the truth. */
  private async recheck(): Promise<void> {
    const remoteSocket = this.remoteSocket;
    if (this.checking || !remoteSocket || this.now() - this.lastCheckedAt < this.timing.recheckIntervalMs) {
      return;
    }
    this.checking = true;
    try {
      this.lastCheckedAt = this.now();
      if (!(await this.socketIsBound(remoteSocket)) && this.child && this.status.state === 'up') {
        this.status.lastError = `${remoteSocket} disappeared on ${this.host}`;
        this.child.kill();
      }
    } finally {
      this.checking = false;
    }
  }

  private onChildExit(child: ForwardProcess, code: number | null, stderr: string): void {
    if (this.child !== child) {
      // Stopped or replaced on purpose.
      if (this.wanted && !this.child && !this.launching && !this.retryTimer) {
        void this.launch();
      }
      return;
    }
    this.child = null;
    if (this.upSince !== null && this.now() - this.upSince >= STABLE_CONNECTION_MS) {
      // A long-lived forward dropping is a new outage, not the same one again.
      this.failures = 0;
      this.backoffMs = this.timing.initialBackoffMs;
    }
    this.upSince = null;
    const detail = stderr.trim().split('\n').pop() || this.status.lastError || `ssh exited ${code}`;
    this.fail(detail);
  }

  private fail(error: string): void {
    this.failures += 1;
    if (!this.wanted) {
      this.setState('stopped', error);
      return;
    }
    this.setState('down', error);
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      // Idle until the next ensure(), which a live remote session will make.
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.timing.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.launch();
    }, delay);
    this.retryTimer.unref?.();
  }
}
