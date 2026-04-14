import { describe, expect, it } from 'vitest';
import {
  compactTaskBranchLabel,
  getTaskCardHeight,
  getTaskCardTitleLines,
} from '../src/ui/TaskCard.js';

describe('task card layout helpers', () => {
  it('wraps long titles across two lines before truncating', () => {
    expect(
      getTaskCardTitleLines('Things that we needed to discuss before shipping the repo'),
    ).toEqual(['Things that we needed to', 'discuss before shipping the…']);
  });

  it('compacts title-derived branch names after a few words', () => {
    expect(compactTaskBranchLabel('ab/things-that-we-needed-to-discuss-7241')).toBe(
      'ab/things-that-we…-7241',
    );
  });

  it('adds height for wrapped titles and description previews', () => {
    expect(
      getTaskCardHeight(
        {
          id: 'task-1',
          repoId: 'repo-1',
          trackId: 'backlog',
          title: 'Things that we needed to discuss before shipping the repo',
          description: 'Align the title and description treatment in the card.',
          sortKey: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        false,
      ),
    ).toBe(11);
  });
});
