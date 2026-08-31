import { shellQuote } from '../shell-quote.js';

/**
 * Pane-scoped option stamped on every task pane.
 *
 * The Go layout engine breaks panes out of their original session and joins them
 * into the board layout, which loses the session name; this tag is how a pane is
 * matched back to its task afterwards.
 */
export const AGENTBOARD_PANE_SESSION_OPTION = '@agentboard_backend_session_id';

/** Every AgentBoard-owned tmux session name starts with this. */
export const AGENTBOARD_SESSION_PREFIX = 'ab_';

export const TMUX_SESSION_NAME_FORMAT = '#S';
export const TMUX_PANE_TAG_FORMAT = `#{${AGENTBOARD_PANE_SESSION_OPTION}}`;
export const TMUX_TAGGED_PANE_FORMAT = `#{pane_id}\t#{${AGENTBOARD_PANE_SESSION_OPTION}}`;
export const TMUX_PANE_PROCESS_FORMAT = '#{pane_pid} #{pane_current_command}';

export interface TmuxInvocation {
  args: string[];
}

export function buildTmuxAttachCommand(backendSessionId: string): string {
  return `env -u TMUX tmux attach-session -t ${shellQuote(backendSessionId)}`;
}

export function buildTmuxHasSessionArgs(backendSessionId: string): string[] {
  return ['has-session', '-t', backendSessionId];
}

export function buildTmuxKillSessionArgs(backendSessionId: string): string[] {
  return ['kill-session', '-t', backendSessionId];
}

export function buildTmuxKillPaneArgs(paneId: string): string[] {
  return ['kill-pane', '-t', paneId];
}

export function buildTmuxListSessionsArgs(format: string = TMUX_SESSION_NAME_FORMAT): string[] {
  return ['list-sessions', '-F', format];
}

/** Omitting `target` scans every pane on the server. */
export function buildTmuxListPanesArgs(format: string, target?: string): string[] {
  return ['list-panes', ...(target === undefined ? ['-a'] : ['-t', target]), '-F', format];
}

export interface TmuxSetOptionSpec {
  target: string;
  name: string;
  value: string;
  /** Pane-scoped options need `-p`; session-scoped is the default. */
  scope?: 'session' | 'pane';
}

export function buildTmuxSetOptionArgs({
  target,
  name,
  value,
  scope = 'session',
}: TmuxSetOptionSpec): string[] {
  return ['set-option', ...(scope === 'pane' ? ['-p'] : []), '-q', '-t', target, name, value];
}

/** Without this a session is destroyed the moment its last client detaches. */
export function buildTmuxSurviveDetachArgs(backendSessionId: string): string[] {
  return buildTmuxSetOptionArgs({
    target: backendSessionId,
    name: 'destroy-unattached',
    value: 'off',
  });
}

export function buildTmuxTagPaneArgs(target: string, backendSessionId: string): string[] {
  return buildTmuxSetOptionArgs({
    target,
    name: AGENTBOARD_PANE_SESSION_OPTION,
    value: backendSessionId,
    scope: 'pane',
  });
}

/** Removes the AgentBoard tag from a single pane, leaving the pane running. */
export function buildTmuxUntagPaneArgs(paneId: string): string[] {
  return ['set-option', '-p', '-q', '-u', '-t', paneId, AGENTBOARD_PANE_SESSION_OPTION];
}

/** Resolves the pane id tmux would target for a session name. */
export function buildTmuxPaneIdArgs(target: string): string[] {
  return ['display-message', '-p', '-t', target, '#{pane_id}'];
}

/** Renders whatever is currently on screen in the pane, for idle-detection. */
export function buildTmuxCapturePaneArgs(target: string): string[] {
  return ['capture-pane', '-p', '-t', target];
}

/**
 * Loads a file's contents into a tmux paste buffer.
 *
 * Delivering the card's brief this way, rather than as typed keystrokes,
 * matters once it spans more than one line: `send-keys` submits on every
 * newline it sees, so a multi-line brief typed key-by-key would be cut off and
 * submitted after its first line. A paste, like a human pasting into the pane,
 * inserts the whole block — including its newlines — without triggering submit
 * until a real Enter follows.
 */
export function buildTmuxLoadBufferArgs(bufferName: string, filePath: string): string[] {
  return ['load-buffer', '-b', bufferName, filePath];
}

/** Pastes a loaded buffer into the target pane and frees it (`-d`). */
export function buildTmuxPasteBufferArgs(bufferName: string, target: string): string[] {
  return ['paste-buffer', '-b', bufferName, '-d', '-t', target];
}

export interface TmuxNewSessionSpec {
  backendSessionId: string;
  cwd?: string;
  /** Pane command line; tmux starts the default shell when omitted. */
  command?: string;
}

export function buildTmuxNewSessionArgs({
  backendSessionId,
  cwd,
  command,
}: TmuxNewSessionSpec): string[] {
  return [
    'new-session',
    '-d',
    '-s',
    backendSessionId,
    ...(cwd === undefined ? [] : ['-c', cwd]),
    ...(command === undefined ? [] : [command]),
  ];
}

/**
 * Join several tmux commands into one invocation.
 *
 * tmux splits its argv on a bare `;` argument, so this turns N tmux calls into a
 * single process — which over SSH turns N round trips into one.
 */
export function chainTmuxArgs(...commands: readonly (readonly string[])[]): string[] {
  return commands.flatMap((args, index) => (index === 0 ? [...args] : [';', ...args]));
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

/** Parse `#{pane_pid} #{pane_current_command}` output into typed fields. */
export function parseTmuxPaneProcess(stdout: string): {
  shellPid?: number;
  currentCommand?: string;
} {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) {
    return {};
  }

  const separatorIndex = line.indexOf(' ');
  const pidText = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
  const command = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1).trim();
  const shellPid = Number.parseInt(pidText, 10);

  return {
    shellPid: Number.isNaN(shellPid) ? undefined : shellPid,
    currentCommand: command.length > 0 ? command : undefined,
  };
}

/** Extract AgentBoard session names from newline-delimited tmux output. */
export function parseAgentboardSessionNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.startsWith(AGENTBOARD_SESSION_PREFIX));
}
