import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { URL } from 'url';

/**
 * OAuth2 client for an MCP server that advertises RFC 9728 protected-resource
 * metadata, RFC 8414 authorization-server metadata and RFC 7591 dynamic client
 * registration — which is what mcp-s.wewix.net does.
 *
 * The flow is authorization_code + PKCE against a loopback redirect. The server
 * advertises refresh_token support but does not always echo it back at
 * registration, so a refresh token is treated as optional: when one is issued
 * the daemon renews silently, and when it is not the caller is told to log in
 * again rather than being left with a silently dead panel.
 */

const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const LOGIN_TIMEOUT_MS = 300_000;
const HTTP_TIMEOUT_MS = 20_000;
const LOOPBACK_HOST = '127.0.0.1';
const CREDENTIALS_FILE_MODE = 0o600;

export interface McpAuthConfig {
  /** MCP endpoint, e.g. https://mcp-s.wewix.net/mcp */
  serverUrl: string;
  /** Where the client registration and tokens are cached. */
  credentialsPath: string;
  /** Fixed loopback port; must match the registered redirect URI. */
  callbackPort?: number;
}

interface StoredCredentials {
  serverUrl: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/** Signals the caller must complete an interactive login. */
export class McpAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAuthRequiredError';
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${response.status} ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Falling back to the printed URL is fine; the caller logs it.
  }
}

export class McpOAuthClient {
  private readonly serverUrl: string;
  private readonly credentialsPath: string;
  private readonly callbackPort: number;

  private credentials: StoredCredentials;
  private metadata: AuthorizationServerMetadata | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(config: McpAuthConfig) {
    this.serverUrl = config.serverUrl;
    this.credentialsPath = config.credentialsPath;
    this.callbackPort = config.callbackPort ?? 41777;
    this.credentials = this.readCredentials();
  }

  private readCredentials(): StoredCredentials {
    try {
      const raw = readFileSync(this.credentialsPath, 'utf8');
      const parsed = JSON.parse(raw) as StoredCredentials;
      // A cache for a different server is not ours to reuse.
      return parsed.serverUrl === this.serverUrl ? parsed : { serverUrl: this.serverUrl };
    } catch {
      return { serverUrl: this.serverUrl };
    }
  }

  private writeCredentials(next: StoredCredentials): void {
    this.credentials = next;
    mkdirSync(dirname(this.credentialsPath), { recursive: true });
    writeFileSync(this.credentialsPath, JSON.stringify(next, null, 2), 'utf8');
    // Tokens are bearer credentials: keep them owner-only.
    chmodSync(this.credentialsPath, CREDENTIALS_FILE_MODE);
  }

  /** True when a login has been completed at some point. */
  get isRegistered(): boolean {
    return Boolean(this.credentials.accessToken || this.credentials.refreshToken);
  }

  private async discover(): Promise<AuthorizationServerMetadata> {
    if (this.metadata) {
      return this.metadata;
    }

    const resourceUrl = new URL(this.serverUrl);
    const resourceMetadataUrl =
      `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`;
    const resource = await fetchJson<{ authorization_servers?: string[] }>(resourceMetadataUrl);
    const authServer = resource.authorization_servers?.[0];
    if (!authServer) {
      throw new Error(`No authorization server advertised at ${resourceMetadataUrl}`);
    }

    const base = authServer.replace(/\/$/, '');
    this.metadata = await fetchJson<AuthorizationServerMetadata>(
      `${base}/.well-known/oauth-authorization-server`
    );
    return this.metadata;
  }

