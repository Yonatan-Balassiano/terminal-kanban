// ============================================================
// AgentBoard — configuration system
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type {
  AppConfig,
  RepoOverlayConfig,
  SessionBackendType,
} from '../types/index.js';

// ============================================================
// Zod schemas
// ============================================================

const SessionBackendTypeSchema = z.enum(['tmux', 'pty'] as const);
const ThemeModeSchema = z.enum(['truecolor', '256color', 'monochrome'] as const);
const WorktreeModeSchema = z.enum(['off', 'auto', 'always'] as const);
const PreferredIDESchema = z.enum(['system', 'webstorm', 'idea', 'cursor', 'vscode'] as const);

const FilterModelSchema = z.object({
  repoIds: z.array(z.string()).optional(),
  pillarIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  trackIds: z.array(z.string()).optional(),
  prState: z
    .array(z.enum(['none', 'draft', 'open', 'merged', 'closed'] as const))
    .optional(),
  ciState: z
    .array(z.enum(['none', 'pending', 'failed', 'passed'] as const))
    .optional(),
  sessionState: z
    .array(z.enum(['active', 'idle', 'orphaned', 'terminated'] as const))
    .optional(),
  searchText: z.string().optional(),
  includeArchived: z.boolean().optional(),
});

const TrackConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  sortOrder: z.number(),
});

const PillarConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
});

const RepoConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  githubUrl: z.string().optional(),
  defaultBaseBranch: z.string().optional(),
  defaultPillarId: z.string().optional(),
  preferredIde: PreferredIDESchema.optional(),
  ideCommand: z.string().optional(),
  worktreeMode: WorktreeModeSchema.optional(),
  worktreeRoot: z.string().optional(),
});

const SavedViewConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  filters: FilterModelSchema,
});

const AgentMacroSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

/**
 * Full AppConfig schema — used when reading from disk.
 * Fields are individually optional so partial configs on disk are tolerated;
 * missing values are filled in from defaults before the final object is
 * returned to callers.
 */
export const AppConfigSchema = z
  .object({
    sessionBackend: SessionBackendTypeSchema,
    pollIntervalMs: z.number().int().positive(),
    githubTokenEnvVar: z.string().optional(),
    tracks: z.array(TrackConfigSchema),
    pillars: z.array(PillarConfigSchema),
    repos: z.array(RepoConfigSchema),
    savedViews: z.array(SavedViewConfigSchema),
    agentMacros: z.array(AgentMacroSchema),
    theme: ThemeModeSchema.optional(),
    iconMode: z.enum(['unicode', 'ascii'] as const).optional(),
  })
  .strict();

/**
 * Partial variant used when reading a user-authored file — every key is
 * optional so we can merge with defaults for missing keys.
 */
export const PartialAppConfigSchema = AppConfigSchema.partial();

/**
 * Repo-level overlay (.agentboard.json).
 */
export const RepoOverlayConfigSchema = z
  .object({
    defaultBaseBranch: z.string().optional(),
    defaultPillarId: z.string().optional(),
    preferredIde: PreferredIDESchema.optional(),
    ideCommand: z.string().optional(),
    worktreeMode: WorktreeModeSchema.optional(),
    worktreeRoot: z.string().optional(),
    agentMacros: z.array(AgentMacroSchema).optional(),
  })
  .strict()
  .partial();

// ============================================================
// Default config
// ============================================================

export function defaultConfig(): AppConfig {
  return {
    sessionBackend: 'tmux' as SessionBackendType,
    pollIntervalMs: 60000,
    tracks: [
      { id: 'backlog', label: 'Backlog', sortOrder: 0 },
      { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
      { id: 'pr', label: 'PR', sortOrder: 2 },
      { id: 'done', label: 'Done', sortOrder: 3 },
    ],
    pillars: [],
    repos: [],
    savedViews: [],
    agentMacros: [],
    theme: undefined,
    iconMode: 'unicode',
  };
}

// ============================================================
// Platform paths
// ============================================================

export interface ConfigPaths {
  configFile: string;
  configDir: string;
  stateDir: string;
  dbFile: string;
  logFile: string;
  socketPath: string;
}

export function configPaths(): ConfigPaths {
  const platform = process.platform;
  const home = os.homedir();

  let configDir: string;
  let stateDir: string;

  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support', 'AgentBoard');
    configDir = base;
    stateDir = base;
  } else {
    // Linux (and other Unix-likes) — respect XDG base dirs
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
    const xdgState = process.env['XDG_STATE_HOME'] ?? path.join(home, '.local', 'state');
    configDir = path.join(xdgConfig, 'agentboard');
    stateDir = path.join(xdgState, 'agentboard');
  }

  // Keep socket path well under the 104-char Unix domain socket limit.
  // Use /tmp so we never exceed the limit even on systems with deep home dirs.
  const uid = (process as NodeJS.Process & { getuid?: () => number }).getuid?.() ?? 'user';
  const socketPath = path.join(os.tmpdir(), `agentboard-${uid}.sock`);

  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    stateDir,
    dbFile: path.join(stateDir, 'agentboard.db'),
    logFile: path.join(stateDir, 'agentboard.log'),
    socketPath,
  };
}

