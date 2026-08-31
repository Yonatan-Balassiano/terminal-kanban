import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  AttachMetadata,
  BackendHealth,
  BackendSessionInfo,
  CreateSessionOpts,
  SessionBackend,
  SessionRecord,
} from '../../types/index.js';
import { existsSync } from 'fs';
import { generateId } from '../../db/index.js';
import { buildNewSessionBootstrapCommand } from '../session-bootstrap.js';
import { writeLocalBrief } from '../session-brief.js';
import { buildBackendSessionName } from '../session-name.js';
import {
  DEFAULT_POST_PASTE_DELAY_MS,
  sleep,
  waitForStablePane,
  type PaneIdleWaitOptions,
} from './pane-idle.js';
import {
  buildTmuxAttachCommand,
  buildTmuxCapturePaneArgs,
  buildTmuxHasSessionArgs,
  buildTmuxKillPaneArgs,
  buildTmuxKillSessionArgs,
  buildTmuxListPanesArgs,
  buildTmuxListSessionsArgs,
  buildTmuxLoadBufferArgs,
  buildTmuxNewSessionArgs,
  buildTmuxPasteBufferArgs,
  buildTmuxSendInputCommands,
  buildTmuxSurviveDetachArgs,
  buildTmuxTagPaneArgs,
  buildTmuxUntagPaneArgs,
  buildTmuxPaneIdArgs,
  chainTmuxArgs,
  parseAgentboardSessionNames,
  TMUX_PANE_TAG_FORMAT,
  TMUX_TAGGED_PANE_FORMAT,
} from './tmux-commands.js';

export {
  buildTmuxAttachCommand,
  buildTmuxSendInputCommands,
  AGENTBOARD_PANE_SESSION_OPTION,
} from './tmux-commands.js';
export type { TmuxInvocation } from './tmux-commands.js';

const execFileAsync = promisify(execFile);

export interface TmuxCommandResult {
  stdout: string;
  stderr: string;
}

export type TmuxCommandRunner = (args: string[]) => Promise<TmuxCommandResult>;

export interface TmuxBackendOptions {
  runner?: TmuxCommandRunner;
  idGenerator?: () => string;
  now?: () => number;
  /** Overridable so tests don't sit through real polling intervals. */
  paneIdleOptions?: PaneIdleWaitOptions;
}