  private async ensureClient(): Promise<{ clientId: string; clientSecret?: string; redirectUri: string }> {
    const redirectUri = `http://${LOOPBACK_HOST}:${this.callbackPort}/callback`;
    if (this.credentials.clientId && this.credentials.redirectUri === redirectUri) {
      return {
        clientId: this.credentials.clientId,
        clientSecret: this.credentials.clientSecret,
        redirectUri,
      };
    }

    const metadata = await this.discover();
    if (!metadata.registration_endpoint) {
      throw new Error(`${metadata.issuer} does not support dynamic client registration`);
    }

    const registered = await fetchJson<{ client_id: string; client_secret?: string }>(
      metadata.registration_endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'AgentBoard',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: 'openid email profile',
        }),
      }
    );

    this.writeCredentials({
      ...this.credentials,
      clientId: registered.client_id,
      clientSecret: registered.client_secret,
      redirectUri,
    });

    return {
      clientId: registered.client_id,
      clientSecret: registered.client_secret,
      redirectUri,
    };
  }

  /**
   * Run the interactive browser login. Resolves once tokens are cached.
   *
   * `onPrompt` receives the URL so a CLI can print it when the browser cannot be
   * opened automatically.
   */
  async login(onPrompt?: (url: string) => void): Promise<void> {
    const metadata = await this.discover();
    const client = await this.ensureClient();

    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const state = base64Url(randomBytes(16));

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.clientId);
    authorizeUrl.searchParams.set('redirect_uri', client.redirectUri);
    authorizeUrl.searchParams.set('scope', 'openid email profile');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('resource', this.serverUrl);

    const code = await this.awaitAuthorizationCode(authorizeUrl.toString(), state, onPrompt);
    await this.exchangeCode(code, verifier, client);
  }

  private awaitAuthorizationCode(
    authorizeUrl: string,
    expectedState: string,
    onPrompt?: (url: string) => void
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${this.callbackPort}`);
        if (requestUrl.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const code = requestUrl.searchParams.get('code');
        const state = requestUrl.searchParams.get('state');
        const error = requestUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body style="font-family:system-ui;padding:2rem">
             <h2>${error ? 'AgentBoard sign-in failed' : 'AgentBoard is connected'}</h2>
             <p>${error ? error : 'You can close this tab and return to the terminal.'}</p>
           </body></html>`
        );

        cleanup();
        if (error) {
          reject(new Error(`Authorization failed: ${error}`));
        } else if (!code) {
          reject(new Error('Authorization response had no code'));
        } else if (state !== expectedState) {
          // A mismatched state means the response is not the one we started.
          reject(new Error('Authorization state mismatch'));
        } else {
          resolve(code);
        }
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the browser sign-in'));
      }, LOGIN_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        server.close();
      };

      server.on('error', (err) => {
        cleanup();
        reject(err);
      });

      server.listen(this.callbackPort, LOOPBACK_HOST, () => {
        onPrompt?.(authorizeUrl);
        openInBrowser(authorizeUrl);
      });
    });
  }

  private async exchangeCode(
    code: string,
    verifier: string,
    client: { clientId: string; clientSecret?: string; redirectUri: string }
  ): Promise<void> {
    const metadata = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: this.serverUrl,
    });
    if (client.clientSecret) {
      body.set('client_secret', client.clientSecret);
    }

    const token = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    }>(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    this.storeToken(token);
  }

  private storeToken(token: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }): void {
    this.writeCredentials({
      ...this.credentials,
      accessToken: token.access_token,
      // Keep any previous refresh token when the server omits one on refresh.
      refreshToken: token.refresh_token ?? this.credentials.refreshToken,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    });
  }

  /** Whether the cached access token is usable right now. */
  private hasFreshToken(): boolean {
    if (!this.credentials.accessToken) {
      return false;
    }
    if (this.credentials.expiresAt === undefined) {
      return true;
    }
    return this.credentials.expiresAt - TOKEN_EXPIRY_SAFETY_MS > Date.now();
  }

  /**
   * A bearer token for the MCP server.
   *
   * Throws {@link McpAuthRequiredError} when an interactive login is needed, so
   * callers can surface "run agentboard mcp login" instead of a raw 401.
   */
  async getAccessToken(): Promise<string> {
    if (this.hasFreshToken()) {
      return this.credentials.accessToken!;
    }

    if (!this.credentials.refreshToken) {
      throw new McpAuthRequiredError(
        this.credentials.accessToken
          ? 'MCP access token expired and no refresh token was issued. Run: agentboard mcp login'
          : 'Not signed in to the MCP server. Run: agentboard mcp login'
      );
    }

    this.refreshInFlight ??= this.refreshAccessToken().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshAccessToken(): Promise<string> {
    const metadata = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.credentials.refreshToken!,
      client_id: this.credentials.clientId ?? '',
      resource: this.serverUrl,
    });
    if (this.credentials.clientSecret) {
      body.set('client_secret', this.credentials.clientSecret);
    }

    try {
      const token = await fetchJson<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      }>(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      this.storeToken(token);
      return token.access_token;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpAuthRequiredError(
        `MCP token refresh failed (${detail}). Run: agentboard mcp login`
      );
    }
  }

  /** Drops cached tokens, keeping the client registration. */
  logout(): void {
    this.writeCredentials({
      serverUrl: this.serverUrl,
      clientId: this.credentials.clientId,
      clientSecret: this.credentials.clientSecret,
      redirectUri: this.credentials.redirectUri,
    });
  }

  /** Whether a credentials file exists at all. */
  get hasCredentialsFile(): boolean {
    return existsSync(this.credentialsPath);
  }
}
