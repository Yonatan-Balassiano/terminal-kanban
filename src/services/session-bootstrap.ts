export function buildNewSessionBootstrapCommand(
  repoPath: string,
  branch: string,
  baseBranch = 'main',
  usesWorktree = false,
  cwd?: string,
): string {
  const quotedRepoPath = JSON.stringify(repoPath);
  const quotedBranch = JSON.stringify(branch);
  const quotedBaseBranch = JSON.stringify(baseBranch);
  const cdPrefix = cwd ? `cd ${JSON.stringify(cwd)} && ` : '';

  if (usesWorktree) {
    return `${cdPrefix}clear && claude`;
  }

  return (
    `git -C ${quotedRepoPath} checkout ${quotedBaseBranch} && ` +
    `git -C ${quotedRepoPath} pull && ` +
    `(` +
    `git -C ${quotedRepoPath} checkout ${quotedBranch} 2>/dev/null || ` +
    `git -C ${quotedRepoPath} checkout -b ${quotedBranch}` +
    `) && ` +
    cdPrefix +
    `clear && ` +
    `claude`
  );
}
