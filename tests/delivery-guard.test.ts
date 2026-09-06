import { describe, expect, it } from 'vitest';
import { DeliveryGuard } from '../src/services/session-backends/delivery-guard.js';

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('DeliveryGuard', () => {
  it('runs a delivery when the pane is free', async () => {
    // Arrange
    const guard = new DeliveryGuard();

    // Act
    const delivered = await guard.run('pane-1', 'brief', async () => true);

    // Assert
    expect(delivered).toBe(true);
    expect(guard.isDelivering('pane-1')).toBe(false);
  });

  it('joins an identical delivery already in flight instead of pasting twice', async () => {
    // Arrange — the exact shape of the original damage: the same brief sent
    // again while the first send is still patiently retrying.
    const guard = new DeliveryGuard();
    const gate = deferred();
    let deliveries = 0;
    const deliver = () => {
      deliveries += 1;
      return gate.promise;
    };

    // Act
    const first = guard.run('pane-1', 'brief', deliver);
    const second = guard.run('pane-1', 'brief', deliver);
    gate.resolve(true);

    // Assert — one paste, and the duplicate caller still gets a real answer.
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(deliveries).toBe(1);
  });

  it('refuses a different message mid-delivery rather than stacking it into the pane', async () => {
    // Arrange
    const guard = new DeliveryGuard();
    const gate = deferred();
    let deliveries = 0;

    // Act
    const first = guard.run('pane-1', 'brief', () => {
      deliveries += 1;
      return gate.promise;
    });
    const second = guard.run('pane-1', 'a different message', async () => {
      deliveries += 1;
      return true;
    });

    // Assert
    await expect(second).rejects.toThrow('already in progress');
    gate.resolve(true);
    expect(await first).toBe(true);
    expect(deliveries).toBe(1);
  });

  it('leaves other panes alone', async () => {
    // Arrange
    const guard = new DeliveryGuard();
    const gate = deferred();

    // Act
    const first = guard.run('pane-1', 'brief', () => gate.promise);
    const other = await guard.run('pane-2', 'brief', async () => true);
    gate.resolve(true);

    // Assert
    expect(other).toBe(true);
    expect(await first).toBe(true);
  });

  it('frees the pane again after a delivery fails, so recovery is still possible', async () => {
    // Arrange
    const guard = new DeliveryGuard();

    // Act
    await expect(
      guard.run('pane-1', 'brief', async () => {
        throw new Error('tmux went away');
      }),
    ).rejects.toThrow('tmux went away');

    // Assert
    expect(guard.isDelivering('pane-1')).toBe(false);
    expect(await guard.run('pane-1', 'brief', async () => true)).toBe(true);
  });
});
