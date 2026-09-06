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
  /** How long to wait for the agent CLI to become the pane's foreground process. */
  foregroundCommandTimeoutMs?: number;
  /** How often to re-check the pane's foreground process while waiting. */
  foregroundCommandIntervalMs?: number;
  /** How long to wait, per attempt, for a pasted brief's own start to render. */
  pasteVerifyTimeoutMs?: number;
  /** How often to re-check the pane while waiting for a paste to render. */
  pasteVerifyIntervalMs?: number;
  /** How many times to (re-)paste before giving up on this delivery. */
  maxPasteAttempts?: number;
}

export const DEFAULT_TIMEOUT_MS = 12_000;
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
export const DEFAULT_MAX_SUBMIT_RETRIES = 85;
export const DEFAULT_SUBMIT_RETRY_INTERVAL_MS = 2500;
// The bootstrap script's own pre-launch work (checking out the base branch,
// pulling, and so on) runs entirely before the agent CLI is even the pane's
// foreground process, and can go silent for several seconds at a time on a
// slow fetch — long enough for `waitForStablePane`'s "screen stopped
// changing" heuristic to false-positive on "ready", landing the paste in a
// plain shell instead of the CLI's own input box. That shell has no bracketed
// paste request of its own, so the brief's embedded blank lines get read back
// as separate Enters, submitting only the first line — a boilerplate subtask
// notice, say — while the rest is left as stray, unsubmitted text.
export const DEFAULT_FOREGROUND_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_FOREGROUND_COMMAND_INTERVAL_MS = 500;
// Confirmed live on a several-KB multi-paragraph brief: the pane ended up
// with only the final paragraph as its first submitted message, its blank
// lines rendered back as literal `\r` bytes rather than newlines within the
// input box. Something between tmux's `paste-buffer` and the CLI's own input
// handling can mangle a large burst — bracketed-paste negotiation is itself
// a race no less real than the one `waitForForegroundCommand` guards against,
// just one layer deeper (the process is already `claude`; its input handling
// may not have finished initializing yet). Whatever the exact mechanism,
// checking the pane actually shows the brief's own opening before trusting a
// paste catches it regardless.
export const DEFAULT_PASTE_VERIFY_TIMEOUT_MS = 2_000;
const DEFAULT_PASTE_VERIFY_INTERVAL_MS = 200;
export const DEFAULT_MAX_PASTE_ATTEMPTS = 3;
const PASTE_MARKER_LENGTH = 24;

/**
 * The wall-clock ceiling one full brief delivery can occupy, derived from the
 * same retry budgets the delivery pipeline actually spends — not guessed.
 *
 * Every RPC caller that waits on a delivery (`redeliverInitialPrompt`,
 * `notifyTaskSession` — see `src/cli/rpc.ts`) has to allow at least this long
 * before calling the daemon dead. Getting that wrong is not cosmetic: a client
 * that gives up early looks like a failure, the natural response is to run the
 * command again, and a second run starts a *second* paste into the same pane.
 * That is how one pane ended up holding 20 stacked, unsubmitted fragments.
 *
 * Derived rather than written down so that raising, say,
 * {@link DEFAULT_MAX_SUBMIT_RETRIES} moves every caller's timeout with it
 * instead of silently re-introducing that bug. Summed over the pipeline in
 * `deliverInitialPrompt`'s own order:
 *   - {@link waitForStablePane}, twice (once more after the trust prompt)
 *   - {@link waitForForegroundCommand}
 *   - {@link pasteAndVerify}: every attempt's verify window plus its post-paste pause
 *   - {@link submitAndVerify}: every Enter retry
 */
export function deliveryBudgetMs(options: PaneIdleWaitOptions = {}): number {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    postPasteDelayMs = DEFAULT_POST_PASTE_DELAY_MS,
    maxSubmitRetries = DEFAULT_MAX_SUBMIT_RETRIES,
    submitRetryIntervalMs = DEFAULT_SUBMIT_RETRY_INTERVAL_MS,
    foregroundCommandTimeoutMs = DEFAULT_FOREGROUND_COMMAND_TIMEOUT_MS,
    pasteVerifyTimeoutMs = DEFAULT_PASTE_VERIFY_TIMEOUT_MS,
    maxPasteAttempts = DEFAULT_MAX_PASTE_ATTEMPTS,
  } = options;

  return (
    timeoutMs * 2 +
    foregroundCommandTimeoutMs +
    maxPasteAttempts * (pasteVerifyTimeoutMs + postPasteDelayMs) +
    maxSubmitRetries * submitRetryIntervalMs
  );
}

