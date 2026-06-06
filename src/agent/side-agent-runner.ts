/**
 * N1 Phase-2 — the `@/agent`-side bridge that wires the pure `@/side-agent`
 * supervise-loop registry to the REAL substrate (RFC §4.3 / §9):
 *
 *   - {@link mailboxToSideAgentMailbox}: adapt the ADR-0416 `MailboxPort` to the
 *     slice's `SideAgentMailboxPort` (a finding → a `broadcast` message, the
 *     daemon → main "conversation kept" push channel).
 *   - {@link subagentRunnerToSidePass}: adapt the ADR-0130 `SubagentRunner` to
 *     the slice's `SideAgentRunnerPort` — ONE bounded, READ-BIASED pass per wake
 *     (RFC §4.6: a side-agent defaults to a read-only tool surface; any write
 *     re-enters the normal permission gate). `finalText` becomes the finding.
 *   - {@link wireSideAgentDaemons}: assemble the registry from the two adapters
 *     + injected timers/clock (the composition root passes the real ones, so
 *     this module carries no `Date.now()`/`setInterval` of its own).
 *
 * This is the sole place that couples the side-agent slice to `@/subagent` +
 * `@/agent/subagent-mailbox`, mirroring how `subagent-runner.ts` is the sole
 * bridge for ADR-0130. The slice itself (`@/side-agent`) stays a pure leaf.
 */

import { runtimeConfig, sliceWholeChars } from "@/shared"
import {
  createSideAgentDaemonRegistry,
  type SideAgentDaemonRegistry,
  type SideAgentMailboxPort,
  type SideAgentRunnerPort,
} from "@/side-agent"
import type { SubagentRunner } from "@/subagent"
import { createIdleBarrier } from "@/subagent/coordination"
import type { MailboxPort } from "./subagent-mailbox"

/** One-line summary cap for the status-bar finding. */
const SUMMARY_MAX = 200

/** Cap on the full-text `detail` of a finding. A side-agent CHILD can return an
 *  arbitrarily large `finalText`; without a ceiling, that raw text flows
 *  unbounded into the registry findings ring-buffer (up to `maxFindings`
 *  entries) AND the mailbox broadcast body — a memory/transcript-explosion DoS
 *  identical to the one C2's per-field caps (`communicate-update.ts`) guard
 *  against. Generous (a real finding's context fits well under this) but bounded;
 *  an over-cap detail is truncated with a marker so the loss is visible rather
 *  than silent. */
const DETAIL_MAX = 8_000
const DETAIL_TRUNC_MARKER = "\n…[side-agent finding truncated]"

/** Clamp an over-cap detail to `DETAIL_MAX`, leaving room for the truncation
 *  marker so the returned string never exceeds the cap. Surrogate-safe: a JS
 *  string is UTF-16, and a naive `slice` at the cap index can cut an astral char
 *  (emoji / CJK-ext) in HALF, emitting a LONE surrogate into the findings
 *  ring-buffer / mailbox body — which re-encodes to a U+FFFD replacement char /
 *  malformed token. The shared `sliceWholeChars` helper snaps the cut off a
 *  surrogate boundary (dropping a straddling pair whole) before the marker is
 *  appended. An under-cap detail is returned untouched. */
const capDetail = (detail: string): string => {
  if (detail.length <= DETAIL_MAX) return detail
  const cut = DETAIL_MAX - DETAIL_TRUNC_MARKER.length
  return sliceWholeChars(detail, cut) + DETAIL_TRUNC_MARKER
}

/** Read-biased default tool surface for a side-agent pass (RFC §4.6). A daemon
 *  observes/monitors; it does NOT get the mutating tools by default. A charter
 *  that needs to write must be spawned with an explicit (wider) toolFilter — and
 *  even then every write re-enters the main permission/HARD_DENY gate. */
export const SIDE_AGENT_READONLY_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "file_tree_summary",
  "parse_test_failure",
  "diagnostics",
  "bash_await",
  "test_runner",
]

/** Adapt the inter-agent mailbox to the side-agent finding channel. A finding
 *  is a `broadcast` (push, no reply expected); the summary + optional detail are
 *  encoded into the message body. */
