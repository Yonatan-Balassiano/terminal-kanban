import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  AttachMetadata,
  BackendHealth,
  BackendSessionInfo,
  CreateSessionOpts,
  RedeliverPromptOptions,
  SessionBackend,
  SessionRecord,
  SessionSlot,
} from '../../types/index.js';
import { existsSync } from 'fs';
import { generateId } from '../../db/index.js';
import { buildNewSessionBootstrapCommand } from '../session-bootstrap.js';
import { writeLocalBrief, writeLocalResumeNotice } from '../session-brief.js';
import { buildBackendSessionName } from '../session-name.js';
import { DeliveryGuard } from './delivery-guard.js';
import {
  autoTrustIfPrompted,
  DEFAULT_POST_PASTE_DELAY_MS,
  pasteAndVerify,
  pasteMarker,
  sleep,
  submitAndVerify,
  waitForStablePane,
  waitForTrustPromptAndDismiss,
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
  parseTmuxPaneProcess,
  TMUX_PANE_PROCESS_FORMAT,
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
  /** One brief delivery per pane at a time — see {@link DeliveryGuard}. */
  private readonly deliveries = new DeliveryGuard();

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
      const resumeNoticeFile = opts.resumeNotice
        ? writeLocalResumeNotice(opts.taskId, opts.slot, opts.resumeNotice)
        : undefined;
      const bootstrapCommand = buildNewSessionBootstrapCommand({
        taskId: opts.taskId,
        sessionName: opts.sessionName,
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
        resumeNoticeFile,
      });
      await this.sendInput(backendSessionId, `${bootstrapCommand}\r`);
      // The brief rides the bootstrap command's own argv from here — see
      // session-bootstrap.sh. Nothing is pasted into this pane, so there is no
      // delivery to wait for, retry, or verify.
      //
      // The trust dialog still has to be answered, though, and it is the one
      // thing that can stall an unattended session before the CLI ever reads
      // its argv: on a worktree Claude Code has not seen before it opens with
      // "do you trust this folder", default-highlighted on "No, exit". Left
      // alone, a --start'ed card sits there forever. Not awaited, for the same
      // reason delivery never was — the caller is a synchronous RPC round trip
      // an agent's Bash call is blocked on, and `createTask` is not idempotent,
      // so a client timeout that retries would mint a second card.
      void this.dismissTrustPromptInBackground(backendSessionId);
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
   * Answers Claude Code's first-run trust dialog on a freshly spawned pane.
   *
   * Split out of brief delivery, which no longer touches the pane at all. This
   * is now the only thing the daemon types into a starting session, and it
   * exists because the dialog blocks the CLI before it reads its own argv:
   * AgentBoard created this worktree itself, under a repo the user registered,
   * so the trust is implicit, but nobody is watching an unattended card to
   * answer it.
   *
   * Deliberately never a bare Enter — the default-highlighted option is
   * "No, exit", so an Enter alone quits the CLI.
   *
   * Fully best-effort: a pane with no dialog settles and this returns having
   * sent nothing.
   */
  private async dismissTrustPromptInBackground(backendSessionId: string): Promise<void> {
    try {
      const target = await this.resolveInputTarget(backendSessionId);
      const capture = async () => (await this.runner(buildTmuxCapturePaneArgs(target))).stdout;
      await waitForTrustPromptAndDismiss(
        capture,
        async () => {
          await this.runner(['send-keys', '-t', target, 'Down']);
        },
        async () => {
          await this.runner(['send-keys', '-t', target, 'Enter']);
        },
        this.paneIdleOptions,
      );
    } catch {
      // A pane that went away, or a tmux that refused — neither is worth
      // failing a session over.
    }
  }

  /**
   * Delivers text into an already-running session's pane.
   *
   * Only reached by `redeliverPrompt` now — `notifyTaskSession` and the manual
   * `redeliver-prompt` escape hatch. A card's *opening* brief no longer comes
   * through here at all: it rides the agent CLI's own argv at launch (see
   * session-bootstrap.sh), which removed every startup race this path used to
   * have to guess its way around.
   *
   * What remains is the genuinely terminal-bound case — typing into a CLI that
   * is already up — where there is no channel other than the pane, so the
   * paste still has to be verified on screen before its Enter is trusted.
   *
   * Resolves `true` once the paste has been verified and Enter sent to
   * submit it, `false` when the paste never verified (nothing was
   * submitted) or the brief file was gone.
   */
  private deliverInitialPrompt(
    backendSessionId: string,
    briefFile: string,
    promptText?: string,
    skipIfAlreadyOnPane = false,
  ): Promise<boolean> {
    // Never two at once into the same pane — see {@link DeliveryGuard}.
    return this.deliveries.run(backendSessionId, promptText ?? '', () =>
      this.deliverToPane(backendSessionId, briefFile, promptText, skipIfAlreadyOnPane),
    );
  }

  /** {@link deliverInitialPrompt}'s body, minus the one-at-a-time guard. */
  private async deliverToPane(
    backendSessionId: string,
    briefFile: string,
    promptText?: string,
    skipIfAlreadyOnPane = false,
  ): Promise<boolean> {
    const target = await this.resolveInputTarget(backendSessionId);
    const capture = async () => (await this.runner(buildTmuxCapturePaneArgs(target))).stdout;
    await waitForStablePane(capture, this.paneIdleOptions);

    const sendTrustDown = async () => {
      await this.runner(['send-keys', '-t', target, 'Down']);
    };
    const sendTrustEnter = async () => {
      await this.runner(['send-keys', '-t', target, 'Enter']);
    };

    // Still worth a check, cheaply: this path also runs against a session that
    // was only just created, whose dialog the background dismissal may not have
    // reached yet. A bare Enter on that dialog selects "No, exit".
    const trusted = await autoTrustIfPrompted(capture, sendTrustDown, sendTrustEnter);
    if (trusted) {
      // The prompt just gave way to the CLI's own startup, hooks included —
      // wait for that to settle too before treating the pane as ready.
      await waitForStablePane(capture, this.paneIdleOptions);
    }

    if (!existsSync(briefFile)) {
      return false;
    }

    const bufferName = `agentboard_brief_${backendSessionId}`;
    const outcome = await pasteAndVerify(
      async () => {
        await this.runner(buildTmuxLoadBufferArgs(bufferName, briefFile));
        await this.runner(buildTmuxPasteBufferArgs(bufferName, target));
        // An Enter sent right after the paste lands before the CLI has
        // finished processing it and is silently dropped — see
        // PaneIdleWaitOptions.
        await sleep(this.paneIdleOptions?.postPasteDelayMs ?? DEFAULT_POST_PASTE_DELAY_MS);
      },
      capture,
      pasteMarker(promptText ?? ''),
      { ...this.paneIdleOptions, skipIfAlreadyOnPane },
    );
    // 'already-present' pasted nothing on purpose — this brief is still
    // sitting on the pane from an earlier run — but the text is there, so it
    // still wants the Enter the earlier run never got to send. Only a
    // redelivery ever reaches it; a notify always pastes.
    if (outcome === 'unverified') {
      // Whatever is on screen is unverified — do not submit it. Leaving it
      // sitting there is a state `redeliverInitialPrompt` already knows how
      // to fix; submitting a mangled fragment is not.
      return false;
    }
    await submitAndVerify(
      async () => (await this.runner(buildTmuxCapturePaneArgs(target))).stdout,
      async () => {
        await this.runner(['send-keys', '-t', target, 'Enter']);
      },
      this.paneIdleOptions,
    );
    return true;
  }

  /**
   * The manual escape hatch for a session whose automatic delivery (in
   * `create()`) gave up before the pane became responsive — see
   * `SessionBackend.redeliverPrompt`. Writes a fresh brief file since the
   * original (if any) was already deleted by session-bootstrap.sh or consumed
   * by the first attempt.
   */
  async redeliverPrompt(
    taskId: string,
    slot: SessionSlot,
    backendSessionId: string,
    prompt: string,
    agentCli?: string,
    options: RedeliverPromptOptions = {},
  ): Promise<boolean> {
    const briefFile = writeLocalBrief(taskId, slot, prompt);
    return this.deliverInitialPrompt(
      backendSessionId,
      briefFile,
      prompt,
      options.skipIfAlreadyOnPane ?? false,
    );
  }

  /**
   * The pane id this session is running in — stable for the pane's whole life,
   * unlike a window index, which tmux renumbers as windows come and go.
   */
  async resolvePaneId(backendSessionId: string): Promise<string | null> {
    const tagged = await this.findTaggedPane(backendSessionId);
    return tagged ?? (await this.resolveSessionPaneId(backendSessionId));
  }

  async peekPane(backendSessionId: string): Promise<string> {
    const target = await this.resolveInputTarget(backendSessionId);
    return (await this.runner(buildTmuxCapturePaneArgs(target))).stdout;
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

  /**
   * Reads the pane's own process info, the way `SshTmuxBackend.inspect` always
   * has.
   *
   * Its absence here was not cosmetic: `inspectSessionState` routes on
   * `info.shellPid`, so a local tmux session with no pid never reached
   * `deriveSessionActivity` at all — it fell through to
   * `deriveFallbackSessionActivity` with no command, which reports
   * `isBusy: false` unconditionally. Every local tmux session therefore read as
   * idle no matter what it was doing, which is what `agentboard fleet`'s BUSY
   * column was reporting.
   *
   * Best-effort: a pane that has gone away between `has-session` and this call
   * still counts as active, just without process detail.
   */
  private async readPaneProcess(
    target: string,
  ): Promise<{ shellPid?: number; currentCommand?: string }> {
    try {
      const result = await this.runner(buildTmuxListPanesArgs(TMUX_PANE_PROCESS_FORMAT, target));
      return parseTmuxPaneProcess(result.stdout);
    } catch {
      return {};
    }
  }

  async inspect(backendSessionId: string): Promise<BackendSessionInfo | null> {
    try {
      await this.runner(buildTmuxHasSessionArgs(backendSessionId));
      await this.ensureSessionSurvivesDetach(backendSessionId);
      await this.tagSessionPane(backendSessionId);
      return {
        backendSessionId,
        status: 'active',
        // Targeted by session name, which `has-session` just proved resolves —
        // no need to re-scan every pane on the server for the tag.
        ...(await this.readPaneProcess(backendSessionId)),
      };
    } catch {
      const taggedPane = await this.findTaggedPane(backendSessionId);
      if (!taggedPane) {
        return null;
      }
      // The busier of the two branches, not the rarer one: once the Go layout
      // engine joins a pane into the board session, its original session name
      // is gone and `has-session` above always fails, so every attached card
      // is inspected through here. It needs the pane's process info just as
      // much as the branch above.
      return {
        backendSessionId,
        status: 'active',
        ...(await this.readPaneProcess(taggedPane)),
      };
    }
  }
}
