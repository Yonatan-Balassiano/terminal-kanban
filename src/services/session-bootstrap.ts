import type { AgentCLI, AgentPermissionMode, TaskKind } from '../types/index.js';
import { shellJoin } from './shell-quote.js';

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
  ];

  return [
    ...envVars.map(([key, value]) => `${key}=${shellString(value)}`),
    shellString(sessionBootstrapScript),
  ].join(' ');
}
