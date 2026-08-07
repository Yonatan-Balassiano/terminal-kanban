import type { RemoteWorkspaceStatus } from '../../types/index.js';
import type { ExecTransport } from '../transport/index.js';
import type { RemoteHostProvider } from './types.js';

/** A build is dispatched control-plane side, so polling is the only honest signal. */
const POLL_INTERVAL_MS = 3_000;
const START_TIMEOUT_MS = 5 * 60 * 1000;

/** Bounded so a hung control plane cannot stall the daemon's reconnect path. */
const STATUS_TIMEOUT_MS = 15_000;
const START_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Coder reports a dozen build states; AgentBoard only cares whether the host is
 * usable, on its way up, off, or broken.
 */
const STATUS_BY_BUILD_STATE: Record<string, RemoteWorkspaceStatus> = {
  running: 'running',
  pending: 'starting',
  starting: 'starting',
  stopping: 'stopped',
  stopped: 'stopped',
  canceled: 'stopped',
  canceling: 'failed',
  failed: 'failed',
  deleting: 'failed',
  deleted: 'failed',
};

export interface CoderProviderOptions {
  /** Runs the `coder` CLI. This is the laptop, so a LocalTransport in production. */
  transport: ExecTransport;
  /** Workspace as `owner/name`. An SSH-style `agent.name.owner` form is normalised. */
  workspace: string;
  coderBin?: string;
  startTimeoutMs?: number;
  /** Injectable seams for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CoderWorkspaceRow {
  name?: unknown;
  owner_name?: unknown;
  latest_build?: { status?: unknown } | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `coder` CLI takes `owner/name`, never the SSH alias.
 *
 * Accepting the alias anyway costs one line and removes the sharpest edge in
 * configuring this: `remote.sshHost` is right there in the same object, and
 * pasting it into `remote.workspace` is the obvious mistake.
 */
export function normalizeWorkspaceName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.endsWith('.coder')) {
    // `agent.name.owner.coder` — the CLI wants `owner/name`.
    const parts = trimmed.slice(0, -'.coder'.length).split('.');
    if (parts.length >= 3) {
      const owner = parts[parts.length - 1];
      const name = parts[parts.length - 2];
      return `${owner}/${name}`;
    }
  }
  // A bare `owner/name.agent` still carries an agent suffix on some paths.
  return trimmed.split('.')[0] ?? trimmed;
}

/** Starts and inspects a Coder workspace through the `coder` CLI. */
export class CoderProvider implements RemoteHostProvider {
  readonly label: string;

  private readonly transport: ExecTransport;
  private readonly workspace: string;
  private readonly coderBin: string;
  private readonly startTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CoderProviderOptions) {
    this.transport = options.transport;
    this.workspace = normalizeWorkspaceName(options.workspace);
    this.label = this.workspace;
    this.coderBin = options.coderBin ?? 'coder';
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Never throws: a missing `coder` binary, an expired login, or a control plane
   * behind a dropped VPN all mean "cannot tell", and the caller falls through to
   * an SSH probe rather than refusing to reconnect.
   */
  async status(): Promise<RemoteWorkspaceStatus> {
    let stdout: string;
    try {
      const result = await this.transport.exec(
        [this.coderBin, 'list', '--output', 'json'],
        { timeoutMs: STATUS_TIMEOUT_MS }
      );
      stdout = result.stdout;
    } catch {
      return 'unknown';
    }

    let rows: unknown;
    try {
      rows = JSON.parse(stdout);
    } catch {
      return 'unknown';
    }
    if (!Array.isArray(rows)) {
      return 'unknown';
    }

    const row = (rows as CoderWorkspaceRow[]).find((candidate) => this.matches(candidate));
    if (!row) {
      return 'unknown';
    }

    const buildState = row.latest_build?.status;
    if (typeof buildState !== 'string') {
      return 'unknown';
    }
    return STATUS_BY_BUILD_STATE[buildState] ?? 'unknown';
  }

  /** `coder list` rows carry owner and name separately; accept either form. */
  private matches(row: CoderWorkspaceRow): boolean {
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name) {
      return false;
    }
    const owner = typeof row.owner_name === 'string' ? row.owner_name : '';
    return this.workspace === name || this.workspace === `${owner}/${name}`;
  }

  async start(): Promise<void> {
    await this.transport.exec([this.coderBin, 'start', this.workspace], {
      timeoutMs: START_DISPATCH_TIMEOUT_MS,
    });
  }

  /**
   * Poll until the workspace reports running.
   *
   * Transient probe failures are swallowed and retried: a build restarts the
   * networking the control plane is reached over, so a single failed `coder
   * list` mid-build says nothing about the outcome.
   */
  async waitUntilRunning(): Promise<boolean> {
    const deadline = this.now() + this.startTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      const state = await this.status();
      if (state === 'running') {
        return true;
      }
      if (state === 'failed') {
        return false;
      }
    }
    return false;
  }
}
