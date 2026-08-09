import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DEFAULT_AI_CHAT_SYSTEM_PROMPT } from '../src/prompts/ai-chat-system-prompt.js';
import {
  configPaths,
  defaultConfig,
  normalizeLegacyConfig,
  saveArtifactList,
} from '../src/config/index.js';

describe('defaultConfig', () => {
  it('syncs GitHub every 60 seconds by default', () => {
    expect(defaultConfig().pollIntervalMs).toBe(60000);
  });

  it('separates merged work from shipped work in the default board tracks', () => {
    // Shipping sits between review and done because merging stopped being the
    // end of the story: a card whose pull requests have landed but whose change
    // is not in production yet is neither in review nor finished.
    expect(defaultConfig().tracks).toEqual([
      { id: 'backlog', label: 'Backlog', sortOrder: 0 },
      { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
      { id: 'pr', label: 'PR', sortOrder: 2 },
      { id: 'shipping', label: 'Shipping', sortOrder: 3 },
      { id: 'done', label: 'Done', sortOrder: 4 },
    ]);
  });

  it('uses the bundled session bootstrap script by default', () => {
    expect(defaultConfig().sessionBootstrapScript).toMatch(/scripts\/session-bootstrap\.sh$/);
  });

  it('uses tmux sessions with managed layout by default', () => {
    expect(defaultConfig().sessionBackend).toBe('tmux');
    expect(defaultConfig().tmux).toEqual({
      autoLayout: true,
      layoutSessionName: 'agentboard',
    });
  });

  it('includes the default Ollama chat config and system prompt', () => {
    expect(defaultConfig().aiChat).toEqual({
      enabled: true,
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'gemma4:e2b',
      requestTimeoutMs: 45000,
      maxToolRounds: 6,
      historyLimit: 24,
      systemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT,
    });
  });
});

describe('normalizeLegacyConfig', () => {
  it('accepts legacy track sort_order and theme object config', () => {
    expect(
      normalizeLegacyConfig({
        tracks: [
          { id: 'backlog', label: 'Backlog', sort_order: 0 },
          { id: 'in-progress', label: 'In Progress', sort_order: 1 },
        ],
        theme: { name: 'default', monochrome: false, trueColor: true },
      })
    ).toEqual({
      tracks: [
        { id: 'backlog', label: 'Backlog', sort_order: 0, sortOrder: 0 },
        { id: 'in-progress', label: 'In Progress', sort_order: 1, sortOrder: 1 },
      ],
      theme: 'truecolor',
    });
  });

  it('uses track position when legacy track order is absent', () => {
    expect(
      normalizeLegacyConfig({
        tracks: [
          { id: 'backlog', label: 'Backlog' },
          { id: 'done', label: 'Done' },
        ],
      })
    ).toEqual({
      tracks: [
        { id: 'backlog', label: 'Backlog', sortOrder: 0 },
        { id: 'done', label: 'Done', sortOrder: 1 },
      ],
    });
  });
});

describe('saveArtifactList', () => {
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    originals['XDG_CONFIG_HOME'] = process.env['XDG_CONFIG_HOME'];
    originals['HOME'] = process.env['HOME'];
    const dir = mkdtempSync(join(tmpdir(), 'ab-cfg-'));
    process.env['HOME'] = dir;
    process.env['XDG_CONFIG_HOME'] = join(dir, '.config');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('keeps every other setting when the artifact list changes', () => {
    // Arrange — the file is hand-edited, and may hold keys this build predates.
    const { configDir, configFile } = configPaths();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configFile,
      JSON.stringify({
        sessionBackend: 'tmux',
        somethingThisBuildHasNeverHeardOf: { keep: true },
        artifacts: { list: ['com.a'], refreshIntervalMs: 300000, githubLogin: 'someone' },
      }),
    );

    // Act
    saveArtifactList(['com.a', 'com.b']);

    // Assert
    const saved = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, never>;
    expect(saved['artifacts']).toEqual({
      list: ['com.a', 'com.b'],
      refreshIntervalMs: 300000,
      githubLogin: 'someone',
    });
    expect(saved['sessionBackend']).toBe('tmux');
    expect(saved['somethingThisBuildHasNeverHeardOf']).toEqual({ keep: true });
  });

  it('refuses to overwrite a config it cannot parse', () => {
    // Arrange — replacing it would discard everything the user has configured.
    const { configDir, configFile } = configPaths();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, '{ this is not json');

    // Act / Assert
    expect(() => saveArtifactList(['com.a'])).toThrow(/not valid JSON/);
    expect(readFileSync(configFile, 'utf8')).toBe('{ this is not json');
  });

  it('creates the artifacts section when the config has none', () => {
    const { configDir, configFile } = configPaths();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({ sessionBackend: 'pty' }));

    saveArtifactList(['com.a']);

    const saved = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, never>;
    expect(saved['artifacts']).toEqual({ list: ['com.a'] });
  });
});
