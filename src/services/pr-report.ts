/**
 * Reading a pull request a session just opened out of a Claude Code
 * PostToolUse hook payload — see `prReportHookArgs` in session-bootstrap.ts.
 */

/** One pull request named in a hook payload, by its GitHub coordinates. */
export interface ReportedPR {
  owner: string;
  repo: string;
  number: number;
}

const PR_URL_PATTERN = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * The pull requests a `gh pr create` Bash call reports having opened.
 *
 * Only a call whose command ran `gh pr create` counts, and only URLs in what
 * the call *printed*: `gh pr create` prints the new PR's URL, while the command
 * itself (a `--body` quoting another PR, say) can name any PR at all, and
 * attaching one of those would put someone else's work on the card. Anything
 * unexpected — not JSON, another tool, no URL — yields nothing rather than
 * throwing, because the payload's shape is Claude Code's own.
 */
export function parsePrReportHookInput(raw: string): ReportedPR[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse } = payload as {
    tool_name?: unknown;
    tool_input?: { command?: unknown };
    tool_response?: unknown;
  };
  if (toolName !== 'Bash' || typeof toolInput?.command !== 'string') {
    return [];
  }
  if (!/\bgh\s+pr\s+create\b/.test(toolInput.command)) {
    return [];
  }

  const output =
    typeof toolResponse === 'string'
      ? toolResponse
      : typeof toolResponse === 'object' && toolResponse !== null
        ? [
            (toolResponse as { stdout?: unknown }).stdout,
            (toolResponse as { stderr?: unknown }).stderr,
          ]
            .filter((part): part is string => typeof part === 'string')
            .join('\n')
        : '';

  const found = new Map<string, ReportedPR>();
  for (const match of output.matchAll(PR_URL_PATTERN)) {
    const [, owner, repo, numberText] = match;
    const number = Number.parseInt(numberText!, 10);
    found.set(`${owner}/${repo}#${number}`.toLowerCase(), { owner: owner!, repo: repo!, number });
  }
  return Array.from(found.values());
}
