/**
 * `apps/cli/mcp-server-setup.ts` — TICKET-19 reverse-MCP composition root.
 *
 * The ONLY place `@/agent` (`dispatchTool` + the assembled `AgentConfig`/
 * registry) and `@/mcp` (`buildMcpServer`) meet. The `@/mcp` slice fence forbids
 * `@/mcp` importing `@/agent`/`@/tool`, so {@link McpServer} takes duck-typed
 * ports; THIS adapter binds the real dispatch + registry to those ports.
 *
 * `quanta mcp-server` makes quanta an MCP server an EXTERNAL client (Claude
 * Desktop, Cursor, …) drives over stdio JSON-RPC. That is an RCE surface, so:
 *
 *   - GATE: `gateOnStrict(env,'QUANTA_MCP_SERVER')` — exact `=1` (a stray
 *     `on`/`true` is REFUSED). Off ⇒ exit 64, NOTHING assembled, stdout empty.
 *   - WHITELIST: only READ-ONLY tools are exposed by default; a mutating tool
 *     appears IFF named in `QUANTA_MCP_SERVER_EXPOSE` (comma list, each VALIDATED
 *     against the registry — an unknown name warns to stderr, never widens).
 *   - DISPATCH FENCE: `tools/call` folds the REAL `dispatchTool` (full
 *     permission / HARD_DENY / HITL / jail / redactSecrets pipeline). Even a
 *     force-opted-in mutating tool still hits the permission gate — it surfaces
 *     as an `isError` tool_result, never a raw breakout.
 *   - PROTOCOL CHANNEL: stdout is PURE JSON-RPC; the start banner + every
 *     diagnostic goes to STDERR only.
 *
 * No-throw at the boundary: {@link runMcpServerCmd} returns a numeric exit code
 * and NEVER rejects (mirrors `batch-cmd.ts`). A missing API key (assembly fault)
 * → exit 64 with a logged reason; the pump itself is no-throw by `McpServer`'s
 * contract.
 */

import { randomBytes } from "node:crypto"
import { buildMcpServer, type ToolCallPort, type ToolListSource } from "@/mcp"
import { errMessage, gateOn, gateOnStrict } from "@/shared"
import type { Tool, ToolOrigin } from "@/tool"

/** EX_USAGE — gate-off / argument / assembly fault (BSD sysexits). */
const EXIT_USAGE = 64
const EXIT_OK = 0

/** Minimal IO seam — injected so the hellgate test drives the command without
 *  touching real process streams or stdin. `stdin` yields raw byte chunks; the
 *  server's pump frames them. */
export interface McpServerCmdIo {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
  readonly stdin: AsyncIterable<Uint8Array>
}

/** Composition-root dependency seam (test-injectable). Production leaves every
 *  field unset so the real builders are used; the hellgate test overrides
 *  {@link lspToolsForBridge} with fake-provider-backed tools to observe a real
 *  effect through the full JSON-RPC pipeline without a language-server binary. */
export interface McpServerCmdDeps {
  /** T06 LSP-as-MCP bridge — build the LSP tool list merged into the registry
   *  when `QUANTA_LSP_MCP` is set. Unset ⇒ the real `lspNavToolList()` +
   *  `lspDiagnosticsTool()` (from `@/agent`) are built lazily. The returned
   *  list is filtered to READ-ONLY tools before exposure regardless. */
  readonly lspToolsForBridge?: () => Tool[]
}

/** Default IO bound to the real process. Constructed ONLY on an actual
 *  `quanta mcp-server` invocation (the test injects its own). stdout carries the
 *  JSON-RPC protocol channel; stderr carries the banner + diagnostics. */
const defaultIo = (): McpServerCmdIo => ({
  out: (s) => {
    process.stdout.write(s)
  },
  err: (s) => {
    process.stderr.write(s)
  },
  stdin: process.stdin,
})

