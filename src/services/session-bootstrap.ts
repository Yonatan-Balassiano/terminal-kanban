import type { AgentCLI, AgentPermissionMode, TaskKind } from '../types/index.js';
import { shellJoin } from './shell-quote.js';

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

export interface SessionBootstrapCommandOptions {
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
  sessionBootstrapScript: string;
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

function shellString(value: string): string {
  return JSON.stringify(value);
}

const WORKSPACE_COLUMN_SEPARATOR = '\t';
const WORKSPACE_ROW_SEPARATOR = '\n';

/**
 * The card's checkouts as a single env var: three tab-separated columns per row,
 * one row per checkout.
 *
 * Deliberately has no escaping of its own. shellString is JSON.stringify, which
 * already turns these separators into `\t` and `\n` escape sequences that survive
 * the shell's double-quote parsing intact; the bootstrap script turns them back
 * into real separators with `printf %b` before splitting.
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

export function buildNewSessionBootstrapCommand({
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
  sessionBootstrapScript,
  agentPermissionMode,
  agentArgs,
  workspaces = [],
  agentSessionId,
  initialPromptFile,
  resumeNoticeFile,
}: SessionBootstrapCommandOptions): string {
  const resolvedAgentArgs = resolveAgentArgs(agentCli, agentPermissionMode, agentArgs, sessionName);
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
    // A path, never the brief itself: the whole command line is typed into the
    // session's pane, and a long brief would push it past the ~4 KB the pane
    // accepts, truncating the command mid-quote.
    ['AGENTBOARD_INITIAL_PROMPT_FILE', initialPromptFile ?? ''],
    ['AGENTBOARD_RESUME_PROMPT_FILE', resumeNoticeFile ?? ''],
  ];

  return [
    ...envVars.map(([key, value]) => `${key}=${shellString(value)}`),
    shellString(sessionBootstrapScript),
  ].join(' ');
}
