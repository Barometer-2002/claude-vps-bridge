import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STDIO_REQUEST_TIMEOUT_MS = 120000;

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { child.kill(); } catch {}
  }
}

function resolveWindowsCommand(command) {
  if (process.platform !== 'win32' || typeof command !== 'string' || !command.trim()) {
    return { command, useShell: false };
  }
  if (path.isAbsolute(command) || command.includes('\\') || command.includes('/')) {
    return { command, useShell: /\.(cmd|bat)$/i.test(command) };
  }
  const hasExt = /\.[A-Za-z0-9]+$/.test(command);
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = hasExt ? [''] : ['.exe', '.cmd', '.bat', '.com'];
  for (const dir of dirs) {
    const cleanDir = dir.replace(/^"(.*)"$/, '$1');
    for (const ext of exts) {
      const candidate = path.join(cleanDir, command + ext);
      if (existsSync(candidate)) {
        return { command: candidate, useShell: /\.(cmd|bat)$/i.test(candidate) };
      }
    }
  }
  return { command, useShell: /\.(cmd|bat)$/i.test(command) };
}

/**
 * Local Windows-only Streamable HTTP MCP client (for T3 Code's t3-code endpoint and user HTTP MCPs).
 * Local endpoint URLs and Authorization headers stay strictly inside this Windows process.
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
      throw new Error(`Local HTTP MCP endpoint responded with HTTP ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
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
      throw new Error('Local HTTP MCP endpoint is not configured for this session');
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
          error: { code: -32603, message: err?.message ?? 'Local HTTP MCP request failed' },
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

/**
 * Local Windows-only stdio MCP client for user-configured stdio MCP servers.
 */
export class LocalStdioMcpClient {
  constructor(serverConfig, cwd) {
    this.command = serverConfig?.command ?? null;
    this.args = Array.isArray(serverConfig?.args) ? serverConfig.args.map(String) : [];
    this.env = serverConfig?.env && typeof serverConfig.env === 'object' ? { ...serverConfig.env } : {};
    this.cwd = typeof serverConfig?.cwd === 'string' && serverConfig.cwd ? serverConfig.cwd : cwd;
    this.connections = new Map();
  }

  get enabled() {
    return typeof this.command === 'string' && this.command.trim().length > 0;
  }

  #stop(connectionId, error = new Error('Local stdio MCP closed')) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.connections.delete(connectionId);
    try { conn.rl?.close(); } catch {}
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    conn.pending.clear();
    try { conn.child.stdin?.end(); } catch {}
    setTimeout(() => killProcessTree(conn.child), 1000).unref();
  }

  #spawnConnection(connectionId) {
    const { command, useShell } = resolveWindowsCommand(this.command);
    const child = spawn(command, this.args, {
      cwd: this.cwd || process.cwd(),
      env: { ...process.env, ...this.env },
      windowsHide: true,
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const conn = {
      child,
      pending: new Map(),
      stderr: '',
      rl: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    };
    this.connections.set(connectionId, conn);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      conn.stderr = (conn.stderr + chunk).slice(-2000);
    });
    child.stdin.on('error', err => this.#stop(connectionId, err));
    child.on('error', err => this.#stop(connectionId, err));
    child.on('exit', code => {
      const detail = conn.stderr.trim();
      this.#stop(connectionId, new Error(`Local stdio MCP exited (${code ?? 'signal'})${detail ? `: ${detail.slice(0, 300)}` : ''}`));
    });

    conn.rl.on('line', line => {
      if (!line.trim()) return;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      if (!reply || typeof reply !== 'object' || reply.id === undefined || reply.id === null) return;
      const pending = conn.pending.get(String(reply.id));
      if (!pending) return;
      conn.pending.delete(String(reply.id));
      clearTimeout(pending.timer);
      pending.resolve(reply);
    });

    return conn;
  }

  async handle(request) {
    if (!this.enabled) {
      throw new Error('Local stdio MCP command is not configured');
    }
    const connectionId = request?.connectionId;
    if (typeof connectionId !== 'string' || !connectionId) {
      throw new Error('Missing MCP connectionId');
    }
    if (request.close) {
      this.#stop(connectionId);
      return {};
    }
    const frame = request.frame;
    if (!frame || typeof frame !== 'object' || typeof frame.method !== 'string') {
      throw new Error('Invalid MCP JSON-RPC frame');
    }

    let conn = this.connections.get(connectionId);
    if (!conn) {
      conn = this.#spawnConnection(connectionId);
    }

    const isNotification = frame.id === undefined || frame.id === null;
    const payload = `${JSON.stringify(frame)}\n`;
    if (isNotification) {
      try {
        conn.child.stdin.write(payload);
      } catch (err) {
        this.#stop(connectionId, err);
      }
      return {};
    }

    const reqKey = String(frame.id);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        conn.pending.delete(reqKey);
        resolve({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32603, message: 'Local stdio MCP request timed out' },
        });
      }, STDIO_REQUEST_TIMEOUT_MS);

      conn.pending.set(reqKey, {
        timer,
        resolve,
        reject: err => {
          resolve({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32603, message: err?.message ?? 'Local stdio MCP failed' },
          });
        },
      });

      try {
        conn.child.stdin.write(payload);
      } catch (err) {
        conn.pending.delete(reqKey);
        clearTimeout(timer);
        this.#stop(connectionId, err);
        resolve({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32603, message: err?.message ?? 'Local stdio MCP write failed' },
        });
      }
    });
  }

  async closeAll() {
    for (const id of [...this.connections.keys()]) {
      this.#stop(id);
    }
  }
}

