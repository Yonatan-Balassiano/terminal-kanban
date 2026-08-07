import { createHash } from 'crypto';
import { join } from 'path';
import { LocalTransport } from './local.js';
import { shellJoin, shellQuote } from '../shell-quote.js';
import {
  ExecError,
  SSH_TRANSPORT_EXIT_CODE,
  TransportUnreachableError,
  type ExecOptions,
  type ExecResult,
  type ExecTransport,
  type TransportReachability,
} from './types.js';

/**
 * Cold SSH connects to a Coder workspace measured ~8s; over an established
 * ControlMaster socket the same command takes ~50ms. Multiplexing is therefore
 * required rather than an optimisation.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 25_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const CONTROL_PERSIST_SECONDS = 300;
const SERVER_ALIVE_INTERVAL_SECONDS = 15;
const REACHABLE_CACHE_MS = 5_000;
const UNREACHABLE_CACHE_MS = 10_000;
const REACHABILITY_PROBE_TIMEOUT_MS = 8_000;

export interface SshTransportOptions {
  host: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Injectable for tests; defaults to running the real `ssh` binary locally. */
  runner?: ExecTransport;
  now?: () => number;
}

interface ReachabilityCacheEntry {
  value: TransportReachability;
  expiresAt: number;
}

/**
 * The OpenSSH ControlPath is bound by the 104-byte sockaddr_un limit. The macOS
 * temp dir alone can approach that, so the socket always goes in /tmp under a
 * hashed, fixed-length name.
 */
export function buildControlPath(host: string, uid: number): string {
  const digest = createHash('sha256').update(host).digest('hex').slice(0, 8);
  return join('/tmp', `agentboard-ssh-${uid}-${digest}.sock`);
}

/** Runs commands on a remote host over a shared, multiplexed SSH connection. */
export class SshTransport implements ExecTransport {
  readonly id: string;
  readonly isRemote = true;

  readonly host: string;
  private readonly controlPath: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly runner: ExecTransport;
  private readonly now: () => number;

  private masterInFlight: Promise<void> | null = null;
  private reachabilityCache: ReachabilityCacheEntry | null = null;

  constructor(options: SshTransportOptions) {
    this.host = options.host;
    this.id = `ssh:${options.host}`;
    this.controlPath = buildControlPath(options.host, process.getuid?.() ?? 0);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.runner = options.runner ?? new LocalTransport();
    this.now = options.now ?? Date.now;
  }

