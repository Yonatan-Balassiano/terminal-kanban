import { describe, it, expect, vi } from 'vitest';
import { CommitOwnership, repoSlug } from '../src/services/commit-ownership.js';

const VMR = 'git@github.com:wix-private/wix-vmr-repo.git';
const MONO = 'git@github.com:wix-private/monorepo.git';

describe('repoSlug', () => {
  it('normalises every GitHub remote form to owner/repo', () => {
    expect(repoSlug(VMR)).toBe('wix-private/wix-vmr-repo');
    expect(repoSlug('https://github.com/wix-private/monorepo')).toBe('wix-private/monorepo');
    expect(repoSlug('https://github.com/wix-private/monorepo.git')).toBe('wix-private/monorepo');
  });

  it('rejects anything that is not a GitHub repo reference', () => {
    expect(repoSlug(undefined)).toBeNull();
    expect(repoSlug('')).toBeNull();
    expect(repoSlug('not a url')).toBeNull();
  });
});

describe('CommitOwnership.countMine', () => {
  it('counts releases built from the user’s commits', async () => {
    // Arrange
    const ownership = new CommitOwnership({
      login: 'me',
      listAuthoredShas: async () => ['aaa', 'bbb'],
    });

    // Act
    const mine = await ownership.countMine([
      { commitHash: 'aaa', repoUrl: VMR },
      { commitHash: 'zzz', repoUrl: VMR },
      { commitHash: 'bbb', repoUrl: VMR },
    ]);

    // Assert
    expect(mine).toBe(2);
  });

  it('returns a confident zero when none are the user’s', async () => {
    const ownership = new CommitOwnership({ login: 'me', listAuthoredShas: async () => ['aaa'] });

    // Zero is a real answer and must not be confused with "unknown".
    expect(await ownership.countMine([{ commitHash: 'zzz', repoUrl: VMR }])).toBe(0);
  });

  it('matches each release against its own repo, not the first one seen', async () => {
    // Arrange — an artifact's RCs can come from more than one repo, and the same
    // sha in a different repo is not the user's commit.
    const ownership = new CommitOwnership({
      login: 'me',
      listAuthoredShas: async (repo) => (repo === 'wix-private/monorepo' ? ['shared'] : []),
    });

    // Act
    const mine = await ownership.countMine([
      { commitHash: 'shared', repoUrl: MONO },
      { commitHash: 'shared', repoUrl: VMR },
    ]);

    // Assert
    expect(mine).toBe(1);
  });

  it('reports unknown rather than zero when the lookup fails', async () => {
    // Arrange — a confident zero would read as "nothing of mine is waiting",
    // which is exactly the wrong thing to tell someone deciding what to ship.
    const ownership = new CommitOwnership({
      login: 'me',
      listAuthoredShas: async () => {
        throw new Error('gh not installed');
      },
    });

    // Act + Assert
    expect(await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }])).toBeNull();
  });

  it('reports unknown when no release carries a usable repo', async () => {
    const ownership = new CommitOwnership({ login: 'me', listAuthoredShas: async () => ['aaa'] });

    expect(await ownership.countMine([{ commitHash: 'aaa' }])).toBeNull();
    expect(await ownership.countMine([])).toBeNull();
  });

  it('reads each repo once and shares it across artifacts', async () => {
    // Arrange — several artifacts build from the same repo; re-querying per
    // artifact would multiply the API calls for no new information.
    const listAuthoredShas = vi.fn(async () => ['aaa']);
    const ownership = new CommitOwnership({ login: 'me', listAuthoredShas });

    // Act
    await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }]);
    await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }]);

    // Assert
    expect(listAuthoredShas).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the cache window has passed', async () => {
    // Arrange
    let now = 1_000;
    const listAuthoredShas = vi.fn(async () => ['aaa']);
    const ownership = new CommitOwnership({ login: 'me', listAuthoredShas, now: () => now });

    // Act
    await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }]);
    now += 10 * 60_000;
    await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }]);

    // Assert
    expect(listAuthoredShas).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the previous answer when a later lookup fails', async () => {
    // Arrange — a transient gh failure should not flip a known answer to unknown.
    let now = 1_000;
    let fail = false;
    const ownership = new CommitOwnership({
      login: 'me',
      now: () => now,
      listAuthoredShas: async () => {
        if (fail) throw new Error('rate limited');
        return ['aaa'];
      },
    });
    await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }]);

    // Act
    fail = true;
    now += 10 * 60_000;
    const mine = await ownership.countMine([{ commitHash: 'aaa', repoUrl: VMR }]);

    // Assert
    expect(mine).toBe(1);
  });

  it('ignores releases with no commit hash', async () => {
    const ownership = new CommitOwnership({ login: 'me', listAuthoredShas: async () => ['aaa'] });

    expect(
      await ownership.countMine([{ repoUrl: VMR }, { commitHash: 'aaa', repoUrl: VMR }])
    ).toBe(1);
  });
});
