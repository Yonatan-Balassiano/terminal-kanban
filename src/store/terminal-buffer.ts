import React, { useSyncExternalStore } from 'react';
import type { GetBufferResult } from '../types/index.js';

export const initialTerminalBufferState: GetBufferResult = {
  lines: [],
  ansiLines: [],
  cursorX: 0,
  cursorY: 0,
};

function snapshotsLikelyEqual(left: GetBufferResult, right: GetBufferResult): boolean {
  if (
    left.cursorX !== right.cursorX ||
    left.cursorY !== right.cursorY ||
    left.lines.length !== right.lines.length ||
    left.ansiLines.length !== right.ansiLines.length
  ) {
    return false;
  }

  const lastLineIndex = left.lines.length - 1;
  const lastAnsiLineIndex = left.ansiLines.length - 1;

  return (
    (left.lines[0] ?? '') === (right.lines[0] ?? '') &&
    (left.lines[lastLineIndex] ?? '') === (right.lines[lastLineIndex] ?? '') &&
    (left.ansiLines[0] ?? '') === (right.ansiLines[0] ?? '') &&
    (left.ansiLines[lastAnsiLineIndex] ?? '') === (right.ansiLines[lastAnsiLineIndex] ?? '')
  );
}

export class TerminalBufferStore {
  private snapshot: GetBufferResult;
  private listeners = new Set<() => void>();

  constructor(initial = initialTerminalBufferState) {
    this.snapshot = initial;
  }

  getSnapshot = (): GetBufferResult => this.snapshot;

  setSnapshot(next: GetBufferResult): void {
    if (this.snapshot === next || snapshotsLikelyEqual(this.snapshot, next)) {
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
