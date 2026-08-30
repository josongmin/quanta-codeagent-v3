/**
 * `/goal` for the browser — show, set, work, and control the durable goal.
 *
 * # Why this file exists
 * The SPA shipped the entire goal-work transport (`sendGoalWork`,
 * `onGoalWorkResult`, a no-throw decoder, inbound dispatch, its own test suite)
 * and nothing called it, and the palette had no `goal` row at all — not even an
 * `unwired(...)` stub pointing at the CLI. This is the caller.
 *
 * # Why the control verbs are here and not a new mechanism
 * The USER actor is allowed `replace` / `clear` / `setExplicitStatus` by the
 * policy table, and the host binds `session.objective.mutate` to that actor and
 * to THIS session. Kernel, protocol and typed refusals all exist. What was
 * missing was a caller, so that is all this adds.
 *
 * # Why set and work landed together
 * A work verb alone would be inert. The browser cannot create an objective any
 * other way: a model `create` is refused `actor-forbidden` with the propose gate
 * off and `approval-unavailable` with it on (the daemon composes no confirm
 * surface), so on a fresh web session `goal work` would answer "the goal is not
 * active" every time.
 *
 * # Concurrency semantics — read this before adding a verb
 * The browser sends NO `expectedObjectiveRevision`, so the host binds the
 * revision it reads at APPLY time. That is an atomic apply against
 * current state; it is NOT optimistic concurrency against what the operator was
 * looking at. Concretely: a `replace`/`clear` under a started attempt is refused
 * by the domain, but two idle surfaces editing at once is LAST-WRITER-WINS, and
 * a stale browser view is not detected. This is deliberate CLI parity, not a
 * safety claim. Strict cross-surface conflict detection needs a structured
 * `objectiveRevision` on the readout payload — never parsed out of the rendered
 * text — and is its own packet.
 *
 * # Why the read is HTTP and the writes are not
 * The readout is lease-free, so it answers MID-TURN — exactly when someone wants
 * to look at a goal that is being worked. The writes must be ordered against the
 * turn, so they ride the channels that are.
 *
 * # What read-back does and does not prove
 * It proves the DESIRED END STATE was observed. It is not an acknowledgement:
 * the command's own accept/refusal is a session `rejected` frame, which the
 * transcript renders on its own. A refusal therefore shows up as BOTH a refusal
 * line and a "did not land" line, which is the honest pair.
 */

import type { SlashCommand } from "./SlashPalette"
import { fetchReadoutBody, type ReadoutEndpoint } from "./slash-readout"

