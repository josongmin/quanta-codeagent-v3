/**
 * Per-instance sandbox lifecycle: create an isolated `cp -R` copy of the
 * instance's repo into `benchWorkRoot()/bench-<id>-XXXX`, hand it to the
 * driver, then unconditionally `rm -rf` on the finally path. Pure path
 * functions: no behavior change vs the prior inline runner.ts block, just a
 * single-responsibility module the driver imports.
 *
 * The corpus is NEVER mutated — that invariant lives here.
 */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gateOn } from "@/shared"
import { benchWorkRoot } from "../corpus/paths"
import type { Instance } from "../types"

/** B1 (jun-27-bench-spot-resume-s3.md): when resume is enabled the sandbox
 *  workdir must be DETERMINISTIC so a partial cassette recorded on box A
 *  replays HIT on box B — the random `mkdtemp` suffix otherwise embeds in the
 *  agent's cwd → into the prompt → content-hash mismatch → replay MISS from
 *  turn 1. Read the env gate inline (NOT a resume/config module — owned
 *  elsewhere) with the canonical truthy vocab so ""/"0"/"off" = OFF.
 *
 *  CONCURRENCY: a deterministic path loses mkdtemp's uniqueness, so two
 *  concurrent runs of the SAME instance on one host would collide on this path.
 *  Resume mode therefore ASSUMES workers=1 / chunk-size=1 (the plan's Tier-0
 *  default). No locking is added here. */
const resumeEnabled = (): boolean => gateOn(process.env, "QUANTA_BENCH_RESUME")

/** Filesystem-safe instance id: replace any char outside [A-Za-z0-9._-] with
 *  "_" so an instance id never escapes its scoped dir or breaks path parsing. */
const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_")

/** The deterministic instance-scoped sandbox path used in resume mode:
 *  `<benchWorkRoot()>/<sanitized id>/sandbox`. Stable across calls and across
 *  boxes for the same instance (→ stable agent cwd → stable prompt hashes for
 *  cross-box cassette replay). The leaf is `sandbox`, NOT `repo`, so it never
 *  collides with the prepared checkout the driver mints at
 *  `<benchWorkRoot()>/<id>/repo` (instance.repoPath) — otherwise createSandbox's
 *  clean-wipe would delete the prepared repo and copyRepo would see src===dest. */
const deterministicSandbox = (id: string): string =>
  join(benchWorkRoot(), sanitizeId(id), "sandbox")

/** Create the fresh sandbox dir. Returns the absolute sandbox path. Does NOT
 *  copy the repo — that is a separate step (see {@link copyRepo}) so the
 *  runner's try/catch can map a `cp` failure (e.g. 0o000 source perms) to a
 *  structured `InstanceResult.error` rather than throwing out of the cleanup
 *  boundary.
 *
 *  ISOLATION (#10097-class fix): each instance gets its OWN private parent dir
 *  with the repo ONE LEVEL DOWN. An agent's `find ..` / `cd ..` then lands in an
 *  empty private parent instead of `benchWorkRoot()`, where every CONCURRENT
 *  sandbox is a sibling. Previously `find ..` wandered into a peer's sandbox
 *  (e.g. mid-`rm` cleanup of `bench-<other>-XXXX`), hung the command to the
 *  deadline → SIGTERM → aborted session → no outcome (lost ~6 instances/batch at
 *  concurrency 6). */
export const createSandbox = async (instance: Instance): Promise<string> => {
  if (resumeEnabled()) {
    // DETERMINISTIC (B1): instance-scoped, stable path. If it already exists (a
    // local re-run) wipe it first so resume re-executes tools against a CLEAN
    // checkout — the dir must be reset, not reused dirty.
    const sandbox = deterministicSandbox(instance.id)
    await rm(sandbox, { recursive: true, force: true })
    await mkdir(sandbox, { recursive: true })
    return sandbox
  }
  // DEFAULT (resume OFF): byte-identical to the original — two random mkdtemp
  // levels (private parent + repo leaf) for concurrent-sibling isolation.
  const parent = await mkdtemp(join(benchWorkRoot(), `bench-${instance.id}-`))
  return mkdtemp(join(parent, "repo-"))
}

/** Recursive copy of the instance's repo into the sandbox. Separate from
 *  {@link createSandbox} so the runner can catch a permissions / disk failure
 *  inside its try arm and surface it as a failed InstanceResult. */
export const copyRepo = async (instance: Instance, sandbox: string): Promise<void> => {
  await cp(instance.repoPath, sandbox, { recursive: true })
}

/** Fork a PREPARED sandbox into a fresh isolated sibling sandbox. Used by
 *  verify-select candidate generation when concurrency > 1: every candidate
 *  must run on its OWN tree, otherwise concurrent agents race on one git
 *  worktree and corrupt patch capture. */
// B1 NOTE: forkSandbox intentionally KEEPS the random suffix even under resume.
// A fork's whole purpose is a DISTINCT sibling tree per verify-select candidate
// (concurrency > 1); a stable deterministic path would collapse every candidate
// onto ONE tree and re-introduce the worktree race fork exists to prevent. Fork
// output is also never the cassette-replay cwd, so determinism buys nothing here.
export const forkSandbox = async (instanceId: string, sourceSandbox: string): Promise<string> => {
  const parent = await mkdtemp(join(benchWorkRoot(), `bench-${instanceId}-fork-`))
  const sandbox = await mkdtemp(join(parent, "repo-"))
  await cp(sourceSandbox, sandbox, { recursive: true })
  return sandbox
}

/** Best-effort cleanup — never throws (the run is already done). Removes the
 *  PRIVATE PARENT (one level up from the repo dir), so both the repo and its
 *  isolation wrapper are gone. */
export const cleanupSandbox = async (sandbox: string): Promise<void> => {
  await rm(dirname(sandbox), { recursive: true, force: true })
}
