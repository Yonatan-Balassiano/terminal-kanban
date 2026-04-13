import { describe, expect, it } from 'vitest';
import { deriveCIState } from '../src/services/github.js';

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
