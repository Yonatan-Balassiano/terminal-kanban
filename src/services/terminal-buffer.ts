import headlessPkg from '@xterm/headless';
const { Terminal } = headlessPkg;
type TerminalInstance = InstanceType<typeof Terminal>;

import type { GetBufferResult } from '../types/index.js';
import { extractTerminalBufferSnapshot } from './terminal-render.js';

const TERMINAL_SCROLLBACK_LINES = 2000;
const TERMINAL_EMIT_INTERVAL_MS = 8;

export class TerminalBufferService {
  private terminals = new Map<string, TerminalInstance>();
  private listeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<(taskId: string, buffer: GetBufferResult) => void>();
  private snapshots = new Map<string, GetBufferResult>();
  private dirtyTasks = new Set<string>();
  private emitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getOrCreate(taskId: string, cols = 220, rows = 50): TerminalInstance {
    let terminal = this.terminals.get(taskId);
    if (!terminal) {
      terminal = new Terminal({
        cols,
        rows,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        allowProposedApi: true,
      });
      this.terminals.set(taskId, terminal);
    }
    return terminal;
  }

  write(taskId: string, data: string): void {
    const terminal = this.getOrCreate(taskId);
    terminal.write(data, () => {
      this.markDirty(taskId);
      this.scheduleEmit(taskId);
    });
  }

  resize(taskId: string, cols: number, rows: number): void {
    const terminal = this.getOrCreate(taskId, cols, rows);
    terminal.resize(Math.max(1, cols), Math.max(1, rows));
    this.markDirty(taskId);
    this.scheduleEmit(taskId);
  }

  has(taskId: string): boolean {
    return this.terminals.has(taskId);
  }

  private markDirty(taskId: string): void {
    this.dirtyTasks.add(taskId);
  }

  private scheduleEmit(taskId: string): void {
    if (this.emitTimers.has(taskId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.emitTimers.delete(taskId);
      const buffer = this.getBuffer(taskId);
      const cbs = this.listeners.get(taskId);
      cbs?.forEach((cb) => cb());
      this.globalListeners.forEach((listener) => listener(taskId, buffer));
    }, TERMINAL_EMIT_INTERVAL_MS);
    timer.unref?.();
    this.emitTimers.set(taskId, timer);
  }

  getBuffer(taskId: string): GetBufferResult {
    const cached = this.snapshots.get(taskId);
    if (cached && !this.dirtyTasks.has(taskId)) {
      return cached;
    }

    const terminal = this.getOrCreate(taskId);
    const buffer = extractTerminalBufferSnapshot(
      terminal.buffer.active,
      terminal.buffer.active.cursorX,
      terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    );
    this.snapshots.set(taskId, buffer);
    this.dirtyTasks.delete(taskId);
    return buffer;
  }

  subscribe(taskId: string, cb: () => void): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  subscribeAll(cb: (taskId: string, buffer: GetBufferResult) => void): () => void {
    this.globalListeners.add(cb);
    return () => {
      this.globalListeners.delete(cb);
    };
  }

  destroy(taskId: string): void {
    const terminal = this.terminals.get(taskId);
    if (terminal) {
      try {
        terminal.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.terminals.delete(taskId);
    }
    const timer = this.emitTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.emitTimers.delete(taskId);
    }
    this.snapshots.delete(taskId);
    this.dirtyTasks.delete(taskId);
    this.listeners.delete(taskId);
  }
}