export const mailboxToSideAgentMailbox = (mailbox: MailboxPort): SideAgentMailboxPort => ({
  send: ({ from, to, summary, detail }) => {
    mailbox.send({
      from,
      to,
      kind: "broadcast",
      body: detail !== undefined && detail.length > 0 ? `${summary}\n\n${detail}` : summary,
    })
  },
})

/** Adapt a `SubagentRunner` into a side-agent pass: run ONE bounded, read-biased
 *  child agent over the daemon's task; map its `finalText` to a finding (or
 *  `null` when the child produced nothing / failed — the wake found nothing). */
export const subagentRunnerToSidePass = (
  runner: SubagentRunner,
  opts: { readonly toolFilter?: readonly string[] } = {},
): SideAgentRunnerPort => ({
  run: async ({ task, maxTurns, signal }) => {
    // SubagentRunner is a bare callable `(req) => Promise<result>`, not an
    // object — invoke it directly (was `runner.run(...)`, a type error).
    const result = await runner({
      prompt: task,
      depth: 1,
      toolFilter: [...(opts.toolFilter ?? SIDE_AGENT_READONLY_TOOLS)],
      budget: { maxTurns },
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!result.ok) return null
    const text = result.finalText.trim()
    if (text.length === 0) return null
    const firstLine = text.split("\n", 1)[0] ?? text
    const summary = firstLine.slice(0, SUMMARY_MAX)
    // `text === summary` ⇒ the whole finding is the (short, single-line) summary
    // ⇒ no detail. Otherwise carry the full text as detail, but CAPPED so a
    // chatty child cannot balloon the findings log / mailbox body.
    return text === summary ? { summary } : { summary, detail: capDetail(text) }
  },
})

export interface SideAgentWireDeps {
  /** The ADR-0130 runner the host already builds (shared with the subagent block
   *  so daemon passes draw from the SAME concurrency/token budget). */
  readonly runner: SubagentRunner
  /** The ADR-0416 mailbox findings are pushed onto. */
  readonly mailbox: MailboxPort
  /** Recipient id (the main session) findings are addressed to. */
  readonly mainRecipient: string
  /** Real timers + clock — injected by the composition root (no `Date.now()` /
   *  global `setInterval` in this module). */
  readonly setInterval: (handler: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
  readonly now: () => number
  /** Override the read-biased default tool surface (RFC §4.6). */
  readonly toolFilter?: readonly string[]
  readonly maxConcurrent?: number
  readonly maxFindings?: number
  readonly maxRetained?: number
}

/** Build a live `SideAgentDaemonRegistry` from the real substrate. Returned
 *  registry structurally satisfies the tool-side `SideAgentDaemonPort`, so the
 *  host sets it directly on `AgentConfig.sideAgentDaemons`. */
export const wireSideAgentDaemons = (deps: SideAgentWireDeps): SideAgentDaemonRegistry =>
  createSideAgentDaemonRegistry({
    runner: subagentRunnerToSidePass(
      deps.runner,
      deps.toolFilter !== undefined ? { toolFilter: deps.toolFilter } : {},
    ),
    mailbox: mailboxToSideAgentMailbox(deps.mailbox),
    mainRecipient: deps.mainRecipient,
    setInterval: deps.setInterval,
    clearInterval: deps.clearInterval,
    now: deps.now,
    ...(deps.maxConcurrent !== undefined ? { maxConcurrent: deps.maxConcurrent } : {}),
    ...(deps.maxFindings !== undefined ? { maxFindings: deps.maxFindings } : {}),
    ...(deps.maxRetained !== undefined ? { maxRetained: deps.maxRetained } : {}),
    // Capability C — team-idle barrier. Wired ONLY under `QUANTA_TEAM_IDLE`, so a
    // leader can fan IN over the resident daemons by awaiting `teamIdle()` instead
    // of polling. Reuses the injected real clock (`deps.now`) — no `Date.now()`
    // here. Absent knob ⇒ no barrier (byte-identical legacy registry).
    ...(runtimeConfig().teamIdle ? { idleBarrier: createIdleBarrier({ now: deps.now }) } : {}),
  })
