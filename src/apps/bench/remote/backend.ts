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
}

/** Result of a grading run. */
export interface GradeOutcome {
  /** Local path to the retrieved swebench report json. */
  readonly reportPath: string
  readonly resolved: readonly string[]
  readonly unresolved: readonly string[]
  readonly errored: readonly string[]
  readonly emptyPatch: readonly string[]
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
 */
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { readonly cwd?: string; readonly input?: string },
) => Promise<SpawnResult>

/** Real {@link SpawnFn} via `Bun.spawn` — argv-array (no shell ⇒ no injection). */
export const defaultSpawn: SpawnFn = async (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd,
    stdin: opts?.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

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
