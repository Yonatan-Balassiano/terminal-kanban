// ============================================================
// AgentBoard — one delivery per pane at a time
// ============================================================

/**
 * Serializes brief deliveries so that two of them can never paste into the
 * same pane at once.
 *
 * This exists because of a real, repeated failure. `redeliverInitialPrompt`
 * and `notifyTaskSession` drive a pipeline whose designed worst case is
 * minutes long (see `pane-idle.ts`'s `deliveryBudgetMs`), while their RPC
 * client used to give up after ten seconds. The command looked like it had
 * failed, so it got run again — every ten seconds, while the first one was
 * still patiently working — and each run pasted the brief afresh. One pane was
 * left holding 20 stacked fragments, none of them submitted.
 *
 * Fixing the timeout removes the reason to re-run, but not the ability to:
 * a `--start`ed card's automatic delivery is already running in the background
 * when a user, seeing `DELIVERY: UNSUBMITTED` in `agentboard fleet`, reaches
 * for `redeliver-prompt`. Both paths funnel through the backends'
 * `deliverInitialPrompt`, so guarding there covers automatic and manual
 * deliveries alike.
 *
 * Instance state, not module state: one backend instance per daemon owns one
 * tmux server, and tests get a fresh guard with a fresh backend.
 */
export class DeliveryGuard {
  private readonly inFlight = new Map<string, { text: string; promise: Promise<boolean> }>();

  /**
   * Runs `deliver` for `key` (a pane), unless one is already running there.
   *
   * A concurrent request to deliver the *same* text joins the delivery already
   * in flight and resolves with its result — the duplicate is a genuine no-op,
   * which is the whole point: no second paste, and the caller still gets a
   * real answer rather than an error it would only retry.
   *
   * A concurrent request to deliver *different* text throws instead. Stacking
   * a second, unrelated message into a pane mid-paste produces exactly the
   * mangled input this guard exists to prevent, and silently dropping it would
   * be worse than saying so — the caller can wait and send it afterwards.
   */
  run(key: string, text: string, deliver: () => Promise<boolean>): Promise<boolean> {
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.text === text) {
        return existing.promise;
      }
      return Promise.reject(
        new Error(
          `A prompt delivery is already in progress for this session. It can take several minutes on a slow pane — watch it with \`agentboard fleet\`, then send this message once it finishes.`,
        ),
      );
    }

    const promise = (async () => deliver())().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, { text, promise });
    return promise;
  }

  /** Whether a delivery is currently running for `key`. Exposed for tests. */
  isDelivering(key: string): boolean {
    return this.inFlight.has(key);
  }
}
