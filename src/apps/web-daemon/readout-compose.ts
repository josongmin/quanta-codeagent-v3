/**
 * `@/apps/web-daemon/readout-compose` — the one place the daemon assembles its
 * {@link WebReadoutSources}.
 *
 * Hoisted out of `startWebDaemon` for two reasons. The mechanical one: that
 * function sits one line under the god-function ceiling, so every future readout
 * would have had to fight for room in the wrong file. The load-bearing one: the
 * goal accessor must be bound to the LIVE session id, and binding a per-session
 * identity inside a composition root is exactly the hop that broke the
 * observability objective pane before `bindObjectivePaneThread` existed. Doing it
 * in a named unit means a test can drive the real composition instead of
 * re-implementing it.
 *
 * The runtime FACADE cannot own the goal accessor: it is built before any
 * session exists, so it has no thread id to read the domain for. That is the
 * same reason `cost` is composed here — the server owns the authority projection.
 */

import {
  createObjectiveCapabilities,
  type ObjectivePort,
  type ObjectiveVerificationPort,
  reconcileObjectiveRead,
} from "@/objective"
import type { WebReadoutSources } from "./readout"

/** What a runtime facade may optionally carry. Both are composition extensions
 *  rather than `RuntimeFacade` fields, so the daemon duck-reads them — and it
 *  does so HERE, once, instead of at each call site. */
interface FacadeExtensions {
  readonly readoutSources?: WebReadoutSources
  readonly objectiveAuthority?: ObjectivePort
  readonly objectiveVerifier?: ObjectiveVerificationPort
}

export interface DaemonReadoutComposeArgs {
  /** The runtime facade, duck-read for its readout sources and objective
   *  authority. Omitted by tests that inject the pieces directly. */
  readonly runtime?: unknown
  /** Accessors the runtime facade already built (session-independent). */
  readonly facade?: WebReadoutSources | undefined
  /** The objective authority, when this daemon composed one. */
  readonly objectiveAuthority?: ObjectivePort | undefined
  /** The same verifier coordinator used by settlement and browser verify. */
  readonly objectiveVerifier?: ObjectiveVerificationPort | undefined
  /** Rearm the existing wake owner after reconcile invalidates a receipt. */
  readonly onGoalMutation?: (() => void) | undefined
  /** The LIVE session id — the key the objective domain is stored under. */
  readonly threadId: string
  /** The server-owned turn-usage fold. */
  readonly cost?: WebReadoutSources["cost"]
  /** Injectable clock (deterministic age rendering under test). */
  readonly now?: () => number
}

export const buildDaemonReadoutSources = (args: DaemonReadoutComposeArgs): WebReadoutSources => {
  const facadeExt = (args.runtime ?? {}) as FacadeExtensions
  const authority = args.objectiveAuthority ?? facadeExt.objectiveAuthority
  const verifier = args.objectiveVerifier ?? facadeExt.objectiveVerifier
  const goal: WebReadoutSources["goal"] =
    authority === undefined
      ? undefined
      : (() => {
          const read = createObjectiveCapabilities(authority).read
          return async () => {
            const before = read.readDomain(args.threadId).revision
            const result = await reconcileObjectiveRead(read, verifier, args.threadId)
            if (result.freshness.kind === "invalidated" && result.domain.revision !== before) {
              args.onGoalMutation?.()
            }
            return result
          }
        })()
  return {
    ...(args.facade ?? facadeExt.readoutSources ?? {}),
    ...(args.cost !== undefined ? { cost: args.cost } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(args.now !== undefined ? { now: args.now } : {}),
  }
}
