import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  SessionActivityKind,
  SessionActivitySnapshot,
  SessionStatus,
} from '../types/index.js';

export interface ProcessRow {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
  args: string;
}

const execFileAsync = promisify(execFile);

const AGENT_RECENT_OUTPUT_WINDOW_MS = 2500;

const SHELL_COMMANDS = new Set([
  'bash',
  '-bash',
  'dash',
  'fish',
  '-fish',
  'ksh',
  '-ksh',
  'login',
  'nu',
  '-nu',
  'pwsh',
  '-pwsh',
  'sh',
  '-sh',
  'tcsh',
  '-tcsh',
  'xonsh',
  '-xonsh',
  'zsh',
  '-zsh',
]);

const AGENT_LABELS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bclaude\b/i, label: 'Claude' },
  { pattern: /\bcodex\b/i, label: 'Codex' },
  { pattern: /\bcursor(?:-agent)?\b/i, label: 'Cursor' },
  { pattern: /\baider\b/i, label: 'Aider' },
  { pattern: /\bopencode\b/i, label: 'OpenCode' },
];

function baseCommandName(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function formatProcessLabel(command: string): string {
  const normalized = baseCommandName(command).replace(/^[-]+/, '');
  if (normalized.length === 0) {
    return 'working';
  }

  const agent = AGENT_LABELS.find(({ pattern }) => pattern.test(normalized));
  if (agent) {
    return agent.label;
  }

  return normalized;
}

function detectActivityKind(command: string, args: string): SessionActivityKind {
  const haystack = `${command} ${args}`;
  return AGENT_LABELS.some(({ pattern }) => pattern.test(haystack)) ? 'agent' : 'process';
}

function hasRecentOutput(lastOutputAt: number | undefined, now: number): boolean {
  return lastOutputAt !== undefined && now - lastOutputAt <= AGENT_RECENT_OUTPUT_WINDOW_MS;
}

function stripTerminalControlSequences(data: string): string {
  return data
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export function hasMeaningfulTerminalOutput(data: string): boolean {
  const visible = stripTerminalControlSequences(data).trim();
  if (visible.length === 0) {
    return false;
  }

  return /[\p{L}\p{N}\u2800-\u28ff]/u.test(visible);
}

function parseProcessTable(output: string): ProcessRow[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number.parseInt(match[1] ?? '', 10),
        ppid: Number.parseInt(match[2] ?? '', 10),
        stat: match[3] ?? '',
        command: match[4] ?? '',
        args: match[5] ?? '',
      };
    })
    .filter((row): row is ProcessRow => row !== null);
}

function isLiveProcess(process: ProcessRow): boolean {
  return !process.stat.toUpperCase().includes('Z');
}

function isShellProcess(command: string): boolean {
  return SHELL_COMMANDS.has(baseCommandName(command));
}

function getDescendants(processes: ProcessRow[], rootPid: number): ProcessRow[] {
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const process of processes) {
    const current = childrenByParent.get(process.ppid) ?? [];
    current.push(process);
    childrenByParent.set(process.ppid, current);
  }

  const descendants: ProcessRow[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const process = queue.shift();
    if (!process) {
      continue;
    }

    descendants.push(process);
    const children = childrenByParent.get(process.pid);
    if (children) {
      queue.push(...children);
    }
  }

  return descendants;
}

function selectBusyProcess(
  descendants: ProcessRow[],
  lastOutputAt: number | undefined,
  now: number,
  currentCommand?: string,
): Pick<SessionActivitySnapshot, 'isBusy' | 'kind' | 'command' | 'label' | 'pid'> {
  const liveDescendants = descendants.filter(isLiveProcess);
  const meaningfulDescendants = liveDescendants.filter(
    (process) => !isShellProcess(process.command),
  );
  const preferred = meaningfulDescendants[0];

  if (preferred) {
    const kind = detectActivityKind(preferred.command, preferred.args);
    return {
      isBusy: kind === 'agent' ? hasRecentOutput(lastOutputAt, now) : true,
      kind,
      command: baseCommandName(preferred.command),
      label: formatProcessLabel(preferred.command),
      pid: preferred.pid,
    };
  }

  if (currentCommand && !isShellProcess(currentCommand)) {
    const kind = detectActivityKind(currentCommand, currentCommand);
    return {
      isBusy: kind === 'agent' ? hasRecentOutput(lastOutputAt, now) : true,
      kind,
      command: baseCommandName(currentCommand),
      label: formatProcessLabel(currentCommand),
      pid: undefined,
    };
  }

  return {
    isBusy: false,
    kind: undefined,
    command: undefined,
    label: undefined,
    pid: undefined,
  };
}

export function deriveFallbackSessionActivity(
  taskId: string,
  sessionId: string | undefined,
  sessionStatus: SessionStatus,
  lastOutputAt?: number,
  currentCommand?: string,
): SessionActivitySnapshot {
  const now = Date.now();
  const isAgentCommand =
    currentCommand !== undefined && !isShellProcess(currentCommand)
      ? detectActivityKind(currentCommand, currentCommand) === 'agent'
      : false;

  return {
    taskId,
    sessionId,
    sessionStatus,
    isBusy:
      currentCommand !== undefined &&
      !isShellProcess(currentCommand) &&
      (!isAgentCommand || hasRecentOutput(lastOutputAt, now)),
    kind:
      currentCommand !== undefined && !isShellProcess(currentCommand)
        ? detectActivityKind(currentCommand, currentCommand)
        : undefined,
    command:
      currentCommand !== undefined && !isShellProcess(currentCommand)
        ? baseCommandName(currentCommand)
        : undefined,
    label:
      currentCommand !== undefined && !isShellProcess(currentCommand)
        ? formatProcessLabel(currentCommand)
        : undefined,
    updatedAt: now,
  };
}

export function deriveSessionActivity(
  taskId: string,
  sessionId: string | undefined,
  sessionStatus: SessionStatus,
  processes: ProcessRow[],
  shellPid?: number,
  lastOutputAt?: number,
  currentCommand?: string,
): SessionActivitySnapshot {
  const now = Date.now();

  if (shellPid === undefined || shellPid <= 0 || sessionStatus !== 'active') {
    return {
      taskId,
      sessionId,
      sessionStatus,
      isBusy: false,
      updatedAt: now,
    };
  }

  const descendants = getDescendants(processes, shellPid);
  const activity = selectBusyProcess(descendants, lastOutputAt, now, currentCommand);

  return {
    taskId,
    sessionId,
    sessionStatus,
    ...activity,
    updatedAt: now,
  };
}

export async function loadProcessTable(): Promise<ProcessRow[] | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,stat=,comm=,args='], {
      encoding: 'utf8',
    });
    return parseProcessTable(String(stdout));
  } catch {
    return null;
  }
}