/** Usage text. Pure data — no I/O, no assembly. */
export const mcpServerUsage = (): string =>
  `quanta mcp-server — expose quanta AS an MCP server over stdio (TICKET-19)

USAGE
  QUANTA_MCP_SERVER=1 quanta mcp-server

DESCRIPTION
  Lets an external MCP client (Claude Desktop, Cursor, …) call quanta's tools
  over newline-delimited JSON-RPC on stdin/stdout. SECURITY: only READ-ONLY
  tools are exposed by default — an external client calling a mutating tool
  would be remote code execution.

GATE
  QUANTA_MCP_SERVER=1          REQUIRED (strict === '1'; a loose 'on' is refused).
                              Unset ⇒ this command exits 64 and assembles nothing.

OPT-IN (per tool, deliberate)
  QUANTA_MCP_SERVER_EXPOSE     Comma list of additional tool names to expose
                              (e.g. 'write,bash'). Each is validated against the
                              registry; an unknown name warns and is ignored.
                              An opted-in mutating tool STILL passes through the
                              full permission / jail pipeline on every call.

CHANNELS
  • stdout is PURE JSON-RPC (the protocol channel — never written to directly).
  • stderr carries the start banner + diagnostics.

  --help, -h                  Print this help and exit.
`

/** Parse `QUANTA_MCP_SERVER_EXPOSE` into a validated opt-in list. Each name is
 *  checked against the registry's actual tool set; an unknown name is WARNED to
 *  stderr and dropped (never silently widens the surface). */
const resolveExplicitOptIn = (
  raw: string | undefined,
  knownNames: ReadonlySet<string>,
  io: McpServerCmdIo,
): string[] => {
  if (raw === undefined || raw.trim().length === 0) return []
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const valid: string[] = []
  for (const name of requested) {
    if (knownNames.has(name)) valid.push(name)
    else io.err(`quanta mcp-server: ignoring unknown tool in QUANTA_MCP_SERVER_EXPOSE: '${name}'\n`)
  }
  return valid
}

/** Mint a unique, replay-stable tool-call id (the synthesized `ToolUseBlock.id`
 *  the dispatch dedup / observability surfaces key off). */
const idMinter = (): (() => string) => {
  let seq = 0
  const salt = randomBytes(3).toString("hex")
  return () => `mcp-server-${salt}-${(seq++).toString(36)}`
}

/** T06 — build the read-only LSP tool set and merge it into the assembled
 *  registry (returns a fresh {@link ToolRegistry}). `override` (test seam)
 *  supplies fake-provider-backed tools; production builds the real
 *  `lspNavToolList()` + `lspDiagnosticsTool()` from `@/agent` lazily (nothing
 *  spawns a server until a tool is actually CALLED).
 *
 *  Only READ-ONLY tools are merged — a mutating LSP tool (`lsp_rename_apply`,
 *  bundled in `lspNavToolList()`) is dropped (the whitelist would block it
 *  anyway, but we don't even register it).
 *
 *  Merge is OVERRIDE-by-name (bridge tools last ⇒ `ToolRegistry` set() lets
 *  them win): the base `diagnostics` tool ships a `nullDiagnosticsProvider`
 *  (always "no language server"), so the bridge's real-provider `diagnostics`
 *  must REPLACE it — otherwise the gate would expose a permanently-empty tool.
 *  The `lsp_*` nav tools are net-new names (no base collision). The origin map
 *  is preserved (and bridged tools tagged `lsp`) so provenance/trust derivation
 *  is unchanged for every pre-existing tool. */
const mergeLspBridgeTools = async (
  config: import("@/agent").AgentConfig,
  override: (() => Tool[]) | undefined,
  io: McpServerCmdIo,
): Promise<import("@/tool").ToolRegistry> => {
  const [{ ToolRegistry }, agent] = await Promise.all([import("@/tool"), import("@/agent")])
  const built = override ? override() : [...agent.lspNavToolList(), agent.lspDiagnosticsTool()]
  const readOnly = built.filter((t) => t.isReadOnly())
  if (readOnly.length === 0) return config.registry
  const currentTools = config.registry
    .specs()
    .map((s) => config.registry.get(s.name))
    .filter((t): t is Tool => t !== undefined)
  const origin = new Map<string, ToolOrigin>()
  for (const s of config.registry.specs()) origin.set(s.name, config.registry.originOf(s.name))
  for (const t of readOnly) origin.set(t.name, "lsp")
  io.err(`quanta MCP server · LSP bridge on (+${readOnly.length} read-only LSP tools)\n`)
  return new ToolRegistry([...currentTools, ...readOnly], origin)
}

