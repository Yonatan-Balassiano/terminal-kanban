import { McpAuthRequiredError, McpOAuthClient } from './oauth.js';

/**
 * Minimal client for a streamable-HTTP MCP server.
 *
 * Only what the artifacts rail needs: an `initialize` handshake and
 * `tools/call`. Responses may arrive as plain JSON or as an SSE stream
 * depending on the server, so both framings are accepted.
 */

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface McpClientOptions {
  serverUrl: string;
  auth: McpOAuthClient;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** An MCP tool returned an error result rather than a transport failure. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Guards the unwrap loop against a pathological or hostile payload. */
const MAX_CONTENT_UNWRAP_DEPTH = 5;

/** The MCP `{ content: [{ type, text }] }` envelope, if this value is one. */
function textContentOf(value: unknown): string | undefined {
  const content = (value as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.find((part) => part?.type === 'text')?.text;
}

/**
 * Unwrap an MCP tool result down to its payload.
 *
 * Gateways may nest envelopes: mcp-s returns a content array whose text part is
 * itself a serialized content envelope wrapping the real JSON. Unwrapping only
 * once yields an object with none of the expected fields, which reads as an
 * empty result rather than an error — so keep unwrapping while the value still
 * looks like an envelope.
 */
function parseToolResult(result: unknown): { value: unknown; isError: boolean } {
  let current: unknown = result;
  // Any layer may carry the error flag, so it is collected across all of them.
  let isError = Boolean((result as { isError?: boolean })?.isError);

  for (let depth = 0; depth < MAX_CONTENT_UNWRAP_DEPTH; depth += 1) {
    const text = textContentOf(current);
    if (text === undefined) {
      return { value: current, isError };
    }
    try {
      current = JSON.parse(text);
      isError = isError || Boolean((current as { isError?: boolean })?.isError);
    } catch {
      // A text part that is not JSON is the payload itself.
      return { value: text, isError };
    }
  }

  return { value: current, isError };
}

/** Pulls the last JSON-RPC payload out of an SSE body. */
function parseSseBody(body: string): JsonRpcResponse | null {
  let last: JsonRpcResponse | null = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    try {
      last = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      // Ignore keep-alive or partial frames.
    }
  }
  return last;
}

export class McpClient {
  private readonly serverUrl: string;
  private readonly auth: McpOAuthClient;
  private readonly timeoutMs: number;

  private sessionId: string | null = null;
  private initializing: Promise<void> | null = null;
  private nextId = 1;

  constructor(options: McpClientOptions) {
    this.serverUrl = options.serverUrl;
    this.auth = options.auth;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const token = await this.auth.getAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const response = await fetch(this.serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 401) {
      // The cached session is bound to a token the server no longer accepts.
      this.sessionId = null;
      this.initializing = null;
      throw new McpAuthRequiredError('MCP server rejected the token. Run: agentboard mcp login');
    }

    const session = response.headers.get('mcp-session-id');
    if (session) {
      this.sessionId = session;
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${method} failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const parsed = contentType.includes('text/event-stream')
      ? parseSseBody(body)
      : (JSON.parse(body) as JsonRpcResponse);

    if (!parsed) {
      throw new Error(`MCP ${method} returned no usable response`);
    }
    if (parsed.error) {
      throw new McpToolError(`MCP ${method} error: ${parsed.error.message}`);
    }
    return parsed;
  }

  /** Handshake once per session; concurrent callers share one attempt. */
  private async ensureInitialized(): Promise<void> {
    if (this.sessionId) {
      return;
    }
    this.initializing ??= (async () => {
      try {
        await this.send('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'agentboard', version: '0.1.0' },
        });
      } catch (error) {
        this.initializing = null;
        throw error;
      }
    })();
    return this.initializing;
  }

  /** Call a tool and return its parsed JSON result. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized();
    const response = await this.send('tools/call', { name, arguments: args });

    const { value, isError } = parseToolResult(response.result);
    if (isError) {
      throw new McpToolError(
        `MCP tool ${name} failed: ${typeof value === 'string' ? value : JSON.stringify(value).slice(0, 200)}`
      );
    }
    return value as T;
  }
}
