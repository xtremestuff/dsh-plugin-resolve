/**
 * dsh-plugin-resolve — bridges DaVinci Resolve into DeepSeek Harness (DSH).
 *
 * This Cordis plugin registers DaVinci Resolve's MCP server with DSH's tool
 * runtime, mirroring Blackmagic's own MCPB distribution for Claude
 * (`DaVinciResolve.mcpb` shipped inside the Resolve app):
 *
 *  - Native backend (Resolve Studio 21.1+ `ResolveMCP`): the tool catalog is
 *    obtained at boot with a one-shot `--dump-tools` invocation (no
 *    persistent process). The real server is spawned lazily on the first
 *    tool call, killed after an idle timeout, and respawned on demand.
 *  - Community backend (`davinci-resolve-mcp` npm bootstrapper): no
 *    `--dump-tools` support, so the server runs persistently and its tools
 *    are discovered over a live MCP handshake at activation.
 *
 * Tools are registered on the harness tool registry as
 * `mcp__resolve__<tool>` (e.g. `mcp__resolve__get_resolve_status`,
 * `mcp__resolve__run_script`). The implementation is self-contained
 * (node: builtins only), so a `link:` development install works without a
 * node_modules next to the checkout and a registry install adds no
 * transitive packages.
 *
 * The registration lives for this plugin's lifetime: disabling or
 * uninstalling this bundle disposes the transport and withdraws its tools.
 *
 * Row config (all optional):
 *   mode               'auto' | 'native' | 'community'   (default 'auto')
 *   serverName         tool namespace                     (default 'resolve')
 *   nativeCommand      ResolveMCP executable path         (default per platform)
 *   communityCommand   bootstrapper executable            (default 'npx')
 *   communityArgs      bootstrapper arguments             (default ['-y', 'davinci-resolve-mcp'])
 *   env                extra environment for the server   (object of strings)
 *   cwd                working directory for the server   (string)
 *   toolCallTimeoutMs  per tool-call timeout              (number, ms)
 *
 * @module dsh-plugin-resolve
 */

import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-plugin-resolve'

/** Services required by this plugin (tool registration). */
export const inject = ['tools']

/** Default `ResolveMCP` executable locations shipped with Resolve Studio 21.1+. */
const NATIVE_DEFAULTS = {
  darwin: '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP',
  win32: 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\ResolveMCP.exe',
  linux: '/opt/resolve/bin/ResolveMCP',
}

/** Default community-server launch: the npm bootstrapper over stdio. */
const COMMUNITY_DEFAULT_COMMAND = 'npx'
const COMMUNITY_DEFAULT_ARGS = ['-y', 'davinci-resolve-mcp']

/** MCP `serverName` pattern enforced by DSH's tool naming. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Budgets, aligned with Blackmagic's MCPB wrapper. */
const DUMP_TIMEOUT_MS = 10_000
const INIT_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * Resolve a bare executable name against `PATH`.
 * @param {string} command - absolute/relative path or bare command name.
 * @returns {string | undefined} the usable path, or undefined when not found.
 */
function resolveExecutable(command) {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command) ? command : undefined
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    const candidate = `${dir}/${command}`
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * @param {string} path
 * @returns {boolean} true when the path is an existing regular file.
 */
function isExecutable(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Rewrite an MCP input schema into DSH's supported JSON-Schema subset
 * (type/oneOf/properties/required/additionalProperties/items/enum/const +
 * annotations).
 *  - `type` arrays (native server's `["integer","string"]` offset/timecode
 *    params): a single-type array collapses to that type; a true union drops
 *    `type` so the parameter is unconstrained for DSH while the MCP server
 *    validates it.
 *  - `anyOf` (pydantic emits it for `Optional[...]` params in the community
 *    server): renamed to the supported `oneOf`; branches are sanitized too.
 * @param {unknown} node
 * @returns {unknown} a sanitized copy of the schema node.
 */
function sanitizeSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const out = { ...node }
  if (Array.isArray(out.type)) {
    const supported = out.type.filter((t) => typeof t === 'string')
    if (supported.length === 1) out.type = supported[0]
    else delete out.type
  }
  if (Array.isArray(out.anyOf)) {
    if (!Array.isArray(out.oneOf)) out.oneOf = out.anyOf
    delete out.anyOf
  }
  if (Array.isArray(out.oneOf)) {
    out.oneOf = out.oneOf.map((branch) => sanitizeSchema(branch))
  }
  if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeSchema(value)]),
    )
  }
  if (out.items !== undefined) out.items = sanitizeSchema(out.items)
  return out
}

