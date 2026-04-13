import React, { useSyncExternalStore } from 'react';
import type { GetBufferResult } from '../types/index.js';

export const initialTerminalBufferState: GetBufferResult = {
  lines: [],
  ansiLines: [],
  cursorX: 0,
  cursorY: 0,
};

function snapshotsEqual(left: GetBufferResult, right: GetBufferResult): boolean {
  if (
    left.cursorX !== right.cursorX ||
    left.cursorY !== right.cursorY ||
    left.lines.length !== right.lines.length ||
    left.ansiLines.length !== right.ansiLines.length
  ) {
    return false;
  }

  for (let index = 0; index < left.lines.length; index += 1) {
    if (left.lines[index] !== right.lines[index]) {
      return false;
    }
  }

  for (let index = 0; index < left.ansiLines.length; index += 1) {
    if (left.ansiLines[index] !== right.ansiLines[index]) {
      return false;
    }
  }

  return true;
}

export class TerminalBufferStore {
  private snapshot: GetBufferResult;
  private listeners = new Set<() => void>();

  constructor(initial = initialTerminalBufferState) {
    this.snapshot = initial;
  }

  getSnapshot = (): GetBufferResult => this.snapshot;

  setSnapshot(next: GetBufferResult): void {
    if (snapshotsEqual(this.snapshot, next)) {
      return;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function createTerminalBufferStore(): TerminalBufferStore {
  return new TerminalBufferStore();
}

export const TerminalBufferContext = React.createContext<TerminalBufferStore>(
  createTerminalBufferStore(),
);

export function useTerminalBuffer(): GetBufferResult {
  const store = React.useContext(TerminalBufferContext);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
