/**
 * `tools/dev/worker-home` — what a shard worker's scratch HOME is allowed to see.
 *
 * # The defect this carves out
 *
 * Every local shard worker used to get a symlink from its scratch HOME to the
 * developer's real `~/Library`. The measurement that licensed it was narrow and
 * real — a raw CDP probe completed `Page.navigate` 2/6 times under a cold HOME
 * and 6/6 with the real Library lent in — but the workaround was applied to
 * EVERY worker. A full suite plans 44 chunks; 12 files classify `browser`, and
 * only three of those drive a real Chrome (the rest match the detector on a
 * string literal). So ~43 of 44 workers were handed the user's entire Library —
 * Mail, Keychains, Safari, Messages, every app's Application Support — for a
 * browser they never start, from processes that routinely spawn shells.
 *
 * Two further consequences, beyond the exposure itself: the link is invisible
 * to cache and receipt identity, and it does not exist on Linux CI. The local
 * and hosted lanes were not running the same thing and nothing said so.
 *
 * # Why this is a decision function
 *
 * The runner (`run-test-shards.ts`) ends in a top-level `await main()`, so it
 * cannot be imported by a test. Keeping the policy here means the guard can
 * assert it directly instead of re-deriving it from a source grep.
 */

import { existsSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_VERDICTS_ENV,
} from "./capability-receipt"

/** The three variables a campaign receipt delivers. All three, or none. */
export const CAMPAIGN_CAPABILITY_ENV: readonly string[] = [
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_VERDICTS_ENV,
]

/** Mirrors `TestResourceClass` structurally to avoid importing the planner. */
export type WorkerResourceClass = string

/** Env this decision reads, injectable so the guard needs no process mutation.
 *  An open record rather than a one-key interface: `process.env` is an index
 *  signature, and a closed shape shares no properties with it under
 *  `exactOptionalPropertyTypes`. */
export type WorkerHomeEnv = Readonly<Record<string, string | undefined>>

export type UserLibraryDecision =
  /** Browser lane, opted in: the measured Chrome workaround applies. */
  | "lend"
  /** Not a browser chunk — there is no Chrome here to work around. */
  | "not-browser"
  /** Explicitly disabled; the browser lane inherits the 1-in-3 navigate. */
  | "opted-out"

/**
 * The only condition under which a worker HOME may reach the real `~/Library`.
 *
 * Scoped rather than deleted: removing it for the browser lane too needs the
 * Chrome capability producer to own a disposable profile and RE-MEASURE the
 * navigate rate. Dropping it silently would trade a safety defect for a flake
 * nobody could attribute, which is the worse of the two.
 */
export const userLibraryDecision = (
  resourceClass: WorkerResourceClass,
  env: WorkerHomeEnv = process.env,
): UserLibraryDecision => {
  if (resourceClass !== "browser") return "not-browser"
  if (env.QUANTA_TEST_NO_USER_LIBRARY === "1") return "opted-out"
  return "lend"
}

/**
 * Apply the decision to a real worker HOME.
 *
 * Lives here, not in the runner, so a guard can execute it. A source scan for a
 * class-aware call site is not a proof: a call that passes `resourceClass` in
 * FORM while computing it wrongly reads identically. What a test can check
 * instead is the only thing that matters — whether a `Library` entry appears
 * under the worker HOME for each class.
 *
 * `sourceLibrary` is injectable so the guard does not have to reach into the
 * developer's real home to observe the effect.
 */
export const applyUserLibraryDecision = (input: {
  readonly workerHome: string
  readonly resourceClass: WorkerResourceClass
  readonly env?: WorkerHomeEnv
  readonly sourceLibrary?: string
}): UserLibraryDecision | "unavailable" => {
  const decision = userLibraryDecision(input.resourceClass, input.env ?? process.env)
  if (decision !== "lend") return decision
  try {
    const real = input.sourceLibrary ?? join(homedir(), "Library")
    if (!existsSync(real)) return "unavailable"
    symlinkSync(real, join(input.workerHome, "Library"))
    return "lend"
  } catch {
    // Already linked, or a platform without this convention.
    return "unavailable"
  }
}

