/**
 * Per-attempt observation wiring + bench-event emission helpers.
 *
 * RFC-0002 §8 observability seam. `buildWiring(observe)` returns either a bare
 * `NullStream` (default-OFF, byte-identical to pre-W-D behavior) or a strict
 * `TeeStream([NullStream, JsonlRecorder, UsageTap])`. The per-event helpers
 * (`emitSandbox`/`emitPatch`/`emitVerify`) wrap append calls in
 * `ObservationError` so the driver can map a strict-recorder failure to
 * `verdict:"degraded"`.
 *
 * `BenchObserver`/`UsageTap`/`countDiff`/`verifyLogTail` live in `../observe`
 * and are re-exported by `./index` for the public barrel; this file uses them
 * but does not own them.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { errMessage, redactValue } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import {
  type AttemptObservation,
  BenchObserver,
  countDiff,
  UsageTap,
  verifyLogTail,
} from "../observe"
import type { Instance } from "../types"
import { gatherSandbox } from "./snapshot"
import type { VerifyOutcome } from "./verdict"

/** StreamPort that swallows every event — silent benchmark runs. */
export class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {
    // intentionally empty
  }
}

/** Marker thrown when a strict (eval) recorder/observer write fails so the
 *  outer catch can map it to `verdict:"degraded"` (RFC §3/§8/§12). */
export class ObservationError extends Error {
  constructor(cause: unknown) {
    super(errMessage(cause))
    this.name = "ObservationError"
  }
}

/** Per-attempt observation wiring (or the no-op default). `obs` is undefined
 *  ⇒ NullStream, byte-identical to pre-W-D behavior. */
export interface Wiring {
  stream: StreamPort
  observer?: BenchObserver
  usage?: UsageTap
}

/** Build the agent stream. Default-off ⇒ a bare `NullStream`. Observing ⇒
 *  `TeeStream([NullStream, JsonlRecorder, UsageTap], {strict:true})` so a
 *  recorder failure rethrows for `verdict:"degraded"` handling (RFC §8). */
export const buildWiring = (
  instance: Instance,
  observe: AttemptObservation | undefined,
): Wiring => {
  if (observe === undefined) return { stream: new NullStream() }
  let observer: BenchObserver
  try {
    observer = new BenchObserver(observe, instance.id)
  } catch (e) {
    // Strict (eval): an unwritable observe dir is an observation failure, not
    // a silent fallback — surface it so the instance is marked degraded.
    throw new ObservationError(e)
  }
  const usage = new UsageTap()
  const stream = new TeeStream([new NullStream(), observer.recorder, usage], { strict: true })
  return { stream, observer, usage }
}

/** Emit the one-shot `sandbox` snapshot before the agent runs. Strict: a
 *  recorder failure becomes an {@link ObservationError}. */
export const emitSandbox = async (
  observer: BenchObserver | undefined,
  sandbox: string,
  baseCommit: string | undefined,
  timeoutMs: number,
): Promise<void> => {
  if (observer === undefined) return
  const data = await gatherSandbox(sandbox, baseCommit, timeoutMs)
  try {
    observer.sandbox(data)
  } catch (e) {
    throw new ObservationError(e)
  }
}

/** Persist the unified diff to `<run>/<id>.<attempt>.patch` and emit
 *  `patch_generated` (filesChanged:0 for an empty patch). Returns the patch
 *  file path so it lands in the summary. */
export const emitPatch = (
  observe: AttemptObservation,
  instance: Instance,
  observer: BenchObserver,
  patch: string,
): string => {
  const attempt = observe.attempt ?? 0
  const diffPath = join(observe.dir, observe.runId, `${instance.id}.${attempt}.patch`)
  // S2: a committed `.env`/fixture token captured in the diff must NOT land
  // raw on disk. Scrub via the single-source @/shared redactor; countDiff runs
  // on the scrubbed text so filesChanged/hunks still reflect what we wrote.
  const safePatch = redactValue(patch) as string
  const { filesChanged, hunks } = countDiff(safePatch)
  try {
    writeFileSync(diffPath, safePatch)
    observer.patchGenerated({ diffPath, filesChanged, hunks, applyStatus: "generated" })
  } catch (e) {
    throw new ObservationError(e)
  }
  return diffPath
}

/**
 * ADR-0539 R2 — emit the patch-LIFECYCLE outcome that mirrors `patch_generated`.
 *
 * `applied:true`  ⇒ `patch_applied`  (`applyStatus:"applied"`): the captured
 *   non-empty patch was applied to the grading tree and graded.
 * `applied:false` ⇒ `patch_rejected` (`applyStatus:"rejected"`): no submittable
 *   patch reached the tree (empty submission / hard-rejected winner).
 *
 * `diffPath` is the path `emitPatch` already wrote (same file — no re-write);
 * `filesChanged`/`hunks` are recomputed from the SAME redacted diff text so the
 * payload matches the `patch_generated` line one-for-one. Strict: a recorder
 * failure becomes an {@link ObservationError} (mapped to `verdict:"degraded"`).
 */
export const emitPatchOutcome = (
  observer: BenchObserver | undefined,
  diffPath: string,
  patch: string,
  applied: boolean,
): void => {
  if (observer === undefined) return
  const safePatch = redactValue(patch) as string
  const { filesChanged, hunks } = countDiff(safePatch)
  const data = { diffPath, filesChanged, hunks, applyStatus: applied ? "applied" : "rejected" }
  try {
    if (applied) observer.patchApplied(data)
    else observer.patchRejected(data)
  } catch (e) {
    throw new ObservationError(e)
  }
}

export const emitVerify = (observer: BenchObserver | undefined, v: VerifyOutcome): void => {
  if (observer === undefined) return
  try {
    observer.verify({
      command: v.command,
      exitCode: v.exitCode,
      passed: v.passed,
      failedTests: v.failedTests,
      logTail: verifyLogTail(v.logTail),
      reportPath: v.reportPath,
    })
  } catch (e) {
    throw new ObservationError(e)
  }
}
