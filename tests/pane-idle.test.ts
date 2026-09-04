import { describe, expect, it } from 'vitest';
import { waitForForegroundCommand } from '../src/services/session-backends/pane-idle.js';

describe('waitForForegroundCommand', () => {
  it('matches an exact process name (claude, a short binary that never truncates)', async () => {
    const resolves = await raceResolved(
      waitForForegroundCommand(async () => 'claude', 'claude', {
        foregroundCommandTimeoutMs: 50,
        foregroundCommandIntervalMs: 5,
      }),
    );
    expect(resolves).toBe(true);
  });

  it("matches codex's real process name, truncated by the OS to codex-aarch64-a via its symlinked binary", async () => {
    // Confirmed live: `codex` resolves to `codex-aarch64-apple-darwin`, and
    // the kernel's process-name field truncates that — an exact-equality
    // check against the plain `agentCli` value 'codex' never matches this.
    const resolves = await raceResolved(
      waitForForegroundCommand(async () => 'codex-aarch64-a', 'codex', {
        foregroundCommandTimeoutMs: 50,
        foregroundCommandIntervalMs: 5,
      }),
    );
    expect(resolves).toBe(true);
  });

  it('does not match an unrelated process name (still the bootstrap shell)', async () => {
    const resolves = await raceResolved(
      waitForForegroundCommand(async () => 'bash', 'claude', {
        foregroundCommandTimeoutMs: 30,
        foregroundCommandIntervalMs: 5,
      }),
    );
    expect(resolves).toBe(false);
  });

  it('gives up and returns after the timeout when the process name never matches', async () => {
    const start = Date.now();
    await waitForForegroundCommand(async () => 'bash', 'claude', {
      foregroundCommandTimeoutMs: 30,
      foregroundCommandIntervalMs: 5,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});

/** Resolves `true` if `promise` settles before the timeout, `false` if it's still pending. */
async function raceResolved(promise: Promise<unknown>): Promise<boolean> {
  const timeout = Symbol('timeout');
  const result = await Promise.race([promise.then(() => true), sleep(10).then(() => timeout)]);
  return result !== timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
