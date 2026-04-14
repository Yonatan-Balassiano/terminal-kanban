import { describe, expect, it } from 'vitest';
import { deriveCIState, deriveReviewState } from '../src/services/github.js';

describe('deriveCIState', () => {
  it('treats mixed successful check runs and status contexts as passed', () => {
    expect(
      deriveCIState([
        { conclusion: 'SUCCESS', status: 'COMPLETED' },
        { state: 'SUCCESS' },
      ]),
    ).toBe('passed');
  });

  it('treats pending state contexts as pending', () => {
    expect(deriveCIState([{ state: 'PENDING' }])).toBe('pending');
  });

  it('treats failed state contexts as failed', () => {
    expect(deriveCIState([{ state: 'FAILURE' }])).toBe('failed');
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
