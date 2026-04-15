import { describe, expect, it } from 'vitest';
import {
  deriveCheckSummary,
  deriveReviewState,
} from '../src/services/github.js';

describe('deriveCheckSummary', () => {
  it('treats all passing checks as passed with a complete counter', () => {
    expect(
      deriveCheckSummary([
        { bucket: 'pass', name: 'unit' },
        { bucket: 'pass', name: 'lint' },
      ]),
    ).toEqual({
      ciState: 'passed',
      ciSummary: 'checks 2/2',
      failingCheckName: undefined,
      ciRequiredTotal: 2,
      ciRequiredPassed: 2,
      ciRequiredFailed: 0,
      ciRequiredPending: 0,
    });
  });

  it('treats mixed pass and pending checks as pending', () => {
    expect(
      deriveCheckSummary([
        { bucket: 'pass', name: 'unit' },
        { bucket: 'pending', name: 'e2e' },
      ]),
    ).toEqual({
      ciState: 'pending',
      ciSummary: 'checks 1/2',
      failingCheckName: undefined,
      ciRequiredTotal: 2,
      ciRequiredPassed: 1,
      ciRequiredFailed: 0,
      ciRequiredPending: 1,
    });
  });

  it('treats failed checks as failed and surfaces the failing check name', () => {
    expect(
      deriveCheckSummary([
        { bucket: 'pass', name: 'unit' },
        { bucket: 'fail', name: 'e2e' },
      ]),
    ).toEqual({
      ciState: 'failed',
      ciSummary: 'e2e fail',
      failingCheckName: 'e2e',
      ciRequiredTotal: 2,
      ciRequiredPassed: 1,
      ciRequiredFailed: 1,
      ciRequiredPending: 0,
    });
  });

  it('ignores skipped checks in the x/X counter', () => {
    expect(
      deriveCheckSummary([
        { bucket: 'pass', name: 'unit' },
        { bucket: 'skipping', name: 'docs' },
      ]),
    ).toEqual({
      ciState: 'passed',
      ciSummary: 'checks 1/1',
      failingCheckName: undefined,
      ciRequiredTotal: 1,
      ciRequiredPassed: 1,
      ciRequiredFailed: 0,
      ciRequiredPending: 0,
    });
  });
});

describe('deriveReviewState', () => {
  it('treats one approval plus commented reviews as approved', () => {
    expect(
      deriveReviewState([
        { state: 'COMMENTED', author: { login: 'bot' } },
        { state: 'APPROVED', author: { login: 'yonatan' } },
      ]),
    ).toEqual({
      reviewState: 'approved',
      reviewSummary: 'approved by 1',
    });
  });

  it('treats the latest review per reviewer as authoritative', () => {
    expect(
      deriveReviewState([
        { state: 'APPROVED', author: { login: 'yonatan' } },
        { state: 'CHANGES_REQUESTED', author: { login: 'yonatan' } },
      ]),
    ).toEqual({
      reviewState: 'changes_requested',
      reviewSummary: 'changes requested',
    });
  });
});
