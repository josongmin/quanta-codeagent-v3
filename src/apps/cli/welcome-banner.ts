/**
 * Welcome banner — the interactive surface's first paint (jun-10).
 *
 * Replaces the bare `[info] quanta ready (...)` + JSONL config dumps with a
 * Claude-Code-style rounded box: identity (version), runtime facts (model /
 * provider / mode / effort), workspace (cwd, ~-shortened), session continuity
 * (id + resumed message count), capability counts (MCP) and a footer with the
 * three keybinds a new operator actually needs.
 *
 * Constraints (pin):
 *  - PURE renderer + a tiny setup→info mapper. No process/env/TTY reads here —
 *    the caller (repl host) owns the interactive/TTY gate, so one-shot, piped
 *    and eval launches stay byte-identical (they never call this).
 *  - NEVER throws: a banner must not be able to take down startup. The only
 *    live read (`effortStore.get()`) is guarded; everything else is data.
 *  - Version SSOT = package.json (bundled into the compiled binary by bun).
 *  - Slice isolation: imports `@/ui/ui-helpers` only (same rule as
 *    `turn-summary.ts`).
 */

import pkg from "../../../package.json" with { type: "json" }
import { cyan, dim, gray, green, magenta, renderBox, yellow } from "@/ui/ui-helpers"

/** Displayed version — package.json is the single source of truth. */
export const QUANTA_VERSION: string = pkg.version

export interface WelcomeBannerInfo {
  /** Override for tests; defaults to {@link QUANTA_VERSION}. */
  readonly version?: string | undefined
  readonly provider: string
  readonly model: string
  readonly mode: string
  readonly effort?: string | undefined
  readonly cwd: string
  /** When set and `cwd` lives under it, the cwd renders ~-shortened. */
  readonly home?: string | undefined
  readonly sessionId?: string | undefined
  /** Number of transcript messages carried in by a resume (0 ⇒ fresh). */
  readonly resumedMessages?: number | undefined
  readonly mcpServers?: number | undefined
  readonly mcpTools?: number | undefined
}

/** The narrow view of `SessionSetupResult` the banner needs — structural, so
 *  the repl host passes its real setup object and tests pass a stub. */
export interface WelcomeSetupView {
  readonly provider: string
  readonly model: string
  readonly mode: string
  readonly cwd: string
  readonly sessionId?: string | undefined
  readonly history: readonly unknown[]
  readonly mcpClients: readonly unknown[]
  readonly mcpTools: readonly unknown[]
  readonly effortStore: { get(): string }
}

/** Map the live session setup onto banner facts. NEVER throws — a faulting
 *  effort store just drops the effort segment (startup is sacred). */
export const buildWelcomeInfo = (
  setup: WelcomeSetupView,
  home: string | undefined,
): WelcomeBannerInfo => {
  let effort: string | undefined
  try {
    effort = setup.effortStore.get()
  } catch {
    effort = undefined
  }
  return {
    provider: setup.provider,
    model: setup.model,
    mode: setup.mode,
    ...(effort !== undefined ? { effort } : {}),
    cwd: setup.cwd,
    ...(home !== undefined ? { home } : {}),
    ...(setup.sessionId !== undefined ? { sessionId: setup.sessionId } : {}),
    resumedMessages: setup.history.length,
    mcpServers: setup.mcpClients.length,
    mcpTools: setup.mcpTools.length,
  }
}

const shortenCwd = (cwd: string, home: string | undefined): string => {
  if (home === undefined || home.length === 0) return cwd
  if (cwd === home) return "~"
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

/** Two-column row: a dim fixed-width label + the value. */
const row = (label: string, value: string): string => `${dim(label.padEnd(9))}${value}`

export const renderWelcomeBanner = (info: WelcomeBannerInfo): string => {
  const version = info.version ?? QUANTA_VERSION

  const modelSegments = [green(info.model), gray(info.provider)]
  if (info.effort !== undefined && info.effort.length > 0) {
    modelSegments.push(dim(`effort ${info.effort}`))
  }

  const lines: string[] = [
    "",
    row("model", modelSegments.join(dim(" · "))),
    row("mode", yellow(info.mode)),
    row("cwd", cyan(shortenCwd(info.cwd, info.home))),
  ]

  if (info.sessionId !== undefined && info.sessionId.length > 0) {
    const resumed =
      info.resumedMessages !== undefined && info.resumedMessages > 0
        ? dim(` · ${info.resumedMessages} msgs resumed`)
        : ""
    lines.push(row("session", gray(info.sessionId) + resumed))
  }

  if (info.mcpServers !== undefined && info.mcpServers > 0) {
    const tools =
      info.mcpTools !== undefined && info.mcpTools > 0 ? dim(` · ${info.mcpTools} tools`) : ""
    lines.push(row("mcp", `${info.mcpServers} servers${tools}`))
  }

  lines.push("")

  return renderBox(lines, {
    title: `${magenta("✻")} quanta ${gray(`v${version}`)}`,
    footer: "/help commands · Esc Esc cancel turn · Ctrl+C quit",
    borderStyle: dim,
  })
}
