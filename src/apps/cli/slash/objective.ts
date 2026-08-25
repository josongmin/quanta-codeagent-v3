/**
 * RFC-03 C3 — `/objective` CLI edit front door (`@/apps/cli/slash`).
 *
 * The operator's revisioned, CAS-guarded editor for the per-thread objective —
 * the surface realization of the `session.objective.mutate` verb (the web/SDK
 * daemon dispatches the SAME verb through the kernel/host command bus; the CLI
 * REPL is single-focus so it applies it IN-PROCESS through the objective
 * AUTHORITY, exactly as RFC-01 A4's `/attention answer` applies its broker verb
 * in-process rather than round-tripping the kernel).
 *
 * Every write binds ACTOR = `user` (an operator-issued command is a user action,
 * never model input — RFC-03 §8) and the objective THREAD from the surface's
 * session identity. Each sub-command reads the CURRENT revision and runs a FRESH
 * `prepare`/`commit` cycle under CAS: a "revision request" (edit after someone
 * else moved the objective) is a NEW prepare cycle, never a mutation of an
 * approved/stale candidate. A concurrent model/CLI edit at the same revision
 * yields exactly ONE commit; the loser gets a `stale` refresh-required refusal
 * and never clobbers the winner.
 *
 * Sub-commands:
 *   - `/objective`               show the current goal + 6-state status + updated-ago
 *   - `/objective edit <text>`   replace the goal text (fresh prepare cycle)
 *   - `/objective pause`         pause pursuit (`updateStatus paused`)
 *   - `/objective resume`        resume pursuit (`updateStatus active`)
 *   - `/objective clear`         drop pursuit (delete the objective; revision tombstone)
 *   - `/objective <text>`        REPLACE-GUARD: prints "run /objective edit <text>"
 *                                instead of silently overwriting an active goal
 *
 * DEFAULT-OFF: the command is only REGISTERED when `QUANTA_PROPOSE_GOAL` is on
 * (see {@link isObjectiveEditorEnabled}), so the `/help` catalog + command table
 * are byte-identical when the gate is unset (registration ≠ execution; parity
 * with `/attention` / `/ps`). When the slot (`ctx.objectiveEditor`) is absent it
 * prints "not wired" + exit 0 (parity with `/agents`).
 */

import type { ObjectivePort, ObjectiveStatus } from "@/objective"
import { asObjectiveAuthority } from "@/objective"
import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand, SlashContext } from "../slash-contract"
import { successReceipt } from "./render-helpers"

const MAX_GOAL_CHARS = 4000

/** A read projection of the live objective for the CLI editor. */
export interface ObjectiveEditView {
  readonly goal: string
  readonly status: ObjectiveStatus
  /** The per-thread domain revision (CAS bookkeeping the operator can cite). */
  readonly revision: number
  /** Epoch ms of the last mutation — drives the "Updated N min ago" line. */
  readonly updatedAt: number
}

/** CLOSED outcome of an in-process CAS edit. `stale` carries the revision the
 *  operator must re-read; `no-objective` means the verb needs an existing goal. */
export type ObjectiveEditOutcome =
  | {
      readonly kind: "ok"
      readonly revision: number
      readonly goal: string
      readonly status: ObjectiveStatus
    }
  | { readonly kind: "stale"; readonly currentRevision: number }
  | { readonly kind: "no-objective" }
  | { readonly kind: "invalid" }

/** The CLI `/objective` wire (`ctx.objectiveEditor`). A thin projection over the
 *  live objective AUTHORITY; the surface builds it via
 *  {@link buildObjectiveSlashState}. Absent ⇒ `/objective` prints "not wired". */
export interface ObjectiveSlashState {
  /** Current goal projection, or `null` when no objective is set. */
  read(): ObjectiveEditView | null
  /** Replace the goal text — a FRESH prepare cycle at the current revision. */
  edit(goal: string): ObjectiveEditOutcome
  /** Set an explicit status intent (`active` resume / `paused` pause). */
  setStatus(status: "active" | "paused"): ObjectiveEditOutcome
  /** Drop pursuit (delete the objective) — parity with `/goal clear`. */
  clear(): ObjectiveEditOutcome
}

/**
 * Build the `/objective` wire over the live objective AUTHORITY (the SAME
 * instance the `objective_*` tools + the continuation ticker share, recovered
 * via {@link asObjectiveAuthority}). Every mutation binds ACTOR `user` +
 * the surface's session THREAD and runs a fresh `prepare`/`commit` under CAS.
 */
export const buildObjectiveSlashState = (
  port: ObjectivePort,
  threadId: string,
  onMutation?: () => void,
): ObjectiveSlashState => {
  const authority = asObjectiveAuthority(port)
  const view = (): ObjectiveEditView | null => {
    const o = authority.get(threadId)
    if (o === null) return null
    return {
      goal: o.goal,
      status: o.status,
      revision: authority.readDomain(threadId).revision,
      updatedAt: o.updatedAt,
    }
  }
  const commit = (
    mutation: Parameters<typeof authority.prepare>[0]["mutation"],
  ): ObjectiveEditOutcome => {
    // FRESH prepare cycle at the CURRENT revision (a stale peer edit races here).
    const prepared = authority.prepare({ threadId, actor: "user", mutation })
    const res = authority.commit(prepared, { admitted: true })
    if (res.ok) {
      onMutation?.()
      const o = authority.get(threadId)
      return {
        kind: "ok",
        revision: res.revision,
        goal: o?.goal ?? "",
        status: o?.status ?? "active",
      }
    }
    if (res.reason === "stale") return { kind: "stale", currentRevision: res.currentRevision }
    return { kind: "invalid" }
  }
  return {
    read: view,
    // GOAL-01 — `create` when no goal is live, `replace` (fresh generation,
    // evidence reset) when one is; explicit status is `active | paused` only;
    // clear is a real deletion (revision tombstone), not a pause.
    edit: (goal) =>
      authority.get(threadId) === null
        ? commit({ kind: "create", definition: { goal } })
        : commit({ kind: "replace", definition: { goal } }),
    setStatus: (status) =>
      authority.get(threadId) === null
        ? { kind: "no-objective" }
        : commit({ kind: "setExplicitStatus", status }),
    clear: () =>
      authority.get(threadId) === null ? { kind: "no-objective" } : commit({ kind: "clear" }),
  }
}

