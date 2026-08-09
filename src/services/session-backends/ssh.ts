import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  AttachMetadata,
  BackendHealth,
  BackendSessionInfo,
  CreateSessionOpts,
  SessionBackend,
  SessionRecord,
} from '../../types/index.js';
import { generateId } from '../../db/index.js';
import { buildNewSessionBootstrapCommand } from '../session-bootstrap.js';
import { buildBackendSessionName } from '../session-name.js';
import { shellJoin } from '../shell-quote.js';
import { buildControlPath, TransportUnreachableError, type SshTransport } from '../transport/index.js';
import {
  buildTmuxAttachCommand,
  buildTmuxHasSessionArgs,
  buildTmuxKillPaneArgs,
  buildTmuxKillSessionArgs,
  buildTmuxListPanesArgs,
  buildTmuxListSessionsArgs,
  buildTmuxNewSessionArgs,
  buildTmuxSendInputCommands,
  buildTmuxSurviveDetachArgs,
  buildTmuxTagPaneArgs,
  buildTmuxUntagPaneArgs,
  buildTmuxPaneIdArgs,
  chainTmuxArgs,
  parseAgentboardSessionNames,
  parseTmuxPaneProcess,
  TMUX_PANE_PROCESS_FORMAT,
  TMUX_TAGGED_PANE_FORMAT,
} from './tmux-commands.js';
import { localTmuxRunner, type TmuxCommandResult, type TmuxCommandRunner } from './tmux.js';

/**
 * The Go TUI polls inspectSession every 2500ms and every SSH round trip costs
 * ~400ms, so identical inspects arriving inside this window reuse one answer.
 */
const INSPECT_CACHE_MS = 1_500;

/** Where the bootstrap script is mirrored on the remote host, relative to $HOME. */
const REMOTE_BOOTSTRAP_RELATIVE_PATH = '.agentboard/session-bootstrap.sh';
const REMOTE_BOOTSTRAP_MODE = 0o755;

export interface SshTmuxBackendOptions {
  /** Transport for the remote host; also supplies the ControlMaster socket. */
  transport: SshTransport;
  /** SSH host string, e.g. `main.workspace.user.coder`. */
  host: string;
  /** Injectable seams for tests; default to real `tmux` on each side. */
  remoteRunner?: TmuxCommandRunner;
  localRunner?: TmuxCommandRunner;
  /** Local path to `scripts/remote-attach.sh`; defaults to the bundled copy. */
  remoteAttachScript?: string;
  idGenerator?: () => string;
  now?: () => number;
}

interface InspectCacheEntry {
  value: BackendSessionInfo | null;
  expiresAt: number;
}

function bundledRemoteAttachScriptPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../../scripts/remote-attach.sh');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * A task session that lives in tmux on a remote host, fronted by a local tmux
 * session of the same name.
 *
 * The remote session is the authoritative one: it owns the agent process and
 * survives every local restart. The local "wrapper" session holds a single pane
 * running an SSH attach loop, and exists only so the Go layout engine — which
 * knows how to join local tmux panes into the board — needs no remote awareness
 * at all. The wrapper is disposable and rebuilt on demand.
 */
export class SshTmuxBackend implements SessionBackend {
  private readonly transport: SshTransport;
  private readonly host: string;
  private readonly controlPath: string;
  private readonly remoteRunner: TmuxCommandRunner;
  private readonly localRunner: TmuxCommandRunner;
  private readonly remoteAttachScript: string;
  private readonly idGenerator: () => string;
  private readonly now: () => number;

  private readonly inspectCache = new Map<string, InspectCacheEntry>();
  private remoteHome: string | null = null;
  private remoteBootstrapScript: string | null = null;

  constructor(options: SshTmuxBackendOptions) {
    this.transport = options.transport;
    this.host = options.host;
    this.controlPath = buildControlPath(options.host, process.getuid?.() ?? 0);
    this.remoteRunner = options.remoteRunner ?? this.createTransportRunner();
    this.localRunner = options.localRunner ?? localTmuxRunner;
    this.remoteAttachScript = options.remoteAttachScript ?? bundledRemoteAttachScriptPath();
    this.idGenerator = options.idGenerator ?? generateId;
    this.now = options.now ?? Date.now;
  }

