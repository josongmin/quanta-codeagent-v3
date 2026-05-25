/**
 * Playbook auto-dispatch (ADR-0240) — wire from `inline-trigger-watcher.ts`
 * fire callbacks to the plan-queue follow-up rail.
 *
 * Closes the ADR-0203 gap: prior to this slice the watcher detected marker
 * hits but the `onFire` callback was caller-supplied and unwired in the
 * composition root — no actual dispatch occurred. The dispatcher here is the
 * canonical sink:
 *
 *    fire → resolve(playbookName) → planQueueSink.enqueue(/play <name>,
 *           source="inline_trigger", metadata={ path, line, marker })
 *
 * Slice posture: leaf-only. The dispatcher imports `./port` (watcher fire
 * type) + `./types` (frontmatter shape) ONLY. It does NOT import `@/agent`
 * or `@/tool` — the `planQueueSink` is a structural port (not the concrete
 * `PlanQueueStore`) so this file can run in tests without dragging the full
 * loop in. The composition root is responsible for adapting a real
 * `PlanQueueStore.enqueue` to the {@link PlaybookPlanQueueSink} shape.
 *
 * Design constraints (mirror inline-trigger-watcher.ts):
 *   - NO-THROW public surface — dispatcher returns a typed
 *     {@link DispatchResult} so a malformed registry / sink-side rejection
 *     surfaces as data, never an exception.
 *   - DEFAULT-OFF orchestrator — `startPlaybookAutoDispatch` is a NO-OP
 *     when `enabled !== true`. The composition root may always call it; the
 *     gating happens inside.
 *   - SINK-OPTIONAL — when `planQueueSink` is absent, fires are still
 *     resolved + counted (observable via the returned controller), but the
 *     `/play` follow-up is NOT enqueued (graceful degradation — matches the
 *     "watcher without a queue" rig used in tests).
 */

import { matchesGlobSubset } from "./inline-trigger-watcher"
import type {
  InlineTriggerFire,
  InlineTriggerWatcherHandle,
  InlineTriggerWatcherPort,
} from "./port"
import type { PlaybookFrontmatter } from "./types"

/** A registered playbook the watcher may dispatch. The host owns the lookup
 *  (we don't crack open SKILL.md from here — the validator slice already
 *  does that and the result lives in the host's skill registry). */
export interface PlaybookRegistration {
  /** Stable id used in the `/play <name>` follow-up text. kebab-case. */
  readonly name: string
  /** The parsed frontmatter. MUST carry a non-empty `trigger` for this
   *  registration to actually wire (registrations without a trigger are
   *  silently skipped — they are still valid playbooks, just not auto-
   *  dispatched). */
  readonly frontmatter: PlaybookFrontmatter
  /** Optional absolute filesystem root the watcher should scan. Defaults to
   *  `process.cwd()` at orchestrator-start time. */
  readonly root?: string
}

/** Read-only registry the orchestrator iterates at start time. Hosts may
 *  back this with their existing skill registry or a flat in-memory list. */
export interface PlaybookRegistry {
  readonly list: () => readonly PlaybookRegistration[]
}

/** Structural sink the dispatcher hands the resolved follow-up to. Kept
 *  intentionally narrow (vs. importing the full `PlanQueueStore` interface)
 *  so this slice does not depend on `@/agent`. The composition root adapts
 *  the real `PlanQueueStore.enqueue(...)` to this shape with a one-line
 *  closure. */
export interface PlaybookPlanQueueSink {
  /** Enqueue a `/play <name>` follow-up. Returns ok-discriminated outcome —
   *  sink-side rejection surfaces as `{ok:false, reason}` so the dispatcher
   *  never throws. */
  readonly enqueue: (input: PlaybookFollowUpInput) => { ok: true } | { ok: false; reason: string }
}

/** Payload handed to {@link PlaybookPlanQueueSink.enqueue}. Carries enough
 *  envelope for a multi-thread sink to route correctly + enough fire
 *  context (path, line, marker) for the receiving turn to render a useful
 *  "trigger fired here" line. */
