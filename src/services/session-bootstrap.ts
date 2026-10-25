import type { AgentCLI, AgentPermissionMode, TaskKind } from '../types/index.js';
import { shellJoin, shellQuote } from './shell-quote.js';

/**
 * One checkout the card owns, as handed to the agent.
 *
 * Declared here rather than in the shared types because only the bootstrap layer
 * speaks this shape; the workspace resolver builds it from its own branch plans.
 */
export interface SessionWorkspaceEntry {
  /** The repo's board label, so the agent can name the checkout it is in. */
  label: string;
  branch: string;
  path: string;
}

export interface SessionBootstrapEnvOptions {
  /**
   * The card this session belongs to, exported as `AGENTBOARD_TASK_ID` so a
   * `agentboard task create` run from inside the session can mark whatever it
   * spins off as this card's subtask without the agent having to know or
   * guess its own id.
   */
  taskId?: string;
  /**
   * `--name` for the agent CLI, so this session is addressable via
   * SendMessage/ListAgents by a readable name rather than only its task id.
   * Only claude's `--name` is verified — see `resolveAgentArgs`.
   */
  sessionName?: string;
  /** Defaults to 'repo'. A 'general' session gets no branch checkout. */
  taskKind?: TaskKind;
  repoPath: string;
  branch: string;
  baseBranch?: string;
  agentCli: AgentCLI;
  usesWorktree?: boolean;
  cwd?: string;
  bootstrapNotice?: string;
  agentPermissionMode?: AgentPermissionMode;
  agentArgs?: Partial<Record<AgentCLI, string[]>>;
  /**
   * Every checkout the card owns, active branch first. Omitted when the caller
   * could not resolve them — the script then simply prints no map.
   */
  workspaces?: readonly SessionWorkspaceEntry[];
  /** Conversation id to resume, or to start this conversation under. */
  agentSessionId?: string;
  /**
   * Path to the file holding the card's brief, on whichever host the session
   * runs. Read by the script and handed to the agent as its opening prompt when
   * the conversation starts fresh.
   */
  initialPromptFile?: string;
  /**
   * Path to the file holding messages that arrived while this card had no
   * session. Read by the script and handed to the agent only when this open
   * turns out to be a resume — see session-bootstrap.sh for why it is a
   * second file rather than a flag on the first.
   */
  resumeNoticeFile?: string;
  /**
   * How a hook running inside this session invokes the agentboard CLI — see
   * {@link prReportHookArgs}. Omitted where no CLI can reach the daemon from
   * the session's host, which simply leaves the session without the hook.
   */
  agentboardCommand?: string;
  /**
   * Remote (ssh) sessions only: what the mirrored agentboard CLI needs to
   * reach the daemon through the forwarded socket — see `remote-rpc.ts`.
   */
  remoteCli?: {
    /** This card's token: the only identity the remote socket accepts. */
    token: string;
    /** The forwarded daemon socket, on the remote host. */
    socketPath: string;
    /** Prepended to PATH, so a bare `agentboard` is the mirrored CLI. */
    binDir: string;
  };
}

/**
 * The flag each agent CLI uses to skip its own permission prompts.
 *
 * Only agents whose flag has been verified appear here. An agent that is absent
 * simply gets no flag rather than a guessed one that would make its CLI exit
 * with a usage error — override it via `agentArgs` in config if needed.
 */
const BYPASS_PERMISSION_FLAGS: Partial<Record<AgentCLI, string[]>> = {
  claude: ['--dangerously-skip-permissions'],
};

const WORKSPACE_COLUMN_SEPARATOR = '\t';
const WORKSPACE_ROW_SEPARATOR = '\n';

/**
 * The card's checkouts as a single env var: three tab-separated columns per row,
 * one row per checkout.
 *
 * Deliberately has no escaping of its own. The value is single-quoted in the
 * settings file, which carries real tabs and newlines through `source` intact,
 * and the bootstrap script splits on them directly.
 */
function encodeWorkspaces(workspaces: readonly SessionWorkspaceEntry[]): string {
  return workspaces
    .map(({ label, branch, path }) => [label, branch, path].join(WORKSPACE_COLUMN_SEPARATOR))
    .join(WORKSPACE_ROW_SEPARATOR);
}

/**
 * Agent CLIs whose `--name`/display-name flag has been verified. An agent
 * absent here simply gets no name flag, the same way BYPASS_PERMISSION_FLAGS
 * leaves out an unverified CLI's permission flag.
 */
const NAME_FLAG: Partial<Record<AgentCLI, string>> = {
  claude: '--name',
};

/** Arguments appended to the agent CLI invocation, in a stable order. */
export function resolveAgentArgs(
  agentCli: AgentCLI,
  permissionMode: AgentPermissionMode = 'default',
  agentArgs: Partial<Record<AgentCLI, string[]>> = {},
  sessionName?: string
): string[] {
  const permissionArgs = permissionMode === 'bypass' ? (BYPASS_PERMISSION_FLAGS[agentCli] ?? []) : [];
  const nameFlag = NAME_FLAG[agentCli];
  const nameArgs = sessionName && nameFlag ? [nameFlag, sessionName] : [];
  return [...permissionArgs, ...nameArgs, ...(agentArgs[agentCli] ?? [])];
}

/** Agent CLIs whose `--settings` hooks have been verified. */
const SETTINGS_FLAG_CLIS: ReadonlySet<AgentCLI> = new Set(['claude']);

