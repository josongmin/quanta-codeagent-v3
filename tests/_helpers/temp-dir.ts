/**
 * `tests/_helpers/temp-dir` — the owner of a fixture temp root.
 *
 * # Why a helper and not `mkdtempSync` + `rmSync`
 *
 * Both halves have to be written by the same hand, in the same expression, or
 * they drift. The corpus shows the three ways they drift:
 *
 *   · the `rm` is never written at all — MEASURED: 21 call sites across 9
 *     ordinary files, every one of them leaking a directory per test run;
 *   · the `rm` is written at the END of the test body, so the first failing
 *     `expect` above it skips the cleanup, which is exactly the run where the
 *     evidence is worth keeping and the leak is worth avoiding;
 *   · the `rm` is registered with `process.on("exit")`, which bun's test runner
 *     never fires (see `tests/unit/test-fixtures-do-not-leak-tmp.test.ts`).
 *
 * The failure mode is not disk. `/tmp` grows until `ls /tmp` takes long enough
 * to time OTHER tests out, and the suite reds somewhere with no connection to
 * the file that leaked.
 *
 * `withTempDir` makes the pair a single call: the body cannot run without the
 * `finally` also existing, because the `finally` is this function's.
 *
 * # Cleanup failure is reported, not swallowed
 *
 * `force: true` already tolerates "it was not there". Anything else — a
 * permission problem, a busy mount, a file a child process still holds — means
 * the root really is still on disk, and hiding that turns this helper into the
 * thing it replaces. So a failed removal throws when the body succeeded, and
 * when the body ALSO failed the body's error wins (it is the real finding) with
 * the cleanup failure attached as `cause`.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Thrown when the root outlived the test. Named so a suite can assert on it. */
export class TempDirCleanupError extends Error {
  constructor(
    readonly dir: string,
    cause: unknown,
  ) {
    super(`temp root survived the test: ${dir}`, { cause })
    this.name = "TempDirCleanupError"
  }
}

const rootFor = (prefix: string): string => join(tmpdir(), prefix)

/**
 * Run `body` with a fresh temp directory, and remove it afterwards whatever
 * happens — assertion failure, thrown error, or rejection.
 *
 * The prefix is a plain string (`"cli-version-"`), not a path: making the root
 * somewhere other than the OS temp dir is how a fixture ends up writing into the
 * repository, and this helper does not offer that.
 */
export const withTempDir = async <T>(
  prefix: string,
  body: (dir: string) => T | Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(rootFor(prefix))
  let result: T
  try {
    result = await body(dir)
  } catch (error) {
    // The body's error IS the finding and must reach the reporter unchanged.
    // A cleanup problem on this path is attached, never substituted.
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      if (error instanceof Error && error.cause === undefined)
        error.cause = new TempDirCleanupError(dir, cleanupError)
    }
    throw error
  }
  // Success path: a root that would not go away is itself a finding.
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (cleanupError) {
    throw new TempDirCleanupError(dir, cleanupError)
  }
  return result
}

/** The synchronous twin, for fixtures whose body is synchronous. */
export const withTempDirSync = <T>(prefix: string, body: (dir: string) => T): T => {
  const dir = mkdtempSync(rootFor(prefix))
  let result: T
  try {
    result = body(dir)
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      if (error instanceof Error && error.cause === undefined)
        error.cause = new TempDirCleanupError(dir, cleanupError)
    }
    throw error
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (cleanupError) {
    throw new TempDirCleanupError(dir, cleanupError)
  }
  return result
}

/**
 * For suites whose roots outlive a single expression — a `beforeEach` that sets
 * one up and tests that read it. The owner keeps the escrow; the suite wires
 * `afterEach(owner.disposeAll)` (or `afterAll`) once.
 *
 * Disposal is best-effort PER ROOT and total across roots: one root that cannot
 * be removed must not leave the other nine behind, so every failure is
 * collected and raised together at the end.
 */
export interface TempDirOwner {
  create(prefix: string): string
  disposeAll(): void
  /** Roots this owner currently holds. Used by the suite's own assertions. */
  readonly held: readonly string[]
}

export const makeTempDirOwner = (): TempDirOwner => {
  const roots: string[] = []
  return {
    create(prefix: string): string {
      const dir = mkdtempSync(rootFor(prefix))
      roots.push(dir)
      return dir
    },
    disposeAll(): void {
      const failures: TempDirCleanupError[] = []
      while (roots.length > 0) {
        const dir = roots.pop() as string
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch (error) {
          failures.push(new TempDirCleanupError(dir, error))
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, `${failures.length} temp root(s) survived the suite`)
    },
    get held(): readonly string[] {
      return roots
    },
  }
}
