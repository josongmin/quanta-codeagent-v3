/**
 * `/mcp` slash command — MCP server explorer.
 *
 * Surfaces the read-only MCP runtime state to the user:
 *   - `/mcp`               → list servers + tool count + status
 *   - `/mcp tools`         → every bridged tool across all servers
 *   - `/mcp tools <name>`  → tools belonging to one server only
 *   - `/mcp config`        → current MCP config file path + raw contents
 *   - `/mcp enable <s>`    → clear `disabled` on `<s>` IN THE CONFIG FILE
 *   - `/mcp disable <s>`   → set `disabled: true` on `<s>` in the config file
 *   - `/mcp reload [s]`    → honest exit-2: no live MCP reload seam exists;
 *                            config changes take effect next session
 *
 * Slice discipline: this file lives in `src/apps/cli` and is allowed to
 * import `@/ui/ui-helpers` for rendering. It does NOT import `@/mcp` directly
 * — instead it consumes a structural surface (`McpSurfaceInfo`) wired by the
 * REPL via `SlashContext.mcp`. That keeps the command testable in isolation
 * (no live client / spawn required) and lets future surfaces (Tauri/Web)
 * supply the same shape without dragging an MCP transport into their slice.
 *
 * Lifecycle (UUX-4-14): `enable`/`disable` WRITE THROUGH to the config file
 * the loader reads — pure read-modify-write (unknown fields preserved,
 * atomic tmp+rename, concurrent-edit mtime guard), never an in-memory
 * mutation that could diverge from the file. There is NO safe live-reload
 * seam in this surface (the bridged tools are baked into the runtime
 * registry at boot and `McpStoppable` handles are unnamed), so `reload` —
 * and the enable/disable receipts — say honestly that changes take effect
 * next session. The command never calls a tool.
 *
 * Render contract: every styled token goes through `@/ui/ui-helpers` so
 * `setColorPolicy("off")` (or NO_COLOR) yields plain ASCII byte-identical
 * to a non-TTY render. The box border + section dividers fall back to
 * ASCII via the same helpers.
 *
 * ENV knobs:
 *   - `QUANTA_MCP_VERBOSE=1` → include cwd / env-key list per server and the
 *     full tool input-schema `required` keys when listing tools.
 */

import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { errMessage } from "@/shared"
import { bold, cyan, dim, green, red, renderBox, yellow } from "@/ui/ui-helpers"
import { readCliKnob } from "./cli-knobs-accessor"
import { applyMcpServerToggle, type McpToggleAction, writeMcpConfigAtomic } from "./mcp-config-rmw"
import { NOT_WIRED_EXIT, notWired } from "./not-wired"
import type { SlashCommand, SlashContext } from "./slash-commands"
/* ------------------------------------------------------------------ */
/* Surface contract                                                    */
/* ------------------------------------------------------------------ */

/** Per-tool descriptor as exposed to the slash command. Mirrors the public
 *  `McpToolDef` from `@/mcp` minus the `inputSchema` body — only the
 *  declared `required` keys travel here so the renderer can hint them
 *  without dragging a JSON Schema printer into the CLI slice. */
export interface McpToolInfo {
  readonly name: string
  readonly description: string
  /** Top-level `required` keys (from `inputSchema.required`). Empty array
   *  when the schema declares none. */
  readonly required: readonly string[]
}

/** Per-server status row. The four states map 1:1 onto the lifecycle-pills
 *  vocabulary so a future health-probe wiring can flip `degraded` on without
 *  any other surface change. `failed` is the slash-only state for servers
 *  that appeared in the config but never produced a live client. */
export type McpServerStatus = "connected" | "degraded" | "down" | "failed"

export interface McpServerInfo {
  readonly name: string
  readonly status: McpServerStatus
  readonly toolCount: number
  /** Tools bridged from this server. The CLI uses this to render
   *  `/mcp tools <server>` without re-reading from the live client. */
  readonly tools: readonly McpToolInfo[]
  /** Spawned process id when known. Surfaces own when this is set. */
  readonly pid?: number
  /** Connection epoch ms — used to compute uptime relative to `now()`. */
  readonly startedAtMs?: number
  /** Spawn argv from the config (for `/mcp config`). */
  readonly command?: readonly string[]
  /** Spawn cwd from the config (for verbose mode). */
  readonly cwd?: string
  /** Names of env keys explicitly forwarded (values are NEVER rendered —
   *  this is the same posture as `/permission`: never reveal secrets). */
  readonly envKeys?: readonly string[]
  /** When `status === "failed"`, the captured error message. */
  readonly errorMessage?: string
}

