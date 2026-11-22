import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  evaluateLocalMcpToolCall,
  normalizeMcpName,
  validateLocalMcpServerConfig,
} from './mcp-policy.mjs';

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 290_000;
const DEFAULT_HTTP_CLOSE_TIMEOUT_MS = 3_000;
const DEFAULT_STDIO_REQUEST_TIMEOUT_MS = 120_000;
const INVALID_HTTP_SESSION = /\bmcp[-_ ]session[-_ ]id\b|\b(?:invalid|unknown|expired|missing|unrecognized|no such)\b.{0,35}\bsession\b|\bsession\b.{0,35}\b(?:invalid|unknown|expired|missing|not found)\b/is;

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

function mcpError(message, code, jsonRpcCode = -32603) {
  return Object.assign(new Error(message), { code, jsonRpcCode });
}

function isStrictMatchingReply(payload, expectedId) {
  return isRpcReplyWithId(payload) && payload.id === expectedId;
}

function isRpcReplyWithId(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && payload.jsonrpc === '2.0'
    && Object.hasOwn(payload, 'id')
    && (Object.hasOwn(payload, 'result') !== Object.hasOwn(payload, 'error')),
  );
}

function typedIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

/**
 * Local Windows-only Streamable HTTP MCP client (for T3 Code's t3-code endpoint and user HTTP MCPs).
 * Local endpoint URLs and Authorization headers stay strictly inside this Windows process.
 *
 * - Incrementally parses SSE events and returns immediately when the exact JSON-RPC id matches
 *   (never blocks waiting for an open SSE stream to hit EOF).
 * - Strictly matches JSON-RPC id; mismatched or missing replies fail explicitly.
 * - Enforces request and close timeouts; distinguishes expired sessions (-32001) from
 *   post-dispatch uncertain outcomes (-32002) and never replays side-effecting calls.
 */
export class LocalHttpMcpClient {
  constructor(serverConfig, options = {}) {
    this.url = serverConfig?.url?.trim() ?? null;
    this.headers = { ...(serverConfig?.headers ?? {}) };
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
    this.closeTimeoutMs = Number.isFinite(options.closeTimeoutMs) && options.closeTimeoutMs > 0
      ? options.closeTimeoutMs
      : DEFAULT_HTTP_CLOSE_TIMEOUT_MS;
    this.connections = new Map();
  }

  get enabled() {
    return typeof this.url === 'string' && this.url.length > 0;
  }