/**
 * `--settings` carrying a PostToolUse hook that reports each pull request the
 * session opens back to its own card.
 *
 * The board used to find those itself, with an org-wide GitHub search per card
 * on every poll — the search API's 30-a-minute budget is the user's, shared
 * with their own sessions, and the board alone spent it several times over.
 * The session is where a PR is opened, so it is the one place that knows for
 * certain, the moment it happens. Sync keeps a slow search as the safety net
 * for PRs opened anywhere else.
 *
 * The filter runs in the hook's own shell, so the CLI only starts for the rare
 * Bash call that ran `gh pr create`, not for every command the agent runs. The
 * card id is baked in: the bootstrap script unsets its own settings before it
 * execs the agent. Always exits 0 — reporting must never fail a tool call.
 */
export function prReportHookArgs(
  agentCli: AgentCLI,
  taskId: string | undefined,
  agentboardCommand: string | undefined,
): string[] {
  if (!taskId || !agentboardCommand || !SETTINGS_FLAG_CLIS.has(agentCli)) {
    return [];
  }
  const report = `${agentboardCommand} task report-pr ${shellQuote(taskId)}`;
  const command = `input=$(cat); case "$input" in *'gh pr create'*) printf '%s' "$input" | ${report} >/dev/null 2>&1 ;; esac; exit 0`;
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 30 }] }],
    },
  };
  return ['--settings', JSON.stringify(settings)];
}

/**
 * The command that runs this same agentboard CLI: the node binary and entry
 * script the daemon itself was started with, so a hook never depends on
 * `agentboard` being on the session's PATH or on it being the same install.
 * Falls back to the PATH lookup under `npm run dev`, whose `.ts` entry plain
 * node cannot run.
 */
export function currentAgentboardCommand(): string {
  const entry = process.argv[1];
  if (!entry || entry.endsWith('.ts')) {
    return 'agentboard';
  }
  return `${shellQuote(process.execPath)} ${shellQuote(entry)}`;
}

/**
 * The session's settings, as a file for session-bootstrap.sh to source.
 *
 * These used to ride the command line typed into the pane. A pane's shell is
 * usually still starting when that line arrives, so the terminal is in
 * canonical mode and keeps at most 1024 bytes of one line (MAX_CANON on macOS)
 * — everything past it, the Enter included, is dropped. A git error in the
 * bootstrap notice, a long `--name` or a multi-branch workspace map was enough
 * to cross it, and the card opened on a shell holding half a command.
 *
 * Every value is single-quoted, so a `$` or a backtick in a title or a git
 * error is never expanded when the script sources the file.
 */
export function buildSessionBootstrapEnv({
  taskId,
  sessionName,
  taskKind = 'repo',
  repoPath,
  branch,
  baseBranch = 'main',
  agentCli,
  usesWorktree = false,
  cwd,
  bootstrapNotice,
  agentPermissionMode,
  agentArgs,
  workspaces = [],
  agentSessionId,
  initialPromptFile,
  resumeNoticeFile,
  agentboardCommand,
  remoteCli,
}: SessionBootstrapEnvOptions): string {
  const resolvedAgentArgs = [
    ...resolveAgentArgs(agentCli, agentPermissionMode, agentArgs, sessionName),
    // A general card has no repo, so a pull request has nowhere to land.
    ...(taskKind === 'general' ? [] : prReportHookArgs(agentCli, taskId, agentboardCommand)),
  ];
  const envVars: Array<[string, string]> = [
    ['AGENTBOARD_TASK_ID', taskId ?? ''],
    ['AGENTBOARD_TASK_KIND', taskKind],
    ['AGENTBOARD_REPO_PATH', repoPath],
    ['AGENTBOARD_TASK_BRANCH', branch],
    ['AGENTBOARD_BASE_BRANCH', baseBranch],
    ['AGENTBOARD_SESSION_CWD', cwd ?? repoPath],
    ['AGENTBOARD_AGENT', agentCli],
    ['AGENTBOARD_USES_WORKTREE', usesWorktree ? '1' : '0'],
    ['AGENTBOARD_BOOTSTRAP_NOTICE', bootstrapNotice ?? ''],
    ['AGENTBOARD_AGENT_ARGS', shellJoin(resolvedAgentArgs)],
    ['AGENTBOARD_WORKSPACES', encodeWorkspaces(workspaces)],
    ['AGENTBOARD_AGENT_SESSION_ID', agentSessionId ?? ''],
    // A path, never the brief itself: only the script knows whether this open
    // is a fresh start that should read it.
    ['AGENTBOARD_INITIAL_PROMPT_FILE', initialPromptFile ?? ''],
    ['AGENTBOARD_RESUME_PROMPT_FILE', resumeNoticeFile ?? ''],
    // Left on in the agent's environment on purpose: they are how its
    // `agentboard` calls reach the daemon. Remote cards only.
    ...(remoteCli
      ? ([
          ['AGENTBOARD_RPC_TOKEN', remoteCli.token],
          ['AGENTBOARD_REMOTE_SOCKET', remoteCli.socketPath],
          ['AGENTBOARD_EXTRA_PATH', remoteCli.binDir],
        ] as Array<[string, string]>)
      : []),
  ];

  return envVars.map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join('');
}

/**
 * The line typed into the pane: the settings file's path and the script.
 *
 * Two paths and nothing else, so its length no longer depends on anything about
 * the card — see {@link buildSessionBootstrapEnv}.
 */
export function buildSessionBootstrapCommand(envFile: string, sessionBootstrapScript: string): string {
  return `AGENTBOARD_BOOTSTRAP_ENV_FILE=${shellQuote(envFile)} ${shellQuote(sessionBootstrapScript)}`;
}