export interface GoalSlashDeps extends ReadoutEndpoint {
  /** Non-optional here: a write that cannot be delivered must be SAID. */
  readonly onError: (msg: string) => void
  /** Send `session.objective.mutate`. `false` ⇒ the frame did not leave. */
  readonly sendObjectiveMutate: (mutation: unknown) => boolean
  /** Ask for ONE user-requested goal turn. `false` ⇒ the frame did not leave. */
  readonly sendGoalWork: (text: string) => boolean
  /** READ a readout without printing it. REQUIRED: without it a control verb can
   *  only report optimistically, which is the posture `/model` was moved off. */
  readonly readReadout: (name: string) => Promise<string | undefined>
  /** Injected sleep (test seam). Absent ⇒ a real timer. */
  readonly delay?: (ms: number) => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// readout parsing
// ─────────────────────────────────────────────────────────────────────────────

export type GoalReadout =
  | { readonly present: false }
  | { readonly present: true; readonly goal: string; readonly status: string }

const ABSENT: GoalReadout = { present: false }

/** Collapse to the one-line form the daemon renders, so a multi-line goal
 *  compares equal to what the operator typed. */
export const collapseGoalText = (text: string): string => text.replace(/\s+/g, " ").trim()

/**
 * Parse the `/goal` readout body into the two facts a control verb needs.
 *
 * Deliberately a parser and not `body.includes(text)`: the body carries the
 * goal's own words in blocker lines, criteria and next-actions, so a substring
 * test reports success when the goal is something else entirely. An
 * unrecognised body is ABSENCE — never a confident wrong answer.
 */
export const parseGoalReadout = (body: string): GoalReadout => {
  if (body.includes("No goal is set")) return ABSENT
  const goal = /^goal\s+(.+)$/m.exec(body)?.[1]
  const status = /^status\s+(\S+)/m.exec(body)?.[1]
  return goal === undefined || status === undefined
    ? ABSENT
    : { present: true, goal: collapseGoalText(goal), status }
}

// ─────────────────────────────────────────────────────────────────────────────
// the verb table
// ─────────────────────────────────────────────────────────────────────────────

interface ControlVerb {
  /** Does the verb consume the rest of the line? */
  readonly takesArgument: boolean
  readonly mutation: (argument: string) => unknown
  /** The END STATE this verb is asking for. */
  readonly landed: (readout: GoalReadout, argument: string) => boolean
  /** Shown when the end state never appears. */
  readonly pending: string
}

const statusIs =
  (want: string) =>
  (readout: GoalReadout): boolean =>
    readout.present && readout.status === want

const CONTROL_VERBS: Readonly<Record<string, ControlVerb>> = {
  pause: {
    takesArgument: false,
    mutation: () => ({ kind: "setExplicitStatus", status: "paused" }),
    landed: statusIs("paused"),
    pending: "the goal did not become paused",
  },
  resume: {
    takesArgument: false,
    mutation: () => ({ kind: "setExplicitStatus", status: "active" }),
    landed: statusIs("active"),
    pending:
      "the goal did not become active — a blocked goal needs its blocker cleared first, " +
      "and a budget-limited one cannot be resumed at all",
  },
  clear: {
    takesArgument: false,
    mutation: () => ({ kind: "clear" }),
    landed: (readout) => !readout.present,
    pending: "the goal is still set — a definition cannot be cleared under a running attempt",
  },
  edit: {
    takesArgument: true,
    mutation: (argument) => ({ kind: "replace", definition: { goal: argument } }),
    landed: (readout, argument) => readout.present && readout.goal === collapseGoalText(argument),
    pending:
      "the goal text did not change — a definition cannot be replaced under a running attempt",
  },
}

const CREATE_VERB: ControlVerb = {
  takesArgument: true,
  mutation: (argument) => ({ kind: "create", definition: { goal: argument } }),
  landed: (readout, argument) => readout.present && readout.goal === collapseGoalText(argument),
  pending: "the goal was not set — this thread may already have one (edit it instead)",
}

const WORK_VERB = "work"

// ─────────────────────────────────────────────────────────────────────────────
// command parsing
// ─────────────────────────────────────────────────────────────────────────────

export type GoalCommand =
  | { readonly kind: "show" }
  | { readonly kind: "work"; readonly instruction: string }
  | { readonly kind: "mutate"; readonly verb: ControlVerb; readonly argument: string }
  | { readonly kind: "error"; readonly message: string }

/** Split `/goal <rest>` into one intent. Pure — the dispatcher does the I/O. */
export const parseGoalCommand = (rest: string): GoalCommand => {
  const trimmed = rest.trim()
  if (trimmed === "") return { kind: "show" }
  const separator = trimmed.search(/\s/)
  const head = separator < 0 ? trimmed : trimmed.slice(0, separator)
  const tail = separator < 0 ? "" : trimmed.slice(separator + 1).trim()

  if (head === WORK_VERB) {
    return tail === ""
      ? { kind: "error", message: "/goal work: needs an instruction — `/goal work <what to do>`" }
      : { kind: "work", instruction: tail }
  }

  const verb = CONTROL_VERBS[head]
  if (verb === undefined) return { kind: "mutate", verb: CREATE_VERB, argument: trimmed }

  if (!verb.takesArgument && tail !== "") {
    // The CLI drops this tail in silence, so `/goal pause the rollout` pauses and
    // discards the words. Refusing costs one line and the alternative is losing a
    // goal to autocomplete.
    return {
      kind: "error",
      message: `/goal ${head}: takes no argument — did you mean \`/goal edit ${tail}\`?`,
    }
  }
  if (verb.takesArgument && tail === "") {
    return { kind: "error", message: `/goal ${head}: needs text — \`/goal ${head} <objective>\`` }
  }
  return { kind: "mutate", verb, argument: tail }
}

// ─────────────────────────────────────────────────────────────────────────────
// execution
// ─────────────────────────────────────────────────────────────────────────────

/** Bounded by ATTEMPTS, not a wall clock: an injected no-op `delay` makes a test
 *  instant instead of busy-spinning to a deadline, and no clock is read. */
const READBACK_ATTEMPTS = 20
const READBACK_INTERVAL_MS = 150

/** Poll the readout until the DESIRED END STATE is observed. `false` ⇒ the window
 *  elapsed without it. Never an acknowledgement of the command. */
export const awaitGoalState = async (
  deps: GoalSlashDeps,
  landed: (readout: GoalReadout) => boolean,
): Promise<boolean> => {
  const sleep = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(READBACK_INTERVAL_MS)
    const body = await deps.readReadout("goal")
    if (body !== undefined && landed(parseGoalReadout(body))) return true
  }
  return false
}

const runMutation = async (
  deps: GoalSlashDeps,
  verb: ControlVerb,
  argument: string,
): Promise<void> => {
  if (!deps.sendObjectiveMutate(verb.mutation(argument))) {
    deps.onError("/goal: could not be sent (the session socket is not open)")
    return
  }
  const landed = await awaitGoalState(deps, (readout) => verb.landed(readout, argument))
  if (!landed) deps.onError(`/goal: ${verb.pending} (any refusal is shown above)`)
  await fetchReadoutBody(deps, "goal")
}

const runWork = (deps: GoalSlashDeps, instruction: string): void => {
  if (!deps.sendGoalWork(instruction)) {
    deps.onError("/goal work: could not be sent (the session socket is not open)")
  }
  // The accept/refusal arrives asynchronously on `goalWorkResult`; the subscriber
  // the host threads prints it. Nothing is claimed here.
}

export const buildGoalSlashCommands = (deps: GoalSlashDeps): readonly SlashCommand[] => [
  {
    slug: "goal",
    kind: "local",
    description:
      "Durable goal — show, set, `work <text>`, `pause`, `resume`, `edit <text>`, `clear`",
    action: async (rest: string): Promise<string> => {
      const command = parseGoalCommand(rest)
      switch (command.kind) {
        case "show":
          await fetchReadoutBody(deps, "goal")
          return ""
        case "work":
          runWork(deps, command.instruction)
          return ""
        case "mutate":
          await runMutation(deps, command.verb, command.argument)
          return ""
        case "error":
          deps.onError(command.message)
          return ""
      }
    },
  },
]
