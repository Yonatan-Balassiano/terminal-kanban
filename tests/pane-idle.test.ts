import { describe, expect, it } from 'vitest';
import {
  pasteAndVerify,
  pasteMarker,
  submitAndVerify,
  waitForForegroundCommand,
} from '../src/services/session-backends/pane-idle.js';

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


describe('pasteAndVerify', () => {
  const FAST = { pasteVerifyTimeoutMs: 20, pasteVerifyIntervalMs: 1, maxPasteAttempts: 3 };
  const BRIEF = 'Read /tmp/brief.md — that file is your full brief.';

  it('pastes, then reports the paste landed once its own opening renders', async () => {
    // Arrange
    let pane = '';
    const paste = async () => {
      pane = `❯ ${BRIEF}`;
    };

    // Act
    const outcome = await pasteAndVerify(paste, async () => pane, pasteMarker(BRIEF), FAST);

    // Assert
    expect(outcome).toBe('pasted');
  });

  it('does not paste again when the same brief is already sitting on the pane', async () => {
    // Arrange — the duplicate-run case. A second paste would stack a copy
    // underneath the first rather than replace it; that is what left one pane
    // holding 20 unsubmitted fragments.
    const pane = `❯ ${BRIEF}`;
    let pastes = 0;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
      },
      async () => pane,
      pasteMarker(BRIEF),
      FAST,
    );

    // Assert — the caller still submits on 'already-present', so a repeat run
    // presses Enter on text that was already there instead of re-pasting it.
    expect(outcome).toBe('already-present');
    expect(pastes).toBe(0);
  });

  it('matches an already-pasted brief through tmux\'s own line wrapping', async () => {
    // Arrange — capture-pane re-wraps a long line, so the check has to
    // normalise whitespace the same way the verify step does.
    const pane = `❯ Read /tmp/brief.md — that file\n  is your full brief.`;
    let pastes = 0;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
      },
      async () => pane,
      pasteMarker(BRIEF),
      FAST,
    );

    // Assert
    expect(outcome).toBe('already-present');
    expect(pastes).toBe(0);
  });

  it('still pastes when there is no marker to recognise — every pane "contains" an empty one', async () => {
    // Arrange
    let pastes = 0;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
      },
      async () => 'a pane with something else on it',
      '',
      FAST,
    );

    // Assert
    expect(outcome).toBe('pasted');
    expect(pastes).toBe(1);
  });

  it('stops re-pasting once something has landed on the pane it cannot recognise', async () => {
    // Arrange — the mangled-paste case: the text lands, but rendered in a
    // shape the marker cannot match. Pasting again stacks a second copy under
    // the mess instead of replacing it, which is how a pane ends up holding
    // several overlapping fragments from a single delivery.
    let pane = '';
    let pastes = 0;
    const paste = async () => {
      pastes += 1;
      pane += 'Read /tmp/brief.md \r that file\r';
    };

    // Act
    const outcome = await pasteAndVerify(paste, async () => pane, pasteMarker(BRIEF), FAST);

    // Assert — one paste, not three, and nothing gets submitted on 'unverified'.
    expect(outcome).toBe('unverified');
    expect(pastes).toBe(1);
  });

  it('still retries when the paste left no trace at all — re-pasting stacks nothing there', async () => {
    // Arrange — the case this retry loop was added for: a paste swallowed
    // whole by bracketed-paste negotiation leaves the pane untouched.
    let pastes = 0;
    const paste = async () => {
      pastes += 1;
    };

    // Act
    const outcome = await pasteAndVerify(paste, async () => 'an unchanged pane', pasteMarker(BRIEF), FAST);

    // Assert
    expect(outcome).toBe('unverified');
    expect(pastes).toBe(3);
  });

  it('reports unverified, without claiming a paste, when nothing ever renders', async () => {
    // Arrange
    let pastes = 0;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
      },
      async () => '',
      pasteMarker(BRIEF),
      FAST,
    );

    // Assert — the caller must not send Enter on this.
    expect(outcome).toBe('unverified');
    expect(pastes).toBe(3);
  });
});


describe('submitAndVerify', () => {
  it('only ever re-sends Enter — the submit-retry loop has no way to paste again', async () => {
    // Arrange — the pane never acknowledges anything, so every retry is spent.
    // This is the loop that runs for minutes after a client has given up
    // waiting, so it is the one that must not be able to add to the pane.
    const sends: string[] = [];

    // Act
    await submitAndVerify(
      async () => 'a pane that never changes',
      async () => {
        sends.push('Enter');
      },
      { maxSubmitRetries: 20, submitRetryIntervalMs: 0 },
    );

    // Assert — 21 Enters (the first plus every retry), and nothing else: the
    // function is not even handed a paste to call.
    expect(sends).toHaveLength(21);
    expect(new Set(sends)).toEqual(new Set(['Enter']));
  });

  it('stops re-sending as soon as the pane reacts', async () => {
    // Arrange
    let sends = 0;
    let pane = 'waiting';

    // Act
    await submitAndVerify(
      async () => pane,
      async () => {
        sends += 1;
        pane = 'submitted';
      },
      { maxSubmitRetries: 20, submitRetryIntervalMs: 0 },
    );

    // Assert
    expect(sends).toBe(1);
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
