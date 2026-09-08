import { createRequire } from 'module';
import type {
  SessionBackend,
  SessionRecord,
  CreateSessionOpts,
  AttachMetadata,
  BackendSessionInfo,
  BackendHealth,
  SessionSlot,
} from '../../types/index.js';
import { generateId } from '../../db/index.js';
import { buildNewSessionBootstrapCommand } from '../session-bootstrap.js';
import { writeLocalBrief, writeLocalResumeNotice } from '../session-brief.js';
import { buildBackendSessionName } from '../session-name.js';

const require = createRequire(import.meta.url);

// CJS interop for node-pty
let nodePty: typeof import('node-pty') | null = null;
let nodePtyError: string | null = null;
try {
  nodePty = require('node-pty') as typeof import('node-pty');
} catch (err) {
  nodePtyError = err instanceof Error ? err.message : String(err);
}

type IPty = import('node-pty').IPty;

export class PtyBackend implements SessionBackend {
  private ptys = new Map<string, IPty>();

  constructor(private onData?: (taskId: string, slot: SessionSlot, data: string) => void) {}

  async healthCheck(): Promise<BackendHealth> {
    if (nodePty !== null) {
      return { available: true };
    }
    return { available: false, error: nodePtyError ?? 'node-pty failed to load' };
  }

  async create(opts: CreateSessionOpts): Promise<SessionRecord> {
    if (!nodePty) {
      throw new Error(`node-pty not available: ${nodePtyError}`);
    }

    const shell = process.env.SHELL ?? '/bin/sh';
    const cwd = opts.cwd ?? opts.repoPath;

    const backendSessionId = buildBackendSessionName(opts.taskTitle, opts.taskId, opts.slot);

    const pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd,
      env: process.env as Record<string, string>,
    });

    pty.onData((data) => {
      this.onData?.(opts.taskId, opts.slot, data);
    });

    pty.onExit(() => {
      this.ptys.delete(backendSessionId);
    });

    // Bootstrap on master, pull, then switch to the task branch.
    const checkoutCmd = `${buildNewSessionBootstrapCommand({
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
      initialPromptFile: opts.initialPrompt
        ? writeLocalBrief(opts.taskId, opts.slot, opts.initialPrompt)
        : undefined,
      resumeNoticeFile: opts.resumeNotice
        ? writeLocalResumeNotice(opts.taskId, opts.slot, opts.resumeNotice)
        : undefined,
    })}\n`;

    // No headless seeding any more. It existed only because a pty had no way
    // to hand its agent an opening brief — this backend cannot paste into its
    // own pty — so the brief was replayed into a `claude --print` run first,
    // purely so session-bootstrap.sh's resume-check would find a transcript.
    // That was expensive and unsupervised: `--print` runs with tool access, so
    // the seed did not merely receive the mission, it executed it (~4 minutes
    // of real tool calls, observed) before the interactive pane ever opened.
    //
    // session-bootstrap.sh now hands the brief to the CLI as argv, exactly as
    // it does for tmux and ssh, so a pty session gets its brief from the same
    // one mechanism as every other backend and nothing runs ahead of it.
    pty.write(checkoutCmd);

    this.ptys.set(backendSessionId, pty);

    const now = Date.now();
    const session: SessionRecord = {
      id: generateId(),
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'pty',
      backendSessionId,
      attachCommand: undefined,
      status: 'active',
      cwd,
      branch: opts.branch,
      lastHeartbeat: now,
      createdAt: now,
      updatedAt: now,
    };

    return session;
  }

  async attachMetadata(_backendSessionId: string): Promise<AttachMetadata> {
    return { command: '(embedded PTY — attach not supported)' };
  }

  async sendInput(backendSessionId: string, data: string): Promise<void> {
    const pty = this.ptys.get(backendSessionId);
    if (!pty) throw new Error(`No active PTY for session: ${backendSessionId}`);
    pty.write(data);
  }

  async resize(backendSessionId: string, cols: number, rows: number): Promise<void> {
    const pty = this.ptys.get(backendSessionId);
    if (!pty) return;
    pty.resize(cols, rows);
  }

  async terminate(backendSessionId: string): Promise<void> {
    const pty = this.ptys.get(backendSessionId);
    if (!pty) return;
    try {
      pty.kill();
    } catch {
      // Process may already be dead
    }
    this.ptys.delete(backendSessionId);
  }

  async list(): Promise<BackendSessionInfo[]> {
    return Array.from(this.ptys.entries()).map(([backendSessionId, pty]) => ({
      backendSessionId,
      status: 'active' as const,
      shellPid: pty.pid,
    }));
  }

  async inspect(backendSessionId: string): Promise<BackendSessionInfo | null> {
    const pty = this.ptys.get(backendSessionId);
    if (!pty) return null;
    return {
      backendSessionId,
      status: 'active',
      shellPid: pty.pid,
    };
  }
}
