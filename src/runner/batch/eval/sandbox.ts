/**
 * Per-instance sandbox lifecycle: create an isolated `cp -R` copy of the
 * instance's repo into `benchWorkRoot()/bench-<id>-XXXX`, hand it to the
 * driver, then unconditionally `rm -rf` on the finally path. Pure path
 * functions: no behavior change vs the prior inline runner.ts block, just a
 * single-responsibility module the driver imports.
 *
 * The corpus is NEVER mutated — that invariant lives here.
 */
import { cp, mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { benchWorkRoot } from "../corpus/paths"
import type { Instance } from "../types"

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
  const parent = await mkdtemp(join(benchWorkRoot(), `bench-${instance.id}-`))
  return mkdtemp(join(parent, "repo-"))
}

/** Recursive copy of the instance's repo into the sandbox. Separate from
 *  {@link createSandbox} so the runner can catch a permissions / disk failure
 *  inside its try arm and surface it as a failed InstanceResult. */
export const copyRepo = async (instance: Instance, sandbox: string): Promise<void> => {
  await cp(instance.repoPath, sandbox, { recursive: true })
}

/** Best-effort cleanup — never throws (the run is already done). Removes the
 *  PRIVATE PARENT (one level up from the repo dir), so both the repo and its
 *  isolation wrapper are gone. */
export const cleanupSandbox = async (sandbox: string): Promise<void> => {
  await rm(dirname(sandbox), { recursive: true, force: true })
}
