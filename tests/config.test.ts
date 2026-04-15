import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config/index.js';

describe('defaultConfig', () => {
  it('syncs GitHub every 60 seconds by default', () => {
    expect(defaultConfig().pollIntervalMs).toBe(60000);
  });

  it('uses backlog, in-progress, pr, and done as the default board tracks', () => {
    expect(defaultConfig().tracks).toEqual([
      { id: 'backlog', label: 'Backlog', sortOrder: 0 },
      { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
      { id: 'pr', label: 'PR', sortOrder: 2 },
      { id: 'done', label: 'Done', sortOrder: 3 },
    ]);
  });
});
