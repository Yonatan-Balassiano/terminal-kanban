import type { AgentCLI } from '../types/index.js';

export interface SessionBootstrapCommandOptions {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  agentCli: AgentCLI;
  usesWorktree?: boolean;
  cwd?: string;
  bootstrapNotice?: string;
  sessionBootstrapScript: string;
}

function shellString(value: string): string {
  return JSON.stringify(value);
}

export function buildNewSessionBootstrapCommand({
  repoPath,
  branch,
  baseBranch = 'main',
  agentCli,
  usesWorktree = false,
  cwd,
  bootstrapNotice,
  sessionBootstrapScript,
}: SessionBootstrapCommandOptions): string {
  const envVars: Array<[string, string]> = [
    ['AGENTBOARD_REPO_PATH', repoPath],
    ['AGENTBOARD_TASK_BRANCH', branch],
    ['AGENTBOARD_BASE_BRANCH', baseBranch],
    ['AGENTBOARD_SESSION_CWD', cwd ?? repoPath],
    ['AGENTBOARD_AGENT', agentCli],
    ['AGENTBOARD_USES_WORKTREE', usesWorktree ? '1' : '0'],
    ['AGENTBOARD_BOOTSTRAP_NOTICE', bootstrapNotice ?? ''],
  ];

  return [
    ...envVars.map(([key, value]) => `${key}=${shellString(value)}`),
    shellString(sessionBootstrapScript),
  ].join(' ');
}