  private createTransportRunner(): TmuxCommandRunner {
    return async (args: string[]): Promise<TmuxCommandResult> => {
      const result = await this.transport.exec(['tmux', ...args]);
      return { stdout: result.stdout, stderr: result.stderr };
    };
  }

  // ---------------- remote bootstrap script delivery ----------------

  /**
   * `sessionBootstrapScript` is an absolute path on the laptop, so it does not
   * exist on the remote host. Mirror it under $HOME on the first session and
   * remember the result, so later sessions cost no round trips at all.
   *
   * Known limitation: because the upload is memoised for the daemon's lifetime,
   * editing the local script only reaches the remote after a daemon restart.
   */
  private async ensureRemoteBootstrapScript(localScriptPath: string): Promise<string> {
    const home = await this.resolveRemoteHome();
    const remotePath = `${home}/${REMOTE_BOOTSTRAP_RELATIVE_PATH}`;
    if (this.remoteBootstrapScript === remotePath) {
      return remotePath;
    }

    const content = await readFile(localScriptPath, 'utf8');
    await this.transport.writeFileIfChanged(remotePath, content, REMOTE_BOOTSTRAP_MODE);
    this.remoteBootstrapScript = remotePath;
    return remotePath;
  }

  /** A literal `~` would be shell-quoted and never expand, so ask for $HOME. */
  private async resolveRemoteHome(): Promise<string> {
    if (this.remoteHome) {
      return this.remoteHome;
    }
    const result = await this.transport.exec(['sh', '-c', 'printf %s "$HOME"']);
    const home = result.stdout.trim();
    if (!home) {
      throw new Error(`Could not resolve $HOME on ${this.host}`);
    }
    this.remoteHome = home;
    return home;
  }

  // ---------------- local wrapper session ----------------

  /** The pane command that keeps the local wrapper glued to the remote session. */
  private buildWrapperCommand(backendSessionId: string): string {
    return shellJoin([this.remoteAttachScript, this.host, backendSessionId, this.controlPath]);
  }

  /**
   * Rebuild the local wrapper session if it is missing.
   *
   * This is the revival path: after a dropped VPN or a laptop restart the remote
   * session is still running the agent, and only this local plumbing is gone.
   */
  private async ensureWrapper(backendSessionId: string): Promise<void> {
    const exists = await this.hasLocalWrapper(backendSessionId);
    if (!exists) {
      await this.localRunner(
        chainTmuxArgs(
          buildTmuxNewSessionArgs({
            backendSessionId,
            command: this.buildWrapperCommand(backendSessionId),
          }),
          buildTmuxSurviveDetachArgs(backendSessionId)
        )
      );
    }
    await this.tagWrapperPane(backendSessionId);
  }

  /**
   * A wrapper is still alive even when its tmux session is gone.
   *
   * The Go layout engine joins the wrapper pane into the board and later parks
   * it in a holding session, both of which destroy the `ab_*` session while the
   * pane keeps running its SSH attach. Recreating a wrapper at that point would
   * leave two tagged panes for one task — the layout engine joins every tagged
   * pane it finds — and two SSH clients on the same remote tmux session, which
   * makes tmux shrink the session to the smaller client. So the pane tag is
   * checked before concluding the wrapper is dead.
   */
  private async hasLocalWrapper(backendSessionId: string): Promise<boolean> {
    if (await this.hasLocalSession(backendSessionId)) {
      return true;
    }
    const taggedPanes = await this.findLocalTaggedPanes(backendSessionId);
    return taggedPanes.length > 0;
  }

  private async hasLocalSession(backendSessionId: string): Promise<boolean> {
    try {
      await this.localRunner(buildTmuxHasSessionArgs(backendSessionId));
      return true;
    } catch {
      return false;
    }
  }

  private async tagWrapperPane(backendSessionId: string): Promise<void> {
    try {
      await this.localRunner(buildTmuxTagPaneArgs(backendSessionId, backendSessionId));
      await this.dropDuplicateTags(backendSessionId);
    } catch {
      // Best effort: the tag only matters once the pane is moved into the board layout.
    }
  }

