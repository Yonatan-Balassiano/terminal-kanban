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
import { generateId } from '../../db/index.js';
import { buildNewSessionBootstrapCommand } from '../session-bootstrap.js';
import { buildBackendSessionName } from '../session-name.js';

const execFileAsync = promisify(execFile);
const agentboardPaneSessionOption = '@agentboard_backend_session_id';

export interface TmuxCommandResult {
  stdout: string;
  stderr: string;
}

export type TmuxCommandRunner = (args: string[]) => Promise<TmuxCommandResult>;

export interface TmuxBackendOptions {
  runner?: TmuxCommandRunner;
  idGenerator?: () => string;
  now?: () => number;
}

export interface TmuxInvocation {
  args: string[];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execFileRunner(args: string[]): Promise<TmuxCommandResult> {
  return execFileAsync('tmux', args, { encoding: 'utf8' }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

export function buildTmuxAttachCommand(backendSessionId: string): string {
  return `env -u TMUX tmux attach-session -t ${shellQuote(backendSessionId)}`;
}

export function buildTmuxSendInputCommands(
  backendSessionId: string,
  data: string
): TmuxInvocation[] {
  const invocations: TmuxInvocation[] = [];
  let literal = '';

  const flushLiteral = () => {
    if (literal.length === 0) {
      return;
    }
    invocations.push({ args: ['send-keys', '-t', backendSessionId, '-l', literal] });
    literal = '';
  };

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === '\r' || char === '\n') {
      flushLiteral();
      invocations.push({ args: ['send-keys', '-t', backendSessionId, 'Enter'] });
      if (char === '\r' && data[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }
    literal += char;
  }

  flushLiteral();
  return invocations;
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

  constructor(options: TmuxBackendOptions = {}) {
    this.runner = options.runner ?? execFileRunner;
    this.idGenerator = options.idGenerator ?? generateId;
    this.now = options.now ?? Date.now;
  }

  private async ensureSessionSurvivesDetach(backendSessionId: string): Promise<void> {
    try {
      await this.runner(['set-option', '-q', '-t', backendSessionId, 'destroy-unattached', 'off']);
    } catch {
      // Best effort: older/missing sessions should not make attach/inspect fail.
    }
  }

  private async tagSessionPane(backendSessionId: string): Promise<void> {
    try {
      await this.runner([
        'set-option',
        '-p',
        '-q',
        '-t',
        backendSessionId,
        agentboardPaneSessionOption,
        backendSessionId,
      ]);
    } catch {
      // Best effort: pane tags are only needed after the pane is moved into the board layout.
    }
  }

  private async findTaggedPanes(backendSessionId: string): Promise<string[]> {
    try {
      const result = await this.runner([
        'list-panes',
        '-a',
        '-F',
        `#{pane_id}\t#{${agentboardPaneSessionOption}}`,
      ]);
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
      await this.runner([
        'new-session',
        '-d',
        '-s',
        backendSessionId,
        '-c',
        cwd,
        ';',
        'set-option',
        '-q',
        '-t',
        backendSessionId,
        'destroy-unattached',
        'off',
      ]);
      await this.tagSessionPane(backendSessionId);
      const bootstrapCommand = buildNewSessionBootstrapCommand({
        repoPath: opts.repoPath,
        branch: opts.branch,
        baseBranch: opts.baseBranch,
        agentCli: opts.agentCli,
        usesWorktree: opts.usesWorktree,
        cwd: opts.cwd,
        bootstrapNotice: opts.bootstrapNotice,
        sessionBootstrapScript: opts.sessionBootstrapScript,
      });
      await this.sendInput(backendSessionId, `${bootstrapCommand}\r`);
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

  async resize(_backendSessionId: string, _cols: number, _rows: number): Promise<void> {
    // The visible size is owned by the tmux client pane, not AgentBoard.
  }

  async terminate(backendSessionId: string): Promise<void> {
    const taggedPanes = await this.findTaggedPanes(backendSessionId);
    try {
      await this.runner(['kill-session', '-t', backendSessionId]);
    } catch {
      // Session may already be gone because its pane was moved into the board layout.
    }

    for (const taggedPane of taggedPanes) {
      try {
        await this.runner(['kill-pane', '-t', taggedPane]);
      } catch {
        // Pane may already be gone.
      }
    }
  }

  async list(): Promise<BackendSessionInfo[]> {
    const sessions = new Set<string>();
    try {
      const result = await this.runner(['list-sessions', '-F', '#S']);
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((backendSessionId) => backendSessionId.startsWith('ab_'))
        .forEach((backendSessionId) => sessions.add(backendSessionId));
    } catch {
      // The tagged-pane scan below can still find panes moved into the board layout.
    }

    try {
      const result = await this.runner([
        'list-panes',
        '-a',
        '-F',
        `#{${agentboardPaneSessionOption}}`,
      ]);
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((backendSessionId) => backendSessionId.startsWith('ab_'))
        .forEach((backendSessionId) => sessions.add(backendSessionId));
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
      await this.runner(['has-session', '-t', backendSessionId]);
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