/**
 * Pick the backend and its stdio launch spec for the configured mode.
 * @param {object} config - resolved row config.
 * @returns {{kind: 'native'|'community', command: string, args: string[]} | undefined}
 */
function pickBackend(config) {
  const mode = config.mode ?? 'auto'
  if (mode !== 'auto' && mode !== 'native' && mode !== 'community') {
    throw new Error(`dsh-plugin-resolve: unknown mode "${mode}" (expected 'auto', 'native', or 'community')`)
  }

  if (mode === 'native' || mode === 'auto') {
    const command = config.nativeCommand ?? NATIVE_DEFAULTS[process.platform]
    const resolved = command ? resolveExecutable(command) : undefined
    if (resolved) return { kind: 'native', command: resolved, args: [] }
    if (mode === 'native') return undefined
  }

  if (mode === 'community' || mode === 'auto') {
    const command = config.communityCommand ?? COMMUNITY_DEFAULT_COMMAND
    const resolved = command ? resolveExecutable(command) : undefined
    if (resolved) {
      const args = Array.isArray(config.communityArgs) ? config.communityArgs : COMMUNITY_DEFAULT_ARGS
      return { kind: 'community', command: resolved, args }
    }
  }

  return undefined
}

/**
 * Shared stdio JSON-RPC machinery for one server child process.
 * Newline-delimited JSON-RPC over stdin/stdout; pending responses are
 * tracked by id, and client lines may be queued until the child finishes
 * its internal handshake.
 */
class StdioJsonRpc {
  /**
   * @param {object} opts
   * @param {string} opts.command
   * @param {string[]} opts.args
   * @param {Record<string, string>} [opts.env]
   * @param {string} [opts.cwd]
   * @param {(message: string) => void} [opts.onStderr]
   * @param {(code: number|null, signal: string) => void} [opts.onExit]
   */
  constructor(opts) {
    this.child = spawn(opts.command, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
    })
    this.nextId = 1
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map()
    this.queued = []
    this.buffer = ''
    this.initialized = false
    this.closed = false
    this.child.on('exit', (code, signal) => {
      this.#settleAll(`server exited (code=${code} signal=${signal})`)
      if (opts.onExit) opts.onExit(code, signal)
    })
    this.child.on('error', (error) => {
      this.#settleAll(`server process error: ${String(error)}`)
    })
    this.child.stdout.on('data', (chunk) => this.#onData(chunk))
    if (opts.onStderr) this.child.stderr.on('data', (chunk) => opts.onStderr(String(chunk)))
    else this.child.stderr.on('data', () => {}) // drain: a full stderr pipe deadlocks the server
  }

  /** @param {Buffer|String} chunk */
  #onData(chunk) {
    this.buffer += chunk.toString()
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === '__wrapper_init__') {
        this.initialized = true
        this.#flushQueue()
        continue
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'MCP RPC error'))
        else waiter.resolve(message.result)
      }
    }
  }

  /** Send a raw JSON-RPC line, queueing it until the child is initialized. */
  sendLine(line) {
    if (this.closed) return
    if (this.initialized) this.child.stdin.write(line + '\n')
    else this.queued.push(line)
  }

  /** Perform the internal handshake (Blackmagic `__wrapper_init__` convention). */
  start() {
    // Written directly (not queued): the init response is what unlocks the queue.
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: '__wrapper_init__', method: 'initialize', params: {} }) + '\n')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }

  #flushQueue() {
    const lines = this.queued
    this.queued = []
    for (const line of lines) this.child.stdin.write(line + '\n')
  }

  /**
   * Send a JSON-RPC request and await its response.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  request(method, params, timeoutMs = 15_000) {
    if (this.closed) return Promise.reject(new Error('MCP transport is closed'))
    const id = this.nextId++
    this.sendLine(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }

  /** @param {string} reason */
  #settleAll(reason) {
    if (this.closed && this.pending.size === 0) return
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(new Error(reason))
    }
  }

  /**
   * Call one tool over this transport (same surface as LazyStdioServer).
   * @param {string} toolName
   * @param {object} [args]
   * @param {number} [timeoutMs]
   * @param {AbortSignal} [signal]
   */
  callTool(toolName, args, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS, signal) {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    const promise = this.request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs)
    if (signal) signal.addEventListener('abort', () => {
      // JSON-RPC has no cancel; drop the waiters so the caller's signal wins.
      for (const [id, waiter] of [...this.pending]) {
        this.pending.delete(id)
        waiter.reject(new Error('aborted'))
      }
    }, { once: true })
    return promise
  }

  /** Kill the child process and settle every pending request. */
  dispose() {
    this.closed = true
    this.#settleAll('MCP transport disposed')
    try { this.child.stdin.end() } catch { /* already gone */ }
    this.child.kill()
  }
}

