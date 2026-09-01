// ============================================================
// AgentBoard — wait for a freshly spawned pane to settle
// ============================================================

export interface PaneIdleWaitOptions {
  /** Give up and proceed anyway after this long. */
  timeoutMs?: number;
  /** How often to re-capture the pane while waiting. */
  intervalMs?: number;
  /** Consecutive identical captures required before the pane counts as idle. */
  stableChecks?: number;
  /**
   * Extra pause after a paste before the trailing Enter is sent.
   *
   * A screen that "looks" settled is not proof the app has finished handling
   * the paste it just received — an Ink-style UI processes and re-renders a
   * multi-line paste asynchronously, and an Enter that lands mid-render is
   * silently dropped rather than queued. Confirmed live: the identical
   * `send-keys Enter` sent a few seconds later submits it instantly.
   *
   * A fixed pause is still only a best guess at how long that takes — seen
   * live to sometimes not be enough on its own — which is what
   * {@link submitAndVerify} is for: it confirms the Enter actually did
   * something instead of trusting this delay was long enough.
   */
  postPasteDelayMs?: number;
  /** How many more times to resend Enter if the pane never changes. */
  maxSubmitRetries?: number;
  /** Gap between each check of whether the pane changed. */
  submitRetryIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_INTERVAL_MS = 400;
const DEFAULT_STABLE_CHECKS = 2;
export const DEFAULT_POST_PASTE_DELAY_MS = 600;
// Generous on purpose, and had to be raised three times: a single fixed delay
// wasn't enough (first fix), neither was 10 retries over 15s, and neither was
// 55 retries over 110s — all three caught live with a real repo, where a slow
// SessionStart hook chain left the pane frozen and unresponsive to Enter for
// upward of two minutes (131s observed once), with a hand-sent Enter working
// instantly the moment it settled. There is no bound on how slow a hook chain
// can be, so this is not "the right number" so much as a large-but-finite
// ceiling — delivery this whole window only costs wall-clock time on a
// session that is starting up anyway, never a running one, and
// `redeliverInitialPrompt` (session-manager.ts) is the manual escape hatch
// for whatever this ceiling still doesn't cover.
const DEFAULT_MAX_SUBMIT_RETRIES = 85;
const DEFAULT_SUBMIT_RETRY_INTERVAL_MS = 2500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls a pane's rendered content until it stops changing between captures.
 *
 * A prompt typed the instant a pane is spawned races the agent CLI's own
 * startup — which runs arbitrary, sometimes slow, SessionStart hooks — and can
 * land before the CLI is ready to receive it. Waiting for the screen to settle
 * is a best-effort proxy for "the CLI is sitting at its input prompt", not a
 * guarantee, so this gives up after `timeoutMs` and lets the caller proceed
 * anyway rather than blocking a card's session forever.
 */
export async function waitForStablePane(
  capture: () => Promise<string>,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    stableChecks = DEFAULT_STABLE_CHECKS,
  }: PaneIdleWaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const current = await capture();
    if (previous !== null && current === previous) {
      stableCount += 1;
      if (stableCount >= stableChecks) {
        return;
      }
    } else {
      stableCount = 0;
    }
    previous = current;
    await sleep(intervalMs);
  }
}

/**
 * Sends Enter, then confirms the pane actually changed — the sole proof an
 * Enter that races a paste's own processing isn't available (there is no
 * "submitted" signal to poll for, only "something happened"). Resends Enter,
 * never the paste, on each retry: the text is already sitting there, it is
 * only the submit that needs another attempt.
 *
 * Not foolproof — a screen that changes for an unrelated reason (a spinner
 * tick, a hook finishing) reads the same as a real submit — but it is
 * strictly better than the fixed delay alone, which is what shipped first and
 * was seen live to sometimes not be enough.
 */
export async function submitAndVerify(
  capture: () => Promise<string>,
  sendEnter: () => Promise<void>,
  {
    maxSubmitRetries = DEFAULT_MAX_SUBMIT_RETRIES,
    submitRetryIntervalMs = DEFAULT_SUBMIT_RETRY_INTERVAL_MS,
  }: PaneIdleWaitOptions = {},
): Promise<void> {
  const baseline = await capture();
  await sendEnter();

  for (let attempt = 0; attempt < maxSubmitRetries; attempt += 1) {
    await sleep(submitRetryIntervalMs);
    const current = await capture();
    if (current !== baseline) {
      return;
    }
    await sendEnter();
  }
}
