import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpClient, McpToolError } from '../src/services/mcp/client.js';
import { McpAuthRequiredError, type McpOAuthClient } from '../src/services/mcp/oauth.js';

const auth = { getAccessToken: async () => 'test-token' } as unknown as McpOAuthClient;

/** MCP envelope around a JSON payload. */
function envelope(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function mockFetch(
  responder: (body: Record<string, unknown>) => { status?: number; result?: unknown; headers?: Record<string, string> }
) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const { status = 200, result, headers = {} } = responder(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body['id'], result }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('McpClient.callTool', () => {
  it('unwraps a single content envelope', async () => {
    // Arrange
    mockFetch((body) =>
      body['method'] === 'initialize' ? { result: {} } : { result: envelope({ project: { gaVersion: '1.0.0' } }) }
    );
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    // Act
    const result = await client.callTool<{ project: { gaVersion: string } }>('devex__get_project', {});

    // Assert
    expect(result.project.gaVersion).toBe('1.0.0');
  });

  it('unwraps a doubly-nested envelope', async () => {
    // Arrange — the mcp-s gateway returns a content envelope whose text part is
    // itself a serialized content envelope. Unwrapping once yields an object
    // with none of the expected fields, which reads as an empty result.
    mockFetch((body) =>
      body['method'] === 'initialize'
        ? { result: {} }
        : { result: envelope(JSON.stringify(envelope({ project: { gaVersion: '1.1258.0' } }))) }
    );
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    // Act
    const result = await client.callTool<{ project: { gaVersion: string } }>('devex__get_project', {});

    // Assert
    expect(result.project.gaVersion).toBe('1.1258.0');
  });

  it('returns a non-JSON text part as-is', async () => {
    mockFetch((body) => (body['method'] === 'initialize' ? { result: {} } : { result: envelope('plain text') }));
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    expect(await client.callTool('tool', {})).toBe('plain text');
  });

  it('raises an error flagged on the outer envelope', async () => {
    mockFetch((body) =>
      body['method'] === 'initialize' ? { result: {} } : { result: envelope('boom', true) }
    );
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    await expect(client.callTool('tool', {})).rejects.toBeInstanceOf(McpToolError);
  });

  it('raises an error flagged only on the inner envelope', async () => {
    // Arrange — with nesting, the flag can sit on a layer the caller never sees.
    mockFetch((body) =>
      body['method'] === 'initialize'
        ? { result: {} }
        : { result: envelope(JSON.stringify(envelope('inner boom', true))) }
    );
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    await expect(client.callTool('tool', {})).rejects.toBeInstanceOf(McpToolError);
  });

  it('reports a rejected token as needing a login rather than a raw 401', async () => {
    mockFetch(() => ({ status: 401 }));
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    await expect(client.callTool('tool', {})).rejects.toBeInstanceOf(McpAuthRequiredError);
  });

  it('initializes once and reuses the handshake across calls', async () => {
    // Arrange
    const fetchMock = mockFetch((body) =>
      body['method'] === 'initialize' ? { result: {} } : { result: envelope({ ok: true }) }
    );
    const client = new McpClient({ serverUrl: 'https://example/mcp', auth });

    // Act
    await client.callTool('a', {});
    await client.callTool('b', {});

    // Assert — one initialize, then one call each.
    const methods = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).method
    );
    expect(methods.filter((m: string) => m === 'initialize')).toHaveLength(1);
  });
});