/**
 * Lazy stdio server following Blackmagic's MCPB wrapper: the process is
 * spawned on first use, killed after an idle timeout, and respawned on
 * demand. Callers get a stable `callTool` surface.
 */
class LazyStdioServer {
  /**
   * @param {object} opts
   * @param {string} opts.command
   * @param {string[]} opts.args
   * @param {Record<string, string>} [opts.env]
   * @param {string} [opts.cwd]
   * @param {(message: string) => void} [opts.onLog]
   * @param {number} [opts.idleTimeoutMs]
   * @param {number} [opts.initTimeoutMs]
   */
  constructor(opts) {
    this.opts = opts
    this.rpc = null
    this.idleTimer = null
    this.initTimer = null
  }

  #resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.rpc) {
        this.opts.onLog?.('ResolveMCP: idle timeout, stopping server')
        this.#stopChild()
      }
    }, this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
  }

  #stopChild() {
    this.rpc?.dispose()
    this.rpc = null
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null }
  }

  /** Spawn (if needed) and initialize the child, waiting for readiness. */
  async #ensureStarted() {
    if (this.rpc && this.rpc.initialized) {
      this.#resetIdleTimer()
      return
    }
    if (this.rpc && !this.rpc.initialized) {
      // Already spawning; wait for the in-flight handshake.
      this.#resetIdleTimer()
      await new Promise((resolve) => {
        const check = () => (this.rpc?.initialized ? resolve() : setTimeout(check, 50))
        check()
      })
      return
    }
    const rpc = new StdioJsonRpc({
      command: this.opts.command,
      args: this.opts.args,
      env: { ...(this.opts.env ?? {}), BMD_IS_MCPB: '1' },
      cwd: this.opts.cwd,
      onStderr: (message) => this.opts.onLog?.(message.trimEnd()),
      onExit: () => {
        if (this.rpc === rpc) {
          this.rpc = null
          if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null }
          if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
        }
      },
    })
    this.rpc = rpc
    rpc.start()
    this.#resetIdleTimer()
    await new Promise((resolve, reject) => {
      this.initTimer = setTimeout(() => {
        this.initTimer = null
        reject(new Error(`MCP server did not initialize within ${INIT_TIMEOUT_MS / 1000}s`))
        this.#stopChild()
      }, this.opts.initTimeoutMs ?? INIT_TIMEOUT_MS)
      const check = () => {
        if (this.rpc !== rpc) { reject(new Error('MCP server process died during startup')); return }
        if (rpc.initialized) {
          if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null }
          resolve()
        } else setTimeout(check, 25)
      }
      check()
    })
  }

  /**
   * Call one tool, spawning the server lazily.
   * @param {string} toolName
   * @param {object} [args]
   * @param {number} [timeoutMs]
   * @param {AbortSignal} [signal]
   */
  async callTool(toolName, args, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS, signal) {
    if (signal?.aborted) throw new Error('aborted')
    await this.#ensureStarted()
    const rpc = this.rpc
    if (!rpc) throw new Error('MCP server unavailable')
    this.#resetIdleTimer()
    const promise = rpc.request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs)
    if (signal) signal.addEventListener('abort', () => {
      // JSON-RPC has no cancel; drop the waiter so the caller's signal wins.
      for (const [id, waiter] of rpc.pending) {
        rpc.pending.delete(id)
        waiter.reject(new Error('aborted'))
      }
    }, { once: true })
    return promise
  }

  /** Stop the child (if running) and release timers. */
  dispose() {
    this.#stopChild()
  }
}

/**
 * One-shot `--dump-tools` probe of the native ResolveMCP binary
 * (Blackmagic MCPB convention). Returns the live tool definitions without
 * keeping a server process alive.
 * @param {string} command
 * @returns {{tools: any[], instructions?: string} | undefined}
 */
function dumpTools(command) {
  try {
    const result = spawnSync(command, ['--dump-tools'], {
      env: { ...process.env, BMD_IS_MCPB: '1' },
      timeout: DUMP_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
    })
    if (result.status === 0 && result.stdout) {
      const dump = JSON.parse(result.stdout)
      return { tools: dump.tools ?? [], instructions: dump.instructions }
    }
  } catch {
    // fall through: the caller decides how to recover
  }
  return undefined
}

/**
 * Extract the user-facing text from an MCP content array.
 * @param {any} content
 * @returns {string}
 */
function extractContentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

/**
 * Register DaVinci Resolve's MCP server with DSH.
 *
 * Fails safe: when no backend is available (Resolve not installed, free
 * edition without the community server, no `npx`) the plugin logs a warning
 * and registers nothing, so the rest of the harness boots normally.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - resolved row config.
 */