  /**
   * SSH options shared by every invocation.
   *
   * `ControlMaster=auto` is on the options for *every* command, not just the
   * warm-up: a command then transparently reuses the shared socket when it
   * exists and creates it when it does not. That keeps the hot path to a single
   * ssh process — probing with `ssh -O check` first would double the process
   * count and cost more than the command itself.
   */
  private baseSshOptions(): string[] {
    return [
      '-o',
      'BatchMode=yes',
      '-o',
      `ControlPath=${this.controlPath}`,
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
      '-o',
      `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
    ];
  }

  /** The attach command used by the local wrapper session's pane. */
  attachArgs(remoteCommand: readonly string[]): string[] {
    return ['ssh', ...this.baseSshOptions(), '-t', this.host, '--', shellJoin(remoteCommand)];
  }

  /**
   * Open the shared master connection up front.
   *
   * Optional — any `exec` will create the master on demand — but calling this
   * before a burst of commands means the ~8s cold connect is paid once, and
   * serialising it behind a single in-flight promise means N sessions opening
   * together share that one connect instead of racing to make their own.
   */
  async ensureMaster(): Promise<void> {
    if (this.masterInFlight) {
      return this.masterInFlight;
    }

    const connect = (async () => {
      try {
        await this.runner.exec(
          [
            'ssh',
            ...this.baseSshOptions(),
            '-o',
            `ConnectTimeout=${Math.ceil(this.connectTimeoutMs / 1000)}`,
            '-f',
            '-N',
            this.host,
          ],
          { timeoutMs: this.connectTimeoutMs }
        );
      } finally {
        this.masterInFlight = null;
      }
    })();

    this.masterInFlight = connect;
    return connect;
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const envPrefix = Object.entries(options.env ?? {}).map(
      ([key, value]) => `${key}=${shellQuote(value)}`
    );
    const parts = [...envPrefix, shellJoin(argv)];
    const command = options.cwd
      ? `cd ${shellQuote(options.cwd)} && ${parts.join(' ')}`
      : parts.join(' ');

    // Only stdout is trusted: the Coder workspace prints its startup banner on
    // stderr, so a non-empty stderr must never be read as failure.
    try {
      return await this.runner.exec(
        ['ssh', ...this.baseSshOptions(), this.host, '--', command],
        { timeoutMs: options.timeoutMs ?? this.commandTimeoutMs }
      );
    } catch (error) {
      throw this.classifyError(error, argv);
    }
  }

  /**
   * Separate "ssh could not reach the host" from "the remote command exited
   * non-zero", so callers can tell a real answer from no answer at all.
   */
  private classifyError(error: unknown, argv: readonly string[]): unknown {
    if (!(error instanceof ExecError)) {
      return error;
    }
    if (error.timedOut) {
      this.reachabilityCache = null;
      return new TransportUnreachableError(
        `ssh ${this.host} timed out running: ${argv.join(' ')}`,
        error
      );
    }
    if (error.exitCode === SSH_TRANSPORT_EXIT_CODE) {
      this.reachabilityCache = null;
      return new TransportUnreachableError(
        `ssh ${this.host} could not connect: ${error.stderr.trim() || error.message}`,
        error
      );
    }
    return error;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.exec(['test', '-e', path]);
      return true;
    } catch (error) {
      // Only a clean non-zero exit means "not there". A connection failure has
      // to propagate, or an unreachable host looks like an empty filesystem.
      if (error instanceof ExecError) {
        return false;
      }
      throw error;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec(['mkdir', '-p', path]);
  }

  async removeDir(path: string): Promise<void> {
    await this.exec(['rm', '-rf', path]);
  }

  async writeFileIfChanged(path: string, content: string, mode?: number): Promise<boolean> {
    const existing = await this.readFileOrNull(path);
    if (existing === content) {
      return false;
    }

    const encoded = Buffer.from(content, 'utf8').toString('base64');
    const parentDir = path.replace(/\/[^/]*$/, '');
    if (parentDir && parentDir !== path) {
      await this.mkdirp(parentDir);
    }
    await this.exec([
      'sh',
      '-c',
      `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
    ]);
    if (mode !== undefined) {
      await this.exec(['chmod', mode.toString(8), path]);
    }
    return true;
  }

  private async readFileOrNull(path: string): Promise<string | null> {
    try {
      const result = await this.exec(['cat', path]);
      return result.stdout;
    } catch (error) {
      if (error instanceof ExecError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Cheap liveness probe with a short cache, so a poll loop cannot hammer a host
   * that is asleep or off-VPN. A dead remote must never wedge the board.
   */
  async reachability(): Promise<TransportReachability> {
    const cached = this.reachabilityCache;
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    let value: TransportReachability = 'unreachable';
    try {
      await this.runner.exec(['ssh', ...this.baseSshOptions(), this.host, '--', 'true'], {
        timeoutMs: this.connectTimeoutMs,
      });
      value = 'ok';
    } catch {
      value = 'unreachable';
    }

    this.reachabilityCache = {
      value,
      expiresAt: this.now() + (value === 'ok' ? REACHABLE_CACHE_MS : UNREACHABLE_CACHE_MS),
    };
    return value;
  }

  /** Close the shared master connection. Used on daemon shutdown. */
  async disconnect(): Promise<void> {
    try {
      await this.runner.exec(
        ['ssh', '-O', 'exit', '-o', `ControlPath=${this.controlPath}`, this.host],
        { timeoutMs: REACHABILITY_PROBE_TIMEOUT_MS }
      );
    } catch {
      // Master may already be gone.
    }
    this.reachabilityCache = null;
  }
}
