import { describe, expect, it } from 'vitest';
import { countActiveFilters, getSessionBadgeModel } from '../src/ui/chrome.js';

describe('ui chrome helpers', () => {
  it('counts active filters across filter categories', () => {
    expect(
      countActiveFilters({
        repoIds: ['repo-1'],
        pillarIds: ['pillar-1', 'pillar-2'],
        searchText: 'shell',
        includeArchived: true,
      }),
    ).toBe(5);
  });

  it('marks busy sessions with a spinning warning badge model', () => {
    expect(
      getSessionBadgeModel(
        {
          taskId: 'task-1',
          sessionId: 'session-1',
          sessionStatus: 'active',
          isBusy: true,
          label: 'Claude',
          updatedAt: 1,
        },
        { hasSession: true, isActiveSession: false },
      ),
    ).toEqual({
      isSpinning: true,
      label: 'Claude',
      tone: 'warning',
    });
  });

  it('marks active idle sessions as live', () => {
    expect(
      getSessionBadgeModel(undefined, {
        hasSession: true,
        isActiveSession: true,
      }),
    ).toEqual({
      isSpinning: false,
      label: 'live',
      tone: 'accent',
    });
  });
});