/**
 * Multi-server Windows MCP proxy hub for t3-native.
 * Keeps all local HTTP URLs/tokens and Windows stdio processes strictly on Windows.
 */
export class LocalMcpHub {
  constructor() {
    this.clients = new Map();
    this.configs = new Map();
  }

  has(name) {
    return this.clients.has(name);
  }

  names() {
    return [...this.clients.keys()];
  }

  #isProxied(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.url === 'string' && entry.url.trim()) return 'http';
    if (typeof entry.command === 'string' && entry.command.trim()) {
      const alreadyLocalBridge = Array.isArray(entry.args) && entry.args.some(a => typeof a === 'string' && a.endsWith('mcp-local.py'));
      if (alreadyLocalBridge) return null;
      return 'stdio';
    }
    return null;
  }

  #makeClient(kind, entry, cwd) {
    return kind === 'http' ? new LocalHttpMcpClient(entry) : new LocalStdioMcpClient(entry, cwd);
  }

  registerServers(serversObj, remoteRoot, cwd) {
    const rewritten = {};
    if (!serversObj || typeof serversObj !== 'object') return rewritten;
    for (const [name, entry] of Object.entries(serversObj)) {
      if (!SERVER_NAME_RE.test(name)) {
        rewritten[name] = entry;
        continue;
      }
      const kind = this.#isProxied(entry);
      if (!kind) {
        rewritten[name] = entry;
        continue;
      }
      const sig = JSON.stringify(entry);
      if (this.configs.get(name) !== sig) {
        const prev = this.clients.get(name);
        if (prev) void prev.closeAll().catch(() => {});
        this.clients.set(name, this.#makeClient(kind, entry, cwd));
        this.configs.set(name, sig);
      }
      rewritten[name] = {
        type: 'stdio',
        command: 'python3',
        args: [`${remoteRoot}/mcp-local.py`, '--server', name],
      };
    }
    return rewritten;
  }

  syncServers(serversObj, remoteRoot, cwd) {
    const nextNames = new Set(Object.keys(serversObj && typeof serversObj === 'object' ? serversObj : {}));
    for (const existingName of [...this.clients.keys()]) {
      if (!nextNames.has(existingName)) {
        const prev = this.clients.get(existingName);
        this.clients.delete(existingName);
        this.configs.delete(existingName);
        if (prev) void prev.closeAll().catch(() => {});
      }
    }
    return this.registerServers(serversObj, remoteRoot, cwd);
  }

  async handle(request) {
    const name = request?.server;
    const client = typeof name === 'string' ? this.clients.get(name) : null;
    if (!client) {
      throw new Error(`Local MCP server "${name ?? ''}" is not registered for this session`);
    }
    return client.handle(request);
  }

  async closeAll() {
    await Promise.allSettled([...this.clients.values()].map(c => c.closeAll()));
    this.clients.clear();
    this.configs.clear();
  }
}
