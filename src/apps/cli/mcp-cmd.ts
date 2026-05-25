/**
 * `/mcp` slash command — MCP server explorer.
 *
 * Surfaces the read-only MCP runtime state to the user:
 *   - `/mcp`               → list servers + tool count + status
 *   - `/mcp tools`         → every bridged tool across all servers
 *   - `/mcp tools <name>`  → tools belonging to one server only
 *   - `/mcp config`        → current MCP config file path + raw contents
 *
 * Slice discipline: this file lives in `src/apps/cli` and is allowed to
 * import `@/ui/ui-helpers` for rendering. It does NOT import `@/mcp` directly
 * — instead it consumes a structural surface (`McpSurfaceInfo`) wired by the
 * REPL via `SlashContext.mcp`. That keeps the command testable in isolation
 * (no live client / spawn required) and lets future surfaces (Tauri/Web)
 * supply the same shape without dragging an MCP transport into their slice.
 *
 * Read-only: this command never starts/stops a server, never edits the
 * config file, never calls a tool. It is purely an introspector — the
 * lifecycle pills audit found no live health probe and we deliberately do
 * not add one here.
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
import { readFile } from "node:fs/promises"
import { bold, cyan, dim, green, red, renderBox, yellow } from "@/ui/ui-helpers"
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

const isOn = (v: string | undefined): boolean => {
  if (v === undefined) return false
  const n = v.trim().toLowerCase()
  return n !== "" && n !== "0" && n !== "false" && n !== "off" && n !== "no"
}

const isVerbose = (): boolean => isOn(process.env.QUANTA_MCP_VERBOSE)

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
    const msg = e instanceof Error ? e.message : String(e)
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

export const runMcpRender = async (args: readonly string[], ctx: SlashContext): Promise<number> => {
  if (args.length === 0) return runMcpList(ctx)
  const sub = args[0] as string
  const rest = args.slice(1)
  if (sub === "tools") return runMcpTools(ctx, rest)
  if (sub === "config") {
    if (rest.length > 0) {
      ctx.err("/mcp config: takes no arguments\n")
      return 1
    }
    return runMcpConfig(ctx)
  }
  ctx.err(`/mcp: unknown sub-command '${sub}' (valid: tools | config)\n`)
  return 1
}

export const mcpCmd: SlashCommand = {
  name: "/mcp",
  describe: "Inspect MCP servers: /mcp | /mcp tools [server] | /mcp config",
  category: "config",
  run: runMcpRender,
}
