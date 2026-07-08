import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Ambient PARALLEL-LANE context.
 *
 * The bench runs candidate lanes (repair-breadth / verify-select) CONCURRENTLY.
 * Subsystems deep in the agent run — the tool executor, the recorder's per-turn
 * debug drain — need to know WHICH lane they are running under, but they do not
 * receive it as a parameter. The fork sites establish it once with
 * {@link laneContext}.run(lane, fn); everything transitively invoked by `fn`
 * (across await points) reads it via {@link currentLane}.
 *
 * This is the ambient key that makes the debug-sink's per-lane buffering correct
 * under parallelism (each lane's `contribute`/`append` and its `drain` see the
 * SAME lane string). Absent context ⇒ `undefined` (serial runs use one bucket).
 */
export const laneContext = new AsyncLocalStorage<string>()

/** The lane the current async execution is running under, or `undefined` on a
 *  serial path with no established lane. */
export const currentLane = (): string | undefined => laneContext.getStore()
