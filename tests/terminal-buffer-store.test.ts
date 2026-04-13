import { describe, expect, it, vi } from 'vitest';
import {
  TerminalBufferStore,
  initialTerminalBufferState,
} from '../src/store/terminal-buffer.js';

describe('TerminalBufferStore', () => {
  it('does not notify listeners when the snapshot content is unchanged', () => {
    const store = new TerminalBufferStore(initialTerminalBufferState);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setSnapshot({
      lines: [],
      ansiLines: [],
      cursorX: 0,
      cursorY: 0,
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
