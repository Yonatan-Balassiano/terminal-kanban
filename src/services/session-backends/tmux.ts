import { execFile, execFileSync, execSync } from 'child_process';
import { closeSync, openSync, readSync, statSync, unlinkSync, watch, writeFileSync } from 'fs';
import type { FSWatcher } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type {
  SessionBackend,
  SessionRecord,
  CreateSessionOpts,
  AttachMetadata,
  BackendSessionInfo,
  BackendHealth,
  SessionStatus,
  GetBufferResult,
} from '../../types/index.js';
import { generateId } from '../../db/index.js';
import { buildNewSessionBootstrapCommand } from '../session-bootstrap.js';
import { buildBackendSessionName } from '../session-name.js';
import { renderAnsiCapture } from '../terminal-render.js';

const TMUX_SCROLLBACK_LINES = 2000;
const execFileAsync = promisify(execFile);

export function tmuxKeyName(data: string): string | null {
  switch (data) {
    case '\x1b':
      return 'Escape';
    case '\r':
      return 'Enter';
    case '\t':
      return 'Tab';
    case '\x7f':
      return 'BSpace';
    case '\x1b[A':
      return 'Up';
    case '\x1b[B':
      return 'Down';
    case '\x1b[D':
      return 'Left';
    case '\x1b[C':
      return 'Right';
    case '\x03':
      return 'C-c';
    default:
      return null;
  }
}

export class TmuxBackend implements SessionBackend {
  private streamTaps = new Map<
    string,
    {
      taskId: string;
      filePath: string;
      offset: number;
      watcher: FSWatcher;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  constructor(private onOutput?: (taskId: string, data: string) => void) {}

  private streamFilePath(backendSessionId: string): string {
    return join(tmpdir(), `agentboard-${backendSessionId}.stream.log`);
  }

  private readAppendedOutput(backendSessionId: string): void {
    const tap = this.streamTaps.get(backendSessionId);
    if (!tap) {
      return;
    }

    let size = 0;
    try {
      size = statSync(tap.filePath).size;
    } catch {
      return;
    }

    if (size <= tap.offset) {
      tap.offset = size;
      return;
    }

    const fd = openSync(tap.filePath, 'r');
    try {
      const length = size - tap.offset;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, tap.offset);
      tap.offset = size;
      if (buffer.length > 0) {
        this.onOutput?.(tap.taskId, buffer.toString('utf8'));
      }
    } finally {
      closeSync(fd);
    }
  }

  private scheduleOutputNotification(backendSessionId: string): void {
    const tap = this.streamTaps.get(backendSessionId);
    if (!tap || tap.timer) {
      return;
    }

    tap.timer = setTimeout(() => {
      tap.timer = null;
      this.readAppendedOutput(backendSessionId);
    }, 10);
    tap.timer.unref?.();
  }

  ensureStreaming(taskId: string, backendSessionId: string): void {
    const existing = this.streamTaps.get(backendSessionId);
    if (existing) {
      existing.taskId = taskId;
      return;
    }

    const filePath = this.streamFilePath(backendSessionId);
    try {
      execFileSync('tmux', ['pipe-pane', '-t', backendSessionId], { stdio: 'ignore' });
    } catch {
      // Ignore pipe reset failures
    }
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore missing file
    }
    writeFileSync(filePath, '', 'utf8');

    const watcher = watch(filePath, () => {
      this.scheduleOutputNotification(backendSessionId);
    });

    this.streamTaps.set(backendSessionId, {
      taskId,
      filePath,
      offset: 0,
      watcher,
      timer: null,
    });

