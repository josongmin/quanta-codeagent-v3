/**
 * `/goal` for the browser — show, set, and work the durable goal.
 *
 * # Why this file exists
 * The SPA already shipped the entire goal-work transport (`sendGoalWork`,
 * `onGoalWorkResult`, a no-throw decoder, inbound dispatch, its own test suite)
 * and nothing called it, and the palette had no `goal` row at all — not even an
 * `unwired(...)` stub pointing at the CLI. This is the caller.
 *
 * # Why set and work land together
 * A work verb alone would be inert. The browser cannot create an objective any
 * other way: a model `create` is refused `actor-forbidden` with the propose gate
 * off and `approval-unavailable` with it on (the daemon composes no confirm
 * surface), so on a fresh web session `goal work` would answer "the goal is not
 * active" every time. The route that does work is `session.objective.mutate`,
 * which the host binds to the USER actor — a first-class session command
 * generated into this package's union since it shipped, with zero callers.
 *
 * # Why the read is an HTTP readout and the writes are not
 * The readout is served out-of-band, so it answers MID-TURN — the session's
 * single-writer lease would refuse a WS read exactly when someone wants to look
 * at a goal that is being worked. The writes are the opposite: they must be
 * ordered against the turn, so they ride the channels that are.
 *
 * Every write is read back. A mutation lands through the kernel and a work
 * request is answered asynchronously on the socket, so echoing the typed text
 * would be a display-only claim; printing the daemon's own readout is not.
 */

import type { SlashCommand } from "./SlashPalette"
import { fetchReadoutBody, type ReadoutEndpoint } from "./slash-readout"

export interface GoalSlashDeps extends ReadoutEndpoint {
  /** Non-optional here: a write that cannot be delivered must be SAID. */
  readonly onError: (msg: string) => void
  /** Send `session.objective.mutate`. `false` ⇒ the socket refused it. */
  readonly sendObjectiveMutate: (mutation: unknown) => boolean
  /** Ask for ONE user-requested goal turn. `false` ⇒ the socket refused it. */
  readonly sendGoalWork: (text: string) => boolean
}

const WORK_VERB = "work"

/** `/goal work <text>` — one attributed goal turn on the live session. */
const runWork = (deps: GoalSlashDeps, rest: string): void => {
  const instruction = rest.slice(WORK_VERB.length).trim()
  if (instruction === "") {
    deps.onError("/goal work: needs an instruction — `/goal work <what to do>`")
    return
  }
  if (!deps.sendGoalWork(instruction)) {
    deps.onError("/goal work: could not be sent (the session socket is not open)")
  }
  // The accept/refusal arrives asynchronously on `goalWorkResult`; the subscriber
  // the host threads prints it. Nothing is claimed here.
}

/** `/goal <objective>` — set the goal, then show what actually landed. */
const runSet = async (deps: GoalSlashDeps, goal: string): Promise<void> => {
  if (!deps.sendObjectiveMutate({ kind: "create", definition: { goal } })) {
    deps.onError("/goal: could not be sent (the session socket is not open)")
    return
  }
  await fetchReadoutBody(deps, "goal")
}

export const buildGoalSlashCommands = (deps: GoalSlashDeps): readonly SlashCommand[] => [
  {
    slug: "goal",
    kind: "local",
    description: "Durable goal — show, set (`/goal <objective>`), or work it (`/goal work <text>`)",
    action: async (rest: string): Promise<string> => {
      const trimmed = rest.trim()
      if (trimmed === "") {
        await fetchReadoutBody(deps, "goal")
        return ""
      }
      if (trimmed === WORK_VERB || trimmed.startsWith(`${WORK_VERB} `)) {
        runWork(deps, trimmed)
        return ""
      }
      await runSet(deps, trimmed)
      return ""
    },
  },
]
