import { createRequire } from 'module';
import { spawn } from 'child_process';
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
import { writeLocalBrief } from '../session-brief.js';
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

export interface PtySeedOptions {
  /** The exact id the interactive bootstrap script will independently resolve to. */
  agentSessionId: string;
  cwd: string;
  prompt: string;
}

/**
 * Seeds a fresh `claude` conversation headlessly, so the interactive pty's own
 * resume-detection (session-bootstrap.sh's `compgen -G ... .jsonl`) finds a
 * transcript already sitting under that session id and resumes it instead of
 * starting blank.
 *
 * Spawned directly rather than through node-pty: this is a one-shot batch call
 * with piped stdin, not an interactive terminal. Only `claude` is wired up —
 * see resolveAgentArgs's own claude-only carve-outs in session-bootstrap.ts.
 */
export type PtySeedRunner = (opts: PtySeedOptions) => Promise<void>;

function defaultPtySeedRunner({ agentSessionId, cwd, prompt }: PtySeedOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--session-id', agentSessionId, '--print'], {
      cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude --print seed exited with code ${String(code)}`));
      }
    });
    // Avoid an unhandled EPIPE if claude exits before consuming all of stdin.
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export class PtyBackend implements SessionBackend {
  private ptys = new Map<string, IPty>();

  constructor(
    private onData?: (taskId: string, slot: SessionSlot, data: string) => void,
    private seedRunner: PtySeedRunner = defaultPtySeedRunner,
  ) {}

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
    })}\n`;

    // Headless-seed a transcript before the interactive pty ever starts, so
    // session-bootstrap.sh's own resume-check (unmodified) picks `--resume`
    // on its own — see PtySeedRunner above. Claude-only: opts.agentCli may be
    // 'codex', whose resume flags aren't wired up (session-bootstrap.ts), and
    // this seed call is specifically `claude --session-id ... --print`.
    if (opts.initialPrompt && opts.agentSessionId && opts.agentCli === 'claude') {
      try {
        await this.seedRunner({
          agentSessionId: opts.agentSessionId,
          cwd,
          prompt: opts.initialPrompt,
        });
      } catch {
        // Best-effort: session-bootstrap.sh's own resume-check simply won't
        // match (no transcript was written), so it falls back to
        // `--session-id` fresh, same as if this seeding never existed. Never
        // let a failed seed block the interactive pty from opening.
      }
    }

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
