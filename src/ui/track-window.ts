export interface VisibleWindow {
  start: number;
  end: number;
}

export function getVisibleWindow(
  itemHeights: number[],
  selectedIndex: number,
  availableHeight: number,
): VisibleWindow {
  if (itemHeights.length === 0) {
    return { start: 0, end: 0 };
  }

  const maxHeight = Math.max(1, availableHeight);
  const clampedIndex = Math.max(0, Math.min(selectedIndex, itemHeights.length - 1));

  let start = 0;
  let end = 0;
  let used = 0;

  while (end < itemHeights.length) {
    const nextHeight = itemHeights[end] ?? 1;
    if (end > start && used + nextHeight > maxHeight) {
      break;
    }

    used += nextHeight;
    end += 1;
  }

  while (clampedIndex >= end && end < itemHeights.length) {
    used += itemHeights[end] ?? 1;
    end += 1;

    while (start < end - 1 && used > maxHeight) {
      used -= itemHeights[start] ?? 1;
      start += 1;
    }
  }

  return { start, end };
}
