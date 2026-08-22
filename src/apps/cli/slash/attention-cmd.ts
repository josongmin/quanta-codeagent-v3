/**
 * RFC-01 A4 — `/attention` CLI front door (`@/apps/cli/slash`).
 *
 * The operator's answer to "which of my agents is blocked on me right now, and
 * take me there." This is the ONLY v1 attention-navigation surface (web is
 * PARKED). It is a PURE stateless resolver over two LIVE authorities:
 *   - the session `TaskRegistry` (task truth), and
 *   - the `UserQuestionBroker` (pending-question truth, RFC-01 A1),
 * joined by A2's `AttentionReader` (`buildSessionAuthorities`). This command owns
 * NO accumulator and NO per-viewer state — every invocation re-derives the live
 * snapshot.
 *
 * Sub-commands:
 *   - `/attention`                     list agents with a real pending question,
 *                                      oldest-first, exposing the opaque requestId.
 *   - `/attention next`                select+drill the next agent needing
 *                                      attention (honest degrade for the single-
 *                                      focus REPL: NOT a literal focus move —
 *                                      prints the pick + drills `/agents inspect`).
 *   - `/attention answer <id> <text>`  deliver the operator's answer IN-PROCESS
 *                                      via `broker.answer` (_review-01 §D: no
 *                                      protocol/session verb, no kernel/host
 *                                      round-trip). Routes ONLY by the opaque
 *                                      requestId — never label, task id, or
 *                                      "latest".
 *
 * DEFAULT-OFF: the command is only REGISTERED when `QUANTA_ATTENTION_NAV` is on
 * (see {@link isAttentionNavEnabled}), so the `/help` catalog + command table are
 * byte-identical when the gate is unset (parity with `/ps` — registration ≠
 * execution). When the slot (`ctx.attention`) is absent it prints "not wired" +
 * exit 0 (parity with `/agents`).
 */

import type { AttentionReader } from "@/runner/assemble/session-authorities"
import type { UserQuestionBroker } from "@/session/user-question"
import { byteCompare } from "@/shared"
import { type AgentFleetRow, renderAgentInspect } from "../agents-fleet-panel"
import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand, SlashContext } from "../slash-contract"

/** One agent-attention row surfaced to the operator. Mirrors the render-relevant
 *  subset of A1's `PendingQuestion` joined to a live task — the opaque
 *  `requestId` is the ONLY routing authority. */
export interface AttentionListRow {
  /** The live registry task id the pending question is bound to. */
  readonly taskId: string
  /** Display label (mailbox label ?? description). */
  readonly label: string
  /** Opaque response-correlation key — the ONLY routing authority. */
  readonly requestId: string
  /** When the question was asked (ordering key). */
  readonly askedAt: number
  /** Bounded, secret-scrubbed preview. */
  readonly summary: string
}

/** CLOSED outcome of an in-process answer attempt. Mirrors the broker's
 *  {@link import("@/session/user-question").QuestionResult} minus the revision. */
export type AttentionAnswerOutcome =
  | { readonly kind: "answered" }
  | { readonly kind: "unknown" }
  | { readonly kind: "stale" }

/** The CLI `/attention` wire (`ctx.attention`). A stateless projection over the
 *  live `AttentionReader` + `UserQuestionBroker`; the surface builds it via
 *  {@link buildAttentionSlashState}. Absent ⇒ `/attention` prints "not wired". */
export interface AttentionSlashState {
  /** Oldest-first rows: one per task-owned pending question joined to a live
   *  task. Re-derived every call (no accumulator). */
  readonly list: () => readonly AttentionListRow[]
  /** The next agent to go to — the oldest awaiting agent, or the one AFTER
   *  `afterRequestId` (cursor). `undefined` ⇒ nothing awaiting ("all caught
   *  up"). Session-local registry is the scope (a future web plane carries an
   *  explicit session identity — RFC-01 §T2). */
  readonly next: (afterRequestId?: string) => AttentionListRow | undefined
  /** Deliver `text` to the pending question `requestId` IN-PROCESS via
   *  `broker.answer` (CAS on the live revision). Unknown/settled ⇒ `unknown`. */
  readonly answer: (requestId: string, text: string) => AttentionAnswerOutcome
}

/**
 * Build the `/attention` wire from the LIVE authorities A2 assembled. PURE
 * projection: it holds no state and re-reads both authorities on every call, so
 * `/attention` always reflects the current fleet. Only the `task` owner arm of a
 * pending question joins a fleet row (a `root` question is session-level, kept
 * out by A2's reader). Ordering is oldest-first by `(askedAt, requestId)` — the
 * SAME deterministic order A1's pure resolver uses, so the CLI's session-wide
 * navigation cannot silently diverge from the resolver's per-lineage order.
 */
