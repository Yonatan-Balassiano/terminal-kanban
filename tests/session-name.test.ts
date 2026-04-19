import { describe, expect, it } from 'vitest';
import { buildBackendSessionName } from '../src/services/session-name.js';

describe('buildBackendSessionName', () => {
  it('uses a title-based slug with a short task suffix', () => {
    expect(buildBackendSessionName('Friday thing', '2e3019f5')).toBe(
      'ab_friday_thing_2e30_p',
    );
  });

  it('falls back to a generic task label when the title has no slug characters', () => {
    expect(buildBackendSessionName('!!!', '2e3019f5')).toBe('ab_task_2e30_p');
  });

  it('uses a distinct suffix for secondary sessions', () => {
    expect(buildBackendSessionName('Friday thing', '2e3019f5', 'secondary')).toBe(
      'ab_friday_thing_2e30_s',
    );
  });
});