export interface PlaybookFollowUpInput {
  readonly threadId: string
  readonly text: string
  /** Always `"inline_trigger"` — preserved as a separate field so a sink
   *  test can assert the source without parsing the text. */
  readonly source: "inline_trigger"
  /** Free metadata payload. The dispatcher fills:
   *    - `playbook`: registration name
   *    - `path`: absolute path of the saved file
   *    - `line`: 1-based line number of the marker
   *    - `marker`: literal marker substring */
  readonly metadata: Readonly<Record<string, string>>
}

/** Outcome of a single dispatch attempt. Useful for tests + observability
 *  — production callers usually ignore the value. */
export type DispatchResult =
  | { readonly kind: "enqueued"; readonly playbook: string }
  | { readonly kind: "no-sink"; readonly playbook: string }
  | { readonly kind: "sink-rejected"; readonly playbook: string; readonly reason: string }
  | { readonly kind: "not-found"; readonly playbook: string }
  /** Path matched the per-playbook glob but failed the orchestrator-side
   *  `watchGlobs` filter — dispatch suppressed at the orchestrator gate. */
  | { readonly kind: "filtered"; readonly playbook: string; readonly path: string }

/** Direct one-shot dispatch — given a resolved playbook name + fire context
 *  + sink, enqueue the follow-up. Skips the watcher orchestration entirely;
 *  useful for tests and for hosts that wire the watcher themselves but want
 *  the canonical enqueue shape. */
