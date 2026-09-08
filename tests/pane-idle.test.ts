import { describe, expect, it } from 'vitest';
import {
  pasteAndVerify,
  pasteChips,
  pasteMarker,
  submitAndVerify,
  waitForTrustPromptAndDismiss,
} from '../src/services/session-backends/pane-idle.js';

const TRUST_SCREEN = 'Quick safety check\n  No, exit\n❯ Yes, I trust this folder';

describe('waitForTrustPromptAndDismiss', () => {
  const FAST = { trustPromptTimeoutMs: 200, trustPromptIntervalMs: 5, trustPromptStableChecks: 2 };

  it('dismisses the prompt the instant it is already showing', async () => {
    let sent = false;
    const result = await waitForTrustPromptAndDismiss(
      async () => TRUST_SCREEN,
      async () => {
        sent = true;
      },
      async () => {},
      FAST,
    );
    expect(result).toBe(true);
    expect(sent).toBe(true);
  });

  it('catches the prompt even when it only renders partway through the polling window', async () => {
    // Arrange — confirmed live: becoming the pane's foreground process is not
    // proof the CLI has finished rendering its own first screen yet. This is
    // the exact race a single one-shot check (before or after
    // a one-shot check) can miss.
    let checks = 0;
    const capture = async () => {
      checks += 1;
      return checks < 3 ? '' : TRUST_SCREEN;
    };
    let downSent = false;
    let enterSent = false;

    // Act
    const result = await waitForTrustPromptAndDismiss(
      capture,
      async () => {
        downSent = true;
      },
      async () => {
        enterSent = true;
      },
      FAST,
    );

    // Assert
    expect(result).toBe(true);
    expect(downSent).toBe(true);
    expect(enterSent).toBe(true);
  });

  it('gives up once the pane settles on a screen that is not the trust prompt', async () => {
    let sent = false;
    const result = await waitForTrustPromptAndDismiss(
      async () => '',
      async () => {
        sent = true;
      },
      async () => {},
      FAST,
    );
    expect(result).toBe(false);
    expect(sent).toBe(false);
  });

  it('never sends Down/Enter when it times out without ever seeing the prompt', async () => {
    // Arrange — a pane that keeps changing (never stabilizes) and never
    // shows the trust prompt within the window.
    let n = 0;
    let sent = false;
    const result = await waitForTrustPromptAndDismiss(
      async () => `frame-${(n += 1)}`,
      async () => {
        sent = true;
      },
      async () => {},
      { trustPromptTimeoutMs: 30, trustPromptIntervalMs: 5, trustPromptStableChecks: 100 },
    );
    expect(result).toBe(false);
    expect(sent).toBe(false);
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
    // Arrange — the duplicate-run case, which only a redelivery opts into. A
    // second paste would stack a copy underneath the first rather than replace
    // it; that is what left one pane holding 20 unsubmitted fragments.
    const pane = `❯ ${BRIEF}`;
    let pastes = 0;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
      },
      async () => pane,
      pasteMarker(BRIEF),
      { ...FAST, skipIfAlreadyOnPane: true },
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
      { ...FAST, skipIfAlreadyOnPane: true },
    );

    // Assert
    expect(outcome).toBe('already-present');
    expect(pastes).toBe(0);
  });

  it('pastes anyway when the caller did not opt into skipping — a notify must never be dropped', async () => {
    // Arrange — the same pane as the test above, reached by the other caller.
    // For a notify the text is a *new* message, so a marker match is a stale
    // copy of an earlier notice (or a different message sharing its first 24
    // characters), not a re-send of something already waiting to be submitted.
    // Skipping it would drop the message and report success.
    let pane = `❯ ${BRIEF}`;
    let pastes = 0;

    // Act — no skipIfAlreadyOnPane, which is the default.
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
        pane += `\n❯ ${BRIEF}`;
      },
      async () => pane,
      pasteMarker(BRIEF),
      FAST,
    );

    // Assert
    expect(outcome).toBe('pasted');
    expect(pastes).toBe(1);
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

  it('still retries on a pane that was already moving on its own before the paste', async () => {
    // Arrange — an agent mid-generation, which is the normal state for a
    // notify. Every capture differs from the last whether or not the paste
    // landed, so the post-paste "the pane changed" check carries no
    // information about the paste and must not cut the retry loop short.
    // `waitForStablePane` runs earlier but returns on its timeout too, so it
    // does not guarantee a still pane here.
    let tick = 0;
    const capture = async () => `thinking… ${(tick += 1)}`;
    let pastes = 0;
    const paste = async () => {
      pastes += 1;
    };

    // Act — the paste is swallowed whole, so the marker never appears.
    const outcome = await pasteAndVerify(paste, capture, pasteMarker(BRIEF), FAST);

    // Assert — all three attempts spent, not one.
    expect(outcome).toBe('unverified');
    expect(pastes).toBe(3);
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


// Issue #46 §1. A ~20-line `notify` arrived in the pane's input box and was
// never submitted, because claude renders a big paste as a placeholder chip
// instead of echoing it: the text verification looks for is not on the screen
// and never will be, so the paste read as mangled and its Enter was withheld.
describe('pasteAndVerify with a collapsed paste', () => {
  const FAST = { pasteVerifyTimeoutMs: 150, pasteVerifyIntervalMs: 5, maxPasteAttempts: 3 };
  const COLLAPSED = '\u276f [Pasted text #1 +11 lines]\n─────\n  [Opus 5] wix-vmr-repo';

  it('accepts a paste the CLI collapsed into a placeholder chip', async () => {
    // Arrange — the pane never shows the message, only the chip.
    let pane = '\u276f \n─────\n  [Opus 5] wix-vmr-repo';
    let pastes = 0;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pastes += 1;
        pane = COLLAPSED;
      },
      async () => pane,
      pasteMarker('Review findings: the border flicker fix looks right, but'),
      FAST,
    );

    // Assert — verified off the chip, once, so the caller goes on to submit it.
    expect(outcome).toBe('pasted');
    expect(pastes).toBe(1);
  });

  it('does not count a chip that was already on the pane', async () => {
    // Arrange — the pane opens holding an earlier paste's chip and the paste
    // itself changes nothing. Counting that chip would report a delivery for a
    // message that never arrived, which is worse than the bug being fixed.
    const pane = COLLAPSED;

    // Act
    const outcome = await pasteAndVerify(
      async () => {},
      async () => pane,
      pasteMarker('A different message entirely'),
      FAST,
    );

    // Assert
    expect(outcome).toBe('unverified');
  });

  it('counts a second chip stacking under the first', async () => {
    // Arrange — a pane that already held one collapsed paste when this one
    // landed, which is the ordinary state of a pane being notified twice.
    let pane = COLLAPSED;

    // Act
    const outcome = await pasteAndVerify(
      async () => {
        pane = `${COLLAPSED}\n\u276f [Pasted text #2 +6 lines]`;
      },
      async () => pane,
      pasteMarker('The second message'),
      FAST,
    );

    // Assert
    expect(outcome).toBe('pasted');
  });
});

