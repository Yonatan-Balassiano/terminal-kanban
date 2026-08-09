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

/** Arguments appended to the agent CLI invocation, in a stable order. */
export function resolveAgentArgs(
  agentCli: AgentCLI,
  permissionMode: AgentPermissionMode = 'default',
  agentArgs: Partial<Record<AgentCLI, string[]>> = {}
): string[] {
  const permissionArgs = permissionMode === 'bypass' ? (BYPASS_PERMISSION_FLAGS[agentCli] ?? []) : [];
  return [...permissionArgs, ...(agentArgs[agentCli] ?? [])];
}

export function buildNewSessionBootstrapCommand({
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
}: SessionBootstrapCommandOptions): string {
  const resolvedAgentArgs = resolveAgentArgs(agentCli, agentPermissionMode, agentArgs);
  const envVars: Array<[string, string]> = [
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
  ];

  return [
    ...envVars.map(([key, value]) => `${key}=${shellString(value)}`),
    shellString(sessionBootstrapScript),
  ].join(' ');
}
