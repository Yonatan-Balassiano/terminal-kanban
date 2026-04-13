import { describe, expect, it } from 'vitest';
import { buildNewSessionBootstrapCommand } from '../src/services/session-bootstrap.js';

describe('buildNewSessionBootstrapCommand', () => {
  it('checks out the base branch, pulls, switches to the task branch, clears, then launches claude', () => {
    expect(buildNewSessionBootstrapCommand('/repo', 'ab/task-1234')).toBe(
      'git -C "/repo" checkout "main" && ' +
        'git -C "/repo" pull && ' +
        '(git -C "/repo" checkout "ab/task-1234" 2>/dev/null || ' +
        'git -C "/repo" checkout -b "ab/task-1234") && ' +
        'clear && ' +
        'claude',
    );
  });
});
