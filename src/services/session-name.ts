import type { SessionSlot } from '../types/index.js';
import { normalizeTaskBranchSlug } from './branch-name.js';

function normalizeSessionSlug(taskTitle: string): string {
  return normalizeTaskBranchSlug(taskTitle).replace(/-/g, '_');
}

export function buildBackendSessionName(
  taskTitle: string,
  taskId: string,
  slot: SessionSlot = 'primary',
): string {
  const slug = normalizeSessionSlug(taskTitle);
  const suffix = taskId.slice(0, 4).toLowerCase();
  const base = slug.length > 0 ? slug : 'task';
  const slotSuffix = slot === 'secondary' ? 's' : 'p';
  return `ab_${base}_${suffix}_${slotSuffix}`;
}
