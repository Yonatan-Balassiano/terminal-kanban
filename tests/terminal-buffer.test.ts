import { describe, expect, it } from 'vitest';
import { TerminalBufferService } from '../src/services/terminal-buffer.js';

async function flushTerminalWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('TerminalBufferService', () => {
  it('uses the live resized geometry for wrapped output', async () => {
    const buffers = new TerminalBufferService();
    const taskId = 'task-1';

    buffers.resize(taskId, 10, 5);
    buffers.write(taskId, '12345678901');
    await flushTerminalWrites();

    const snapshot = buffers.getBuffer(taskId);
    expect(snapshot.lines[0]).toBe('1234567890');
    expect(snapshot.lines[1]).toBe('1 ');
  });
});