export async function apply(ctx, config = {}) {
  const log = ctx.logger

  const serverName = String(config.serverName ?? 'resolve')
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`dsh-plugin-resolve: serverName "${serverName}" must match [A-Za-z0-9_-]{1,32}`)
  }

  const backend = pickBackend(config)
  if (!backend) {
    const hint =
      config.mode === 'native'
        ? 'Install DaVinci Resolve Studio 21.1+ (the native MCP server is Studio-only) and set config.nativeCommand if it lives elsewhere.'
        : config.mode === 'community'
          ? 'Install Node.js (npx) or set config.communityCommand to the davinci-resolve-mcp bootstrapper.'
          : 'Install DaVinci Resolve Studio 21.1+ (native ResolveMCP) or Node.js (community server via npx).'
    log.warn(`dsh-plugin-resolve: no Resolve MCP backend found on this machine. ${hint} No server registered.`)
    return
  }

  const toolCallTimeoutMs = typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : DEFAULT_TOOL_CALL_TIMEOUT_MS
  const env = config.env && typeof config.env === 'object' ? config.env : undefined
  const cwd = typeof config.cwd === 'string' && config.cwd ? config.cwd : undefined
  const onLog = (message) => log.debug(`resolve-mcp: ${message}`)

  /** @type {LazyStdioServer|StdioJsonRpc|null} */
  let server = null
  /** @type {Array<{name: string}>} */
  let tools = []

  try {
    if (backend.kind === 'native') {
      // Blackmagic pattern: one-shot dump for the catalog, lazy process for calls.
      const dump = dumpTools(backend.command)
      if (dump && dump.tools.length > 0) {
        tools = dump.tools
        server = new LazyStdioServer({ command: backend.command, args: backend.args, env, cwd, onLog })
      } else {
        log.warn('dsh-plugin-resolve: --dump-tools unavailable; falling back to a persistent server for tool discovery.')
      }
    }

    if (server === null) {
      // Community backend (or native dump failure): persistent server + live discovery.
      const rpc = new StdioJsonRpc({ command: backend.command, args: backend.args, env, cwd, onStderr: onLog })
      rpc.start()
      const initOk = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), INIT_TIMEOUT_MS)
        const check = () => (rpc.initialized ? (clearTimeout(timer), resolve(true)) : setTimeout(check, 25))
        check()
      })
      if (!initOk) throw new Error('MCP server did not initialize within 30s')
      const listed = await rpc.request('tools/list', {}, INIT_TIMEOUT_MS)
      tools = listed?.tools ?? []
      server = rpc
    }

    /** @type {Array<() => void>} */
    const disposers = []
    for (const tool of tools) {
      const publicName = `mcp__${serverName}__${tool.name}`
      const definition = {
        name: publicName,
        description: tool.description ?? '',
        parameters: sanitizeSchema(tool.inputSchema) ?? { type: 'object', properties: {} },
        output: {
          schema: {
            type: 'object',
            properties: {
              content: { type: 'array', items: {} },
              structuredContent: {},
            },
            required: ['content'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: extractContentText(value?.content) }],
        },
        execute: async (args, exec) => {
          const result = await server.callTool(tool.name, args ?? {}, toolCallTimeoutMs, exec?.signal)
          if (result?.isError === true) {
            const text = Array.isArray(result.content)
              ? result.content.map((part) => (part?.type === 'text' ? part.text : '')).join('\n')
              : 'tool reported an error'
            throw new Error(text || 'tool reported an error')
          }
          return {
            content: result?.content ?? [],
            ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
          }
        },
      }
      disposers.push(ctx.tools.register(definition))
    }

    // Lifetime scope: uninstalling the bundle disposes the transport and
    // withdraws every registered tool. `ctx.effect(execute, label)` runs
    // `execute` at registration and collects whatever it *returns* as the
    // teardown hook — so return the disposer from a thunk.
    ctx.effect(() => () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* already withdrawn */ }
      }
      server.dispose()
    }, 'dsh-plugin-resolve.mcp')

    log.info(
      `dsh-plugin-resolve: registered ${tools.length} Resolve tools as mcp__${serverName}__* via ${backend.kind} backend ` +
        `(${backend.command} ${backend.args.join(' ')}${backend.kind === 'native' ? ', lazy spawn on first call, idle kill after 5 min' : ''}).`,
    )
  } catch (error) {
    server?.dispose()
    log.warn(`dsh-plugin-resolve: could not start the Resolve MCP server (${backend.kind} backend at ${backend.command}): ${String(error)}. No tools registered.`)
  }
}