describe('pasteChips', () => {
  it('finds the placeholders and ignores everything else', () => {
    expect(pasteChips('\u276f [Pasted text #1 +11 lines] and [Pasted text #2]')).toEqual([
      '[Pasted text #1 +11 lines]',
      '[Pasted text #2]',
    ]);
    expect(pasteChips('nothing pasted here')).toEqual([]);
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

  // Issue #46 §3. Exhausting every retry against a pane that never moved used
  // to resolve exactly like a clean submit, so "the text is in the input box,
  // unsubmitted" could not be reported to anyone.
  it('reports that nothing was submitted when the pane never moves', async () => {
    const submitted = await submitAndVerify(
      async () => 'a pane that never changes',
      async () => {},
      { maxSubmitRetries: 3, submitRetryIntervalMs: 0 },
    );

    expect(submitted).toBe(false);
  });

  it('does not claim a failed submit when it was configured not to look', async () => {
    // Arrange — zero retries means zero verification passes. That is "no
    // evidence", not evidence of failure; reporting the latter would send
    // callers after a pane nobody checked.
    const submitted = await submitAndVerify(
      async () => 'a pane that never changes',
      async () => {},
      { maxSubmitRetries: 0, submitRetryIntervalMs: 0 },
    );

    expect(submitted).toBe(true);
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
    expect(
      await submitAndVerify(
        async () => pane,
        async () => {
          pane = `${pane}!`;
        },
        { maxSubmitRetries: 20, submitRetryIntervalMs: 0 },
      ),
    ).toBe(true);
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