/**
 * Run the `quanta mcp-server` subcommand. NO-THROW: returns a numeric exit code,
 * never rejects. `argv` is `process.argv.slice(3)` (everything after
 * `quanta mcp-server`).
 *
 * Order is deliberate for the security posture:
 *   1. `--help` returns BEFORE any gate / assembly (no API key needed).
 *   2. The strict gate is checked BEFORE any agent assembly — gate-off does
 *      ZERO work (no LLM, no FS, no config), so stdout stays empty.
 *   3. Only then do we dynamic-import `@/host/runtime` + `@/agent`, assemble a
 *      headless config, build the read-only whitelist, and pump stdin.
 */
export const runMcpServerCmd = async (
  argv: readonly string[],
  injectedIo?: McpServerCmdIo,
  deps?: McpServerCmdDeps,
): Promise<number> => {
  const io = injectedIo ?? defaultIo()

  // 1. Help short-circuits before the gate + assembly.
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(mcpServerUsage())
    return EXIT_OK
  }

  // 2. STRICT security gate. Default-OFF byte-identity: nothing is assembled,
  //    no LLM / FS / config touched, stdout stays empty.
  if (!gateOnStrict(process.env, "QUANTA_MCP_SERVER")) {
    io.err("reverse MCP server disabled (set QUANTA_MCP_SERVER=1)\n")
    return EXIT_USAGE
  }

  // 3. Assemble the headless parent config (the ONLY place @/agent meets @/mcp).
  //    Dynamic import keeps the heavy agent assembly out of the common startup
  //    path AND off the gate-off fast path above.
  return await assembleAndServe(io, deps)
}

/** Assemble the headless config, build the whitelisted server, and pump stdin.
 *  Split out so {@link runMcpServerCmd} owns only the help + gate fast paths. */