/** Aggregate surface plumbed onto `SlashContext.mcp`. The optional config
 *  path is used by `/mcp config` only — absent ⇒ that sub-command prints
 *  "no MCP config configured" and exits 0 (parity with the rest of the
 *  surface-wired slash commands). */
export interface McpSurfaceInfo {
  readonly servers: readonly McpServerInfo[]
  /** Resolved path to the JSON config file (`QUANTA_MCP_CONFIG`). */
  readonly configPath?: string
  /** `Date.now`-equivalent — injected for test determinism. */
  readonly now?: () => number
  /** H18 — trigger the OAuth login flow for `serverName` and return the outcome.
   *  Wired by the REPL over the connectors-backed `McpOAuthProviderPort`
   *  (`tokenFor` runs discovery → DCR → PKCE browser flow → token-store). Absent
   *  ⇒ `/mcp login` reports "OAuth not enabled" and exits 0 (default-OFF: a
   *  surface that never wired OAuth — `QUANTA_MCP_OAUTH≠1` — looks identical).
   *  Returns `{ ok, expiresAt? }`; NEVER returns the token itself (it goes
   *  straight into the store, never to the renderer — no secret leak). */
  readonly login?: (serverName: string) => Promise<McpLoginOutcome>
}

/** Outcome of a `/mcp login` — success/failure plus an optional expiry for the
 *  UX. The bearer token itself is NEVER carried here (it is persisted by the
 *  provider's token store and never rendered). */
export interface McpLoginOutcome {
  readonly ok: boolean
  /** Wall-clock ms when the obtained token expires, if known. */
  readonly expiresAt?: number
  /** Failure detail (never contains a token). */
  readonly error?: string
}

declare module "./slash-commands" {
  interface SlashContext {
    /** MCP server snapshot wired by the REPL surface. Absent ⇒ `/mcp`
     *  prints "no MCP servers configured" (default-OFF: one-shot / shell
     *  surfaces that never load MCP look identical). */
    readonly mcp?: McpSurfaceInfo | undefined
  }
}

/* ------------------------------------------------------------------ */
/* env knobs                                                           */
/* ------------------------------------------------------------------ */

/**
 * `QUANTA_MCP_VERBOSE` is a REGISTERED knob — `cli-knobs.ts` declares it
 * `kind: "bool"`, `default: false`, and even names this file as its `readSite`
 * — but the read was raw, so `/config set` and `/knobs set` could not reach it.
 * A knob the registry advertises and the code ignores is worse than an
 * undeclared env var: the surface promises a control that does nothing.
 *
 * The local `isOn` it replaces was a THIRD boolean vocabulary (truthy unless
 * explicitly falsy), so `QUANTA_MCP_VERBOSE=banana` turned verbose output ON.
 * `readCliKnob` uses the `readBool` SSOT, where an unrecognized token falls
 * back to the registry default instead of being read as consent.
 *
 * `=== true` rather than `?? false`: for a REGISTERED knob the accessor always
 * resolves a value, because `resolveRaw` falls through to the registry default
 * — so a `??` fallback here would be a branch no input can reach, and one that
 * would quietly absorb the knob being unregistered. "Unset means off" is a
 * fact of the declaration, pinned by a test, not of a local default.
 */
const isVerbose = (): boolean => readCliKnob("QUANTA_MCP_VERBOSE", "bool") === true

/* ------------------------------------------------------------------ */
/* formatters                                                          */
/* ------------------------------------------------------------------ */

const STATUS_GLYPH: Record<McpServerStatus, string> = {
  connected: "✓",
  degraded: "~",
  down: "✗",
  failed: "✗",
}

const styleStatus = (status: McpServerStatus): string => {
  const glyph = STATUS_GLYPH[status]
  if (status === "connected") return green(glyph)
  if (status === "degraded") return yellow(glyph)
  return red(glyph)
}

