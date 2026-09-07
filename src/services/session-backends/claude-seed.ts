import { spawn } from 'child_process';

export interface ClaudeSeedOptions {
  /** The exact id the interactive bootstrap script will independently resolve to. */
  agentSessionId: string;
  cwd: string;
  prompt: string;
}

export type ClaudeSeedRunner = (opts: ClaudeSeedOptions) => Promise<void>;

/**
 * Seeds a fresh `claude` conversation headlessly on the machine the daemon
 * itself runs on, so the interactive session's own resume-detection
 * (session-bootstrap.sh's `compgen -G ... .jsonl`) finds a transcript already
 * sitting under that session id and resumes it instead of starting blank.
 *
 * Spawned directly rather than through node-pty/tmux: this is a one-shot
 * batch call with piped stdin, not an interactive terminal. Only `claude` is
 * wired up — see resolveAgentArgs's own claude-only carve-outs in
 * session-bootstrap.ts. Confirmed live: a never-before-seen directory does
 * NOT show the trust dialog under `--print`, but also does not mark
 * `hasTrustDialogAccepted` — the interactive session that resumes this
 * transcript still needs its own trust-dialog handling.
 */
export function defaultLocalClaudeSeedRunner({ agentSessionId, cwd, prompt }: ClaudeSeedOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--session-id', agentSessionId, '--print'], {
      cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude --print seed exited with code ${String(code)}`));
      }
    });
    // Avoid an unhandled EPIPE if claude exits before consuming all of stdin.
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
