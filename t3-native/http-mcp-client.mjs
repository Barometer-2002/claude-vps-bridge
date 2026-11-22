/**
 * Local Windows-only Streamable HTTP MCP client for T3 Code's t3-code MCP endpoint.
 * The local endpoint URL and Authorization header stay strictly inside this Windows process.
 */
export class LocalHttpMcpClient {
  constructor(serverConfig) {
    this.url = serverConfig?.url ?? null;
    this.headers = { ...(serverConfig?.headers ?? {}) };
    this.connections = new Map();
  }

  configure(serverConfig) {
    this.url = serverConfig?.url ?? null;
    this.headers = { ...(serverConfig?.headers ?? {}) };
  }

  get enabled() {
    return typeof this.url === 'string' && this.url.length > 0;
  }

  #getOrCreate(connectionId) {
    let conn = this.connections.get(connectionId);
    if (!conn) {
      conn = { sessionId: null, protocolVersion: null, initChain: Promise.resolve() };
      this.connections.set(connectionId, conn);
    }
    return conn;
  }

  async #parseResponsePayloads(response) {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const raw = await response.text();
    if (!raw.trim()) return [];
    if (contentType.includes('text/event-stream')) {
      const payloads = [];
      let dataLines = [];
      const flush = () => {
        if (!dataLines.length) return;
        const text = dataLines.join('\n').trim();
        dataLines = [];
        if (!text || text === '[DONE]') return;
        try {
          payloads.push(JSON.parse(text));
        } catch {
          // Ignore non-JSON SSE chunks.
        }
      };
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          flush();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      flush();
      return payloads;
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  async #post(conn, frame) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
      ...(conn.sessionId ? { 'mcp-session-id': conn.sessionId } : {}),
      ...(conn.protocolVersion ? { 'mcp-protocol-version': conn.protocolVersion } : {}),
    };
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(frame),
    });
    const nextSessionId = response.headers.get('mcp-session-id');
    if (nextSessionId) conn.sessionId = nextSessionId;
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`T3 Code MCP endpoint responded with HTTP ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
    }
    const payloads = await this.#parseResponsePayloads(response);
    for (const payload of payloads) {
      const pv = payload?.result?.protocolVersion;
      if (typeof pv === 'string' && pv) conn.protocolVersion = pv;
    }
    return payloads;
  }

  async #disconnect(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return {};
    this.connections.delete(connectionId);
    if (!conn.sessionId || !this.url) return {};
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: {
          ...this.headers,
          'mcp-session-id': conn.sessionId,
          ...(conn.protocolVersion ? { 'mcp-protocol-version': conn.protocolVersion } : {}),
        },
      });
    } catch {
      // Best-effort disconnect on shutdown.
    }
    return {};
  }

  async handle(request) {
    if (!this.enabled) {
      throw new Error('Local T3 Code HTTP MCP endpoint is not configured for this session');
    }
    const connectionId = request?.connectionId;
    if (typeof connectionId !== 'string' || !connectionId) {
      throw new Error('Missing MCP connectionId');
    }
    if (request.close) {
      return this.#disconnect(connectionId);
    }
    const frame = request.frame;
    if (!frame || typeof frame !== 'object' || typeof frame.method !== 'string') {
      throw new Error('Invalid MCP JSON-RPC frame');
    }
    const conn = this.#getOrCreate(connectionId);
    const isNotification = frame.id === undefined || frame.id === null;

    const run = async () => {
      try {
        const payloads = await this.#post(conn, frame);
        if (isNotification) return {};
        const matched = payloads.find(p => p && typeof p === 'object' && p.id === frame.id)
          ?? payloads.find(p => p && typeof p === 'object' && ('result' in p || 'error' in p));
        if (matched) return matched;
        return { jsonrpc: '2.0', id: frame.id, result: {} };
      } catch (err) {
        if (isNotification) return {};
        return {
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32603, message: err?.message ?? 'Local T3 MCP request failed' },
        };
      }
    };

    if (!conn.protocolVersion) {
      const chained = conn.initChain.then(run, run);
      conn.initChain = chained.then(() => {}, () => {});
      return chained;
    }
    return run();
  }

  async closeAll() {
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map(id => this.#disconnect(id)));
  }
}
