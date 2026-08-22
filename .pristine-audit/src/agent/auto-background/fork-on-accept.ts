/**
 * ADR-0239 — Default `onAccept` bridge for the auto-background slice.
 *
 * Closes the integration gap left by ADR-0223 (R5 follow-up): the proposer's
 * `accept()` callback was a hand-rolled wire on every host. This helper is the
 * canonical bridge that a composition root can call to bind
 * {@link AutoBackgroundConfig.onAccept} ⇒ {@link BackgroundSubagentScheduler.fork}
 * with ONE function call.
 *
 * Default-OFF: when the scheduler is absent, the helper returns `undefined` so
 * the composition root can spread it conditionally and stay byte-identical with
 * the legacy "no autoBackground.onAccept" path.
 *
 * Plane-clean: this slice imports {@link BackgroundSubagentScheduler} as a TYPE
 * only — no runtime dependency on `@/agent/subagent-background`. The fork call
 * is the only side effect; cap-exceeded throws are swallowed (the proposer
 * already promised NO-THROW on `accept`, so the bridge must honour that).
 *
 * Wire precedence (per the user-supplied spec):
 *
 *   - A host that supplies its OWN `autoBackground.onAccept` callback WINS —
 *     the bridge is consulted ONLY when no user callback is set.
 *   - A composition root that wants the default-fork behaviour calls
 *     `autoBackground: { ...detector, onAccept: buildSubagentForkOnAccept({
 *     scheduler, taskFrom }) }` once at setup time. Subsequent accepts fire
 *     the bridge automatically; no per-turn wiring needed.
 */

import type { AutoBackgroundAcceptCallback } from "./port"

/** Minimal scheduler shape this bridge consumes. Imported as a structural
 *  type rather than `BackgroundSubagentScheduler` so the slice can stay
 *  plane-clean (no `@/agent/subagent-background` import). Production callers
 *  pass a real `BackgroundSubagentScheduler`; tests pass a 1-method fake. */
export interface SubagentForkSink {
  fork(spec: {
    readonly task: string
    readonly maxTurns?: number
    readonly metadata?: Readonly<Record<string, string>>
  }): unknown
}

/** Construction options for {@link buildSubagentForkOnAccept}. */
export interface BuildSubagentForkOnAcceptOpts {
  /** The scheduler the bridge forks into. When `undefined` the builder returns
   *  `undefined` (default-OFF byte-identical — the composition root spreads
   *  the result conditionally, so an absent scheduler leaves the slot empty). */
  readonly scheduler?: SubagentForkSink
  /** Optional: derive the child agent's `task` text from the accept event.
   *  Default returns a single-line nudge that includes the toolCallId and
   *  the observed elapsedMs ("background a stuck call after Ns" pattern). A
   *  host that wants a richer prompt (e.g. injecting the tool name + last
   *  N kb of stdout) wires its own `taskFrom`. */
  readonly taskFrom?: (input: { readonly toolCallId: string; readonly elapsedMs: number }) => string
  /** Optional: bound on turns for the forked subagent. Forwarded verbatim to
   *  `scheduler.fork({ maxTurns })` when set; absent ⇒ scheduler default. */
  readonly maxTurns?: number
  /** Optional: extra metadata pairs the bridge attaches to every fork. Useful
   *  for "all auto-background forks tagged origin=auto-bg" analytics. The
   *  bridge always appends `quanta.autoBg = "1"` so a consumer can filter
   *  these out without parsing the prompt. Host metadata wins on key
   *  collision (rare — `quanta.autoBg` is reserved). */
  readonly metadata?: Readonly<Record<string, string>>
}

/** Default `task` text. Single-line nudge that names the originating tool
 *  call and the observed elapsedMs. Hosts override via `opts.taskFrom`. */
const defaultTaskFrom = (input: {
  readonly toolCallId: string
  readonly elapsedMs: number
}): string =>
  `Resume the stuck tool call ${input.toolCallId} (${input.elapsedMs}ms elapsed) in the background and continue the user's intent without re-asking for the prompt.`

/** Build the default `onAccept` bridge.
 *
 *  Returns `undefined` when `opts.scheduler` is absent — the composition root
 *  is expected to spread the result conditionally:
 *
 *  ```ts
 *  const onAccept = buildSubagentForkOnAccept({ scheduler: cfg.subagentBackground?.scheduler })
 *  cfg.autoBackground = {
 *    detector,
 *    proposer,
 *    ...(onAccept !== undefined ? { onAccept } : {}),
 *  }
 *  ```
 *
 *  When the user already wired a custom `onAccept` they should NOT call this
 *  helper for that slot (per the precedence rule in the file header). The
 *  helper does NOT detect collisions — it just builds a callback.
 *
 *  NO-THROW: every error inside the callback (scheduler cap-exceeded, callable
 *  throw) is swallowed. The proposer's `accept` promise is no-throw and this
 *  bridge must honour it; an exception from `fork` would crash the proposer.
 */
export const buildSubagentForkOnAccept = (
  opts: BuildSubagentForkOnAcceptOpts,
): AutoBackgroundAcceptCallback | undefined => {
  const scheduler = opts.scheduler
  if (scheduler === undefined) return undefined
  const taskFrom = opts.taskFrom ?? defaultTaskFrom
  const maxTurns = opts.maxTurns
  const hostMetadata = opts.metadata
  return (input): void => {
    let task: string
    try {
      task = taskFrom(input)
    } catch {
      // Host bug in taskFrom — fall back to the default text rather than
      // skipping the fork entirely (the user accepted; we owe them an attempt).
      task = defaultTaskFrom(input)
    }
    const metadata: Record<string, string> = {
      "quanta.autoBg": "1",
      "quanta.autoBg.toolCallId": input.toolCallId,
      "quanta.autoBg.elapsedMs": String(input.elapsedMs),
      ...(hostMetadata ?? {}),
    }
    const spec: {
      readonly task: string
      readonly maxTurns?: number
      readonly metadata: Readonly<Record<string, string>>
    } = maxTurns !== undefined ? { task, maxTurns, metadata } : { task, metadata }
    try {
      scheduler.fork(spec)
    } catch {
      // cap-exceeded / unknown error — swallow. The proposer's once-per-id
      // state has already transitioned to "accepted"; we cannot un-accept.
      // A host that needs visibility into fork failures should wire its OWN
      // onAccept (this bridge is convenience; observability is the host's
      // responsibility when it matters).
    }
  }
}
