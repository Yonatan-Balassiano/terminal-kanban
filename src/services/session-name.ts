import { normalizeTaskBranchSlug } from './branch-name.js';

function normalizeSessionSlug(taskTitle: string): string {
  return normalizeTaskBranchSlug(taskTitle).replace(/-/g, '_');
}

export function buildBackendSessionName(taskTitle: string, taskId: string): string {
  const slug = normalizeSessionSlug(taskTitle);
  const suffix = taskId.slice(0, 4).toLowerCase();
  const base = slug.length > 0 ? slug : 'task';
  return `ab_${base}_${suffix}`;
}