/** {@link deliveryBudgetMs} with the shipped defaults — currently ~274s. */
export const DEFAULT_DELIVERY_BUDGET_MS = deliveryBudgetMs();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Text unique to Claude Code's first-run "do you trust this folder" prompt.
 * Confirmed live against a real, never-trusted directory.
 */
const TRUST_PROMPT_MARKER = 'Yes, I trust this folder';

export function looksLikeTrustPrompt(paneText: string): boolean {
  return paneText.includes(TRUST_PROMPT_MARKER);
}

/**
 * Auto-accepts Claude Code's own trust prompt, when it's on screen.
 *
 * AgentBoard created this worktree itself, under a repo the user explicitly
 * registered — that trust is implicit. Without this, a `--start`ed session
 * with nobody watching hangs here forever: confirmed live, the prompt's
 * default-highlighted option is "No, exit", not "Yes" — a bare Enter (which
 * is all the rest of the delivery pipeline ever sends) quits the CLI instead
 * of accepting, and `submitAndVerify`'s "did the pane change" check misreads
 * that quit as a successful brief submission.
 *
 * A no-op — returns false, sends nothing — when the prompt is not showing.
 */
export async function autoTrustIfPrompted(
  capture: () => Promise<string>,
  sendDown: () => Promise<void>,
  sendEnter: () => Promise<void>,
): Promise<boolean> {
  const current = await capture();
  if (!looksLikeTrustPrompt(current)) {
    return false;
  }
  await sendDown();
  await sendEnter();
  return true;
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
 * Waits for the pane's foreground process to become the agent CLI itself,
 * rather than the bootstrap script (or whatever it's currently shelling out
 * to — `git`, `corepack`, ...) that runs ahead of it.
 *
 * `waitForStablePane` alone cannot tell those apart: a silent `git pull` looks
 * exactly as "settled" as a CLI sitting at its input prompt. Pasting into the
 * former lands the brief in a plain shell instead of the chat box — see
 * {@link DEFAULT_FOREGROUND_COMMAND_TIMEOUT_MS}.
 *
 * Matched by prefix, not exact equality: confirmed live, `codex`'s installed
 * binary is invoked via a symlink to `codex-aarch64-apple-darwin`, and the
 * kernel's own process-name field truncates that to `codex-aarch64-a` —
 * never equal to the plain `codex` `agentCli` value, which silently defeated
 * this gate for every codex session before this fix (`claude`'s own binary
 * is short enough to never truncate, so its exact-match happened to work by
 * coincidence). A prefix match covers both without needing to special-case
 * either CLI's actual binary name.
 *
 * Best-effort like the rest of this module: gives up and lets the caller
 * proceed after the timeout rather than blocking forever if the process name
 * never matches (a mismatch here is a reason to try anyway, not to hang).
 */
export async function waitForForegroundCommand(
  getCurrentCommand: () => Promise<string | undefined>,
  expectedCommand: string,
  {
    foregroundCommandTimeoutMs = DEFAULT_FOREGROUND_COMMAND_TIMEOUT_MS,
    foregroundCommandIntervalMs = DEFAULT_FOREGROUND_COMMAND_INTERVAL_MS,
  }: PaneIdleWaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + foregroundCommandTimeoutMs;
  while (Date.now() < deadline) {
    const current = await getCurrentCommand();
    if (current?.startsWith(expectedCommand)) {
      return;
    }
    await sleep(foregroundCommandIntervalMs);
  }
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A short, distinctive prefix of a brief, safe to search for in a captured
 * pane even after tmux's own line-wrapped rendering reshuffles whitespace.
 * Kept well under a typical terminal width so the marker itself can't
 * straddle a wrap boundary and split across two captured rows.
 */
export function pasteMarker(prompt: string): string {
  return normalizeForMatch(prompt).slice(0, PASTE_MARKER_LENGTH);
}

/**
 * Waits for a pasted brief's own opening to actually show up on the pane.
 *
 * A paste that "should have" landed is not proof it did — see
 * {@link DEFAULT_PASTE_VERIFY_TIMEOUT_MS}. An empty `marker` (nothing to
 * verify against) always succeeds immediately.
 */
export async function waitForPasteToLand(
  capture: () => Promise<string>,
  marker: string,
  {
    pasteVerifyTimeoutMs = DEFAULT_PASTE_VERIFY_TIMEOUT_MS,
    pasteVerifyIntervalMs = DEFAULT_PASTE_VERIFY_INTERVAL_MS,
  }: PaneIdleWaitOptions = {},
): Promise<boolean> {
  if (!marker) {
    return true;
  }
  const deadline = Date.now() + pasteVerifyTimeoutMs;
  while (Date.now() < deadline) {
    const current = normalizeForMatch(await capture());
    if (current.includes(marker)) {
      return true;
    }
    await sleep(pasteVerifyIntervalMs);
  }
  return false;
}

/**
 * What a delivery attempt did about getting its text onto the pane.
 *
 * `already-present` is not a failure — it is the duplicate-run case, and the
 * one outcome that must never paste again; see {@link pasteAndVerify}.
 */
export type PasteOutcome = 'pasted' | 'already-present' | 'unverified';

/**
 * Pastes a brief and confirms its own opening rendered before trusting it —
 * re-pasting (never typing, never guessing content is fine because a fixed
 * delay elapsed) up to `maxPasteAttempts` times.
 *
 * Pastes nothing at all when the pane *already* shows this exact brief's
 * opening: that means an earlier delivery of the same text is already sitting
 * there, and a second paste would stack a duplicate copy underneath the first
 * rather than replace it — the failure that made a timed-out
 * `redeliver-prompt` actively harmful to re-run (one pane was left holding 20
 * stacked fragments, none submitted). The caller submits either way, so a
 * repeat run still does the useful half of the job: it presses Enter on text
 * that was already there.
 *
 * The check is deliberately one-sided. A false positive — the marker matching
 * the same brief already *submitted* and still visible in the scrollback —
 * costs one stray Enter into an idle CLI, which does nothing. A false
 * negative costs exactly the stacked paste this exists to prevent.
 *
 * `unverified` means nothing on screen can be trusted; a caller must not
 * submit (send Enter) then, since submitting risks committing exactly the
 * mangled fragment this function exists to catch instead of a clean,
 * recoverable "still sitting there unsubmitted" state for
 * `redeliverInitialPrompt` to fix.
 */
export async function pasteAndVerify(
  paste: () => Promise<void>,
  capture: () => Promise<string>,
  marker: string,
  options: PaneIdleWaitOptions = {},
): Promise<PasteOutcome> {
  const { maxPasteAttempts = DEFAULT_MAX_PASTE_ATTEMPTS } = options;

  // An empty marker means there is nothing to recognise — every pane
  // "contains" it — so this shortcut has to stay out of the way there.
  if (marker && normalizeForMatch(await capture()).includes(marker)) {
    return 'already-present';
  }

  for (let attempt = 0; attempt < maxPasteAttempts; attempt += 1) {
    const before = await capture();
    await paste();
    if (await waitForPasteToLand(capture, marker, options)) {
      return 'pasted';
    }
    if ((await capture()) !== before) {
      // The pane changed but the brief's own opening is not on it: something
      // landed, in a shape this cannot recognise — the mangled paste
      // DEFAULT_PASTE_VERIFY_TIMEOUT_MS describes. Pasting again would stack a
      // second copy under that mess rather than replace it, so stop here and
      // report it unverified. Nothing is submitted either way, and an
      // unsubmitted pane is a state `redeliverInitialPrompt` can still fix; a
      // pane holding three overlapping copies is much harder to recover.
      //
      // A retry is still worth it when the pane did *not* change, which is the
      // case this loop was added for: a paste swallowed whole by
      // bracketed-paste negotiation leaves no trace, so re-pasting stacks
      // nothing.
      return 'unverified';
    }
  }
  return 'unverified';
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
