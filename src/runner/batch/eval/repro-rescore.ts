/**
 * Deterministic OFFLINE repro-oracle rescore.
 *
 * WHY: a full-remote bench run is expensive (LLM patch-gen + repro-gen + an EC2
 * box). But the thing that actually decides whether the repro ORACLE is
 * established — running an already-generated repro script against a freshly
 * checked-out base tree under the project build-env — is PURELY DETERMINISTIC.
 * So once the K repro script sources are persisted (sidecar), we can re-run them
 * against a (possibly fixed) build-env / exec path for ZERO LLM tokens and watch
 * `exec_failed → reproduced` flip. This module is that re-run.
 *
 * It takes NO `llm` port on purpose: the rescore CANNOT cost a model call. It
 * reuses the SAME validated executor (`executeReproTests`) the live run uses, so
 * an unchanged build-env round-trips byte-identically (parity === "match") and a
 * real fix shows up as parity === "drift".
 */

import { executeReproTests, type ReproExecPort, type ReproWriteFilePort } from "@/agent/repro-test/execute"
import type { ReproTestConfig, ReproTestOutcome } from "@/agent/repro-test/types"

/** One instance's cached repro material + its checkout coordinates. */
export interface ReproRescoreInput {
  readonly instanceId: string
  /** SWE-bench repo (`owner/name`) — drives the build-env argv. */
  readonly repo?: string
  /** SWE-bench version — drives the per-instance python in the build-env argv. */
  readonly version?: string
  /** Base commit the repro must reproduce against (for the sandbox checkout). */
  readonly baseCommit?: string
  /** The K repro script SOURCES recorded from a prior run, each optionally
   *  carrying the outcome it produced THEN (for parity comparison). */
  readonly scripts: readonly { readonly source: string; readonly recordedOutcome?: ReproTestOutcome }[]
}

/** Parity of the rescore vs the recorded run. */
export type ReproRescoreParity = "match" | "drift" | "unknown"

export interface ReproRescoreResult {
  readonly instanceId: string
  /** Fresh outcomes, one per input script (index-aligned). */
  readonly outcomes: readonly ReproTestOutcome[]
  /** How many scripts printed `Issue reproduced` this time. */
  readonly reproducedCount: number
  /** The recorded outcomes (echoed for the caller's diff), when supplied. */
  readonly recordedOutcomes: readonly (ReproTestOutcome | undefined)[]
  /** `match` ⇒ every script's fresh outcome equals its recorded outcome;
   *  `drift` ⇒ at least one changed; `unknown` ⇒ no recorded outcomes to compare. */
  readonly parity: ReproRescoreParity
  /** Set when this instance could not be rescored (e.g. checkout failed). The
   *  failure is isolated: other instances still rescore. */
  readonly error?: string
}

export interface RescoreReproDeps {
  /** Check out / prepare a sandbox for the instance at its base commit and
   *  return its path. The executor runs repro scripts with this as cwd. */
  readonly prepareSandbox: (input: ReproRescoreInput) => Promise<string>
  /** Injected exec port (production: real subprocess; tests: in-memory). */
  readonly exec: ReproExecPort
  /** Injected file-write port. Defaults to `Bun.write`. */
  readonly writeFile?: ReproWriteFilePort
  /** Build the FULL argv to run a repro script — this is where the per-repo
   *  build-env fix lives (e.g. astropy `--no-build-isolation` + extension_helpers
   *  via `reproRunArgv`). Default: bare `[python3, scriptPath]`. */
  readonly buildArgv?: (input: ReproRescoreInput, scriptPath: string) => readonly string[]
  readonly config?: ReproTestConfig
  readonly signal?: AbortSignal
}

const defaultWriteFile: ReproWriteFilePort = async (path, content) => {
  await Bun.write(path, content)
}

const parityOf = (
  fresh: readonly ReproTestOutcome[],
  recorded: readonly (ReproTestOutcome | undefined)[],
): ReproRescoreParity => {
  const comparable = recorded.filter((o): o is ReproTestOutcome => o !== undefined)
  if (comparable.length === 0) return "unknown"
  for (let i = 0; i < recorded.length; i++) {
    const r = recorded[i]
    if (r === undefined) continue
    if (fresh[i] !== r) return "drift"
  }
  return "match"
}

const rescoreOne = async (
  input: ReproRescoreInput,
  deps: RescoreReproDeps,
): Promise<ReproRescoreResult> => {
  const recordedOutcomes = input.scripts.map((s) => s.recordedOutcome)
  try {
    const sandbox = await deps.prepareSandbox(input)
    const samples = await executeReproTests({
      tests: input.scripts.map((s) => s.source),
      repoRoot: sandbox,
      exec: deps.exec,
      writeFile: deps.writeFile ?? defaultWriteFile,
      ...(deps.config !== undefined ? { config: deps.config } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.buildArgv !== undefined
        ? { buildArgv: (scriptPath: string) => deps.buildArgv!(input, scriptPath) }
        : {}),
    })
    const outcomes = samples.map((s) => s.outcome)
    return {
      instanceId: input.instanceId,
      outcomes,
      reproducedCount: outcomes.filter((o) => o === "reproduced").length,
      recordedOutcomes,
      parity: parityOf(outcomes, recordedOutcomes),
    }
  } catch (e) {
    return {
      instanceId: input.instanceId,
      outcomes: [],
      reproducedCount: 0,
      recordedOutcomes,
      parity: "unknown",
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
  }
}

/**
 * Rescore every instance's cached repro scripts. Instances are independent: a
 * checkout/exec failure on one is captured as `result.error` and never aborts
 * the others. Runs SERIALLY by default (repro exec is heavy and the caller may
 * share a single build cache); pass pre-prepared sandboxes via `prepareSandbox`
 * to parallelise upstream if desired.
 */
export const rescoreReproScripts = async (
  inputs: readonly ReproRescoreInput[],
  deps: RescoreReproDeps,
): Promise<readonly ReproRescoreResult[]> => {
  const out: ReproRescoreResult[] = []
  for (const input of inputs) {
    if (deps.signal?.aborted === true) break
    out.push(await rescoreOne(input, deps))
  }
  return out
}