/**
 * Everything a shard worker's environment is composed from, in one place.
 *
 * # Why the composition moved here
 *
 * It was an object literal at the `spawnWorker` call site:
 *
 *   env: { ...workerEnv, HOME: workerHome, TMPDIR: workerTmp, … }
 *
 * with `Object.assign(workerEnv, capabilityEnv)` fifteen lines earlier. That is
 * correct and it is also unguarded in the one way that matters: the campaign's
 * capability receipt reaches the gated `describe` blocks through those two
 * variables and nothing else. Drop them, or let a later spread win, and every
 * capability answers `blocked-missing`, every gated block becomes
 * `describe.skip`, and the suite reports a PASS having executed nothing — the
 * exact defect the receipt was built to end, which lived in this tree for the
 * whole life of the artifact because a producer was never called.
 *
 * A source grep cannot catch that. `run-test-shards.ts` ends in a top-level
 * `await main()` and cannot be imported, which is the same reason
 * `userLibraryDecision` lives here. So the composition is a function, and the
 * delivery invariant is enforced by the function rather than asserted about it.
 */
export interface WorkerSpawnEnvInput {
  /** The runner's environment, already stripped of the admission deadline. */
  readonly base: WorkerHomeEnv
  /** The campaign receipt's variables. Empty is legal; partial is not. */
  readonly capabilityEnv: Readonly<Record<string, string>>
  readonly workerHome: string
  readonly workerTmp: string
  readonly repoRoot: string
  readonly quantaHome: string
  readonly prefsHome: string
  readonly benchResults: string
  readonly scanReachSink: string
  readonly testTimeoutMs: number
}

/**
 * The worker's environment, with the capability variables proven present.
 *
 * Throws rather than returning a bag that is missing them: a worker launched
 * without the receipt does not fail, it SKIPS, and a skip is reported as a
 * pass. There is no safe degraded mode, so this refuses to produce one.
 */
export const workerSpawnEnv = (input: WorkerSpawnEnvInput): Record<string, string | undefined> => {
  const perWorker: Record<string, string> = {
    HOME: input.workerHome,
    TMPDIR: input.workerTmp,
    PWD: input.repoRoot,
    QUANTA_HOME: input.quantaHome,
    QUANTA_PREFS_HOME: input.prefsHome,
    QUANTA_BENCH_RESULTS_DIR: input.benchResults,
    QUANTA_SCAN_REACH_RECORD: input.scanReachSink,
    QUANTA_TEST_TIMEOUT_SCALE: String(input.testTimeoutMs / 60_000),
  }
  const bag = input.capabilityEnv
  // ONLY the three campaign variables. This also rules out a per-worker override
  // adopting one of their names, which a separate collision check used to guard —
  // and with this rule that check could never fire, so it is gone rather than
  // kept as a guard that cannot fail.
  const stray = Object.keys(bag).filter((key) => !CAMPAIGN_CAPABILITY_ENV.includes(key))
  if (stray.length > 0) {
    throw new Error(
      `[worker-home] ${stray.join(", ")} is not a campaign capability variable. The capability ` +
        `bag carries exactly ${CAMPAIGN_CAPABILITY_ENV.join(", ")}; anything else would collide ` +
        "with a per-worker override, and which one won would depend on spread order.",
    )
  }
  // PRESENT means an OWN key with a non-empty string. `key in bag` counted a key
  // inherited through the prototype, and an own key holding `undefined` or "",
  // as present — and the spread then delivered nothing for them.
  const present = CAMPAIGN_CAPABILITY_ENV.filter((key) => Object.hasOwn(bag, key))
  const empty = present.filter((key) => typeof bag[key] !== "string" || bag[key] === "")
  if (empty.length > 0) {
    throw new Error(`[worker-home] capability variable(s) ${empty.join(", ")} present but empty`)
  }
  // ALL THREE OR NONE. The consumer compares the binding only when it is present,
  // so a path without one is an UNBOUND receipt; without the verdicts digest a
  // worker replays a green earned on a differently capable host.
  if (present.length > 0 && present.length < CAMPAIGN_CAPABILITY_ENV.length) {
    const missing = CAMPAIGN_CAPABILITY_ENV.filter((key) => !present.includes(key))
    throw new Error(
      `[worker-home] partial capability env: ${present.join(", ")} present, ` +
        `${missing.join(", ")} missing. The consumer compares the binding only when it is ` +
        "present, so a path without one is an UNBOUND receipt, and a worker without the " +
        "verdicts digest replays a green earned on a differently capable host.",
    )
  }
  // The runner's OWN environment never supplies a receipt. The all-or-nothing
  // check above looked only at the bag, so an empty bag let a stale receipt in
  // the runner's env — even a path with no binding — straight through to the
  // worker. The TVH-11 handoff tells developers to `export` these variables, so
  // that environment is not hypothetical.
  const base = Object.fromEntries(
    Object.entries(input.base).filter(([key]) => !CAMPAIGN_CAPABILITY_ENV.includes(key)),
  )
  const env: Record<string, string | undefined> = {
    ...base,
    ...Object.fromEntries(present.map((key) => [key, bag[key]])),
    ...perWorker,
  }
  return env
}
