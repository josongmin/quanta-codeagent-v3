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
 *  - Slice isolation: imports `@/ui/ui-helpers` plus the two zero-dep copy
 *    SSOT leaves (`keybind-truth`, `slash-ref`) — same spirit as the
 *    `turn-summary.ts` rule (no agent/LLM/process imports). The footer
 *    keybinds derive from `keybind-truth.ts` (WS-E jul-10, UUX-2-02) so this
 *    banner and `/help` can never disagree about what Ctrl+C does; pinned by
 *    `help-keybind-truth.hellgate`.
 */

import { cyan, dim, gray, green, magenta, renderBox, yellow } from "@/ui/ui-helpers"
import pkg from "../../../package.json" with { type: "json" }
import { KB_CANCEL_TURN, KB_MODE_CYCLE, KB_QUIT } from "./keybind-truth"
import { slashRef } from "./slash-ref"

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
  /** UUX-2-23 — Shift+Tab permission-mode cycling is live (QUANTA_MODE_CYCLE,
   *  CLI-seeded default-ON). The HOST computes this from env (the banner is a
   *  pure renderer); omitted/false ⇒ the affordance is NOT advertised. */
  readonly modeCycle?: boolean | undefined
  /** UUX-2-23 — @-mention autocomplete is live (QUANTA_AT_AUTOCOMPLETE,
   *  CLI-seeded default-ON). Same host-computed contract. */
  readonly atMention?: boolean | undefined
  /** UUX-5-18 — the untrusted-source envelope defense is ON
   *  (QUANTA_UNTRUSTED_ENVELOPE). Renders ONE trust-posture line; never
   *  advertised when off (a defense you don't have must not be claimed). */
  readonly untrustedEnvelope?: boolean | undefined
}

/** Host-computed gate states for the affordance/trust lines (UUX-2-23/5-18).
 *  Computed at the ONE caller (repl host) from env — keeps this module free
 *  of process/env reads (see the module-header constraints). */
export interface WelcomeGateView {
  readonly modeCycle: boolean
  readonly atMention: boolean
  readonly untrustedEnvelope: boolean
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
  gates?: WelcomeGateView,
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
    ...(gates !== undefined
      ? {
          modeCycle: gates.modeCycle,
          atMention: gates.atMention,
          untrustedEnvelope: gates.untrustedEnvelope,
        }
      : {}),
  }
}

const shortenCwd = (cwd: string, home: string | undefined): string => {
  if (home === undefined || home.length === 0) return cwd
  if (cwd === home) return "~"
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

/** Two-column row: a dim fixed-width label + the value. */
const row = (label: string, value: string): string => `${dim(label.padEnd(9))}${value}`

/** UUX-2-23/5-18 — the affordance (`keys`) + trust-posture rows. Rendered
 *  ONLY when the host reports the gate ON (honesty both ways: an explicit
 *  opt-out drops the line; a defense that is off is never claimed). Chord
 *  copy derives from the keybind-truth SSOT (KB_MODE_CYCLE — the SAME object
 *  `/help` renders), never a third hand-written mirror. */
const affordanceRows = (info: WelcomeBannerInfo): string[] => {
  const rows: string[] = []
  const tips: string[] = []
  if (info.modeCycle === true) tips.push(`${KB_MODE_CYCLE.chord} cycle permission mode`)
  if (info.atMention === true) tips.push("@ to mention files/symbols")
  if (tips.length > 0) rows.push(row("keys", tips.join(dim(" · "))))
  if (info.untrustedEnvelope === true) {
    rows.push(row("trust", "external tool output fenced in <untrusted-source>"))
  }
  return rows
}

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

  lines.push(...affordanceRows(info))

  lines.push("")

  return renderBox(lines, {
    title: `${magenta("✻")} quanta ${gray(`v${version}`)}`,
    footer: `${slashRef("help")} commands · ${KB_CANCEL_TURN.chord} cancel turn · ${KB_QUIT.chord} quit`,
    borderStyle: dim,
  })
}