export const dispatchPlaybook = (input: {
  readonly playbookName: string
  readonly fire: InlineTriggerFire
  readonly threadId: string
  readonly planQueueSink?: PlaybookPlanQueueSink
}): DispatchResult => {
  const { playbookName, fire, threadId, planQueueSink } = input
  if (planQueueSink === undefined) {
    return { kind: "no-sink", playbook: playbookName }
  }
  const followUp: PlaybookFollowUpInput = {
    threadId,
    text: `/play ${playbookName}`,
    source: "inline_trigger",
    metadata: {
      playbook: playbookName,
      path: fire.path,
      line: String(fire.line),
      marker: fire.marker,
    },
  }
  let outcome: { ok: true } | { ok: false; reason: string }
  try {
    outcome = planQueueSink.enqueue(followUp)
  } catch (e) {
    return {
      kind: "sink-rejected",
      playbook: playbookName,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
  if (outcome.ok) return { kind: "enqueued", playbook: playbookName }
  return { kind: "sink-rejected", playbook: playbookName, reason: outcome.reason }
}

/** Configuration for {@link startPlaybookAutoDispatch}. All knobs are
 *  default-OFF — when `enabled !== true` the orchestrator returns an
 *  inert controller and never starts the watcher. */
export interface PlaybookAutoDispatchOptions {
  /** Master switch — when `false` (default) the orchestrator is a NO-OP.
   *  The composition root may always call `startPlaybookAutoDispatch`; the
   *  gating happens here so the call site stays one line. */
  readonly enabled: boolean
  /** Filesystem watcher port. Real adapter: `createInlineTriggerWatcher()`.
   *  Tests inject `createMemoryWatcher()`. */
  readonly watcher: InlineTriggerWatcherPort
  /** Registered playbooks to wire. Each registration MUST carry a non-
   *  empty `trigger`; registrations without one are silently skipped. */
  readonly registry: PlaybookRegistry
  /** Optional sink — when absent, fires are detected + counted but NOT
   *  dispatched (graceful degradation). */
  readonly planQueueSink?: PlaybookPlanQueueSink
  /** Thread id stamped on every enqueued follow-up. The watcher fires
   *  across thread boundaries (it's a single fs.watch handle) so a single
   *  thread id matches the original Aider `AI!` semantics — the follow-up
   *  surfaces in the active session. */
  readonly threadId: string
  /** Filesystem root each watcher binds to. When a registration carries
   *  its own `root`, it overrides this value. Defaults to `process.cwd()`. */
  readonly defaultRoot?: string
  /** Per-watcher debounce window (ms). Default 200ms — same default the
   *  watcher uses when `debounceMs` is omitted. */
  readonly debounceMs?: number
  /** Orchestrator-side restricting glob list. A fire is dispatched ONLY
   *  when the saved file's path matches AT LEAST ONE of these globs AND
   *  the per-playbook `trigger.watchGlob`. The per-playbook glob is the
   *  finer filter (e.g. matches all `.ts`/`.py`/`.js` files under root);
   *  these globs are the broad surface gate (e.g. limit to a `src/` or
   *  `tests/` prefix). Default value is a single all-matcher (no extra
   *  restriction). Same fnmatch subset {@link matchesGlobSubset} uses
   *  elsewhere. */
  readonly watchGlobs?: readonly string[]
  /** Optional observer — invoked AFTER every dispatch attempt with the
   *  outcome. Useful for tests + metrics. NO-THROW: a throwing observer
   *  is caught and ignored. */
  readonly onDispatch?: (result: DispatchResult) => void
}

/** Controller returned by {@link startPlaybookAutoDispatch}. The host
 *  calls `.stop()` at session unbind to release every fs.watch handle. */
export interface PlaybookAutoDispatchController {
  /** Number of (registration, watcher-handle) pairs successfully started.
   *  Registrations without a `trigger` and ones whose watcher.start
   *  returned `ok:false` are NOT counted. */
  readonly active: () => number
  /** Stop every watcher handle owned by this controller. Idempotent. */
  readonly stop: () => void
  /** Total dispatch attempts since `.start()`. Counts EVERY fire (including
   *  no-sink + not-found + sink-rejected). For tests / observability. */
  readonly dispatchCount: () => number
}

const NOOP_CONTROLLER: PlaybookAutoDispatchController = {
  active: () => 0,
  stop: () => {
    /* noop */
  },
  dispatchCount: () => 0,
}

/** Orchestrator — starts one watcher per registration with a trigger.
 *  Default-OFF: returns the noop controller when `enabled !== true`. */
export const startPlaybookAutoDispatch = (
  opts: PlaybookAutoDispatchOptions,
): PlaybookAutoDispatchController => {
  if (opts.enabled !== true) return NOOP_CONTROLLER

  const root = opts.defaultRoot ?? process.cwd()
  const debounceMs = opts.debounceMs
  const watchGlobs = opts.watchGlobs ?? ["**/*"]
  const handles: InlineTriggerWatcherHandle[] = []
  let dispatchCount = 0

  /** True iff `path` matches AT LEAST ONE entry in `watchGlobs`. The
   *  per-playbook `trigger.watchGlob` is already enforced by the watcher
   *  itself; this is the orchestrator-side extra gate. */
  const passesOrchestratorFilter = (path: string): boolean => {
    for (const g of watchGlobs) {
      if (matchesGlobSubset(path, g)) return true
    }
    return false
  }

  const onFire = (playbookName: string) => (fire: InlineTriggerFire) => {
    dispatchCount += 1
    let result: DispatchResult
    if (!passesOrchestratorFilter(fire.path)) {
      result = { kind: "filtered", playbook: playbookName, path: fire.path }
    } else {
      result = dispatchPlaybook({
        playbookName,
        fire,
        threadId: opts.threadId,
        ...(opts.planQueueSink !== undefined ? { planQueueSink: opts.planQueueSink } : {}),
      })
    }
    const observer = opts.onDispatch
    if (observer !== undefined) {
      try {
        observer(result)
      } catch {
        /* observer throws never poison the watcher */
      }
    }
  }

  for (const reg of opts.registry.list()) {
    const trigger = reg.frontmatter.trigger
    if (trigger === undefined) continue
    const startResult = opts.watcher.start({
      playbookId: reg.name,
      root: reg.root ?? root,
      trigger,
      onFire: onFire(reg.name),
      ...(debounceMs !== undefined ? { debounceMs } : {}),
    })
    if (!startResult.ok) continue
    handles.push(startResult.handle)
  }

  let stopped = false
  return {
    active: () => handles.filter((h) => !h.isStopped()).length,
    stop: () => {
      if (stopped) return
      stopped = true
      for (const h of handles) {
        try {
          h.stop()
        } catch {
          /* idempotent — a misbehaving custom watcher MUST not block stop */
        }
      }
    },
    dispatchCount: () => dispatchCount,
  }
}
