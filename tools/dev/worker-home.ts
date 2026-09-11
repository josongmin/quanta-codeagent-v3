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
