export function buildNewSessionBootstrapCommand(
  repoPath: string,
  branch: string,
  baseBranch = 'main',
  usesWorktree = false,
  cwd?: string,
  bootstrapNotice?: string,
): string {
  const quotedRepoPath = JSON.stringify(repoPath);
  const quotedBranch = JSON.stringify(branch);
  const quotedBaseBranch = JSON.stringify(baseBranch);
  const changeDirCmd = cwd ? `cd ${JSON.stringify(cwd)}` : '';
  const cdPrefix = changeDirCmd ? `${changeDirCmd} && ` : '';

  if (bootstrapNotice) {
    const noticeCmd = `printf '%b\\n\\n' ${JSON.stringify(bootstrapNotice)}`;
    return changeDirCmd ? `${noticeCmd} && ${changeDirCmd}` : noticeCmd;
  }

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