/** RFC-03 C3 — `/objective` registration gate. Default-OFF (opt-IN): registered
 *  only when `QUANTA_PROPOSE_GOAL` is on so `/help` + the command table are
 *  byte-identical when the gate is unset (parity with `/attention` / `/ps`).
 *  Routed through the typed `readCliKnob` accessor (never raw `process.env`). */
export const isObjectiveEditorEnabled = (): boolean =>
  readCliKnob("QUANTA_PROPOSE_GOAL", "bool") ?? false

/** 6-state status label map (drift-guarded: adding an `ObjectiveStatus` fails
 *  compile via the `Record<ObjectiveStatus, string>` completeness). */
const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  active: "Pursuing goal",
  completed: "Goal achieved",
  paused: "Paused goal",
  blocked: "Goal stalled",
  budget_limited: "Goal limited",
  usage_limited: "Goal usage limited",
}

const updatedAgo = (updatedAt: number, now: number): string => {
  const deltaS = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (deltaS < 60) return "Updated just now"
  const mins = Math.round(deltaS / 60)
  return `Updated ${mins} min ago`
}

const renderView = (view: ObjectiveEditView, now: number): string =>
  `🎯 ${STATUS_LABEL[view.status]}: ${view.goal}\n` +
  `  status: ${view.status} · ${updatedAgo(view.updatedAt, now)} · rev ${view.revision}\n`

/** Map an edit outcome to operator output + exit code. */
const reportOutcome = (
  ctx: SlashContext,
  outcome: ObjectiveEditOutcome,
  okLine: (o: Extract<ObjectiveEditOutcome, { kind: "ok" }>) => string,
): number => {
  switch (outcome.kind) {
    case "ok":
      ctx.out(okLine(outcome))
      return 0
    case "stale":
      ctx.err(
        `/objective: changed under you (now rev ${outcome.currentRevision}) — re-run /objective and retry\n`,
      )
      return 1
    case "no-objective":
      ctx.err("/objective: no objective set — use /objective edit <text> first\n")
      return 1
    case "invalid":
      ctx.err("/objective: could not apply the edit\n")
      return 1
  }
}

const handleEdit = (
  args: readonly string[],
  ctx: SlashContext,
  state: ObjectiveSlashState,
): number => {
  const text = args.slice(1).join(" ").trim()
  if (text === "") {
    ctx.err("/objective edit: requires <text>\n")
    return 1
  }
  if (text.length > MAX_GOAL_CHARS) {
    ctx.err(`/objective edit: objective too long (${text.length} > ${MAX_GOAL_CHARS} chars)\n`)
    return 1
  }
  return reportOutcome(
    ctx,
    state.edit(text),
    (o) => `${successReceipt(`Goal updated (rev ${o.revision}): ${o.goal}`)}\n`,
  )
}

/** RFC-03 C3 — `/objective` show / edit / pause / resume / clear. */
export const objectiveCmd: SlashCommand = {
  name: "/objective",
  describe:
    "Edit the pursued objective under CAS (show | edit <text> | pause | resume | clear). Opt-in: QUANTA_PROPOSE_GOAL=1",
  category: "session",
  async run(args, ctx) {
    const state = ctx.objectiveEditor
    if (state === undefined) {
      ctx.out("/objective: not wired in this surface\n")
      return 0
    }
    const now = ctx.now?.() ?? Date.now()
    const sub = args[0]

    if (sub === undefined || sub === "show") {
      const view = state.read()
      if (view === null) {
        ctx.out("/objective: no objective set. Use /objective edit <text> to set one.\n")
        return 0
      }
      ctx.out(renderView(view, now))
      return 0
    }
    if (sub === "edit") return handleEdit(args, ctx, state)
    if (sub === "pause") {
      return reportOutcome(
        ctx,
        state.setStatus("paused"),
        () => `${successReceipt("Goal paused — auto-pursuit suppressed.")}\n`,
      )
    }
    if (sub === "resume") {
      return reportOutcome(
        ctx,
        state.setStatus("active"),
        () => `${successReceipt("Goal resumed — auto-pursuit re-armed.")}\n`,
      )
    }
    if (sub === "clear") {
      return reportOutcome(ctx, state.clear(), () => `${successReceipt("Goal cleared.")}\n`)
    }
    // REPLACE-GUARD: bare `/objective <text>` never silently overwrites.
    const view = state.read()
    if (view !== null) {
      ctx.err(
        `/objective: a goal is already set ("${view.goal}"). Run '/objective edit ${args.join(" ")}' to replace it.\n`,
      )
      return 1
    }
    // No goal yet. A MULTI-word arg is unambiguously goal text ⇒ set it. A single
    // bare token is ambiguous (a mistyped verb like `pasue` would otherwise
    // silently become the goal), so require the explicit `edit` verb — matching
    // the unknown-sub-command rejection the sibling commands use.
    if (args.length === 1) {
      ctx.err(
        `/objective: unknown sub-command '${args[0]}' (expected show|edit|pause|resume|clear). To set a one-word goal, run '/objective edit ${args[0]}'.\n`,
      )
      return 1
    }
    return handleEdit(["edit", ...args], ctx, state)
  },
}

export type { SlashContext }