const padVisible = (s: string, width: number): string => {
  const pad = " ".repeat(Math.max(0, width - s.length))
  return s + pad
}

/** Human-friendly uptime — clamps to whole seconds and rolls into m/h/d
 *  to keep the pill column narrow. Negative diffs (clock skew, test
 *  injection) clamp to `0s`. */
export const formatUptime = (diffMs: number): string => {
  if (!Number.isFinite(diffMs) || diffMs < 1000) return "0s"
  const totalS = Math.floor(diffMs / 1000)
  if (totalS < 60) return `${totalS}s`
  const totalM = Math.floor(totalS / 60)
  if (totalM < 60) return `${totalM}m`
  const totalH = Math.floor(totalM / 60)
  if (totalH < 24) return `${totalH}h`
  return `${Math.floor(totalH / 24)}d`
}

/** Render a single server's status row. The columns are fixed-width so
 *  multiple rows align in the box without ANSI-width math. */
const renderServerRow = (srv: McpServerInfo, nowMs: number): string => {
  const dot = styleStatus(srv.status)
  const name = padVisible(srv.name, 14)
  const toolsCol =
    srv.status === "failed" ? padVisible("--", 8) : padVisible(`${srv.toolCount} tools`, 8)
  const parts: string[] = [`${dot} ${cyan(name)} ${toolsCol}`]
  if (srv.status === "failed") {
    const msg = srv.errorMessage ?? "spawn failed"
    parts.push(dim(`(failed: ${msg})`))
  } else {
    if (srv.pid !== undefined) parts.push(dim(`pid ${srv.pid}`))
    if (srv.startedAtMs !== undefined) {
      const up = formatUptime(Math.max(0, nowMs - srv.startedAtMs))
      parts.push(dim(`uptime ${up}`))
    }
  }
  return parts.join("  ")
}

const renderVerboseDetails = (srv: McpServerInfo): readonly string[] => {
  const lines: string[] = []
  if (srv.command && srv.command.length > 0) {
    lines.push(`    ${dim("cmd:")}  ${srv.command.join(" ")}`)
  }
  if (srv.cwd !== undefined && srv.cwd.length > 0) {
    lines.push(`    ${dim("cwd:")}  ${srv.cwd}`)
  }
  if (srv.envKeys && srv.envKeys.length > 0) {
    lines.push(`    ${dim("env:")}  ${srv.envKeys.join(", ")} ${dim("(values hidden)")}`)
  }
  return lines
}

const renderServerList = (mcp: McpSurfaceInfo): string => {
  if (mcp.servers.length === 0) {
    return renderBox([dim("(no MCP servers configured)")], {
      title: "MCP servers",
      titleStyle: bold,
    })
  }
  const now = mcp.now ? mcp.now() : Date.now()
  const lines: string[] = []
  for (const srv of mcp.servers) {
    lines.push(renderServerRow(srv, now))
    if (isVerbose()) lines.push(...renderVerboseDetails(srv))
  }
  const connected = mcp.servers.filter((s) => s.status === "connected").length
  const totalTools = mcp.servers.reduce((acc, s) => acc + s.toolCount, 0)
  const footer = `${connected}/${mcp.servers.length} connected · ${totalTools} tool${totalTools === 1 ? "" : "s"}`
  return renderBox(lines, { title: "MCP servers", titleStyle: bold, footer })
}

/** Truncate a description to a one-line, scannable form. Naive `slice` is
 *  fine here — MCP tool descriptions are plain ASCII in practice and the
 *  CLI prints them dim. Multi-line ⇒ first line only. */
const oneLineDesc = (s: string, max = 80): string => {
  const first = s.split("\n")[0] ?? ""
  if (first.length <= max) return first
  return `${first.slice(0, max - 3)}...`
}

const renderToolRow = (tool: McpToolInfo): string => {
  const nameCol = padVisible(tool.name, 28)
  let line = `    • ${cyan(nameCol)} ${dim(oneLineDesc(tool.description))}`
  if (isVerbose() && tool.required.length > 0) {
    line += ` ${dim(`[required: ${tool.required.join(", ")}]`)}`
  }
  return line
}

const renderToolsForServer = (srv: McpServerInfo): readonly string[] => {
  if (srv.tools.length === 0) {
    return [`  ${cyan(srv.name)}: ${dim("(no tools)")}`]
  }
  const lines: string[] = [`  ${cyan(srv.name)}:`]
  for (const tool of srv.tools) lines.push(renderToolRow(tool))
  return lines
}

