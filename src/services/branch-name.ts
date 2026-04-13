import { randomInt } from 'crypto';

const BRANCH_PREFIX = 'ab';
const RANDOM_SUFFIX_WIDTH = 4;
const MAX_SLUG_LENGTH = 48;

function randomBranchSuffix(): string {
  return randomInt(0, 10_000).toString().padStart(RANDOM_SUFFIX_WIDTH, '0');
}

function extractBranchSuffix(branchName?: string): string | undefined {
  return branchName?.match(/(\d{4})$/)?.[1];
}

export function normalizeTaskBranchSlug(taskTitle: string): string {
  const slug = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);

  return slug.length > 0 ? slug : 'task';
}

export function createTaskBranchName(taskTitle: string, suffix = randomBranchSuffix()): string {
  return `${BRANCH_PREFIX}/${normalizeTaskBranchSlug(taskTitle)}-${suffix}`;
}

export function renameTaskBranchName(taskTitle: string, existingBranch?: string): string {
  return createTaskBranchName(taskTitle, extractBranchSuffix(existingBranch) ?? randomBranchSuffix());
}

export function isLegacyTaskBranchName(taskId: string, branchName?: string): boolean {
  return branchName === `${BRANCH_PREFIX}/${taskId}`;
}

export function resolveTaskBranchName(
  taskTitle: string,
  taskId: string,
  existingBranch?: string,
): string {
  if (existingBranch && !isLegacyTaskBranchName(taskId, existingBranch)) {
    return existingBranch;
  }

  return createTaskBranchName(taskTitle);
}
