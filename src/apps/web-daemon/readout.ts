/**
 * `@/apps/web-daemon/readout` — Phase 1 (jun-9-cli-web-parity ticket 05):
 * pure rendering of the read-only "slash readouts" served OUT-OF-BAND over an
 * HTTP route (`GET /readout/:name`), NOT the WS turn channel.
 *
 * # Why out-of-band (the load-bearing architectural decision)
 * An in-flight `turn.run` holds the session single-writer lease for its entire
 * duration; any other WS command routed through `lease.runWith` throws
 * `single_writer_lease_held`. So a `/state` readout fired *while the agent is
 * working* — exactly when you want to look — would be REJECTED on the WS
 * channel. The daemon already serves knobs this way; this mirrors it: the
 * route reads the live `RuntimeSession.snapshot()` (a JS-single-thread sync
 * read between the turn's await-points ⇒ no torn read, no lease) and responds
 * per-client. Works idle AND mid-turn.
 *
 * # Slice fence
 * PURE: `renderReadout` takes a {@link SessionSnapshotLite} + a name and returns
 * a {@link ReadoutResult}. No I/O, no `@/apps/cli` import (the biome fence
 * forbids the daemon from reaching the CLI registry), no host mutation — every
 * readout is read-only. The server route is the only caller; it stays thin.
 *
 * # Coverage today vs. pending
 * The lite snapshot carries `capabilities` ({@link CapabilityManifest}) and
 * `state` ({@link SessionStateView}) — so `/capabilities` and `/state` are served
 * NOW with zero coupling to `context-binding.ts` (the host file the concurrent
 * ADR-0529 work is rewriting). The richer readouts (`/agents` fleet, `/plan`
 * body, `/branches`, working-state blockers/next-steps, `/skills`, `/mcp`,
 * `/memory`, `/why`, `/cost`, `/context`) need host read-accessors that are NOT
 * yet on the snapshot; they degrade GRACEFULLY to a "not wired in this surface"
 * line (never a crash, never `isError`) and turn green one-Set-row at a time as
 * each accessor lands (coordinated with ADR-0529).
 */
import type { CapabilityManifest, SessionSnapshotLite, SessionStateView } from "@/protocol/session"

export interface ReadoutResult {
  /** Normalized command name (alias-resolved, e.g. `caps` → `capabilities`). */
  readonly name: string
  /** Rendered, ANSI-free text body for the web to display. Always non-empty. */
  readonly output: string
  /** True only for an UNKNOWN readout name. A recognized-but-pending readout is
   *  NOT an error — it is a graceful "not wired here yet". */
  readonly isError: boolean
  /** True when this surface actually served live data; false when the name is
   *  recognized but its host accessor is not on the snapshot yet (pending), or
   *  the name is unknown. The web can badge "pending" distinctly from a crash. */
  readonly wired: boolean
}

/** Readouts that are recognized CLI commands but need a host read-accessor not
 *  yet exposed on the lite snapshot. They degrade gracefully (wired:false,
 *  isError:false) until ticket 05 lands each accessor. Listed explicitly (not a
 *  catch-all) so an UNKNOWN name still surfaces as an error — the difference
 *  between "we know this command, just not here yet" and "typo / nonexistent". */
const PENDING_HOST_ACCESSOR: ReadonlySet<string> = new Set([
  "agents",
  "plan",
  "branches",
  "skills",
  "mcp",
  "memory",
  "why",
  "cost",
  "context",
])

const yesno = (b: boolean): string => (b ? "yes" : "no")

const renderCapabilities = (m: CapabilityManifest): string =>
  [
    "capabilities",
    `  transport       ${m.transport}`,
    `  approvals       ${m.approvals}`,
    `  tools           ${yesno(m.tools)}`,
    `  subagents       ${yesno(m.subagents)}`,
    `  memory          ${yesno(m.memory)}`,
    `  artifacts       ${yesno(m.artifacts)}`,
    `  automation      ${yesno(m.automation)}`,
    `  shell snapshot  ${yesno(m.shellSnapshot)}`,
  ].join("\n")

const renderState = (s: SessionStateView): string => {
  const lines = [
    "session state",
    `  status        ${s.status}`,
    `  permission    ${s.permissionMode}`,
  ]
  if (s.identityMode !== undefined) lines.push(`  identity      ${s.identityMode}`)
  if (s.toolProfile !== undefined) lines.push(`  tool profile  ${s.toolProfile}`)
  if (s.modelSlug !== undefined) lines.push(`  model         ${s.modelSlug}`)
  lines.push(`  messages      ${s.messageCount}`)
  if (s.lastOutcomeReason !== undefined) lines.push(`  last outcome  ${s.lastOutcomeReason}`)
  return lines.join("\n")
}

/**
 * Render a read-only readout from the live session snapshot. Pure + total —
 * NEVER throws (a malformed/partial snapshot still yields a result), so the
 * route can't 500 on bad input. Unknown name ⇒ isError; recognized-but-pending
 * ⇒ graceful; served ⇒ live text.
 */
export const renderReadout = (name: string, snapshot: SessionSnapshotLite): ReadoutResult => {
  const n = name.trim().toLowerCase()
  if (n === "capabilities" || n === "caps") {
    return { name: "capabilities", output: renderCapabilities(snapshot.capabilities), isError: false, wired: true }
  }
  if (n === "state") {
    return { name: "state", output: renderState(snapshot.state), isError: false, wired: true }
  }
  if (PENDING_HOST_ACCESSOR.has(n)) {
    return {
      name: n,
      output: `/${n}: not wired in this web surface yet (pending host read-accessor — jun-9-cli-web-parity ticket 05)`,
      isError: false,
      wired: false,
    }
  }
  return { name: n, output: `unknown readout: ${n || "(empty)"}`, isError: true, wired: false }
}

/** The names that serve LIVE data today (everything else is pending/unknown).
 *  Exported so the web palette + a ratchet can enumerate the live set. */
export const SERVED_READOUTS: readonly string[] = ["state", "capabilities", "caps"]