const renderAllTools = (mcp: McpSurfaceInfo): string => {
  const servers = mcp.servers.filter((s) => s.tools.length > 0)
  if (servers.length === 0) {
    return renderBox([dim("(no MCP tools loaded)")], { title: "MCP tools", titleStyle: bold })
  }
  const total = servers.reduce((acc, s) => acc + s.tools.length, 0)
  const lines: string[] = []
  for (let i = 0; i < servers.length; i++) {
    const srv = servers[i]
    if (srv === undefined) continue
    if (i > 0) lines.push("")
    lines.push(...renderToolsForServer(srv))
  }
  const title = `MCP tools (${total} across ${servers.length} server${servers.length === 1 ? "" : "s"})`
  return renderBox(lines, { title, titleStyle: bold })
}

const renderToolsForOneServer = (mcp: McpSurfaceInfo, serverName: string): string | null => {
  const srv = mcp.servers.find((s) => s.name === serverName)
  if (srv === undefined) return null
  const lines = [...renderToolsForServer(srv)]
  const title = `MCP tools · ${serverName} (${srv.tools.length})`
  return renderBox(lines, { title, titleStyle: bold })
}

/* ------------------------------------------------------------------ */
/* /mcp config                                                          */
/* ------------------------------------------------------------------ */

const renderConfigMissing = (): string =>
  renderBox(
    [
      dim("(no QUANTA_MCP_CONFIG configured)"),
      "",
      `${dim("To enable MCP, point QUANTA_MCP_CONFIG at a JSON file with:")}`,
      `  ${cyan('{ "servers": [{ "name": "...", "command": ["..."] }] }')}`,
      `${dim("Browser/plugin bridge: QUANTA_BROWSER_MCP_CONFIG or QUANTA_BROWSER_MCP_PLUGIN_DIR also work.")}`,
    ],
    { title: "MCP config", titleStyle: bold },
  )

const renderConfigBlock = async (configPath: string): Promise<string> => {
  if (!existsSync(configPath)) {
    return renderBox([`${dim("path:")} ${configPath}`, "", red(`(file does not exist)`)], {
      title: "MCP config",
      titleStyle: bold,
    })
  }
  let raw: string
  try {
    raw = await readFile(configPath, "utf8")
  } catch (e) {
    const msg = errMessage(e)
    return renderBox([`${dim("path:")} ${configPath}`, "", red(`(read failed: ${msg})`)], {
      title: "MCP config",
      titleStyle: bold,
    })
  }
  const lines: string[] = [`${dim("path:")} ${configPath}`, ""]
  for (const ln of raw.split("\n")) lines.push(ln)
  return renderBox(lines, { title: "MCP config", titleStyle: bold })
}

/* ------------------------------------------------------------------ */
/* dispatcher                                                          */
/* ------------------------------------------------------------------ */

const runMcpList = (ctx: SlashContext): number => {
  if (ctx.mcp === undefined) {
    ctx.out("/mcp: not wired in this surface\n")
    return 0
  }
  ctx.out(`${renderServerList(ctx.mcp)}\n`)
  return 0
}

const runMcpTools = (ctx: SlashContext, rest: readonly string[]): number => {
  if (ctx.mcp === undefined) {
    ctx.out("/mcp tools: not wired in this surface\n")
    return 0
  }
  if (rest.length > 1) {
    ctx.err("/mcp tools: expected at most one argument (server name)\n")
    return 1
  }
  if (rest.length === 0) {
    ctx.out(`${renderAllTools(ctx.mcp)}\n`)
    return 0
  }
  const name = rest[0] as string
  const out = renderToolsForOneServer(ctx.mcp, name)
  if (out === null) {
    const known = ctx.mcp.servers.map((s) => s.name).join(", ")
    const hint = known.length > 0 ? ` (known: ${known})` : ""
    ctx.err(`/mcp tools: unknown server '${name}'${hint}\n`)
    return 1
  }
  ctx.out(`${out}\n`)
  return 0
}