  /**
   * Keep exactly one local pane carrying a given tag.
   *
   * Two tagged panes mean the layout engine joins both, and two SSH clients end
   * up attached to one remote tmux session — which makes tmux shrink it to the
   * smaller client. Only the freshly tagged pane survives.
   */
  private async dropDuplicateTags(backendSessionId: string): Promise<void> {
    let taggedPane: string;
    try {
      const result = await this.localRunner(buildTmuxPaneIdArgs(backendSessionId));
      taggedPane = result.stdout.trim();
    } catch {
      return;
    }
    if (!taggedPane) {
      return;
    }

    for (const paneId of await this.findLocalTaggedPanes(backendSessionId)) {
      if (paneId === taggedPane) {
        continue;
      }
      try {
        await this.localRunner(buildTmuxUntagPaneArgs(paneId));
      } catch {
        // Pane may have gone away; the next tag pass will retry.
      }
    }
  }

  private async findLocalTaggedPanes(backendSessionId: string): Promise<string[]> {
    try {
      const result = await this.localRunner(buildTmuxListPanesArgs(TMUX_TAGGED_PANE_FORMAT));
      const paneIds: string[] = [];
      for (const line of result.stdout.split('\n')) {
        const [paneId, taggedSessionId] = line.split('\t');
        if (paneId && taggedSessionId === backendSessionId) {
          paneIds.push(paneId);
        }
      }
      return paneIds;
    } catch {
      return [];
    }
  }

  // ---------------- SessionBackend ----------------

