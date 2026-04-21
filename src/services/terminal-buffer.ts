import headlessPkg from '@xterm/headless';
const { Terminal } = headlessPkg;
type TerminalInstance = InstanceType<typeof Terminal>;

import type { GetBufferResult, SessionSlot } from '../types/index.js';
import { extractTerminalBufferSnapshot } from './terminal-render.js';

const TERMINAL_SCROLLBACK_LINES = 2000;
const TERMINAL_EMIT_INTERVAL_MS = 40;

export class TerminalBufferService {
  private terminals = new Map<string, TerminalInstance>();
  private listeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<
    (taskId: string, slot: SessionSlot, buffer: GetBufferResult) => void
  >();
  private snapshots = new Map<string, GetBufferResult>();
  private dirtyTasks = new Set<string>();
  private emitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private key(taskId: string, slot: SessionSlot): string {
    return `${taskId}:${slot}`;
  }

  getOrCreate(taskId: string, slot: SessionSlot = 'primary', cols = 220, rows = 50): TerminalInstance {
    const key = this.key(taskId, slot);
    let terminal = this.terminals.get(key);
    if (!terminal) {
      terminal = new Terminal({
        cols,
        rows,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        allowProposedApi: true,
      });
      this.terminals.set(key, terminal);
    }
    return terminal;
  }

  write(taskId: string, slotOrData: SessionSlot | string = 'primary', maybeData?: string): void {
    const slot = maybeData === undefined ? 'primary' : (slotOrData as SessionSlot);
    const data = maybeData === undefined ? (slotOrData as string) : maybeData;
    const terminal = this.getOrCreate(taskId, slot);
    terminal.write(data, () => {
      this.markDirty(taskId, slot);
      this.scheduleEmit(taskId, slot);
    });
  }

  resize(
    taskId: string,
    slotOrCols: SessionSlot | number = 'primary',
    colsOrRows?: number,
    maybeRows?: number,
  ): void {
    const slot = typeof slotOrCols === 'number' ? 'primary' : slotOrCols;
    const cols = typeof slotOrCols === 'number' ? slotOrCols : (colsOrRows ?? 220);
    const rows = typeof slotOrCols === 'number' ? (colsOrRows ?? 50) : (maybeRows ?? 50);
    const terminal = this.getOrCreate(taskId, slot, cols, rows);
    terminal.resize(Math.max(1, cols), Math.max(1, rows));
    this.markDirty(taskId, slot);
    this.scheduleEmit(taskId, slot);
  }

  has(taskId: string, slot: SessionSlot = 'primary'): boolean {
    return this.terminals.has(this.key(taskId, slot));
  }

  private markDirty(taskId: string, slot: SessionSlot): void {
    this.dirtyTasks.add(this.key(taskId, slot));
  }

  private scheduleEmit(taskId: string, slot: SessionSlot): void {
    const key = this.key(taskId, slot);
    if (this.emitTimers.has(key)) {
      return;
    }

    const timer = setTimeout(() => {
      this.emitTimers.delete(key);
      const buffer = this.getBuffer(taskId, slot);
      const cbs = this.listeners.get(key);
      cbs?.forEach((cb) => cb());
      this.globalListeners.forEach((listener) => listener(taskId, slot, buffer));
    }, TERMINAL_EMIT_INTERVAL_MS);
    timer.unref?.();
    this.emitTimers.set(key, timer);
  }

  getBuffer(taskId: string, slot: SessionSlot = 'primary'): GetBufferResult {
    const key = this.key(taskId, slot);
    const cached = this.snapshots.get(key);
    if (cached && !this.dirtyTasks.has(key)) {
      return cached;
    }

    const terminal = this.getOrCreate(taskId, slot);
    const buffer = extractTerminalBufferSnapshot(
      terminal.buffer.active,
      terminal.buffer.active.cursorX,
      terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    );
    this.snapshots.set(key, buffer);
    this.dirtyTasks.delete(key);
    return buffer;
  }

  subscribe(taskId: string, slot: SessionSlot = 'primary', cb: () => void): () => void {
    const key = this.key(taskId, slot);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  subscribeAll(cb: (taskId: string, slot: SessionSlot, buffer: GetBufferResult) => void): () => void {
    this.globalListeners.add(cb);
    return () => {
      this.globalListeners.delete(cb);
    };
  }

  destroy(taskId: string, slot: SessionSlot = 'primary'): void {
    const key = this.key(taskId, slot);
    const terminal = this.terminals.get(key);
    if (terminal) {
      try {
        terminal.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.terminals.delete(key);
    }
    const timer = this.emitTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.emitTimers.delete(key);
    }
    this.snapshots.delete(key);
    this.dirtyTasks.delete(key);
    this.listeners.delete(key);
  }
}
