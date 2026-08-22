/**
 * Remote grading backend contract (ADR-0536 P0).
 *
 * Grading is a stateless function: predictions.jsonl + dataset.jsonl ⇒ a
 * swebench harness report json ⇒ resolved/unresolved/errored/empty-patch id
 * arrays. Patch-GEN stays local; only the (CPU-bound, native-amd64) GRADING
 * is shipped to a remote box. Two backends implement this contract:
 *
 *   - `ssh:<host>`  — BYO already-bootstrapped box (skips EC2 provisioning).
 *   - `ec2`         — provision a spot box, grade, terminate.
 *
 * Both shell out to `ssh`/`scp`/`aws`/`uvx` exclusively through the injected
 * {@link SpawnFn}, so the entire flow is unit-testable WITHOUT touching the
 * network: a mock SpawnFn records the issued commands and returns canned
 * outputs. {@link defaultSpawn} is the only real effect in this slice.
 */

import type { DatasetFamily } from "../dataset-family-token"

/** Options for a single grading run. */
export interface GradeOptions {
  /** Local path to the swebench instances dataset (instances.jsonl). */
  readonly datasetPath: string
  /** Harness `--run_id` (also names the report file `<model>.<runId>.json`). */
  readonly runId: string
  /** Harness `--max_workers`. Default 4 (cold-image docker-socket safety). */
  readonly maxWorkers?: number
  /** Subset of instance ids to grade (advisory; reserved for future filtering). */
  readonly instanceIds?: readonly string[]
  /** Where to write the retrieved report locally. Default: OS tmp dir. */
  readonly outDir?: string
  /** Dataset family (RFC jun-29). Selects the grading harness fork + image
   *  namespace for the remote grade via that family's profile `harnessSpec` port.
   *  Absent ⇒ treated as `verified` (byte-identical to the pre-family grade path).
   *
   *  aug-22 HIGH-4: typed as `DatasetFamily` rather than an inline copy of the
   *  union — the duplicate literal was one more place a family #4 would have had
   *  to be added by hand. */
  readonly family?: DatasetFamily
}

/** Result of a grading run. */
export interface GradeOutcome {
  /** Local path to the retrieved swebench report json. */
  readonly reportPath: string
  readonly resolved: readonly string[]
  readonly unresolved: readonly string[]
  readonly errored: readonly string[]
  readonly emptyPatch: readonly string[]
  /**
   * Local dir holding each ERROR instance's retrieved swebench log dir
   * (`<outDir>/error-logs/<id>/run_instance.log` …). Present only when grading
   * produced ≥1 error and the best-effort fetch ran. The ground-truth for WHY an
   * instance errored without a manual ssh to the (often gone) box.
   */
  readonly errorLogDir?: string
}

/** A pluggable remote grading backend. */
export interface GradeBackend {
  readonly name: string
  grade(predictionsPath: string, opts: GradeOptions): Promise<GradeOutcome>
}

/** Result of one injected process invocation. */
export interface SpawnResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Injectable process runner. Backends issue every external command (ssh, scp,
 * aws, curl, ...) through this seam, so tests mock it and assert the exact argv
 * without spawning anything. `input` is fed to the child's stdin (for `ssh
 * bash -s` heredoc-style streaming).
 *
 * `onData`: when set, stdout is delivered INCREMENTALLY as it arrives (each
 * decoded chunk) AND still accumulated into the returned `stdout`. This is the
 * real-time-progress seam — a long remote `bench run` is otherwise a black box
 * (the full stdout only lands when the ssh returns, minutes later). Absent ⇒
 * buffer-until-exit (byte-identical to the prior behavior).
 */
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: {
    readonly cwd?: string
    readonly input?: string
    readonly onData?: (chunk: string) => void
  },
) => Promise<SpawnResult>

/**
 * The minimal slice of a spawned child the reader logic depends on. Extracted
 * so {@link spawnWithProc} is testable with a fake proc (no real process), which
 * lets us prove the leak-safe reaping on a stdout-read throw.
 */
export interface SpawnedProc {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(): void
}

/** Factory that produces a {@link SpawnedProc} for the given argv + io. */
export type SpawnProcFactory = (
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd?: string; readonly input?: string },
) => SpawnedProc

/** Real proc factory via `Bun.spawn` — argv-array (no shell ⇒ no injection). */
const bunSpawnProcFactory: SpawnProcFactory = (cmd, args, opts) =>
  Bun.spawn([cmd, ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as SpawnedProc

/**
 * Core {@link SpawnFn} parameterized over the proc factory.
 *
 * Leak-safe: if reading stdout/stderr throws (e.g. a chunk callback raises, or a
 * stream errors mid-read), the child is killed and `exited` is awaited before
 * rethrowing — otherwise the ssh child is never reaped and zombies accumulate
 * across a many-chunk pool run. The success path is byte-identical to the prior
 * direct `Bun.spawn` flow.
 */
export const spawnWithProc = (factory: SpawnProcFactory): SpawnFn => {
  return async (cmd, args, opts) => {
    const proc = factory(cmd, args, {
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    })
    // Streaming path: tee stdout to `onData` chunk-by-chunk while accumulating the
    // full text (needed for downstream parsing). Without onData, the simple
    // buffer-until-exit read is byte-identical to before.
    const readStdout = async (): Promise<string> => {
      if (opts?.onData === undefined) return new Response(proc.stdout).text()
      const decoder = new TextDecoder()
      let acc = ""
      for await (const bytes of proc.stdout as ReadableStream<Uint8Array>) {
        const chunk = decoder.decode(bytes, { stream: true })
        acc += chunk
        opts.onData(chunk)
      }
      return acc
    }
    try {
      const [stdout, stderr] = await Promise.all([readStdout(), new Response(proc.stderr).text()])
      const code = await proc.exited
      return { code, stdout, stderr }
    } catch (err) {
      // Any read-path failure leaks the child unless we reap it here.
      try {
        proc.kill()
      } catch {
        // best-effort: a kill failure must not mask the original error
      }
      await proc.exited.catch(() => undefined)
      throw err
    }
  }
}

/** Real {@link SpawnFn} via `Bun.spawn` — argv-array (no shell ⇒ no injection). */
export const defaultSpawn: SpawnFn = spawnWithProc(bunSpawnProcFactory)

/** Coerce an unknown json field to a string array of ids (defensive). */
const asIdArray = (v: unknown): readonly string[] => {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

/**
 * Parse a swebench harness report json into the id arrays of {@link GradeOutcome}.
 *
 * Shape (validated 2026-06-15):
 *   { resolved_ids, unresolved_ids, error_ids, empty_patch_ids, ... }
 *
 * Garbage / empty / non-object input ⇒ all-empty arrays, NEVER throws (the
 * caller may pass a truncated or half-written report during polling).
 */
export const parseSwebenchReport = (
  json: unknown,
): Pick<GradeOutcome, "resolved" | "unresolved" | "errored" | "emptyPatch"> => {
  if (json === null || typeof json !== "object") {
    return { resolved: [], unresolved: [], errored: [], emptyPatch: [] }
  }
  const r = json as Record<string, unknown>
  return {
    resolved: asIdArray(r.resolved_ids),
    unresolved: asIdArray(r.unresolved_ids),
    errored: asIdArray(r.error_ids),
    emptyPatch: asIdArray(r.empty_patch_ids),
  }
}

/** Default harness worker count — cold-image docker-socket saturation safety. */
export const DEFAULT_MAX_WORKERS = 4