const assembleAndServe = async (io: McpServerCmdIo, deps?: McpServerCmdDeps): Promise<number> => {
  // `assembleAgentConfig` + the arg builders live in `@/host/runtime` (ADR-0303
  // thin-surface). `dispatchTool` is internal to `@/agent` (not on the barrel),
  // so it is reached via the deep `@/agent/dispatch` specifier — the same
  // deep-import pattern `@/host`/`@/apps` already use for agent internals.
  const [
    { parseAgentArgs, buildBaseFromArgs, toAssembleRequest, assembleAgentConfig },
    { dispatchTool },
  ] = await Promise.all([import("@/host/runtime"), import("@/agent/dispatch")])

  // Build a headless AgentConfig. The `-p` placeholder satisfies headless arg
  // validation; the server never enters the parent's own agent loop (each
  // tools/call is a single dispatch), so the prompt is never consumed.
  let config: import("@/agent").AgentConfig
  try {
    const partial = toAssembleRequest(
      parseAgentArgs(["--mode", "headless", "-p", "mcp-server-parent"]),
    )
    const base = buildBaseFromArgs(partial)
    // The `@/host/runtime` assembler is env-pure: the surface (here) threads the
    // launch-time `process.env` in (the single composition-root env touchpoint).
    // `dials` is spread conditionally (exactOptionalPropertyTypes: never pass an
    // explicit `undefined`).
    config = assembleAgentConfig(
      {
        mode: partial.mode,
        base,
        ...(partial.dials !== undefined ? { dials: partial.dials } : {}),
      },
      process.env,
    )
  } catch (e) {
    // Most likely a missing API key (ProviderKeyMissingError). NO-THROW: surface
    // on stderr (NEVER stdout — that is the protocol channel) and exit 64.
    io.err(`quanta mcp-server: cannot assemble config: ${errMessage(e)}\n`)
    return EXIT_USAGE
  }

  // T06 — LSP-as-MCP bridge. quanta already owns the LSP client AND read-only
  // LSP tools (`lsp_diagnostics` / `lsp_references` / `lsp_workspace_symbol` /
  // …), but this headless `assembleAgentConfig` path wires neither the `lsp`
  // knob nor the CLI's `QUANTA_LSP_TOOLS` surface — so they never reach this
  // server's registry. When `QUANTA_LSP_MCP` is set we merge the EXISTING tools
  // in (NOT new duplicates), giving an external/CLI client real code
  // intelligence without an IDE — Codex IDE's `vscode-codex-lsp-mcp-server`
  // parity. Filtered to READ-ONLY (the whitelist would block mutating ones
  // anyway; we don't even register `lsp_rename_apply`). Default-OFF: gate unset
  // ⇒ this branch is skipped and the surface is byte-identical to today. This
  // file is the reverse-MCP composition root (env-read exempt per the
  // no-raw-process-env ratchet), so the gate read lives here beside the server
  // gate. The new registry is rebuilt so `dispatchTool` (which resolves tools
  // from `config.registry`) can find the bridged tools on `tools/call`.
  // Reassign ONLY when the gate is on — the OFF path leaves `config` (and its
  // registry) the exact object `assembleAgentConfig` returned, so default-OFF is
  // LITERALLY byte-identical (no spread, no new object).
  if (gateOn(process.env, "QUANTA_LSP_MCP")) {
    config = { ...config, registry: await mergeLspBridgeTools(config, deps?.lspToolsForBridge, io) }
  }
  const registry = config.registry
  const knownNames = new Set(registry.specs().map((s) => s.name))

  // ToolListSource over the assembled registry: `specs()` enumerates the
  // surface; `readOnly` is the WHITELIST SSOT (registry.isReadOnly).
  const toolList: ToolListSource = {
    specs: () => registry.specs(),
    readOnly: (name) => registry.isReadOnly(name),
  }

  // SECURITY — the permission posture for an EXTERNAL-client RCE surface is
  // fail-closed, NOT the parent's. A headless `assembleAgentConfig` resolves
  // `config.permission.mode === "acceptEdits"`, which `@/permission` `evaluate`
  // AUTO-ALLOWS for mutating tools (policy.ts `global-default`). Reusing it would
  // let a force-opted-in `write` execute against the FS — the exact RCE this
  // command exists to prevent. Instead we dispatch under an explicit `"default"`
  // context: read-only tools are allowed (`read-only-bypass`), HARD_DENY shell
  // is denied, and EVERY mutating tool is `ask` → and because no reviewer port is
  // wired in this headless server, the admissibility gate collapses `ask` to a
  // hard DENY. So an opted-in `write` still APPEARS in tools/list but every call
  // returns an `isError` result and NEVER touches the disk. (A future operator
  // who genuinely wants unattended mutation would supply explicit permission
  // bindings — a separate, deliberate change, not the default.)
  const serverPermission: typeof config.permission = { mode: "default" }

  // ToolCallPort = fold the REAL dispatchTool through the FULL locked pipeline.
  // Mirrors `@/agent/codemode-wire`: synthesize a ToolUseBlock, dispatch with the
  // fail-closed server permission, fold to { text, isError }. The dispatch is
  // no-throw by contract; the try/catch is belt-and-braces so a pathological
  // pre-execute throw becomes an isError result, never a host fault.
  const mintId = idMinter()
  const toolCall: ToolCallPort = async (name, args) => {
    try {
      const result = await dispatchTool(
        { type: "tool_use", id: mintId(), name, input: args },
        config,
        serverPermission,
      )
      const text = typeof result.block.content === "string" ? result.block.content : result.preview
      // isError iff the dispatch was not ok OR the tool_result block flagged it.
      return { text, isError: !result.ok || result.block.is_error === true }
    } catch (e) {
      return { text: `tool dispatch failed for ${name}: ${errMessage(e)}`, isError: true }
    }
  }

  const explicitOptIn = resolveExplicitOptIn(process.env.QUANTA_MCP_SERVER_EXPOSE, knownNames, io)

  const server = buildMcpServer({
    toolList,
    toolCall,
    write: (s) => io.out(s),
    explicitOptIn,
  })

  // Start banner → STDERR only (stdout is the pure JSON-RPC channel).
  const exposed = server.exposedToolNames()
  io.err(`quanta MCP server · ${exposed.length} read-only tools exposed\n`)

  // Pump stdin → server. NO-THROW: a read fault ends the loop cleanly. SIGINT
  // resolves the pump so the command exits 0 rather than being killed.
  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.on("SIGINT", onSig)
  process.on("SIGTERM", onSig)
  try {
    for await (const chunk of io.stdin) {
      if (ac.signal.aborted) break
      server.feed(chunk)
    }
  } catch (e) {
    io.err(`quanta mcp-server: stdin pump ended: ${errMessage(e)}\n`)
  } finally {
    // DRAIN before exit: each tools/call dispatches async, so an in-flight call
    // (and its tool effect) could otherwise outlive the pump. Awaiting here
    // guarantees every reply is flushed and every FS effect has settled before
    // the command returns — closing the race that would let a denied write be
    // observed as "not yet written".
    await server.drain()
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }
  return EXIT_OK
}