  async create(opts: CreateSessionOpts): Promise<SessionRecord> {
    const cwd = opts.cwd ?? opts.repoPath;
    const backendSessionId = buildBackendSessionName(opts.taskTitle, opts.taskId, opts.slot);
    const existing = await this.inspect(backendSessionId);

    if (!existing) {
      const remoteBootstrapScript = await this.ensureRemoteBootstrapScript(
        opts.sessionBootstrapScript
      );
      await this.remoteRunner(
        chainTmuxArgs(
          buildTmuxNewSessionArgs({ backendSessionId, cwd }),
          buildTmuxSurviveDetachArgs(backendSessionId)
        )
      );
      const bootstrapCommand = buildNewSessionBootstrapCommand({
        taskKind: opts.taskKind,
        repoPath: opts.repoPath,
        branch: opts.branch,
        baseBranch: opts.baseBranch,
        agentCli: opts.agentCli,
        usesWorktree: opts.usesWorktree,
        cwd: opts.cwd,
        bootstrapNotice: opts.bootstrapNotice,
        sessionBootstrapScript: remoteBootstrapScript,
        agentPermissionMode: opts.agentPermissionMode,
        agentArgs: opts.agentArgs,
        agentSessionId: opts.agentSessionId,
      });
      await this.sendInput(backendSessionId, `${bootstrapCommand}\r`);
      this.rememberInspect(backendSessionId, { backendSessionId, status: 'active' });
    }

    await this.ensureWrapper(backendSessionId);

    const now = this.now();
    return {
      id: this.idGenerator(),
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'ssh',
      backendSessionId,
      attachCommand: buildTmuxAttachCommand(backendSessionId),
      status: 'active',
      cwd,
      branch: opts.branch,
      lastHeartbeat: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Side-effecting on purpose, matching TmuxBackend (which re-tags panes here):
   * this is the only hook the daemon calls before handing an attach command to
   * the TUI, so it is where a wrapper lost to a network blip gets rebuilt.
   */
  async attachMetadata(backendSessionId: string): Promise<AttachMetadata> {
    await this.ensureWrapper(backendSessionId);
    return { command: buildTmuxAttachCommand(backendSessionId) };
  }

  /**
   * Throw away the local wrapper so the next attach builds a fresh one.
   *
   * {@link ensureWrapper} treats *any* tagged pane as a living wrapper, which it
   * has to: the layout engine moves the real one out of its `ab_` session, and a
   * second wrapper would put two SSH clients on one remote session and make tmux
   * shrink it to the smaller client. The price is that a pane whose attach loop
   * has since died keeps its tag and blocks revival forever — the pane is still
   * there, just sitting at a dead shell.
   *
   * An explicit reconnect is the one moment that ambiguity resolves: the user is
   * telling us the current plumbing is not working. Only local state is touched,
   * so the remote session and its agent are untouched.
   */
  async resetAttachment(backendSessionId: string): Promise<void> {
    this.inspectCache.delete(backendSessionId);

    for (const paneId of await this.findLocalTaggedPanes(backendSessionId)) {
      try {
        await this.localRunner(buildTmuxKillPaneArgs(paneId));
      } catch {
        // Pane may already be gone; the rebuild does not depend on it.
      }
    }

    try {
      await this.localRunner(buildTmuxKillSessionArgs(backendSessionId));
    } catch {
      // No wrapper session to remove, which is the state we are aiming for.
    }
  }

  async sendInput(backendSessionId: string, data: string): Promise<void> {
    for (const invocation of buildTmuxSendInputCommands(backendSessionId, data)) {
      await this.remoteRunner(invocation.args);
    }
  }

  async resize(_backendSessionId: string, _cols: number, _rows: number): Promise<void> {
    // The visible size is owned by the tmux client inside the wrapper pane.
  }

  /**
   * The remote session is authoritative — the local wrapper is never consulted.
   *
   * Liveness and pane info are read in a single tmux invocation: tmux stops a
   * chained sequence at the first failing command, so a missing session exits
   * non-zero without a second round trip.
   *
   * Throws {@link TransportUnreachableError} when the host cannot be reached.
   * Returning null there would tell SessionManager the session died and make it
   * destroy and recreate a remote session that is still running the agent.
   */
  async inspect(backendSessionId: string): Promise<BackendSessionInfo | null> {
    const cached = this.inspectCache.get(backendSessionId);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    let info: BackendSessionInfo | null = null;
    try {
      const result = await this.remoteRunner(
        chainTmuxArgs(
          buildTmuxHasSessionArgs(backendSessionId),
          buildTmuxListPanesArgs(TMUX_PANE_PROCESS_FORMAT, backendSessionId)
        )
      );
      info = {
        backendSessionId,
        status: 'active',
        ...parseTmuxPaneProcess(result.stdout),
      };
    } catch (error) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      info = null;
    }

    this.rememberInspect(backendSessionId, info);
    return info;
  }

  private rememberInspect(backendSessionId: string, value: BackendSessionInfo | null): void {
    this.inspectCache.set(backendSessionId, {
      value,
      expiresAt: this.now() + INSPECT_CACHE_MS,
    });
  }

  async terminate(backendSessionId: string): Promise<void> {
    this.inspectCache.delete(backendSessionId);

    // Each side is isolated so a failure on one cannot strand the other.
    const taggedPanes = await this.findLocalTaggedPanes(backendSessionId);
    try {
      await this.localRunner(buildTmuxKillSessionArgs(backendSessionId));
    } catch {
      // Wrapper may already be gone, or its pane moved into the board layout.
    }

    for (const taggedPane of taggedPanes) {
      try {
        await this.localRunner(buildTmuxKillPaneArgs(taggedPane));
      } catch {
        // Pane may already be gone.
      }
    }

    try {
      await this.remoteRunner(buildTmuxKillSessionArgs(backendSessionId));
    } catch (error) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      // Remote session may already be gone.
    }
  }

  /** Throws {@link TransportUnreachableError} rather than reporting no sessions. */
  async list(): Promise<BackendSessionInfo[]> {
    try {
      const result = await this.remoteRunner(buildTmuxListSessionsArgs());
      return parseAgentboardSessionNames(result.stdout).map((backendSessionId) => ({
        backendSessionId,
        status: 'active' as const,
      }));
    } catch (error) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      // No tmux server running remotely means no sessions.
      return [];
    }
  }

  async healthCheck(): Promise<BackendHealth> {
    const reachability = await this.transport.reachability();
    if (reachability !== 'ok') {
      return { available: false, error: `Cannot reach remote host ${this.host}` };
    }

    try {
      const result = await this.remoteRunner(['-V']);
      return { available: true, version: result.stdout.trim() || undefined };
    } catch (error) {
      return { available: false, error: errorMessage(error) };
    }
  }
}
