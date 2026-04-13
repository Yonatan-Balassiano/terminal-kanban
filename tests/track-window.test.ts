import { describe, expect, it } from 'vitest';
import { getVisibleWindow } from '../src/ui/track-window.js';

describe('getVisibleWindow', () => {
  it('shows the top of the list when everything fits from the start', () => {
    expect(getVisibleWindow([3, 3, 3], 0, 6)).toEqual({ start: 0, end: 2 });
  });

  it('keeps the selected item visible when it falls below the initial window', () => {
    expect(getVisibleWindow([3, 3, 3], 2, 6)).toEqual({ start: 1, end: 3 });
  });

  it('still returns the selected item when a single item is taller than the viewport', () => {
    expect(getVisibleWindow([5, 2, 2], 2, 4)).toEqual({ start: 1, end: 3 });
  });
});
