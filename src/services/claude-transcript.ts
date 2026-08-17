/**
 * Where the Claude CLI keeps a conversation's transcript, and how it names
 * the directory it keeps it in.
 *
 * Only Claude is wired up here, matching scripts/session-bootstrap.sh, which
 * resumes by id for `claude` only.
 */

/**
 * The Claude CLI's own project-directory name for a cwd: every character
 * outside `[A-Za-z0-9]` becomes `-`. Verified against a real
 * `~/.claude/projects` listing — `/Users/me/.claude/x` becomes
 * `-Users-me--claude-x`, so `/` and `.` both fall under this rule, not just
 * `/`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Full path to a conversation's transcript file under a given Claude config dir. */
export function claudeTranscriptPath(
  claudeConfigDir: string,
  cwd: string,
  agentSessionId: string
): string {
  return `${claudeConfigDir}/projects/${claudeProjectSlug(cwd)}/${agentSessionId}.jsonl`;
}
