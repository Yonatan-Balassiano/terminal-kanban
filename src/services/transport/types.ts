/** Identifier for the local machine transport. */
export const LOCAL_TRANSPORT_ID = 'local';

export interface ExecOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Milliseconds before the command is aborted. */
  timeoutMs?: number;
  /** Extra environment variables layered over the inherited environment. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ExecError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the command was killed for exceeding its timeout. */
  readonly timedOut: boolean;

  constructor(
    message: string,
    exitCode: number,
    stdout: string,
    stderr: string,
    timedOut = false
  ) {
    super(message);
    this.name = 'ExecError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

/**
 * The SSH transport itself failed — host down, VPN off, auth rejected.
 *
 * Distinct from a command that ran and exited non-zero. Callers must not read a
 * connection failure as a negative answer: treating an unreachable host as
 * "the file does not exist" would make the worktree logic recreate live state.
 */
export class TransportUnreachableError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportUnreachableError';
    this.cause = cause;
  }
}

/** ssh(1) exits 255 for its own failures, distinct from the remote command's status. */
export const SSH_TRANSPORT_EXIT_CODE = 255;

export type TransportReachability = 'ok' | 'unreachable';

/**
 * A place commands can run and files can live.
 *
 * `LocalTransport` targets the laptop; `SshTransport` targets a remote host over
 * a multiplexed SSH connection. Services that speak only this interface work
 * unchanged against either host.
 */
export interface ExecTransport {
  /** Stable identity, e.g. `local` or `ssh:my.host`. Used as a cache key. */
  readonly id: string;
  /** True when commands run on another machine. */
  readonly isRemote: boolean;

  /** Run a command. Throws {@link ExecError} on a non-zero exit. */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** Whether a path exists on the target host. */
  exists(path: string): Promise<boolean>;
  /** Create a directory and any missing parents. */
  mkdirp(path: string): Promise<void>;
  /** Remove a directory tree, ignoring a missing path. */
  removeDir(path: string): Promise<void>;
  /** Write a file only when its content differs, returning true when written. */
  writeFileIfChanged(path: string, content: string, mode?: number): Promise<boolean>;
  /** Cheap liveness probe. Local transports always report `ok`. */
  reachability(): Promise<TransportReachability>;
}
