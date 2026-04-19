import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedOllamaService } from '../src/services/ollama.js';
import type { AIChatConfig } from '../src/types/index.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe('ManagedOllamaService', () => {
  const originalFetch = globalThis.fetch;
  let config: AIChatConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-model',
      requestTimeoutMs: 10_000,
      maxToolRounds: 6,
      historyLimit: 12,
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('preloads the configured model once for concurrent callers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/version')) {
        return jsonResponse({ version: '0.1.0' });
      }
      if (url.endsWith('/api/chat')) {
        return jsonResponse({ message: { content: '' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new ManagedOllamaService(config);
    await Promise.all([service.ensureModelReady(), service.ensureModelReady()]);

    const warmCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/chat'));
    expect(warmCalls).toHaveLength(1);
    expect(warmCalls[0]?.[1]?.body).toBe(
      JSON.stringify({
        model: 'test-model',
        stream: false,
        keep_alive: 300,
      }),
    );
  });

  it('warms the model again after the warmup TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T09:00:00Z'));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/version')) {
        return jsonResponse({ version: '0.1.0' });
      }
      if (url.endsWith('/api/chat')) {
        return jsonResponse({ message: { content: '' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new ManagedOllamaService(config);
    await service.ensureModelReady();
    await service.ensureModelReady();

    vi.setSystemTime(new Date('2026-04-19T09:05:01Z'));
    await service.ensureModelReady();

    const warmCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/chat'));
    expect(warmCalls).toHaveLength(2);
  });
});
