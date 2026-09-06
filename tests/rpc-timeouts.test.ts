import { describe, expect, it } from 'vitest';
import { rpcTimeoutMs } from '../src/cli/rpc.js';
import {
  DEFAULT_DELIVERY_BUDGET_MS,
  DEFAULT_MAX_PASTE_ATTEMPTS,
  DEFAULT_MAX_SUBMIT_RETRIES,
  DEFAULT_PASTE_VERIFY_TIMEOUT_MS,
  DEFAULT_SUBMIT_RETRY_INTERVAL_MS,
  deliveryBudgetMs,
} from '../src/services/session-backends/pane-idle.js';

/**
 * These two methods drive a pane delivery whose designed worst case is minutes
 * long. They used to fall through to the client's 10-second default, so the
 * CLI abandoned an operation the daemon was still correctly performing — and
 * because that reads as a failure, it got re-run, stacking a second paste into
 * the same pane. The relationship below is what makes that unrepeatable.
 */
describe('delivery RPC timeouts vs the pane retry budget', () => {
  const deliveryMethods = ['redeliverInitialPrompt', 'notifyTaskSession'] as const;

  it.each(deliveryMethods)('gives %s at least the full delivery budget', (method) => {
    expect(rpcTimeoutMs(method)).toBeGreaterThanOrEqual(DEFAULT_DELIVERY_BUDGET_MS);
  });

  it.each(deliveryMethods)('does not leave %s on the 10s default', (method) => {
    expect(rpcTimeoutMs(method)).toBeGreaterThan(rpcTimeoutMs('getBoard'));
  });

  it('counts every Enter retry and every paste attempt in the budget', () => {
    // The two terms that actually dominate: ~212s of Enter retries and the
    // per-attempt paste verification window around them.
    expect(DEFAULT_DELIVERY_BUDGET_MS).toBeGreaterThanOrEqual(
      DEFAULT_MAX_SUBMIT_RETRIES * DEFAULT_SUBMIT_RETRY_INTERVAL_MS +
        DEFAULT_MAX_PASTE_ATTEMPTS * DEFAULT_PASTE_VERIFY_TIMEOUT_MS,
    );
  });

  it('grows with the retry budget, so raising MAX_SUBMIT_RETRIES cannot silently outrun the timeout', () => {
    // The guard the original bug needed: if this budget is ever pinned to a
    // literal instead of being derived, doubling the retries stops moving it
    // and this fails.
    const doubled = deliveryBudgetMs({ maxSubmitRetries: DEFAULT_MAX_SUBMIT_RETRIES * 2 });

    expect(doubled - DEFAULT_DELIVERY_BUDGET_MS).toBe(
      DEFAULT_MAX_SUBMIT_RETRIES * DEFAULT_SUBMIT_RETRY_INTERVAL_MS,
    );
  });
});