/** Runs `tmux` on the machine the daemon is running on. */
export function localTmuxRunner(args: string[]): Promise<TmuxCommandResult> {
  return execFileAsync('tmux', args, { encoding: 'utf8' }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class TmuxBackend implements SessionBackend {
  private runner: TmuxCommandRunner;
  private idGenerator: () => string;
  private now: () => number;
  private paneIdleOptions?: PaneIdleWaitOptions;

  constructor(options: TmuxBackendOptions = {}) {
    this.runner = options.runner ?? localTmuxRunner;
    this.idGenerator = options.idGenerator ?? generateId;
    this.now = options.now ?? Date.now;
    this.paneIdleOptions = options.paneIdleOptions;
  }

  private async ensureSessionSurvivesDetach(backendSessionId: string): Promise<void> {
    try {
      await this.runner(buildTmuxSurviveDetachArgs(backendSessionId));
    } catch {
      // Best effort: older/missing sessions should not make attach/inspect fail.
    }
  }

  private async tagSessionPane(backendSessionId: string): Promise<void> {
    try {
      await this.runner(buildTmuxTagPaneArgs(backendSessionId, backendSessionId));
    } catch {
      // Best effort: pane tags are only needed after the pane is moved into the
      // board layout. Bail out without touching existing tags — the session may
      // be gone precisely because its pane is already parked and still tagged.
      return;
    }
    await this.dropDuplicateTags(backendSessionId);
  }

  /**
   * Keep exactly one pane carrying a given tag.
   *
   * Recreating a session while its previous pane is still parked in the holding
   * session leaves two panes with the same tag, and the layout engine joins
   * every pane it finds — dragging a dead shell in beside the live one. Only
   * runs after a successful tag, so the freshly tagged pane is the one kept.
   */
  private async dropDuplicateTags(backendSessionId: string): Promise<void> {
    const taggedPane = await this.resolveSessionPaneId(backendSessionId);
    if (!taggedPane) {
      return;
    }

    for (const paneId of await this.findTaggedPanes(backendSessionId)) {
      if (paneId === taggedPane) {
        continue;
      }
      try {
        await this.runner(buildTmuxUntagPaneArgs(paneId));
      } catch {
        // Pane may have gone away; the next tag pass will retry.
      }
    }
  }

  private async resolveSessionPaneId(backendSessionId: string): Promise<string | null> {
    try {
      const result = await this.runner(buildTmuxPaneIdArgs(backendSessionId));
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async findTaggedPanes(backendSessionId: string): Promise<string[]> {
    try {
      const result = await this.runner(buildTmuxListPanesArgs(TMUX_TAGGED_PANE_FORMAT));
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

  private async findTaggedPane(backendSessionId: string): Promise<string | null> {
    const paneIds = await this.findTaggedPanes(backendSessionId);
    return paneIds[0] ?? null;
  }

  private async resolveInputTarget(backendSessionId: string): Promise<string> {
    const taggedPane = await this.findTaggedPane(backendSessionId);
    return taggedPane ?? backendSessionId;
  }

  async healthCheck(): Promise<BackendHealth> {
    try {
      const result = await this.runner(['-V']);
      return { available: true, version: result.stdout.trim() || undefined };
    } catch (error) {
      return { available: false, error: errorMessage(error) };
    }
  }

  async create(opts: CreateSessionOpts): Promise<SessionRecord> {
    const cwd = opts.cwd ?? opts.repoPath;
    const backendSessionId = buildBackendSessionName(opts.taskTitle, opts.taskId, opts.slot);
    const existing = await this.inspect(backendSessionId);

    if (!existing) {
      await this.runner(
        chainTmuxArgs(
          buildTmuxNewSessionArgs({ backendSessionId, cwd }),
          buildTmuxSurviveDetachArgs(backendSessionId)
        )
      );
      await this.tagSessionPane(backendSessionId);
      const initialPromptFile = opts.initialPrompt
        ? writeLocalBrief(opts.taskId, opts.slot, opts.initialPrompt)
        : undefined;
      const bootstrapCommand = buildNewSessionBootstrapCommand({
        taskId: opts.taskId,
        taskKind: opts.taskKind,
        repoPath: opts.repoPath,
        branch: opts.branch,
        baseBranch: opts.baseBranch,
        agentCli: opts.agentCli,
        usesWorktree: opts.usesWorktree,
        cwd: opts.cwd,
        bootstrapNotice: opts.bootstrapNotice,
        sessionBootstrapScript: opts.sessionBootstrapScript,
        agentPermissionMode: opts.agentPermissionMode,
        agentArgs: opts.agentArgs,
        agentSessionId: opts.agentSessionId,
        // Only the file's path travels through the pane's argv; the script
        // deletes it itself when this turns out to be a resume (see
        // session-bootstrap.sh). The daemon, not argv, delivers the contents.
        initialPromptFile,
      });
      await this.sendInput(backendSessionId, `${bootstrapCommand}\r`);
      if (initialPromptFile) {
        await this.deliverInitialPrompt(backendSessionId, initialPromptFile);
      }
    }

    const now = this.now();
    return {
      id: this.idGenerator(),
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'tmux',
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

  async attachMetadata(backendSessionId: string): Promise<AttachMetadata> {
    await this.ensureSessionSurvivesDetach(backendSessionId);
    await this.tagSessionPane(backendSessionId);
    return { command: buildTmuxAttachCommand(backendSessionId) };
  }

  async sendInput(backendSessionId: string, data: string): Promise<void> {
    const target = await this.resolveInputTarget(backendSessionId);
    for (const invocation of buildTmuxSendInputCommands(target, data)) {
      await this.runner(invocation.args);
    }
  }

  /**
   * Delivers the card's brief once the pane looks ready for it, instead of
   * trusting the agent CLI to have picked it up from argv on its own.
   *
   * Skipped when `briefFile` is gone: `session-bootstrap.sh` deletes it itself
   * when the pane turned out to be resuming an existing conversation, which is
   * the one signal both sides need to agree the brief should not be replayed.
   */
  private async deliverInitialPrompt(backendSessionId: string, briefFile: string): Promise<void> {
    const target = await this.resolveInputTarget(backendSessionId);
    await waitForStablePane(async () => {
      const result = await this.runner(buildTmuxCapturePaneArgs(target));
      return result.stdout;
    }, this.paneIdleOptions);

    if (!existsSync(briefFile)) {
      return;
    }

    const bufferName = `agentboard_brief_${backendSessionId}`;
    await this.runner(buildTmuxLoadBufferArgs(bufferName, briefFile));
    await this.runner(buildTmuxPasteBufferArgs(bufferName, target));
    // An Enter sent right after the paste lands before the CLI has finished
    // processing it and is silently dropped — see PaneIdleWaitOptions.
    await sleep(this.paneIdleOptions?.postPasteDelayMs ?? DEFAULT_POST_PASTE_DELAY_MS);
    await this.runner(['send-keys', '-t', target, 'Enter']);
  }

  async resize(_backendSessionId: string, _cols: number, _rows: number): Promise<void> {
    // The visible size is owned by the tmux client pane, not AgentBoard.
  }

  async terminate(backendSessionId: string): Promise<void> {
    const taggedPanes = await this.findTaggedPanes(backendSessionId);
    try {
      await this.runner(buildTmuxKillSessionArgs(backendSessionId));
    } catch {
      // Session may already be gone because its pane was moved into the board layout.
    }

    for (const taggedPane of taggedPanes) {
      try {
        await this.runner(buildTmuxKillPaneArgs(taggedPane));
      } catch {
        // Pane may already be gone.
      }
    }
  }

  async list(): Promise<BackendSessionInfo[]> {
    const sessions = new Set<string>();
    try {
      const result = await this.runner(buildTmuxListSessionsArgs());
      parseAgentboardSessionNames(result.stdout).forEach((backendSessionId) =>
        sessions.add(backendSessionId)
      );
    } catch {
      // The tagged-pane scan below can still find panes moved into the board layout.
    }

    try {
      const result = await this.runner(buildTmuxListPanesArgs(TMUX_PANE_TAG_FORMAT));
      parseAgentboardSessionNames(result.stdout).forEach((backendSessionId) =>
        sessions.add(backendSessionId)
      );
    } catch {
      // Ignore pane scan failures.
    }

    return Array.from(sessions).map((backendSessionId) => ({
      backendSessionId,
      status: 'active' as const,
    }));
  }

  async inspect(backendSessionId: string): Promise<BackendSessionInfo | null> {
    try {
      await this.runner(buildTmuxHasSessionArgs(backendSessionId));
      await this.ensureSessionSurvivesDetach(backendSessionId);
      await this.tagSessionPane(backendSessionId);
      return {
        backendSessionId,
        status: 'active',
      };
    } catch {
      const taggedPane = await this.findTaggedPane(backendSessionId);
      if (!taggedPane) {
        return null;
      }
      return {
        backendSessionId,
        status: 'active',
      };
    }
  }
}