    execFileSync(
      'tmux',
      ['pipe-pane', '-O', '-t', backendSessionId, `cat >> ${JSON.stringify(filePath)}`],
      { stdio: 'ignore' },
    );
  }

  private cleanupStreaming(backendSessionId: string): void {
    const tap = this.streamTaps.get(backendSessionId);
    if (!tap) {
      return;
    }

    try {
      execFileSync('tmux', ['pipe-pane', '-t', backendSessionId], { stdio: 'ignore' });
    } catch {
      // Ignore pipe reset failures
    }

    try {
      tap.watcher.close();
    } catch {
      // Ignore watcher close failures
    }

    if (tap.timer) {
      clearTimeout(tap.timer);
    }

    try {
      unlinkSync(tap.filePath);
    } catch {
      // Ignore missing file
    }

    this.streamTaps.delete(backendSessionId);
  }

  async healthCheck(): Promise<BackendHealth> {
    try {
      const out = execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim();
      // e.g. "tmux 3.3a"
      const version = out.replace(/^tmux\s+/i, '');
      return { available: true, version };
    } catch (err) {
      return {
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async create(opts: CreateSessionOpts): Promise<SessionRecord> {
    const name = buildBackendSessionName(opts.taskTitle, opts.taskId);
    const cwd = opts.cwd ?? opts.repoPath;

    execSync(`tmux new-session -d -s ${JSON.stringify(name)} -c ${JSON.stringify(cwd)}`);

    const checkoutCmd = buildNewSessionBootstrapCommand({
      repoPath: opts.repoPath,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      agentCli: opts.agentCli,
      usesWorktree: opts.usesWorktree,
      cwd: opts.cwd,
      bootstrapNotice: opts.bootstrapNotice,
      sessionBootstrapScript: opts.sessionBootstrapScript,
    });

    execSync(
      `tmux send-keys -t ${JSON.stringify(name)} ${JSON.stringify(checkoutCmd)} Enter`,
    );
    this.ensureStreaming(opts.taskId, name);

    const now = Date.now();
    const session: SessionRecord = {
      id: generateId(),
      taskId: opts.taskId,
      backendType: 'tmux',
      backendSessionId: name,
      attachCommand: `tmux attach -t ${name}`,
      status: 'active',
      cwd,
      branch: opts.branch,
      lastHeartbeat: now,
      createdAt: now,
      updatedAt: now,
    };

    return session;
  }

  async attachMetadata(backendSessionId: string): Promise<AttachMetadata> {
    return { command: `tmux attach -t ${backendSessionId}` };
  }

  async sendInput(backendSessionId: string, data: string): Promise<void> {
    const key = tmuxKeyName(data);
    if (key) {
      execFileSync('tmux', ['send-keys', '-t', backendSessionId, key], {
        stdio: 'ignore',
      });
      return;
    }

    if (data.length === 0) {
      return;
    }

    execFileSync('tmux', ['send-keys', '-l', '-t', backendSessionId, '--', data], {
      stdio: 'ignore',
    });
  }

  async resize(backendSessionId: string, cols: number, rows: number): Promise<void> {
    try {
      execSync(
        `tmux resize-window -t ${JSON.stringify(backendSessionId)} -x ${cols} -y ${rows}`,
      );
    } catch {
      // Non-fatal — window may not exist
    }
  }

  async list(): Promise<BackendSessionInfo[]> {
    try {
      const out = execSync(
        `tmux list-sessions -F '#{session_name} #{session_activity}'`,
        { encoding: 'utf8' },
      ).trim();

      if (!out) return [];

      return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('ab_'))
        .map((line) => {
          const parts = line.split(' ');
          const sessionName = parts[0];
          const activitySec = parts[1] ? parseInt(parts[1], 10) : undefined;
          const info: BackendSessionInfo = {
            backendSessionId: sessionName,
            status: 'active' as SessionStatus,
            lastActivity: activitySec ? activitySec * 1000 : undefined,
          };
          return info;
        });
    } catch {
      return [];
    }
  }

  async inspect(backendSessionId: string): Promise<BackendSessionInfo | null> {
    try {
      const { stdout } = await execFileAsync(
        'tmux',
        [
          'display-message',
          '-p',
          '-t',
          backendSessionId,
          '#{pane_pid} #{pane_current_command}',
        ],
        { encoding: 'utf8' },
      );
      const metadata = String(stdout).trim();
      const [pidRaw, currentCommand] = metadata.split(/\s+/, 2);
      const shellPid = Number.parseInt(pidRaw ?? '', 10);
      return {
        backendSessionId,
        status: 'active',
        shellPid: Number.isFinite(shellPid) ? shellPid : undefined,
        currentCommand: currentCommand || undefined,
      };
    } catch {
      return null;
    }
  }

  async capture(backendSessionId: string): Promise<GetBufferResult> {
    const pane = execFileSync(
      'tmux',
      ['capture-pane', '-e', '-p', '-S', `-${TMUX_SCROLLBACK_LINES}`, '-t', backendSessionId],
      { encoding: 'utf8' },
    );
    const lines = pane.length === 0 ? [] : pane.replace(/\n$/, '').split('\n');

    const cursorMeta = execFileSync(
      'tmux',
      [
        'display-message',
        '-p',
        '-t',
        backendSessionId,
        '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/);

    const cursorX = Number.parseInt(cursorMeta[0] ?? '0', 10) || 0;
    const cursorYInPane = Number.parseInt(cursorMeta[1] ?? '0', 10) || 0;
    const paneWidth = Number.parseInt(cursorMeta[2] ?? '0', 10) || 220;
    const paneHeight = Number.parseInt(cursorMeta[3] ?? '0', 10) || 0;
    const cursorY = Math.max(0, lines.length - paneHeight + cursorYInPane);

    return renderAnsiCapture(
      pane,
      paneWidth,
      Math.max(paneHeight, 5),
      cursorX,
      cursorY,
    );
  }

  async terminate(backendSessionId: string): Promise<void> {
    this.cleanupStreaming(backendSessionId);
    try {
      execSync(`tmux kill-session -t ${JSON.stringify(backendSessionId)}`, {
        stdio: 'ignore',
      });
    } catch {
      // Session may already be gone — swallow
    }
  }
}
