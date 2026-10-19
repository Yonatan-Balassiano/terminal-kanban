import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardFromHash, cardHash, pushVisit, replaceVisit, visitFrom, type CardVisit } from '../web/src/history.js';

describe('card hash', () => {
  it('round-trips a card id', () => {
    expect(cardFromHash(cardHash('a1b2c3d4'))).toBe('a1b2c3d4');
    expect(cardHash(null)).toBe('');
  });

  it('ignores a hash that is not a card link', () => {
    expect(cardFromHash('')).toBeNull();
    expect(cardFromHash('#card/')).toBeNull();
    expect(cardFromHash('#something')).toBeNull();
  });
});

describe('visitFrom', () => {
  it('reads an entry this app wrote', () => {
    expect(visitFrom({ taskId: 'a', terminal: true }, '#card/b')).toEqual({ taskId: 'a', terminal: true });
  });

  it('treats a typed or pasted card link as a visit that never showed the terminal', () => {
    // Showing a session starts its agent; a link someone pasted must not.
    expect(visitFrom(null, '#card/b')).toEqual({ taskId: 'b', terminal: false });
  });
});

describe('pushVisit / replaceVisit', () => {
  let entries: Array<{ state: CardVisit; url: string }>;
  let index: number;

  beforeEach(() => {
    entries = [{ state: null as unknown as CardVisit, url: '/' }];
    index = 0;
    const fakeLocation = {
      pathname: '/',
      search: '',
      get hash() {
        const url = entries[index]!.url;
        return url.includes('#') ? url.slice(url.indexOf('#')) : '';
      },
    };
    vi.stubGlobal('location', fakeLocation);
    vi.stubGlobal('history', {
      get state() {
        return entries[index]!.state;
      },
      pushState(state: CardVisit, _: string, url: string) {
        entries = [...entries.slice(0, index + 1), { state, url }];
        index += 1;
      },
      replaceState(state: CardVisit, _: string, url: string) {
        entries[index] = { state, url };
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds one entry per card visited, with the card in the URL', () => {
    pushVisit({ taskId: 'a', terminal: true });
    pushVisit({ taskId: 'b', terminal: false });

    expect(entries.map((e) => e.url)).toEqual(['/', '/#card/a', '/#card/b']);
    expect(entries[1]?.state).toEqual({ taskId: 'a', terminal: true });
  });

  it('does not repeat an entry for the card already current, but records the terminal', () => {
    pushVisit({ taskId: 'a', terminal: false });
    pushVisit({ taskId: 'a', terminal: true });
    pushVisit({ taskId: 'a', terminal: false });

    expect(entries).toHaveLength(2);
    expect(entries[1]?.state).toEqual({ taskId: 'a', terminal: true });
  });

  it('moves the current entry without adding one', () => {
    pushVisit({ taskId: 'a', terminal: true });
    replaceVisit({ taskId: 'c', terminal: false });

    expect(entries.map((e) => e.url)).toEqual(['/', '/#card/c']);
  });
});