export const buildAttentionSlashState = (
  attention: AttentionReader,
  broker: UserQuestionBroker,
): AttentionSlashState => {
  const rows = (): AttentionListRow[] =>
    attention
      .snapshot()
      .flatMap((a): AttentionListRow[] =>
        a.pendingQuestion === null
          ? []
          : [
              {
                taskId: a.id,
                label: a.label,
                requestId: a.pendingQuestion.requestId,
                askedAt: a.pendingQuestion.askedAt,
                summary: a.pendingQuestion.summary,
              },
            ],
      )
      .sort((x, y) => x.askedAt - y.askedAt || byteCompare(x.requestId, y.requestId))
  return {
    list: rows,
    next: (afterRequestId) => {
      const sorted = rows()
      if (afterRequestId === undefined) return sorted[0]
      const idx = sorted.findIndex((r) => r.requestId === afterRequestId)
      // Unknown cursor ⇒ oldest; otherwise the strictly-next awaiting agent.
      return idx === -1 ? sorted[0] : sorted[idx + 1]
    },
    answer: (requestId, text) => {
      // In-process CAS: read the LIVE revision immediately before the settle so a
      // single-threaded CLI answer never spuriously reports `stale`; a
      // concurrently-settled/cancelled id reports `unknown` (harmless no-op).
      const res = broker.answer(requestId, { text }, broker.revision())
      return res.ok ? { kind: "answered" } : { kind: res.reason }
    },
  }
}

/** Render one attention row as a one-line list entry. */
const renderRow = (r: AttentionListRow, now: number): string => {
  const ageS = Math.max(0, Math.round((now - r.askedAt) / 1000))
  return `  [${r.taskId}] (${r.requestId}) ${r.summary} — asked ${ageS}s ago`
}

/**
 * Select the next agent needing attention and DRILL it (honest degrade for the
 * single-focus REPL — trap T6: NOT a literal focus move). Prints the top pick as
 * a one-line notice and, when a fleet getter is wired, the `/agents inspect`
 * detail. Shared by the `/attention next` sub-command AND the operator-bindable
 * `focus-next-attention` KEY_ACTION so both take the operator to the SAME agent.
 * Returns the pick (or `undefined` when nothing is awaiting).
 */
export const runFocusNextAttention = (deps: {
  readonly attention: AttentionSlashState
  readonly agents?: (() => readonly AgentFleetRow[]) | undefined
  readonly now: number
  readonly out: (s: string) => void
  readonly afterRequestId?: string
}): AttentionListRow | undefined => {
  const pick = deps.attention.next(deps.afterRequestId)
  if (pick === undefined) {
    deps.out("/attention: all caught up — no agent is awaiting your input\n")
    return undefined
  }
  deps.out(`→ next needing attention: [${pick.taskId}] (${pick.requestId}) ${pick.summary}\n`)
  // Drill the pick (identification, not a literal focus move). Absent fleet
  // getter ⇒ the notice above is the whole receipt.
  if (deps.agents !== undefined) {
    deps.out(`${renderAgentInspect(deps.agents(), pick.taskId, { now: deps.now })}\n`)
  }
  return pick
}

/** RFC-01 A4 — `/attention` registration gate. Default-OFF (opt-IN): the command
 *  is only REGISTERED when `QUANTA_ATTENTION_NAV` is on, so the `/help` catalog +
 *  command table are byte-identical when the gate is unset (parity with `/ps`;
 *  T2/T3 — a slash always in the registry changes `/help`, breaking OFF parity).
 *  Routed through the typed `readCliKnob` accessor (never raw `process.env`). */
export const isAttentionNavEnabled = (): boolean =>
  readCliKnob("QUANTA_ATTENTION_NAV", "bool") ?? false

const usage =
  "/attention: usage — /attention (list) | /attention next | /attention answer <requestId> <text>"

const handleAnswer = (
  args: readonly string[],
  ctx: SlashContext,
  state: AttentionSlashState,
): number => {
  const requestId = args[1]
  const text = args.slice(2).join(" ")
  if (requestId === undefined || text.length === 0) {
    ctx.err("/attention answer: requires <requestId> <text>\n")
    return 1
  }
  const res = state.answer(requestId, text)
  if (res.kind === "answered") {
    ctx.out(`/attention: answered ${requestId} — the waiting agent resumes\n`)
    return 0
  }
  if (res.kind === "unknown") {
    ctx.err(
      `/attention: no pending question '${requestId}' (already answered, cancelled, or never existed)\n`,
    )
    return 1
  }
  ctx.err(`/attention: '${requestId}' changed under you (stale) — re-run /attention and retry\n`)
  return 1
}

/** RFC-01 A4 — `/attention` list / navigate / answer. */
export const attentionCmd: SlashCommand = {
  name: "/attention",
  describe:
    "Agents awaiting your input (list | next: select+drill | answer <requestId> <text>). Opt-in: QUANTA_ATTENTION_NAV=1",
  category: "loop",
  async run(args, ctx) {
    const state = ctx.attention
    if (state === undefined) {
      ctx.out("/attention: not wired in this surface\n")
      return 0
    }
    const now = ctx.now?.() ?? Date.now()
    const sub = args[0]
    if (sub === "next") {
      runFocusNextAttention({ attention: state, agents: ctx.agents, now, out: ctx.out })
      return 0
    }
    if (sub === "answer") {
      return handleAnswer(args, ctx, state)
    }
    if (sub !== undefined && sub !== "list") {
      ctx.err(`/attention: unknown sub-command '${sub}'\n${usage}\n`)
      return 1
    }
    // Default / `list`.
    const rows = state.list()
    if (rows.length === 0) {
      ctx.out("/attention: no agent is awaiting your input\n")
      return 0
    }
    const lines = rows.map((r) => renderRow(r, now))
    ctx.out(
      `Agents awaiting input — ${rows.length} (oldest first):\n${lines.join("\n")}\n` +
        `Use '/attention next' to go to the oldest, or '/attention answer <requestId> <text>'.\n`,
    )
    return 0
  },
}