  #getOrCreate(connectionId) {
    let conn = this.connections.get(connectionId);
    if (!conn) {
      conn = { sessionId: null, protocolVersion: null, initChain: Promise.resolve(), active: new Set(), closed: false, expired: false };
      this.connections.set(connectionId, conn);
    }
    return conn;
  }

  async #readSseForFrame(response, frame, isNotification) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      if (isNotification) return {};
      throw mcpError(
        `Local HTTP MCP SSE response had no readable body for request id ${JSON.stringify(frame.id)}`,
        'MCP_NO_MATCHING_RESPONSE',
        -32603,
      );
    }

    if (isNotification) {
      void response.body.cancel().catch(() => {});
      return {};
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let skipLf = false;
    let dataLines = [];
    let sawMismatchedId = false;
    let firstMismatchedId = null;

    const inspectPayload = payload => {
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) {
        if (isStrictMatchingReply(item, frame.id)) {
          return item;
        }
        if (isRpcReplyWithId(item) && !sawMismatchedId) {
          sawMismatchedId = true;
          firstMismatchedId = item.id;
        }
      }
      return null;
    };

    const flushEvent = () => {
      if (!dataLines.length) return null;
      const text = dataLines.join('\n').trim();
      dataLines = [];
      if (!text || text === '[DONE]') return null;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      return inspectPayload(parsed);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (skipLf && buffer) {
          if (buffer.startsWith('\n')) buffer = buffer.slice(1);
          skipLf = false;
        }
        let nlIdx;
        while ((nlIdx = buffer.search(/[\r\n]/)) >= 0) {
          const line = buffer.slice(0, nlIdx);
          const crlf = buffer[nlIdx] === '\r' && buffer[nlIdx + 1] === '\n';
          skipLf = buffer[nlIdx] === '\r' && nlIdx === buffer.length - 1;
          buffer = buffer.slice(nlIdx + (crlf ? 2 : 1));
          if (line === '') {
            const matched = flushEvent();
            if (matched) {
              return matched;
            }
            continue;
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }

      if (sawMismatchedId) {
        throw mcpError(
          `Local HTTP MCP SSE response id mismatch: expected ${JSON.stringify(frame.id)}, got ${JSON.stringify(firstMismatchedId)}`,
          'MCP_ID_MISMATCH',
          -32603,
        );
      }
      throw mcpError(
        `Local HTTP MCP SSE stream ended without a matching JSON-RPC response for id ${JSON.stringify(frame.id)}`,
        'MCP_NO_MATCHING_RESPONSE',
        -32603,
      );
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async #readJsonForFrame(response, frame, isNotification) {
    if (isNotification) {
      void response.body?.cancel().catch(() => {});
      return {};
    }
    const raw = await response.text();
    if (!raw.trim()) {
      throw mcpError(
        `Local HTTP MCP returned an empty response body for request id ${JSON.stringify(frame.id)}`,
        'MCP_NO_MATCHING_RESPONSE',
        -32603,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw mcpError(
        `Local HTTP MCP returned invalid JSON for request id ${JSON.stringify(frame.id)}: ${err?.message ?? 'parse error'}`,
        'MCP_INVALID_RESPONSE',
        -32603,
      );
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let sawMismatchedId = false;
    let firstMismatchedId = null;
    for (const item of items) {
      if (isStrictMatchingReply(item, frame.id)) {
        return item;
      }
      if (isRpcReplyWithId(item) && !sawMismatchedId) {
        sawMismatchedId = true;
        firstMismatchedId = item.id;
      }
    }
    if (sawMismatchedId) {
      throw mcpError(
        `Local HTTP MCP response id mismatch: expected ${JSON.stringify(frame.id)}, got ${JSON.stringify(firstMismatchedId)}`,
        'MCP_ID_MISMATCH',
        -32603,
      );
    }
    throw mcpError(
      `Local HTTP MCP JSON response did not contain a valid reply for id ${JSON.stringify(frame.id)}`,
      'MCP_NO_MATCHING_RESPONSE',
      -32603,
    );
  }

  async #post(conn, frame, isNotification) {
    const initializing = frame.method === 'initialize';
    if (conn.closed || (conn.expired && !initializing)) {
      throw mcpError('Local HTTP MCP session is closed or expired; initialize a new session', 'MCP_SESSION_EXPIRED', -32001);
    }
    const sentSessionId = initializing ? null : conn.sessionId;
    const headers = new Headers(this.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    headers.delete('mcp-session-id');
    headers.delete('mcp-protocol-version');
    if (sentSessionId) headers.set('mcp-session-id', sentSessionId);
    if (!initializing && conn.protocolVersion) headers.set('mcp-protocol-version', conn.protocolVersion);

    const controller = new AbortController();
    conn.active.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, this.requestTimeoutMs);

    try {
      let response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(frame),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (err) {
        if (timedOut) {
          throw mcpError(
            `Local HTTP MCP request timed out after ${this.requestTimeoutMs}ms; execution outcome is unknown and no operation was replayed`,
            'MCP_OUTCOME_UNKNOWN',
            -32002,
          );
        }
        const causeCode = err?.cause?.code ?? err?.code ?? '';
        if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(causeCode)) {
          throw mcpError(
            `Local HTTP MCP endpoint unreachable (${causeCode}); request was not sent`,
            'MCP_CONNECT_FAILED',
            -32003,
          );
        }
        throw mcpError(
          `Local HTTP MCP transport error after dispatch (${err?.message ?? 'network error'}); execution outcome is unknown and no operation was replayed`,
          'MCP_OUTCOME_UNKNOWN',
          -32002,
        );
      }

      if (!response.ok) {
        const errText = response.status === 400 && sentSessionId ? await response.text() : '';
        const sessionInvalid = Boolean(sentSessionId) && (response.status === 404
          || (response.status === 400 && INVALID_HTTP_SESSION.test(errText)));
        if (sessionInvalid) {
          if (conn.sessionId === sentSessionId) {
            conn.sessionId = null;
            conn.protocolVersion = null;
            conn.expired = true;
          }
          throw mcpError(
            `Local HTTP MCP session expired or invalid (HTTP ${response.status}); reconnect required and no operation was replayed`,
            'MCP_SESSION_EXPIRED',
            -32001,
          );
        }
        throw mcpError(
          `Local HTTP MCP endpoint responded with HTTP ${response.status}`,
          'MCP_HTTP_ERROR',
          -32603,
        );
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      try {
        const reply = contentType.includes('text/event-stream')
          ? await this.#readSseForFrame(response, frame, isNotification)
          : await this.#readJsonForFrame(response, frame, isNotification);
        if (initializing && typeof reply?.result?.protocolVersion === 'string' && reply.result.protocolVersion) {
          conn.sessionId = response.headers.get('mcp-session-id');
          conn.protocolVersion = reply.result.protocolVersion;
          conn.expired = false;
        }
        return reply;
      } catch (err) {
        if (timedOut) {
          throw mcpError(
            `Local HTTP MCP response timed out after ${this.requestTimeoutMs}ms; execution outcome is unknown and no operation was replayed`,
            'MCP_OUTCOME_UNKNOWN',
            -32002,
          );
        }
        if (err?.code && String(err.code).startsWith('MCP_')) throw err;
        throw mcpError(
          `Local HTTP MCP stream failed while reading response (${err?.message ?? 'stream error'}); execution outcome is unknown and no operation was replayed`,
          'MCP_OUTCOME_UNKNOWN',
          -32002,
        );
      }
    } catch (err) {
      if (!timedOut || err?.code === 'MCP_OUTCOME_UNKNOWN') throw err;
      throw mcpError(
        `Local HTTP MCP request timed out after ${this.requestTimeoutMs}ms; execution outcome is unknown and no operation was replayed`,
        'MCP_OUTCOME_UNKNOWN',
        -32002,
      );
    } finally {
      clearTimeout(timer);
      conn.active.delete(controller);
      controller.abort();
    }
  }

  async #disconnect(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return {};
    this.connections.delete(connectionId);
    conn.closed = true;
    for (const controller of conn.active) controller.abort();
    if (!conn.sessionId || !this.url) return {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('close-timeout'), this.closeTimeoutMs);
    try {
      const headers = new Headers(this.headers);
      headers.set('mcp-session-id', conn.sessionId);
      if (conn.protocolVersion) headers.set('mcp-protocol-version', conn.protocolVersion);
      const response = await fetch(this.url, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
        redirect: 'error',
      });
      void response.body?.cancel().catch(() => {});
    } catch {
      // Best-effort disconnect on shutdown; never hang past closeTimeoutMs.
    } finally {
      clearTimeout(timer);
      controller.abort();
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
    if (frame.id != null && !['number', 'string'].includes(typeof frame.id)) {
      throw new Error('Invalid MCP JSON-RPC request ID');
    }
    const conn = this.#getOrCreate(connectionId);
    const isNotification = frame.id === undefined || frame.id === null;

    const run = async () => {
      try {
        const reply = await this.#post(conn, frame, isNotification);
        return isNotification ? {} : reply;
      } catch (err) {
        if (isNotification) return {};
        return {
          jsonrpc: '2.0',
          id: frame.id,
          error: {
            code: typeof err?.jsonRpcCode === 'number' ? err.jsonRpcCode : -32603,
            message: err?.message ?? 'Local HTTP MCP request failed',
            ...(err?.code ? { data: { code: err.code } } : {}),
          },
        };
      }
    };

    if (!conn.protocolVersion || frame.method === 'initialize') {
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
  constructor(serverConfig, cwd, options = {}) {
    this.command = serverConfig?.command ?? null;
    this.args = Array.isArray(serverConfig?.args) ? serverConfig.args.map(String) : [];
    this.env = serverConfig?.env && typeof serverConfig.env === 'object' ? { ...serverConfig.env } : {};
    this.cwd = typeof serverConfig?.cwd === 'string' && serverConfig.cwd ? serverConfig.cwd : cwd;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : DEFAULT_STDIO_REQUEST_TIMEOUT_MS;
    this.onDisconnect = options.onDisconnect;
    this.connections = new Map();
  }

  get enabled() {
    return typeof this.command === 'string' && this.command.trim().length > 0;
  }

  #stop(connectionId, error = mcpError('Local stdio MCP closed; execution outcome is unknown and no operation was replayed', 'MCP_OUTCOME_UNKNOWN', -32002), expected) {
    const conn = this.connections.get(connectionId);
    if (!conn || (expected && conn !== expected)) return;
    this.connections.delete(connectionId);
    this.onDisconnect?.(connectionId);
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
      rl: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    };
    this.connections.set(connectionId, conn);

    child.stderr.resume();
    const transportError = () => this.#stop(connectionId, undefined, conn);
    child.stdin.on('error', transportError);
    child.on('error', transportError);
    child.on('exit', code => {
      this.#stop(
        connectionId,
        mcpError(
          `Local stdio MCP exited (${code ?? 'signal'}); execution outcome is unknown and no operation was replayed`,
          'MCP_OUTCOME_UNKNOWN',
          -32002,
        ),
        conn,
      );
    });

    conn.rl.on('line', line => {
      if (!line.trim()) return;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRpcReplyWithId(reply)) return;
      const key = typedIdKey(reply.id);
      const pending = conn.pending.get(key);
      if (!pending) return;
      conn.pending.delete(key);
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

    const reqKey = typedIdKey(frame.id);
    if (!['number', 'string'].includes(typeof frame.id) || conn.pending.has(reqKey)) {
      return { jsonrpc: '2.0', id: frame.id, error: { code: -32600, message: 'Invalid or duplicate in-flight JSON-RPC request ID' } };
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        // End the connection so a late reply cannot satisfy a later request reusing this ID.
        this.#stop(connectionId, mcpError(
          `Local stdio MCP request timed out after ${this.requestTimeoutMs}ms; execution outcome is unknown and no operation was replayed`,
          'MCP_OUTCOME_UNKNOWN', -32002,
        ), conn);
      }, this.requestTimeoutMs);

      conn.pending.set(reqKey, {
        timer,
        resolve,
        reject: err => {
          resolve({
            jsonrpc: '2.0',
            id: frame.id,
            error: {
              code: typeof err?.jsonRpcCode === 'number' ? err.jsonRpcCode : -32603,
              message: err?.message ?? 'Local stdio MCP failed',
              ...(err?.code ? { data: { code: err.code } } : {}),
            },
          });
        },
      });

      try {
        conn.child.stdin.write(payload);
      } catch {
        this.#stop(connectionId, undefined, conn);
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
 * - Strictly validates every local config before proxying (never leaks url/headers/env to VPS).
 * - Enforces shared local MCP policy (Plan mode fail-closed, allow/deny, project deny rules)
 *   before every tools/call and filters tools/list.
 */
export class LocalMcpHub {
  constructor(options = {}) {
    this.options = options;
    this.clients = new Map();
    this.configs = new Map();
    this.toolCatalogs = new Map();
  }

  has(name) {
    return this.clients.has(name);
  }

  names() {
    return [...this.clients.keys()];
  }

  getToolMeta(serverName, connectionId, toolName) {
    return this.toolCatalogs.get(serverName)?.get(connectionId)?.get(toolName) ?? { known: false };
  }

  #makeClient(kind, entry, cwd, catalogs) {
    return kind === 'http'
      ? new LocalHttpMcpClient(entry, this.options)
      : new LocalStdioMcpClient(entry, cwd, { ...this.options, onDisconnect: id => catalogs.delete(id) });
  }

  #validateAll(serversObj) {
    if (!serversObj || typeof serversObj !== 'object' || Array.isArray(serversObj)) {
      throw new Error('Local MCP servers configuration must be an object');
    }
    const validated = [];
    const normalized = new Set();
    for (const [name, entry] of Object.entries(serversObj)) {
      const check = validateLocalMcpServerConfig(name, entry);
      if (!check.ok) {
        throw new Error(check.error);
      }
      const key = normalizeMcpName(name);
      if (normalized.has(key)) throw new Error(`Ambiguous local MCP server name "${name}"`);
      normalized.add(key);
      validated.push({ name, entry, kind: check.kind });
    }
    return validated;
  }

  registerServers(serversObj, remoteRoot, cwd) {
    return this.syncServers(serversObj, remoteRoot, cwd);
  }

  syncServers(serversObj, remoteRoot, cwd) {
    const staged = this.stageServers(serversObj, remoteRoot, cwd);
    staged.finish(true);
    return staged.servers;
  }

  stageServers(serversObj, remoteRoot, cwd) {
    const validated = this.#validateAll(serversObj);
    const previous = { clients: this.clients, configs: this.configs, toolCatalogs: this.toolCatalogs };
    const clients = new Map();
    const configs = new Map();
    const toolCatalogs = new Map();
    for (const { name, entry, kind } of validated) {
      const signature = JSON.stringify([entry, cwd]);
      configs.set(name, signature);
      if (previous.configs.get(name) === signature) {
        clients.set(name, previous.clients.get(name));
        toolCatalogs.set(name, previous.toolCatalogs.get(name));
      } else {
        const catalogs = new Map();
        toolCatalogs.set(name, catalogs);
        clients.set(name, this.#makeClient(kind, entry, cwd, catalogs));
      }
    }
    Object.assign(this, { clients, configs, toolCatalogs });
    return {
      servers: Object.fromEntries(validated.map(({ name }) => [name, {
        type: 'stdio', command: 'python3', args: [path.posix.join(remoteRoot, 'mcp-local.py'), '--server', name],
      }])),
      finish: accepted => {
        if (!accepted) Object.assign(this, previous);
        const discarded = accepted ? previous.clients : clients;
        for (const [name, client] of discarded) {
          if (this.clients.get(name) !== client) void client.closeAll().catch(() => {});
        }
      },
    };
  }

  async handle(request, policyContext = {}) {
    const name = request?.server;
    const client = typeof name === 'string' ? this.clients.get(name) : null;
    if (!client) {
      throw new Error(`Local MCP server "${name ?? ''}" is not registered for this session`);
    }
    const frame = request?.frame;
    const catalogs = this.toolCatalogs.get(name);
    const connectionId = request.connectionId;
    if (request.close || frame?.method === 'initialize') catalogs.delete(connectionId);
    if (!request?.close && frame?.method === 'tools/call') {
      const toolName = frame.params?.name;
      const decision = evaluateLocalMcpToolCall({
        server: name,
        toolName,
        permissionMode: policyContext.permissionMode ?? 'default',
        t3Policy: policyContext.t3Policy ?? null,
        projectPermissions: policyContext.projectPermissions ?? null,
        toolMeta: this.getToolMeta(name, connectionId, toolName),
      });
      if (!decision.allowed) {
        return {
          jsonrpc: '2.0',
          id: frame.id,
          error: {
            code: -32602,
            message: decision.reason,
          },
        };
      }
    }

    const reply = await client.handle(request);

    if (reply?.error?.data?.code === 'MCP_SESSION_EXPIRED' || reply?.error?.data?.code === 'MCP_OUTCOME_UNKNOWN') catalogs.delete(connectionId);
    if (!request?.close && frame?.method === 'tools/list' && Array.isArray(reply?.result?.tools)
        && this.clients.get(name) === client) {
      const catalog = (frame.params?.cursor && catalogs.get(connectionId)) || new Map();
      const filteredTools = [];
      for (const tool of reply.result.tools) {
        if (!tool || typeof tool.name !== 'string') continue;
        catalog.set(tool.name, {
          known: true,
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          destructiveHint: tool.annotations?.destructiveHint !== undefined && tool.annotations.destructiveHint !== false,
        });
        const projectCheck = evaluateLocalMcpToolCall({
          server: name,
          toolName: tool.name,
          permissionMode: 'default',
          t3Policy: policyContext.t3Policy ?? null,
          projectPermissions: policyContext.projectPermissions ?? null,
          toolMeta: catalog.get(tool.name),
        });
        if (!projectCheck.allowed) continue;
        filteredTools.push(tool);
      }
      catalogs.set(connectionId, catalog);
      return {
        ...reply,
        result: {
          ...reply.result,
          tools: filteredTools,
        },
      };
    }

    return reply;
  }

  async closeAll() {
    await Promise.allSettled([...this.clients.values()].map(c => c.closeAll()));
    this.clients.clear();
    this.configs.clear();
    this.toolCatalogs.clear();
  }
}