const runMcpConfig = async (ctx: SlashContext): Promise<number> => {
  if (ctx.mcp === undefined || ctx.mcp.configPath === undefined) {
    ctx.out(`${renderConfigMissing()}\n`)
    return 0
  }
  ctx.out(`${await renderConfigBlock(ctx.mcp.configPath)}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* /mcp login <server>  (H18 — OAuth)                                   */
/* ------------------------------------------------------------------ */

/** Run the OAuth login flow for one server. Reuses the connectors-backed
 *  provider wired onto `ctx.mcp.login` (discovery → DCR → PKCE browser flow →
 *  token store). The token is NEVER rendered — only success + expiry. */
const runMcpLogin = async (ctx: SlashContext, rest: readonly string[]): Promise<number> => {
  if (rest.length !== 1) {
    ctx.err("/mcp login: usage: /mcp login <server>\n")
    return 1
  }
  const serverName = rest[0] as string
  const login = ctx.mcp?.login
  if (login === undefined) {
    ctx.out(
      `${renderBox(
        [
          dim("(OAuth not enabled)"),
          "",
          `${dim("Set ")}${cyan("QUANTA_MCP_OAUTH=1")}${dim(" and mark the server ")}${cyan('"oauth": true')}`,
          `${dim("in its MCP config to enable HTTP-server OAuth login.")}`,
        ],
        { title: "MCP login", titleStyle: bold },
      )}\n`,
    )
    return 0
  }
  ctx.out(`${dim(`→ starting OAuth login for '${serverName}'…`)}\n`)
  let outcome: McpLoginOutcome
  try {
    outcome = await login(serverName)
  } catch (e) {
    ctx.err(
      `${renderBox([`${red("✗")} ${bold("Login failed")}`, "", dim(errMessage(e))], {
        title: "MCP login",
        titleStyle: bold,
      })}\n`,
    )
    return 1
  }
  if (!outcome.ok) {
    ctx.err(
      `${renderBox(
        [
          `${red("✗")} ${bold(`Login failed for '${serverName}'`)}`,
          "",
          dim(outcome.error ?? "no token obtained"),
        ],
        { title: "MCP login", titleStyle: bold },
      )}\n`,
    )
    return 1
  }
  const lines: string[] = [`${green("✓")} ${bold(`Signed in to '${serverName}'`)}`]
  if (outcome.expiresAt !== undefined) {
    lines.push("", `${dim("expires:")} ${new Date(outcome.expiresAt).toISOString()}`)
  }
  lines.push("", dim("Token stored securely (0600). It is never displayed or logged."))
  ctx.out(`${renderBox(lines, { title: "MCP login", titleStyle: bold })}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* /mcp enable|disable <server>  (UUX-4-14 — write-through)             */
/* ------------------------------------------------------------------ */

/** One line of honest posture shared by every write receipt: the loader reads
 *  the config ONCE at boot, so a write can only take effect next session. */
const NEXT_SESSION_NOTE =
  "takes effect next session (MCP config is loaded once at boot; no live reload in this surface)"

/** Resolve the config path or print the not-wired posture (exit 2). */
const requireConfigPath = (ctx: SlashContext, feature: string): string | number => {
  const configPath = ctx.mcp?.configPath
  if (configPath === undefined) {
    return notWired(ctx.out, {
      feature,
      hint: "point QUANTA_MCP_CONFIG (or QUANTA_BROWSER_MCP_CONFIG) at your MCP config file",
    })
  }
  return configPath
}

/** Render the honest refusal line for a failed toggle. Extracted from
 *  {@link runMcpToggle} for the cognitive-complexity budget. Pure. */
const renderToggleFailure = (
  failure: Exclude<ReturnType<typeof applyMcpServerToggle>, { ok: true }>,
  info: { action: McpToggleAction; server: string; configPath: string },
): string => {
  if (failure.reason === "parse") {
    return `/mcp ${info.action}: ${info.configPath} is not valid JSON (comments/JSONC?) — refusing to rewrite it: ${failure.detail ?? ""}\n`
  }
  if (failure.reason === "unknown-server") {
    const known = (failure.known ?? []).join(", ")
    return `/mcp ${info.action}: unknown server '${info.server}'${known.length > 0 ? ` (config declares: ${known})` : ""}\n`
  }
  return `/mcp ${info.action}: unrecognized config shape in ${info.configPath} (expected {servers:[...]} or {mcpServers:{...}}) — file left untouched\n`
}

/** `enable <s>` / `disable <s>` — read-modify-write the loader's config file.
 *  The FILE is the SSOT: unknown server names are checked against the file
 *  (not the boot snapshot — a disabled server is absent from the snapshot by
 *  design), and NO in-memory state is touched. */
const runMcpToggle = async (
  ctx: SlashContext,
  action: McpToggleAction,
  rest: readonly string[],
): Promise<number> => {
  if (rest.length !== 1) {
    ctx.err(`/mcp ${action}: usage: /mcp ${action} <server>\n`)
    return 1
  }
  const server = rest[0] as string
  const configPath = requireConfigPath(ctx, `/mcp ${action}`)
  if (typeof configPath === "number") return configPath
  let raw: string
  let readAtMs: number
  try {
    const st = await stat(configPath)
    readAtMs = st.mtimeMs
    raw = await readFile(configPath, "utf8")
  } catch (e) {
    ctx.err(`/mcp ${action}: cannot read ${configPath}: ${errMessage(e)}\n`)
    return 1
  }
  const toggled = applyMcpServerToggle(raw, server, action)
  if (!toggled.ok) {
    ctx.err(renderToggleFailure(toggled, { action, server, configPath }))
    return 1
  }
  if (!toggled.changed) {
    ctx.out(`/mcp ${action}: '${server}' is already ${action}d — file untouched\n`)
    return 0
  }
  const written = await writeMcpConfigAtomic(configPath, toggled.next, readAtMs)
  if (!written.ok) {
    ctx.err(`/mcp ${action}: not written: ${written.detail ?? written.reason}\n`)
    return 1
  }
  ctx.out(`${green("✓")} '${server}' ${action}d in ${configPath} — ${NEXT_SESSION_NOTE}\n`)
  ctx.out(
    `${dim("note: read-modify-write — a concurrent edit landing between read and write wins last.")}\n`,
  )
  return 0
}

/* ------------------------------------------------------------------ */
/* /mcp reload [server]  (UUX-4-14 — honest half)                       */
/* ------------------------------------------------------------------ */

/** No safe live-reload seam exists: the bridged tools are baked into the
 *  runtime registry at facade creation and the `McpStoppable` handles carry
 *  no server identity — tearing one down and re-bridging its tools into the
 *  LIVE session is not reachable from this surface. Honest exit-2 instead of
 *  a fake success (the config half — enable/disable — did ship). */
const runMcpReload = (ctx: SlashContext, rest: readonly string[]): number => {
  if (rest.length > 1) {
    ctx.err("/mcp reload: usage: /mcp reload [server]\n")
    return 1
  }
  const target = rest.length === 1 ? ` for '${rest[0]}'` : ""
  ctx.out(`/mcp reload: live reload${target} is not available in this surface\n`)
  ctx.out(`hint: the config on disk is already authoritative — it ${NEXT_SESSION_NOTE}\n`)
  ctx.out(`hint: restart (or \`quanta --resume <session-id>\`) to apply it\n`)
  return NOT_WIRED_EXIT
}

export const runMcpRender = async (args: readonly string[], ctx: SlashContext): Promise<number> => {
  if (args.length === 0) return runMcpList(ctx)
  const sub = args[0] as string
  const rest = args.slice(1)
  if (sub === "tools") return runMcpTools(ctx, rest)
  if (sub === "login") return runMcpLogin(ctx, rest)
  if (sub === "enable" || sub === "disable") return runMcpToggle(ctx, sub, rest)
  if (sub === "reload") return runMcpReload(ctx, rest)
  if (sub === "config") {
    if (rest.length > 0) {
      ctx.err("/mcp config: takes no arguments\n")
      return 1
    }
    return runMcpConfig(ctx)
  }
  ctx.err(
    `/mcp: unknown sub-command '${sub}' (valid: tools | login | config | enable | disable | reload)\n`,
  )
  return 1
}

export const mcpCmd: SlashCommand = {
  name: "/mcp",
  describe:
    "Inspect/auth/manage MCP servers: /mcp | /mcp tools [server] | /mcp login <server> | /mcp config | /mcp enable|disable <server> | /mcp reload",
  category: "config",
  run: runMcpRender,
}
