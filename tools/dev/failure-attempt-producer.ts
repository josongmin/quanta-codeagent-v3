/**
 * `tools/dev/failure-attempt-producer` — the authoritative attempt, written down.
 *
 * # Why this exists
 *
 * `tools/test-resilience/failure-artifact.ts` states the contract in its own
 * header: "The runner that actually holds the lease writes this artifact; the
 * diagnostic tool consumes it and never runs a broad suite of its own. With no
 * artifact the tool FAILS CLOSED (exit 2) — there is no fallback path, because
 * a fallback is how the second authority came back last time."
 *
 * The consumer was built, the fail-closed was built, the schema and the
 * fingerprint were built. The PRODUCER was not. So the tool could only ever be
 * driven by a hand-authored file, and the one path that was supposed to feed it
 * — a real chunk failing under the lease — fed it nothing.
 *
 * # Why the first failure and not all of them
 *
 * The runner bails the campaign on the first failing chunk, so the artifact
 * describes the attempt that actually happened rather than a synthesised
 * aggregate. `retryCount` is 0 by construction here: this is written from the
 * ORIGINAL attempt, before any retry, which is what makes its verdict
 * unambiguous.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type FailureAttemptArtifact,
  type FailureRecord,
  type FailureReplayContext,
  failureFingerprint,
} from "../test-resilience/failure-artifact"
import { parseJunitCases } from "../test-resilience/junit"

/**
 * The ONE path this artifact lives at.
 *
 * A wiring audit found the producer writing
 * `<git-common>/quanta-verification-cache/failure-attempt.json` while the
 * `test:flake:diagnose` script read `.cache/test-failure-attempt.json` — a
 * different directory AND a different filename. The artifact was real, current
 * and read by nobody. Exported so the consumer resolves it rather than
 * restating a literal that can drift again.
 */
export const failureAttemptPath = (sharedCacheRoot: string): string =>
  join(sharedCacheRoot, "failure-attempt.json")

/** Bytes of a failure body kept for human triage. */
const MESSAGE_BYTES = 2_000

/**
 * Failure records from ONE chunk's JUnit.
 *
 * The JUnit is the worker's own artifact, so this reports what the worker
 * recorded rather than what the runner believes it asked for — the same reason
 * the executed-file set is read from there.
 */
export const failureRecordsFromJunit = (
  junitXml: string,
  chunkIndex: number,
  messageFor: (testId: string) => string = () => "",
): readonly FailureRecord[] =>
  parseJunitCases(junitXml)
    .filter((testCase) => testCase.status === "fail")
    .map((testCase): FailureRecord => {
      const message = messageFor(testCase.testId).slice(0, MESSAGE_BYTES)
      return {
        file: testCase.file,
        testId: testCase.testId,
        leaf: testCase.leaf,
        kind: "assertion",
        fingerprint: failureFingerprint(testCase.testId, message),
        elapsedMs: testCase.elapsedMs,
        chunkIndex,
        message,
      }
    })

export const buildFailureAttemptArtifact = (input: {
  readonly head: string
  readonly dirty: boolean
  readonly suite: string
  readonly replay: FailureReplayContext
  readonly failures: readonly FailureRecord[]
  readonly nowMs?: number
}): FailureAttemptArtifact => ({
  schema: "quanta.test-failure-attempt.v1",
  head: input.head,
  dirty: input.dirty,
  suite: input.suite,
  createdAtMs: input.nowMs ?? Date.now(),
  replay: input.replay,
  failures: [...input.failures],
})

/**
 * `false` when there was nothing to write.
 *
 * A chunk can exit non-zero with no failed CASE — a crash before the reporter
 * flushed, a killed worker. Writing an artifact with an empty `failures` array
 * would hand the diagnostic tool a file that parses and describes nothing,
 * which is worse than the fail-closed it already has for an absent one.
 */
export const writeFailureAttemptArtifact = (
  path: string,
  artifact: FailureAttemptArtifact,
): boolean => {
  if (artifact.failures.length === 0) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
  return true
}