// ============================================================
// loadConfig
// ============================================================

/**
 * Reads the config file (if it exists), validates with Zod, merges with
 * defaults, then applies any runtime override.  Throws a human-readable
 * error — not a raw Zod dump — when validation fails.
 */
export function loadConfig(override?: Partial<AppConfig>): AppConfig {
  const { configFile } = configPaths();
  const base = defaultConfig();

  if (!fs.existsSync(configFile)) {
    // No file yet — use defaults (+ override)
    return mergePartial(base, override);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `AgentBoard: failed to read config file at ${configFile}: ${(err as Error).message}`,
    );
  }

  const result = PartialAppConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const summary = issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error(
      `AgentBoard: config validation failed for the following fields:\n${summary}\n` +
        `Falling back to default values for invalid fields.`,
    );
    // Collect the field paths that are invalid so we can strip them
    const invalidPaths = new Set(issues.map((i) => i.path[0]?.toString() ?? ''));
    const cleaned: Record<string, unknown> = {};
    if (typeof raw === 'object' && raw !== null) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!invalidPaths.has(k)) {
          cleaned[k] = v;
        }
      }
    }
    const cleanedResult = PartialAppConfigSchema.safeParse(cleaned);
    const partial = cleanedResult.success ? cleanedResult.data : {};
    return mergePartial(base, partial as Partial<AppConfig>, override);
  }

  return mergePartial(base, result.data as Partial<AppConfig>, override);
}

// ============================================================
// loadRepoOverlay
// ============================================================

/**
 * Looks for `.agentboard.json` in repoPath, validates it, and returns the
 * parsed overlay — or null if the file does not exist.
 */
export function loadRepoOverlay(repoPath: string): RepoOverlayConfig | null {
  const overlayFile = path.join(repoPath, '.agentboard.json');

  if (!fs.existsSync(overlayFile)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `AgentBoard: failed to read repo overlay at ${overlayFile}: ${(err as Error).message}`,
    );
  }

  const result = RepoOverlayConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const summary = issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `AgentBoard: repo overlay at ${overlayFile} has invalid fields:\n${summary}`,
    );
  }

  return result.data as RepoOverlayConfig;
}

// ============================================================
// mergeOverlay
// ============================================================

/**
 * Returns a new AppConfig with repo-level overlay values applied.
 * The overlay may only influence per-repo defaults (defaultBaseBranch,
 * defaultPillarId, agentMacros).  It never changes DB path, socket, or
 * workspace ownership settings.
 */
export function mergeOverlay(config: AppConfig, overlay: RepoOverlayConfig): AppConfig {
  const merged: AppConfig = { ...config };

  if (overlay.agentMacros !== undefined) {
    // Overlay macros are prepended so they take precedence over global ones.
    // Duplicates (by id) in the global list are removed to avoid conflicts.
    const overlayIds = new Set(overlay.agentMacros.map((m) => m.id));
    const globalMacros = config.agentMacros.filter((m) => !overlayIds.has(m.id));
    merged.agentMacros = [...overlay.agentMacros, ...globalMacros];
  }

  // defaultBaseBranch and defaultPillarId are per-repo concerns — store them
  // back on the matching repo entry if present, otherwise they are only
  // accessible via the overlay object itself (callers may use it directly).
  if (overlay.defaultBaseBranch !== undefined || overlay.defaultPillarId !== undefined) {
    // Nothing to merge into AppConfig top-level; these live on RepoConfig
    // entries. We leave them for the caller to apply per-repo as needed.
  }

  return merged;
}

// ============================================================
// writeDefaultConfig
// ============================================================

/**
 * Creates the config directory if it does not exist, then writes the default
 * config as formatted JSON.  Idempotent — will not overwrite an existing file.
 */
export function writeDefaultConfig(): void {
  const { configDir, configFile } = configPaths();

  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(configFile)) {
    return; // Already present — do not overwrite
  }

  const content = JSON.stringify(defaultConfig(), null, 2) + '\n';
  fs.writeFileSync(configFile, content, { encoding: 'utf8', mode: 0o600 });
}

// ============================================================
// ensureDirectories
// ============================================================

/**
 * Creates configDir and stateDir with restrictive permissions (0o700).
 */
export function ensureDirectories(): void {
  const { configDir, stateDir } = configPaths();

  for (const dir of [configDir, stateDir]) {
    fs.mkdirSync(dir, { recursive: true });
    // Set permissions explicitly after creation (mkdirSync mode is masked by
    // umask, so chmod is the reliable approach).
    fs.chmodSync(dir, 0o700);
  }
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Merges one or more partial configs on top of a base config.
 * Only defined (non-undefined) values from each partial are applied.
 */
function mergePartial(
  base: AppConfig,
  ...partials: (Partial<AppConfig> | undefined)[]
): AppConfig {
  let result: AppConfig = { ...base };
  for (const partial of partials) {
    if (!partial) continue;
    result = { ...result, ...removeUndefined(partial) };
  }
  return result;
}

function removeUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}
