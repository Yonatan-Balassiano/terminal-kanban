import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_CHAT_SYSTEM_PROMPT } from '../src/prompts/ai-chat-system-prompt.js';
import { defaultConfig, normalizeLegacyConfig } from '../src/config/index.js';

describe('defaultConfig', () => {
  it('syncs GitHub every 60 seconds by default', () => {
    expect(defaultConfig().pollIntervalMs).toBe(60000);
  });

  it('uses backlog, in-progress, pr, and done as the default board tracks', () => {
    expect(defaultConfig().tracks).toEqual([
      { id: 'backlog', label: 'Backlog', sortOrder: 0 },
      { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
      { id: 'pr', label: 'PR', sortOrder: 2 },
      { id: 'done', label: 'Done', sortOrder: 3 },
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
